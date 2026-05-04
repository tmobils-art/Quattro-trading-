# QUATTRO AI v14 — Trading Signal App

**4-strategy fusion engine with real-time Binance + Yahoo Finance data, adaptive learning, and risk management.**

---

## Deploy Backend to Render.com (Free, 5 minutes)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Set these options:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Click **Deploy**
6. Copy the URL (e.g. `https://quattro-ai-backend.onrender.com`)
7. Paste it into the app's **Render Backend** field → tap **TEST CONNECTION**

That's it. The backend auto-streams:
- **BTC/USD, ETH/USD** — Binance WebSocket (real-time, zero latency)
- **EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, EUR/JPY, GBP/JPY** — Yahoo Finance (5-min OHLCV)
- **GOLD** — Yahoo Finance futures (GC=F)

---

## How It Works

### Signal Generation
1. Backend fetches real 5-minute OHLCV candles for the selected asset
2. Computes: **RSI(14), MACD(12,26,9), Bollinger Bands(20), ATR(14), Stochastic(14)**
3. Multi-timeframe alignment check (5-candle vs 30-candle trend)
4. Volume profile scoring
5. Composite weighted score → CALL / PUT / WAIT
6. Only fires signal when composite score exceeds adaptive threshold

### Adaptive Learning
- After each trade, tap **WIN** or **LOSS** in the History tab
- The engine adjusts indicator weights (indicators that predict correctly gain weight)
- The score threshold auto-tunes: if you're losing it becomes stricter, winning = more signals
- Trade results are also sent to the backend for server-side learning

### Risk Management
- Default: 1% of balance per trade
- High confidence (≥85%): up to 1.5%
- Low confidence (<70%): 0.5%
- After 3 consecutive losses: **hard stop** (returns position size = 0)

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Health check, stream status |
| `GET /signal/:asset` | Signal for asset (e.g. `/signal/eurusd`) |
| `GET /signals` | All ready assets at once |
| `POST /trade-result` | Log `WIN`/`LOSS` for learning |
| `GET /status` | Detailed stream + learning state |
| `GET /ping` | Keep-alive |

### Signal Response
```json
{
  "strategy": {
    "signal": "CALL",
    "confidence": 78,
    "score": 1.42,
    "reason": "RSI 31 oversold • MACD bull cross • BB lower touch",
    "agree": 3,
    "indicators": {
      "rsi": 31.2,
      "macd": 0.000123,
      "macdSignal": 0.000089,
      "bbPct": 0.04,
      "trend": "up",
      "price": 1.08521
    }
  },
  "positionSize": 1.50,
  "riskLevel": "GOOD",
  "currentPrice": 1.08521,
  "candleCount": 156,
  "dataSource": "yahoo"
}
```

---

## Notes

- **Free tier on Render sleeps after 15 minutes** of no traffic — first request takes ~30s to wake
- To keep it awake: set up a free cron job at [cron-job.org](https://cron-job.org) to ping `https://your-app.onrender.com/ping` every 14 minutes
- No API keys required for any data source
- For best results use 5-min or 15-min expiry on PocketOption
