'use strict';

const fetch = require('node-fetch');
const WebSocket = require('ws');

// Asset registry — maps internal symbol to data-source config
const ASSETS = {
  eurusd:  { yahoo: 'EURUSD=X',  binance: null,      type: 'forex',     base: 'EUR', quote: 'USD' },
  gbpusd:  { yahoo: 'GBPUSD=X',  binance: null,      type: 'forex',     base: 'GBP', quote: 'USD' },
  eurjpy:  { yahoo: 'EURJPY=X',  binance: null,      type: 'forex',     base: 'EUR', quote: 'JPY' },
  usdjpy:  { yahoo: 'USDJPY=X',  binance: null,      type: 'forex',     base: 'USD', quote: 'JPY' },
  audusd:  { yahoo: 'AUDUSD=X',  binance: null,      type: 'forex',     base: 'AUD', quote: 'USD' },
  usdcad:  { yahoo: 'USDCAD=X',  binance: null,      type: 'forex',     base: 'USD', quote: 'CAD' },
  gbpjpy:  { yahoo: 'GBPJPY=X',  binance: null,      type: 'forex',     base: 'GBP', quote: 'JPY' },
  btcusd:  { yahoo: 'BTC-USD',   binance: 'btcusdt', type: 'crypto',    base: 'BTC', quote: 'USD' },
  ethusd:  { yahoo: 'ETH-USD',   binance: 'ethusdt', type: 'crypto',    base: 'ETH', quote: 'USD' },
  gold:    { yahoo: 'GC=F',      binance: null,      type: 'commodity', base: 'XAU', quote: 'USD' },
};

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

const BINANCE_REST = 'https://api.binance.com/api/v3/klines';
const BINANCE_WS   = 'wss://stream.binance.com:9443/ws';
const YAHOO_CHART  = 'https://query2.finance.yahoo.com/v8/finance/chart';

// Spot-price fallback for forex (open.er-api.com, truly free, no key)
const ER_API = 'https://open.er-api.com/v6/latest';

class DataManager {
  constructor() {
    this.store = {};  // { symbol: { '5m': Candle[], currentPrice, lastUpdate, source } }
    this.wsSockets = {};
    this.tickBuffers = {}; // for fallback candle building from spot ticks
    this.pollTimers = {};

    for (const sym of Object.keys(ASSETS)) {
      this.store[sym] = { '5m': [], currentPrice: 0, lastUpdate: 0, source: 'none' };
      this.tickBuffers[sym] = { current: null, completed: [] };
    }
  }

  async initialize() {
    console.log('[DataManager] Warming all asset streams...');
    await Promise.allSettled(Object.keys(ASSETS).map(sym => this._boot(sym)));
    console.log('[DataManager] Initial warm complete.');
    this._scheduleRefresh();
  }

  // ─────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────
  getCandles(sym, tf = '5m') { return this.store[sym]?.[tf] || []; }
  getCurrentPrice(sym)       { return this.store[sym]?.currentPrice || 0; }
  getLastUpdate(sym)         { return this.store[sym]?.lastUpdate || 0; }
  isReady(sym)               { return (this.store[sym]?.['5m'] || []).length >= 30; }

  getStatus() {
    const out = {};
    for (const sym of Object.keys(ASSETS)) {
      const s = this.store[sym];
      out[sym] = {
        candles: s['5m'].length,
        source:  s.source,
        price:   s.currentPrice,
        ready:   this.isReady(sym),
        age:     s.lastUpdate ? Math.floor((Date.now() - s.lastUpdate) / 1000) : null,
      };
    }
    return out;
  }

  // ─────────────────────────────────────────────────
  // Boot sequence per asset
  // ─────────────────────────────────────────────────
  async _boot(sym) {
    const cfg = ASSETS[sym];
    if (cfg.binance) {
      await this._fetchBinance(sym, cfg.binance);
      this._connectBinanceWS(sym, cfg.binance);
    }
    // Always try Yahoo (good for all assets, and richer data for crypto too)
    await this._fetchYahoo(sym, cfg.yahoo);

    // If still not ready, fall back to spot-price polling
    if (!this.isReady(sym) && cfg.type === 'forex') {
      this._startSpotPolling(sym, cfg);
    }
  }

  _scheduleRefresh() {
    // Refresh Yahoo every 5 min for all non-Binance assets
    setInterval(async () => {
      for (const [sym, cfg] of Object.entries(ASSETS)) {
        if (!cfg.binance) {
          await this._fetchYahoo(sym, cfg.yahoo).catch(() => {});
        }
      }
    }, 5 * 60 * 1000);
  }

  // ─────────────────────────────────────────────────
  // Yahoo Finance (5-min OHLCV)
  // ─────────────────────────────────────────────────
  async _fetchYahoo(sym, yahooSym) {
    const url = `${YAHOO_CHART}/${encodeURIComponent(yahooSym)}?interval=5m&range=2d&includePrePost=false`;
    try {
      const res = await fetch(url, { headers: YAHOO_HEADERS, timeout: 12000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error('empty result');

      const timestamps = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const { open = [], high = [], low = [], close = [], volume = [] } = q;

      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (close[i] == null || isNaN(close[i])) continue;
        candles.push({
          t: timestamps[i] * 1000,
          o: open[i]   ?? close[i],
          h: high[i]   ?? close[i],
          l: low[i]    ?? close[i],
          c: close[i],
          v: volume[i] ?? 0,
        });
      }

      if (candles.length >= 10) {
        const s = this.store[sym];
        // If we already have better live data from Binance, only update if Yahoo has more
        if (candles.length > s['5m'].length || s.source === 'none' || s.source === 'spot-poll') {
          s['5m'] = candles;
          s.currentPrice = candles[candles.length - 1].c;
          s.lastUpdate   = Date.now();
          s.source       = 'yahoo';
          console.log(`[DataManager] ${sym}: ${candles.length} candles via Yahoo (${yahooSym})`);
        }
      }
    } catch (err) {
      console.warn(`[DataManager] Yahoo failed for ${sym}: ${err.message}`);
      // Try alternate Yahoo URL format
      await this._fetchYahooAlt(sym, yahooSym).catch(() => {});
    }
  }

  async _fetchYahooAlt(sym, yahooSym) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=5m&range=1d`;
    const res = await fetch(url, { headers: YAHOO_HEADERS, timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('empty');

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = q.close?.[i];
      if (c == null || isNaN(c)) continue;
      candles.push({ t: timestamps[i] * 1000, o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? 0 });
    }
    if (candles.length >= 10) {
      const s = this.store[sym];
      s['5m'] = candles;
      s.currentPrice = candles[candles.length - 1].c;
      s.lastUpdate   = Date.now();
      s.source       = 'yahoo-alt';
      console.log(`[DataManager] ${sym}: ${candles.length} candles via Yahoo-alt`);
    }
  }

  // ─────────────────────────────────────────────────
  // Binance REST (bootstrap)
  // ─────────────────────────────────────────────────
  async _fetchBinance(sym, binSym) {
    const url = `${BINANCE_REST}?symbol=${binSym.toUpperCase()}&interval=5m&limit=200`;
    try {
      const res = await fetch(url, { timeout: 12000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Not array');
      const candles = data.map(k => ({
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      }));
      const s = this.store[sym];
      s['5m'] = candles;
      s.currentPrice = candles[candles.length - 1].c;
      s.lastUpdate   = Date.now();
      s.source       = 'binance';
      console.log(`[DataManager] ${sym}: ${candles.length} candles via Binance REST`);
    } catch (err) {
      console.warn(`[DataManager] Binance REST failed for ${sym}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────
  // Binance WebSocket (real-time 5m kline)
  // ─────────────────────────────────────────────────
  _connectBinanceWS(sym, binSym) {
    const url = `${BINANCE_WS}/${binSym}@kline_5m`;
    const reconnect = () => setTimeout(() => this._connectBinanceWS(sym, binSym), 5000);

    try {
      const ws = new WebSocket(url);
      this.wsSockets[sym] = ws;

      ws.on('open', () => console.log(`[DataManager] Binance WS open: ${sym}`));

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw);
          const k = msg.k;
          if (!k) return;
          const candle = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
          const arr = this.store[sym]['5m'];
          if (arr.length && arr[arr.length - 1].t === candle.t) {
            arr[arr.length - 1] = candle;
          } else if (k.x) {
            arr.push(candle);
            if (arr.length > 300) arr.shift();
          }
          this.store[sym].currentPrice = candle.c;
          this.store[sym].lastUpdate   = Date.now();
          this.store[sym].source       = 'binance-ws';
        } catch (e) {}
      });

      ws.on('close', () => { console.warn(`[DataManager] Binance WS closed: ${sym}`); reconnect(); });
      ws.on('error', err => { console.warn(`[DataManager] Binance WS error: ${sym}: ${err.message}`); });
    } catch (err) {
      console.warn(`[DataManager] WS connect failed: ${sym}`);
      reconnect();
    }
  }

  // ─────────────────────────────────────────────────
  // Spot-price polling fallback (forex, no Yahoo)
  // Builds synthetic 5-min candles from spot ticks
  // ─────────────────────────────────────────────────
  _startSpotPolling(sym, cfg) {
    if (this.pollTimers[sym]) return;
    console.log(`[DataManager] Starting spot-poll fallback for ${sym}`);
    const poll = async () => {
      try {
        const res = await fetch(`${ER_API}/${cfg.base}`, { timeout: 8000 });
        if (!res.ok) return;
        const data = await res.json();
        const price = data.rates?.[cfg.quote];
        if (!price) return;
        this._addTick(sym, price);
      } catch (e) {}
    };
    poll();
    this.pollTimers[sym] = setInterval(poll, 30000); // every 30 seconds
  }

  _addTick(sym, price) {
    const now = Date.now();
    const FIVE_MIN = 5 * 60 * 1000;
    const bucket = Math.floor(now / FIVE_MIN) * FIVE_MIN;
    const tb = this.tickBuffers[sym];

    if (tb.current && tb.current.t === bucket) {
      tb.current.h = Math.max(tb.current.h, price);
      tb.current.l = Math.min(tb.current.l, price);
      tb.current.c = price;
      tb.current.v += 1;
    } else {
      if (tb.current) {
        tb.completed.push(tb.current);
        if (tb.completed.length > 200) tb.completed.shift();
      }
      tb.current = { t: bucket, o: price, h: price, l: price, c: price, v: 1 };
    }

    // Merge completed candles back into store
    const all = [...tb.completed, tb.current].filter(Boolean);
    if (all.length >= 5) {
      const s = this.store[sym];
      s['5m'] = all;
      s.currentPrice = price;
      s.lastUpdate   = now;
      s.source       = 'spot-poll';
    }
  }
}

module.exports = { DataManager, ASSETS };
