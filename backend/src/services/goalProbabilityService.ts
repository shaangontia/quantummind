/**
 * goalProbabilityService.ts — Phase 21: Goal Probability Engine (deterministic v1)
 *
 * Calculates the probability that a portfolio will reach its target return
 * within the remaining investment horizon using a deterministic scoring approach.
 *
 * Version 1 is intentionally simple and explainable. Monte Carlo simulation
 * (Phase 23+) will replace this when sufficient trade history accumulates.
 *
 * IMPORTANT: When the target return is unrealistic given risk limits and horizon,
 * the system must say so clearly. "Impossible" targets should never show high probability.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoalProbabilityInput {
  currentNav:       number;
  initialCapital:   number;
  targetReturnPct:  number | null;
  horizonDays:      number | null;
  daysRemaining:    number | null;
  currentReturnPct: number;
  currentDrawdownPct: number;
  marketRegime:     string | null;  // 'BULL' | 'BEAR' | 'NEUTRAL' | etc.
  modelStage:       string | null;  // 'CANDIDATE' | 'SHADOW' | 'ADVISORY' | 'PRODUCTION'
  riskLevel:        'low' | 'medium' | 'high';
  coldStartMode:    boolean;
}

export interface GoalProbabilityResult {
  goalProbabilityPct:       number | null;
  requiredMonthlyReturnPct: number | null;
  requiredReturnFromHerePct: number | null;
  riskReasonCodes:          string[];
  impossible:               boolean;
  impossibilityReason:      string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

// ── Main function ─────────────────────────────────────────────────────────────

export function calculateGoalProbability(input: GoalProbabilityInput): GoalProbabilityResult {
  const {
    currentNav, initialCapital, targetReturnPct, horizonDays, daysRemaining,
    currentReturnPct, currentDrawdownPct, marketRegime, modelStage, coldStartMode,
  } = input;

  // Edge case: no target or no horizon
  if (!targetReturnPct || !horizonDays) {
    return {
      goalProbabilityPct: null, requiredMonthlyReturnPct: null, requiredReturnFromHerePct: null,
      riskReasonCodes: [], impossible: false, impossibilityReason: null,
    };
  }

  // Edge case: zero target (trivially achievable)
  if (targetReturnPct === 0) {
    return {
      goalProbabilityPct: 95, requiredMonthlyReturnPct: 0, requiredReturnFromHerePct: 0,
      riskReasonCodes: [], impossible: false, impossibilityReason: null,
    };
  }

  const targetNav = initialCapital * (1 + targetReturnPct / 100);

  // Already achieved
  if (currentNav >= targetNav) {
    return {
      goalProbabilityPct: 97, requiredMonthlyReturnPct: 0, requiredReturnFromHerePct: 0,
      riskReasonCodes: ['TARGET_ACHIEVED'], impossible: false, impossibilityReason: null,
    };
  }

  const navToUse   = Math.max(currentNav, initialCapital * 0.01); // prevent division by near-zero
  const remaining  = daysRemaining ?? horizonDays;

  // Horizon elapsed
  if (remaining <= 0) {
    return {
      goalProbabilityPct: 0, requiredMonthlyReturnPct: null, requiredReturnFromHerePct: null,
      riskReasonCodes: ['HORIZON_ELAPSED'], impossible: true, impossibilityReason: 'HORIZON_ELAPSED',
    };
  }

  const requiredReturnFromHerePct = ((targetNav / navToUse) - 1) * 100;
  const monthsRemaining = remaining / 30.44;
  const requiredMonthlyReturnPct = (Math.pow(targetNav / navToUse, 1 / monthsRemaining) - 1) * 100;

  // Impossibility check: > 15% monthly return is beyond realistic risk limits
  const MAX_REALISTIC_MONTHLY_RETURN = 15;
  if (requiredMonthlyReturnPct > MAX_REALISTIC_MONTHLY_RETURN) {
    return {
      goalProbabilityPct: Math.max(2, Math.round(100 / requiredMonthlyReturnPct)),
      requiredMonthlyReturnPct,
      requiredReturnFromHerePct,
      riskReasonCodes: ['REQUIRED_RETURN_VERY_HIGH', 'TARGET_NOT_ACHIEVABLE_WITHIN_RISK_LIMITS'],
      impossible: true,
      impossibilityReason: 'TARGET_NOT_ACHIEVABLE_WITHIN_RISK_LIMITS',
    };
  }

  // ── Deterministic scoring ─────────────────────────────────────────────────

  let baseProbability = 50;
  const riskReasonCodes: string[] = [];

  // Required monthly return adjustments (mutually exclusive brackets)
  if (requiredMonthlyReturnPct < 0.75) {
    baseProbability += 20;
    riskReasonCodes.push('REQUIRED_RETURN_LOW');
  } else if (requiredMonthlyReturnPct < 1.25) {
    baseProbability += 10;
    riskReasonCodes.push('REQUIRED_RETURN_MODERATE');
  } else if (requiredMonthlyReturnPct > 5.0) {
    baseProbability -= 40;
    riskReasonCodes.push('REQUIRED_RETURN_VERY_HIGH');
  } else if (requiredMonthlyReturnPct > 2.5) {
    baseProbability -= 20;
    riskReasonCodes.push('REQUIRED_RETURN_HIGH');
  }

  // Drawdown penalty
  if (currentDrawdownPct > 8) {
    baseProbability -= 15;
    riskReasonCodes.push('DRAWDOWN_ELEVATED');
  }

  // Market regime
  const regimeUpper = (marketRegime ?? '').toUpperCase();
  if (regimeUpper.includes('BULL')) {
    baseProbability += 10;
    riskReasonCodes.push('BULLISH_REGIME');
  } else if (regimeUpper.includes('BEAR')) {
    baseProbability -= 15;
    riskReasonCodes.push('BEARISH_REGIME');
  }

  // Model stage and cold-start penalties are about AI execution quality, not target difficulty.
  // When the target requires <0.75%/month, scale these penalties down — a trivially easy
  // target (e.g. 1% over 12m) does not depend on model maturity to be achievable.
  const targetDifficultyFactor = requiredMonthlyReturnPct < 0.75 ? 0.25
    : requiredMonthlyReturnPct < 1.25 ? 0.6
    : 1.0;

  if (modelStage === 'PRODUCTION') {
    baseProbability += 10;
    riskReasonCodes.push('MODEL_PRODUCTION');
  } else if (modelStage === 'CANDIDATE') {
    baseProbability -= Math.round(10 * targetDifficultyFactor);
    riskReasonCodes.push('MODEL_CANDIDATE');
  }

  // Cold start
  if (coldStartMode) {
    baseProbability -= Math.round(5 * targetDifficultyFactor);
    riskReasonCodes.push('COLD_START_ACTIVE');
  }

  // Negative current return — also scale by difficulty: if target is tiny, a small
  // negative return is barely meaningful vs the remaining runway.
  if (currentReturnPct < 0) {
    baseProbability -= Math.round(10 * targetDifficultyFactor);
    riskReasonCodes.push('NEGATIVE_RETURN');
  }

  // Very new portfolio — add INSUFFICIENT_HISTORY signal but still score normally.
  // A hard-coded 50% was incorrect: a 1% target over 12m requiring 0.15%/month
  // is trivially achievable and should show high probability even on day 1.
  // The cold-start and model-stage penalties already capture early-stage uncertainty.
  const elapsedDays = horizonDays - remaining;
  if (elapsedDays < 15) {
    riskReasonCodes.push('INSUFFICIENT_HISTORY');
  }

  return {
    goalProbabilityPct:       clamp(Math.round(baseProbability)),
    requiredMonthlyReturnPct: Math.round(requiredMonthlyReturnPct * 100) / 100,
    requiredReturnFromHerePct: Math.round(requiredReturnFromHerePct * 100) / 100,
    riskReasonCodes,
    impossible:               false,
    impossibilityReason:      null,
  };
}

export function calculateRequiredMonthlyReturn(params: {
  currentNav:      number;
  initialCapital:  number;
  targetReturnPct: number;
  daysRemaining:   number;
}): number | null {
  const { currentNav, initialCapital, targetReturnPct, daysRemaining } = params;
  if (daysRemaining <= 0) return null;
  const targetNav = initialCapital * (1 + targetReturnPct / 100);
  const months    = daysRemaining / 30.44;
  return (Math.pow(targetNav / Math.max(currentNav, 0.01), 1 / months) - 1) * 100;
}
