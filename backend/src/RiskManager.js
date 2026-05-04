'use strict';

class RiskManager {
  /**
   * Returns the recommended position size in dollars.
   * Returns 0 when trading should stop (3+ consecutive losses).
   */
  calculatePositionSize(balance, baseStake, confidence, consecutiveLosses) {
    if (consecutiveLosses >= 3) return 0;

    let riskPct = 0.01; // base 1% of balance

    if (confidence >= 88) riskPct = 0.018;
    else if (confidence >= 80) riskPct = 0.013;
    else if (confidence >= 70) riskPct = 0.010;
    else riskPct = 0.005; // sub-70% confidence — half size

    if (consecutiveLosses === 2) riskPct *= 0.5;
    else if (consecutiveLosses === 1) riskPct *= 0.75;

    const position = balance * riskPct;
    const cap = Math.min(baseStake * 3, balance * 0.02); // never more than 2% or 3× base
    return Math.min(position, cap);
  }

  /**
   * Kelly-criterion suggestion (informational, not enforced).
   * f* = (bp - q) / b  where b = net_payout, p = winRate, q = 1 - p
   */
  kellyFraction(winRate, payoutPct) {
    const b = payoutPct / 100;
    const p = winRate;
    const q = 1 - p;
    if (b === 0) return 0;
    const f = (b * p - q) / b;
    return Math.max(0, Math.min(f, 0.05)); // cap at 5%
  }

  assessRisk(consecutiveLosses, confidence, agree) {
    if (consecutiveLosses >= 3) return { level: 'STOP', color: '#ff2d55', maxMult: 0 };
    if (consecutiveLosses >= 2) return { level: 'PAUSE', color: '#ff2d55', maxMult: 0 };
    if (confidence >= 85 && agree >= 3) return { level: 'STRONG', color: '#00ff9d', maxMult: 5 };
    if (confidence >= 78 && agree >= 3) return { level: 'GOOD', color: '#00ff9d', maxMult: 3 };
    if (confidence >= 70) return { level: 'MODERATE', color: '#f5b93a', maxMult: 2 };
    return { level: 'WEAK', color: '#ff2d55', maxMult: 1 };
  }
}

module.exports = RiskManager;
