'use strict';

const express    = require('express');
const cors       = require('cors');
const { DataManager, ASSETS } = require('./src/DataManager');
const SignalEngine  = require('./src/SignalEngine');
const LearningEngine = require('./src/LearningEngine');
const RiskManager   = require('./src/RiskManager');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Engine init ───────────────────────────────────
const dataManager    = new DataManager();
const learningEngine = new LearningEngine();
const signalEngine   = new SignalEngine(learningEngine);
const riskManager    = new RiskManager();

const START_TIME = Date.now();

// Signal cache — avoid recomputing for the same asset within 30 seconds
const sigCache = {}; // { sym: { ts, payload } }

// ─── Helpers ───────────────────────────────────────
function uptime() { return Math.floor((Date.now() - START_TIME) / 1000); }

// ─── Routes ────────────────────────────────────────

// Health / dashboard
app.get('/', (req, res) => {
  const streams = dataManager.getStatus();
  const ready   = Object.values(streams).filter(s => s.ready);
  res.json({
    status:  `ONLINE — ${ready.length}/${Object.keys(streams).length} streams ready`,
    version: '2.0',
    uptime:  uptime(),
    streams: ready.map(s => s), // array for frontend .streams.length check
    streamDetails: streams,
    learning: {
      weights:   learningEngine.getWeights(),
      threshold: learningEngine.getThreshold(),
      stats:     learningEngine.getStats(),
    },
  });
});

// Ping / keep-alive
app.get('/ping', (req, res) => res.json({ pong: true, uptime: uptime() }));

// Status (detailed)
app.get('/status', (req, res) => {
  res.json({
    uptime:    uptime(),
    streams:   dataManager.getStatus(),
    learning:  {
      weights:   learningEngine.getWeights(),
      threshold: learningEngine.getThreshold(),
      stats:     learningEngine.getStats(),
    },
  });
});

// ── Main signal endpoint ──────────────────────────
// GET /signal/:asset?balance=100&stake=1.71
app.get('/signal/:asset', (req, res) => {
  const sym     = req.params.asset.toLowerCase().replace(/[^a-z]/g, '');
  const balance = parseFloat(req.query.balance) || 100;
  const stake   = parseFloat(req.query.stake)   || 1.71;

  if (!ASSETS[sym]) {
    return res.status(404).json({ error: `Unknown asset: ${sym}. Valid: ${Object.keys(ASSETS).join(', ')}` });
  }

  // Return cached signal if fresh
  const cached = sigCache[sym];
  if (cached && Date.now() - cached.ts < 30000) {
    return res.json(cached.payload);
  }

  if (!dataManager.isReady(sym)) {
    const candles = dataManager.getCandles(sym).length;
    return res.json({
      strategy: {
        signal:     'WAIT',
        confidence: 0,
        score:      0,
        reason:     `Warming up: ${candles}/30 candles loaded — retry in 15s`,
        indicators: {},
        scores:     {},
      },
      positionSize: 0,
      asset:     sym,
      dataReady: false,
      candleCount: candles,
    });
  }

  const candles5m    = dataManager.getCandles(sym, '5m');
  const currentPrice = dataManager.getCurrentPrice(sym);
  const analysis     = signalEngine.analyze(sym, candles5m);
  const stats        = learningEngine.getStats();
  const agree        = analysis.agree || 0;

  const riskInfo     = riskManager.assessRisk(stats.consecutiveLosses, analysis.confidence, agree);
  const positionSize = riskManager.calculatePositionSize(balance, stake, analysis.confidence, stats.consecutiveLosses);

  const payload = {
    strategy:     analysis,
    positionSize: parseFloat(positionSize.toFixed(2)),
    riskLevel:    riskInfo.level,
    maxMultiplier: riskInfo.maxMult,
    currentPrice,
    asset:        sym,
    dataReady:    true,
    candleCount:  candles5m.length,
    dataSource:   dataManager.getStatus()[sym]?.source,
    generatedAt:  Date.now(),
  };

  sigCache[sym] = { ts: Date.now(), payload };
  res.json(payload);
});

// ── Adaptive learning: receive trade results ──────
// POST /trade-result  { result: "WIN"|"LOSS", indicatorPerformance: {...}, pnl: 0 }
app.post('/trade-result', (req, res) => {
  const { result, indicatorPerformance = {}, pnl = 0 } = req.body || {};
  if (!result || !['WIN', 'LOSS'].includes(result.toUpperCase())) {
    return res.status(400).json({ error: 'result must be "WIN" or "LOSS"' });
  }
  const stats = learningEngine.recordResult(result.toUpperCase(), indicatorPerformance, Number(pnl));
  res.json({
    success:   true,
    stats,
    weights:   learningEngine.getWeights(),
    threshold: learningEngine.getThreshold(),
  });
});

// ── Bulk signals (all ready assets) ──────────────
// GET /signals?balance=100
app.get('/signals', (req, res) => {
  const balance = parseFloat(req.query.balance) || 100;
  const out = {};
  for (const sym of Object.keys(ASSETS)) {
    if (!dataManager.isReady(sym)) continue;
    const candles = dataManager.getCandles(sym, '5m');
    const analysis = signalEngine.analyze(sym, candles);
    const stats = learningEngine.getStats();
    const pos = riskManager.calculatePositionSize(balance, 1.71, analysis.confidence, stats.consecutiveLosses);
    out[sym] = { ...analysis, positionSize: parseFloat(pos.toFixed(2)), price: dataManager.getCurrentPrice(sym) };
  }
  res.json(out);
});

// ─── Start ─────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 QUATTRO AI Backend v2.0 — port ${PORT}`);
  console.log('   Warming data streams in background...\n');
  try {
    await dataManager.initialize();
    const status = dataManager.getStatus();
    const readyCount = Object.values(status).filter(s => s.ready).length;
    console.log(`\n✅ Data ready: ${readyCount}/${Object.keys(status).length} assets`);
  } catch (err) {
    console.error('[Init Error]', err);
  }
});
