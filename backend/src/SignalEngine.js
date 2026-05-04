'use strict';

const I = require('./Indicators');

class SignalEngine {
  constructor(learningEngine) {
    this.learning = learningEngine;
  }

  analyze(symbol, candles5m) {
    if (!candles5m || candles5m.length < 30) {
      return {
        signal: 'WAIT', confidence: 0, score: 0,
        reason: `Insufficient candle data (${candles5m ? candles5m.length : 0}/30 min)`,
        indicators: {}, scores: {},
      };
    }

    const closes = candles5m.map(c => c.c);
    const W = this.learning.getWeights();
    const threshold = this.learning.getThreshold();

    // ── Compute all indicators ──
    const rsiVal      = I.rsi(closes);
    const macdData    = I.macd(closes);
    const bb          = I.bollingerBands(closes);
    const trend       = I.trendStrength(candles5m);
    const vol         = I.volumeProfile(candles5m);
    const atrVal      = I.atr(candles5m);
    const stoch       = I.stochastic(candles5m);
    const volScore    = I.volatilityScore(candles5m);
    const mtfScore    = I.multiTimeframeScore(candles5m);

    // ── Individual scores (–1 to +1) ──
    const rsiScore   = this._scoreRSI(rsiVal);
    const macdScore  = this._scoreMACD(macdData);
    const bbScore    = this._scoreBB(bb);
    const trendScore = this._scoreTrend(trend);

    // ── Composite score ──
    let score = 0;
    score += W.rsi   * rsiScore;
    score += W.macd  * macdScore;
    score += W.boll  * bbScore;
    score += W.trend * trendScore;
    score += 1.1  * volScore;
    score += 1.3  * vol.score;
    score += 1.2  * mtfScore;

    // ── Decision ──
    const callVotes = [rsiScore, macdScore, bbScore, trendScore].filter(s => s > 0.1).length;
    const putVotes  = [rsiScore, macdScore, bbScore, trendScore].filter(s => s < -0.1).length;

    let signal, confidence;
    if (score > threshold) {
      signal = 'CALL'; confidence = this._normalize(score);
    } else if (score < -threshold) {
      signal = 'PUT';  confidence = this._normalize(score);
    } else if (callVotes >= 3) {
      signal = 'CALL'; confidence = Math.max(62, this._normalize(Math.abs(score) + 0.3));
    } else if (putVotes >= 3) {
      signal = 'PUT';  confidence = Math.max(62, this._normalize(Math.abs(score) + 0.3));
    } else {
      signal = 'WAIT'; confidence = 0;
    }

    confidence = Math.max(50, Math.min(97, confidence || 0));

    // ── Human-readable reason ──
    const parts = [];
    if (Math.abs(rsiScore) > 0.3)  parts.push(`RSI ${rsiVal.toFixed(0)} ${rsiScore > 0 ? 'oversold' : 'overbought'}`);
    if (Math.abs(macdScore) >= 0.9) parts.push(macdScore > 0 ? 'MACD bull cross' : 'MACD bear cross');
    else if (Math.abs(macdScore) > 0.5) parts.push(macdScore > 0 ? 'MACD rising' : 'MACD falling');
    if (Math.abs(bbScore) > 0.3)   parts.push(bbScore > 0 ? 'BB lower touch' : 'BB upper touch');
    if (trend !== 'mixed')         parts.push(trend.replace(/_/g, ' '));
    if (mtfScore >= 0.5)            parts.push('MTF ↑ aligned');
    else if (mtfScore <= -0.5)      parts.push('MTF ↓ aligned');
    if (vol.score > 0.5)           parts.push('volume spike');
    if (volScore < -0.3)           parts.push('⚠ low volatility');
    if (signal === 'WAIT')         parts.push(`score ${score.toFixed(2)} below threshold`);

    // Determine how many core indicators agree with signal
    const agree = signal === 'CALL' ? callVotes : signal === 'PUT' ? putVotes : 0;

    return {
      signal,
      confidence,
      score: parseFloat(score.toFixed(3)),
      reason: parts.join(' • ') || 'neutral — no edge',
      agree,
      indicators: {
        rsi:         parseFloat(rsiVal.toFixed(1)),
        macd:        parseFloat(macdData.macd.toFixed(8)),
        macdSignal:  parseFloat(macdData.signal.toFixed(8)),
        macdHist:    parseFloat(macdData.hist.toFixed(8)),
        prevMacd:    parseFloat(macdData.prevMacd.toFixed(8)),
        prevMacdSignal: parseFloat(macdData.prevSignal.toFixed(8)),
        bbUpper:     parseFloat(bb.upper.toFixed(6)),
        bbMiddle:    parseFloat(bb.middle.toFixed(6)),
        bbLower:     parseFloat(bb.lower.toFixed(6)),
        bbPct:       parseFloat(bb.pct.toFixed(4)),
        bbBandwidth: parseFloat(bb.bandwidth.toFixed(6)),
        trend,
        atr:         parseFloat(atrVal.toFixed(8)),
        stochK:      parseFloat(stoch.k.toFixed(1)),
        volumeScore: vol.score,
        price:       closes[closes.length - 1],
      },
      scores: { rsi: rsiScore, macd: macdScore, boll: bbScore, trend: trendScore, mtf: mtfScore, vol: volScore, volume: vol.score },
    };
  }

  _normalize(score) {
    return Math.round(60 + Math.tanh(score * 0.9) * 35);
  }

  _scoreRSI(rsi) {
    if (rsi <= 20) return  1.0;
    if (rsi <= 30) return  0.8;
    if (rsi <= 38) return  0.5;
    if (rsi <  47) return  0.2;
    if (rsi >= 80) return -1.0;
    if (rsi >= 70) return -0.8;
    if (rsi >= 62) return -0.5;
    if (rsi >  53) return -0.2;
    return 0;
  }

  _scoreMACD({ macd, signal, prevMacd, prevSignal }) {
    if (prevMacd < prevSignal && macd >= signal) return  1.0; // bull cross
    if (prevMacd > prevSignal && macd <= signal) return -1.0; // bear cross
    if (macd > signal && macd > prevMacd)        return  0.7; // bull growing
    if (macd < signal && macd < prevMacd)        return -0.7; // bear growing
    if (macd > signal)                           return  0.3;
    if (macd < signal)                           return -0.3;
    return 0;
  }

  _scoreBB({ pct, bandwidth }) {
    if (bandwidth < 0.003) return 0; // squeeze — no direction
    if (pct <= 0.05)  return  1.0;
    if (pct <= 0.15)  return  0.6;
    if (pct <= 0.28)  return  0.3;
    if (pct >= 0.95)  return -1.0;
    if (pct >= 0.85)  return -0.6;
    if (pct >= 0.72)  return -0.3;
    return 0;
  }

  _scoreTrend(trend) {
    return { strong_up: 1.0, up: 0.6, mixed: 0, down: -0.6, strong_down: -1.0 }[trend] || 0;
  }
}

module.exports = SignalEngine;
