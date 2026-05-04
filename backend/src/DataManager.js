'use strict';

const fetch = require('node-fetch');
const WebSocket = require('ws');

const TD_BASE    = 'https://api.twelvedata.com';
const BN_REST    = 'https://api.binance.com/api/v3/klines';
const BN_WS      = 'wss://stream.binance.com:9443/ws';

const ASSETS = {
  eurusd: { td: 'EUR/USD',  binance: null,      type: 'forex' },
  gbpusd: { td: 'GBP/USD',  binance: null,      type: 'forex' },
  eurjpy: { td: 'EUR/JPY',  binance: null,      type: 'forex' },
  usdjpy: { td: 'USD/JPY',  binance: null,      type: 'forex' },
  audusd: { td: 'AUD/USD',  binance: null,      type: 'forex' },
  usdcad: { td: 'USD/CAD',  binance: null,      type: 'forex' },
  gbpjpy: { td: 'GBP/JPY',  binance: null,      type: 'forex' },
  btcusd: { td: 'BTC/USD',  binance: 'btcusdt', type: 'crypto' },
  ethusd: { td: 'ETH/USD',  binance: 'ethusdt', type: 'crypto' },
  gold:   { td: 'XAU/USD',  binance: null,      type: 'commodity' },
};

// ─── Rate-limited request queue ───────────────────
// TwelveData free tier: 8 req/min, 800 credits/day
// We process 1 request every 8.5 seconds → ~7/min (safe buffer)
class RequestQueue {
  constructor(intervalMs = 8500) {
    this.queue = [];
    this.timer = null;
    this.intervalMs = intervalMs;
  }
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.timer) this._tick();
    });
  }
  _tick() {
    if (!this.queue.length) { this.timer = null; return; }
    const { fn, resolve, reject } = this.queue.shift();
    fn().then(resolve).catch(reject);
    this.timer = setTimeout(() => this._tick(), this.intervalMs);
  }
}

// ─── DataManager ──────────────────────────────────
class DataManager {
  constructor() {
    this.store   = {};
    this.sockets = {};
    this.tdKey   = process.env.TWELVEDATA_API_KEY || '';
    this.queue   = new RequestQueue(8500);
    // 15-minute freshness window per asset (keeps daily credits low)
    this.STALE_MS = 15 * 60 * 1000;

    for (const sym of Object.keys(ASSETS)) {
      this.store[sym] = { '5m': [], currentPrice: 0, lastUpdate: 0, source: 'none' };
    }
  }

  async initialize() {
    if (!this.tdKey) {
      console.warn('[DataManager] ⚠️  TWELVEDATA_API_KEY not set — forex/gold signals disabled. Set it in Render env vars.');
    } else {
      console.log('[DataManager] TwelveData key found ✓');
    }

    // Crypto: Binance REST bootstrap → WebSocket (no key, no rate limit)
    for (const [sym, cfg] of Object.entries(ASSETS)) {
      if (cfg.binance) {
        await this._fetchBinanceREST(sym, cfg.binance);
        this._connectBinanceWS(sym, cfg.binance);
      }
    }

    // Forex + Gold: queue TwelveData fetches (rate limited)
    if (this.tdKey) {
      for (const [sym, cfg] of Object.entries(ASSETS)) {
        if (!cfg.binance) this._queueTD(sym);
      }
    }
  }

  // Called by /signal route before generating — refreshes if stale
  async ensureFresh(sym) {
    const cfg = ASSETS[sym];
    if (!cfg || cfg.binance) return; // crypto stays fresh via WS
    if (!this.tdKey) return;
    const age = Date.now() - (this.store[sym]?.lastUpdate || 0);
    if (age < this.STALE_MS) return; // still fresh — skip
    return this._queueTD(sym);
  }

  // ── TwelveData fetch ──────────────────────────────
  _queueTD(sym) {
    return this.queue.enqueue(() => this._fetchTD(sym));
  }

  async _fetchTD(sym) {
    const cfg = ASSETS[sym];
    if (!cfg || !this.tdKey) return;

    const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(cfg.td)}&interval=5min&outputsize=150&apikey=${this.tdKey}`;
    try {
      const res  = await fetch(url, { timeout: 15000 });
      const data = await res.json();

      if (data.status === 'error') {
        console.warn(`[TwelveData] ${sym}: ${data.message}`);
        return;
      }
      if (!Array.isArray(data.values) || !data.values.length) {
        console.warn(`[TwelveData] ${sym}: empty values`);
        return;
      }

      // TwelveData returns newest-first — reverse to chronological
      const candles = data.values.slice().reverse().map(v => ({
        t: new Date(v.datetime + 'Z').getTime(),
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
        v: parseFloat(v.volume) || 0,
      })).filter(c => !isNaN(c.c));

      if (candles.length < 10) return;

      const s        = this.store[sym];
      s['5m']        = candles;
      s.currentPrice = candles[candles.length - 1].c;
      s.lastUpdate   = Date.now();
      s.source       = 'twelvedata';
      console.log(`[TwelveData] ${sym}: ${candles.length} candles (${cfg.td})`);
    } catch (err) {
      console.warn(`[TwelveData] ${sym} fetch error: ${err.message}`);
    }
  }

  // ── Binance REST (crypto bootstrap) ──────────────
  async _fetchBinanceREST(sym, binSym) {
    const url = `${BN_REST}?symbol=${binSym.toUpperCase()}&interval=5m&limit=200`;
    try {
      const res  = await fetch(url, { timeout: 12000 });
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const candles = data.map(k => ({
        t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
      }));

      const s        = this.store[sym];
      s['5m']        = candles;
      s.currentPrice = candles[candles.length - 1].c;
      s.lastUpdate   = Date.now();
      s.source       = 'binance';
      console.log(`[Binance REST] ${sym}: ${candles.length} candles`);
    } catch (err) {
      console.warn(`[Binance REST] ${sym}: ${err.message}`);
    }
  }

  // ── Binance WebSocket (crypto real-time) ─────────
  _connectBinanceWS(sym, binSym) {
    const reconnect = () => setTimeout(() => this._connectBinanceWS(sym, binSym), 5000);
    try {
      const ws = new WebSocket(`${BN_WS}/${binSym}@kline_5m`);
      this.sockets[sym] = ws;

      ws.on('open', () => console.log(`[Binance WS] ${sym} connected`));

      ws.on('message', raw => {
        try {
          const k = JSON.parse(raw).k;
          if (!k) return;
          const c   = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
          const arr = this.store[sym]['5m'];
          if (arr.length && arr[arr.length - 1].t === c.t) {
            arr[arr.length - 1] = c;
          } else if (k.x) {
            arr.push(c);
            if (arr.length > 300) arr.shift();
          }
          this.store[sym].currentPrice = c.c;
          this.store[sym].lastUpdate   = Date.now();
          this.store[sym].source       = 'binance-ws';
        } catch (e) {}
      });

      ws.on('close', () => {
        console.warn(`[Binance WS] ${sym} closed — reconnecting in 5s`);
        reconnect();
      });
      ws.on('error', err => console.warn(`[Binance WS] ${sym}: ${err.message}`));
    } catch (err) {
      reconnect();
    }
  }

  // ── Public getters ────────────────────────────────
  getCandles(sym, tf = '5m') { return this.store[sym]?.[tf] || []; }
  getCurrentPrice(sym)       { return this.store[sym]?.currentPrice || 0; }
  getLastUpdate(sym)         { return this.store[sym]?.lastUpdate   || 0; }
  isReady(sym)               { return (this.store[sym]?.['5m'] || []).length >= 30; }
  hasTDKey()                 { return !!this.tdKey; }

  getStatus() {
    const out = {};
    for (const [sym, cfg] of Object.entries(ASSETS)) {
      const s = this.store[sym];
      out[sym] = {
        type:    cfg.type,
        source:  s.source,
        candles: s['5m'].length,
        price:   s.currentPrice,
        ready:   this.isReady(sym),
        ageSeconds: s.lastUpdate ? Math.floor((Date.now() - s.lastUpdate) / 1000) : null,
      };
    }
    return out;
  }
}

module.exports = { DataManager, ASSETS };
