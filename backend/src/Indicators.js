'use strict';

// Pure functions — no side effects, all return plain numbers/objects

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (gains += d) : (losses -= d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function ema(data, period) {
  if (!data.length) return 0;
  const k = 2 / (period + 1);
  let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

function macd(closes) {
  if (closes.length < 35) return { macd: 0, signal: 0, hist: 0, prevMacd: 0, prevSignal: 0 };
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
  let e12 = closes[0], e26 = closes[0];
  const macdLine = [];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) macdLine.push(e12 - e26);
  }
  let sig = macdLine[0];
  const sigLine = [sig];
  for (let i = 1; i < macdLine.length; i++) {
    sig = macdLine[i] * k9 + sig * (1 - k9);
    sigLine.push(sig);
  }
  const n = macdLine.length - 1;
  return {
    macd: macdLine[n],
    signal: sigLine[n],
    hist: macdLine[n] - sigLine[n],
    prevMacd: n > 0 ? macdLine[n - 1] : macdLine[n],
    prevSignal: n > 0 ? sigLine[n - 1] : sigLine[n],
  };
}

function bollingerBands(closes, period = 20, mult = 2) {
  const last = closes[closes.length - 1] || 0;
  if (closes.length < period) return { upper: last * 1.01, middle: last, lower: last * 0.99, pct: 0.5, bandwidth: 0.02 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const pct = upper !== lower ? (last - lower) / (upper - lower) : 0.5;
  return { upper, middle: mean, lower, pct, bandwidth: mean > 0 ? (upper - lower) / mean : 0 };
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stochastic(candles, period = 14) {
  if (candles.length < period) return { k: 50, d: 50 };
  const slice = candles.slice(-period);
  const hh = Math.max(...slice.map(c => c.h));
  const ll = Math.min(...slice.map(c => c.l));
  const last = slice[slice.length - 1].c;
  const k = hh !== ll ? ((last - ll) / (hh - ll)) * 100 : 50;
  return { k, d: k };
}

function trendStrength(candles, lookback = 5) {
  if (candles.length < lookback) return 'mixed';
  const last = candles.slice(-lookback);
  const greens = last.filter(c => c.c >= c.o).length;
  if (greens === 5) return 'strong_up';
  if (greens === 4) return 'up';
  if (greens === 1) return 'down';
  if (greens === 0) return 'strong_down';
  return 'mixed';
}

function volumeProfile(candles, lookback = 20) {
  if (candles.length < lookback) return { score: 0, avg: 0, last: 0 };
  const recent = candles.slice(-lookback).map(c => c.v || 0);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg === 0) return { score: 0, avg: 0, last: 0 };
  const lastVol = recent[recent.length - 1];
  const score = lastVol > avg * 1.5 ? 1.0 : lastVol > avg * 1.2 ? 0.5 : lastVol < avg * 0.7 ? -0.5 : 0;
  return { score, avg, last: lastVol };
}

function volatilityScore(candles, lookback = 20) {
  if (candles.length < lookback) return 0;
  const recent = candles.slice(-lookback);
  const ranges = recent.map(c => c.h - c.l);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastClose = recent[recent.length - 1].c;
  if (lastClose === 0) return 0;
  const pct = (avgRange / lastClose) * 100;
  if (pct < 0.02) return -0.8;
  if (pct > 2.5) return -0.5;
  if (pct >= 0.05 && pct <= 0.8) return 0.8;
  return 0.2;
}

function multiTimeframeScore(candles) {
  if (candles.length < 30) return 0;
  const c5 = candles.slice(-5);
  const c15 = candles.slice(-30, -5);
  const dir5 = c5[c5.length - 1].c > c5[0].c ? 1 : -1;
  const dir15 = c15[c15.length - 1].c > c15[0].c ? 1 : -1;
  return dir5 === dir15 ? 0.7 * dir5 : -0.3 * dir5;
}

module.exports = { rsi, ema, macd, bollingerBands, atr, stochastic, trendStrength, volumeProfile, volatilityScore, multiTimeframeScore };
