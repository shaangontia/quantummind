/**
 * portfolioUtilityScore.ts — Phase 19: Per-portfolio candidate utility scoring
 *
 * Replaces the global signal_score ranking in the BUY loop.
 * Each portfolio now gets its own ranked list of candidates based on a
 * portfolio-specific utility formula.
 *
 * Formula:
 *   portfolioUtility =
 *       expectedValuePct
 *     × strategyFitMultiplier
 *     × horizonFitMultiplier
 *     × regimeFitMultiplier
 *     − volatilityPenalty
 *     − drawdownPenalty
 *     − sectorConcentrationPenalty
 *     − liquidityPenalty
 *
 * The same stock may produce very different utility scores for different portfolios:
 *   - A high-volatility momentum stock scores high for HIGH_RISK_3M
 *   - The same stock scores low (or is ineligible) for LOW_RISK_24M
 *
 * This does NOT replace the eligibility filter — eligibility is a hard gate.
 * Utility scoring is only computed for eligible candidates.
 */

import type { PortfolioPolicy, StrategyTypeWeight } from './portfolioPolicy.js';
import type { StrategyType } from './strategyClassifier.js';
import type { PortfolioExposure } from './portfolioEligibilityFilter.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for utility computation — superset of eligibility input */
export interface CandidateUtilityInput {
  symbol: string;
  strategyType: StrategyType;
  evPct: number;                   // Expected value % (required for scoring)
  mlPwin: number | null;
  atrPct: number;                  // ATR as % of price
  liquidityScore: number;          // 0..1
  sector: string | null;
  expectedHoldingDays: number;     // estimated holding period for this setup
  marketRegime: string;
}

export interface UtilityComponents {
  expectedValuePct: number;
  strategyFitMultiplier: number;
  horizonFitMultiplier: number;
  regimeFitMultiplier: number;
  volatilityPenalty: number;
  drawdownPenalty: number;
  sectorConcentrationPenalty: number;
  liquidityPenalty: number;
  finalScore: number;
}

// ── Utility computation ───────────────────────────────────────────────────────

/**
 * Computes the portfolio utility score for a candidate.
 * Only call this for candidates that have PASSED the eligibility check.
 * Returns all components for storage in portfolio_policy_evaluations.
 */
export function computePortfolioUtility(
  candidate: CandidateUtilityInput,
  policy: PortfolioPolicy,
  exposure: PortfolioExposure,
): UtilityComponents {
  const ev = candidate.evPct;

  // ── Strategy fit multiplier ────────────────────────────────────────────────
  // Maps strategy type to portfolio's preferred weight, then scales to 0.1..1.9 range.
  // strategyWeights sum to 1.0 → multiply by 2 to get useful range.
  const strategyWeight = isValidStrategyWeight(candidate.strategyType)
    ? (policy.strategyWeights[candidate.strategyType] ?? 0.25)
    : 0.1; // UNKNOWN/MIXED get minimum weight
  const strategyFitMultiplier = Math.max(0.1, strategyWeight * 2);

  // ── Horizon fit multiplier ─────────────────────────────────────────────────
  // Reward setups whose expected holding period fits within policy's horizon.
  // Short horizon setup for a long-horizon portfolio → penalise.
  const horizonFitMultiplier = candidate.expectedHoldingDays <= policy.labelHorizonDays
    ? 1.1
    : Math.max(0.5, 1.1 - (candidate.expectedHoldingDays - policy.labelHorizonDays) / policy.labelHorizonDays * 0.6);

  // ── Regime fit multiplier ──────────────────────────────────────────────────
  const regimeFitMultiplier = policy.allowedRegimes.includes(candidate.marketRegime)
    ? 1.0
    : 0.6; // not a hard block (eligibility already checks this), but penalise boundary cases

  // ── Volatility penalty ─────────────────────────────────────────────────────
  // Higher aversion and higher ATR → larger penalty
  const volatilityPenalty = candidate.atrPct * policy.volatilityAversion;

  // ── Drawdown penalty ───────────────────────────────────────────────────────
  // If portfolio is already in drawdown, penalise adding new risk
  const drawdownPenalty = (exposure.drawdownPct ?? 0) * 0.15;

  // ── Sector concentration penalty ───────────────────────────────────────────
  // Smooth quadratic increase as sector approaches the cap
  let sectorConcentrationPenalty = 0;
  if (candidate.sector) {
    const sectorFrac = exposure.sectorPct[candidate.sector] ?? 0;
    const softLimit = policy.maxSectorExposure * 0.75; // start penalising at 75% of cap
    if (sectorFrac > softLimit) {
      sectorConcentrationPenalty = Math.pow((sectorFrac - softLimit) / (policy.maxSectorExposure - softLimit), 2) * 3;
    }
  }

  // ── Liquidity penalty ─────────────────────────────────────────────────────
  // Score < 0.5 = below ideal liquidity → scale penalty
  const liquidityPenalty = candidate.liquidityScore < 0.5
    ? (0.5 - candidate.liquidityScore) * 2
    : 0;

  // ── Final score ────────────────────────────────────────────────────────────
  const finalScore =
    ev
    * strategyFitMultiplier
    * horizonFitMultiplier
    * regimeFitMultiplier
    - volatilityPenalty
    - drawdownPenalty
    - sectorConcentrationPenalty
    - liquidityPenalty;

  return {
    expectedValuePct: ev,
    strategyFitMultiplier,
    horizonFitMultiplier,
    regimeFitMultiplier,
    volatilityPenalty,
    drawdownPenalty,
    sectorConcentrationPenalty,
    liquidityPenalty,
    finalScore,
  };
}

/**
 * Sort a list of candidates by utility score for a given portfolio policy.
 * Returns a new array sorted descending by finalScore.
 */
export function rankByUtility<T extends { utilityScore: number }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => b.utilityScore - a.utilityScore);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidStrategyWeight(st: StrategyType): st is StrategyTypeWeight {
  return st === 'MOMENTUM' || st === 'VALUE' || st === 'MEAN_REVERSION' || st === 'NEWS_CATALYST';
}

/**
 * Estimate expected holding days from strategy type.
 * Used when actual holding duration is not yet known at evaluation time.
 */
export function estimateHoldingDays(strategyType: StrategyType): number {
  switch (strategyType) {
    case 'MEAN_REVERSION': return 10;
    case 'NEWS_CATALYST':  return 7;
    case 'MOMENTUM':       return 25;
    case 'VALUE':          return 90;
    case 'MIXED':          return 20;
    case 'UNKNOWN':        return 15;
    default:               return 15;
  }
}
