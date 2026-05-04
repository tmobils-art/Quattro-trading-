'use strict';

class LearningEngine {
  constructor() {
    this.weights = { trend: 1.0, rsi: 1.0, macd: 1.0, boll: 1.0 };
    this.threshold = 0.5;
    this.history = [];
    this.factorAccuracy = {};
    this.recentResults = [];
  }

  getWeights() { return { ...this.weights }; }
  getThreshold() { return this.threshold; }

  recordResult(result, indicatorPerformance = {}, pnl = 0) {
    const wasWin = result === 'WIN';
    this.history.unshift({ result, time: Date.now(), pnl, indicatorPerformance });
    if (this.history.length > 50) this.history.pop();

    this.recentResults.unshift(wasWin ? 'W' : 'L');
    if (this.recentResults.length > 10) this.recentResults.pop();

    for (const [factor, wasCorrect] of Object.entries(indicatorPerformance)) {
      if (!this.factorAccuracy[factor]) this.factorAccuracy[factor] = { correct: 0, total: 0 };
      this.factorAccuracy[factor].total++;
      if (wasCorrect) this.factorAccuracy[factor].correct++;
    }

    const lr = 0.05, bigLr = 0.10;
    for (const factor of ['trend', 'rsi', 'macd', 'boll']) {
      if (indicatorPerformance[factor] === undefined) continue;
      const correct = indicatorPerformance[factor];
      const rate = correct ? lr : bigLr;
      if (correct) {
        this.weights[factor] += rate * (2 - this.weights[factor]) * 0.5;
      } else {
        this.weights[factor] -= rate * this.weights[factor] * 0.5;
      }
      this.weights[factor] = Math.max(0.3, Math.min(2.0, this.weights[factor]));
    }

    if (this.recentResults.length >= 5) {
      const wins = this.recentResults.filter(r => r === 'W').length;
      const wr = wins / this.recentResults.length;
      if (wr < 0.4) {
        this.threshold = Math.min(2.0, this.threshold + 0.1);
      } else if (wr >= 0.65 && this.threshold > 0.4) {
        this.threshold = Math.max(0.4, this.threshold - 0.05);
      }
    }

    return this.getStats();
  }

  getStats() {
    const wins = this.history.filter(h => h.result === 'WIN').length;
    const losses = this.history.filter(h => h.result === 'LOSS').length;
    const total = wins + losses;
    return {
      wins,
      losses,
      total,
      winRate: total > 0 ? parseFloat((wins / total).toFixed(3)) : 0,
      consecutiveLosses: this.getConsecutiveLosses(),
      recentResults: this.recentResults.slice(),
      factorAccuracy: this.getFactorAccuracySummary(),
    };
  }

  getConsecutiveLosses() {
    let count = 0;
    for (const r of this.history) {
      if (r.result === 'LOSS') count++;
      else break;
    }
    return count;
  }

  getFactorAccuracySummary() {
    const out = {};
    for (const [k, v] of Object.entries(this.factorAccuracy)) {
      if (v.total < 2) continue;
      out[k] = { correct: v.correct, total: v.total, rate: parseFloat((v.correct / v.total).toFixed(3)) };
    }
    return out;
  }
}

module.exports = LearningEngine;
