/**
 * riskClassifier.ts
 *
 * Derives a portfolio risk level from objective inputs rather than
 * requiring the user to self-classify. Weighted scoring across four signals:
 *
 *   Target Return %       — 45 pts  (primary intent signal — dominant weight)
 *   Investment Horizon    — 20 pts  (shorter = higher risk)
 *   Max Drawdown %        — 20 pts  (pain tolerance)
 *   Volatility Preference — 15 pts  (stated comfort level)
 *
 * Score → Band:
 *   0–19  → Low
 *   20–39 → Medium
 *   40–59 → High
 *   60+   → Very High
 *
 * The computed value is stored in risk_tolerance.
 */

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Very High';

export interface RiskClassifierInput {
  targetReturnPct?: number;
  investmentHorizonMonths?: number;
  maxDrawdownPct?: number;
  volatilityPreference?: string;
}

/**
 * Derive a risk level from portfolio inputs.
 * Falls back to 'Medium' if no inputs are provided.
 */
export function deriveRiskLevel(inputs: RiskClassifierInput): { level: RiskLevel; score: number; explanation: string } {
  const {
    targetReturnPct = 15,
    investmentHorizonMonths = 12,
    maxDrawdownPct = 20,
    volatilityPreference,
  } = inputs;

  let score = 0;
  const factors: string[] = [];

  // ── Target Return (45 pts max) — primary intent signal ───────────────────
  if (targetReturnPct < 10) {
    score += 5;
    factors.push(`conservative return target (${targetReturnPct}%)`);
  } else if (targetReturnPct < 20) {
    score += 15;
    factors.push(`moderate return target (${targetReturnPct}%)`);
  } else if (targetReturnPct < 40) {
    score += 28;
    factors.push(`aggressive return target (${targetReturnPct}%)`);
  } else if (targetReturnPct < 60) {
    score += 38;
    factors.push(`very aggressive return target (${targetReturnPct}%)`);
  } else {
    score += 45;
    factors.push(`extreme return target (${targetReturnPct}%)`);
  }

  // ── Investment Horizon (20 pts max) — shorter = higher score ─────────────
  // >=60m=long, 24–59m=medium-long, 6–23m=medium, <6m=short
  if (investmentHorizonMonths >= 60) {
    score += 2;
    factors.push(`long horizon (${investmentHorizonMonths}m)`);
  } else if (investmentHorizonMonths >= 24) {
    score += 6;
    factors.push(`medium-long horizon (${investmentHorizonMonths}m)`);
  } else if (investmentHorizonMonths >= 6) {
    score += 12;
    factors.push(`medium horizon (${investmentHorizonMonths}m)`);
  } else {
    score += 20;
    factors.push(`short horizon (${investmentHorizonMonths}m)`);
  }

  // ── Max Drawdown Tolerance (20 pts max) ───────────────────────────────────
  if (maxDrawdownPct < 10) {
    score += 2;
    factors.push(`low drawdown tolerance (${maxDrawdownPct}%)`);
  } else if (maxDrawdownPct < 20) {
    score += 6;
    factors.push(`moderate drawdown tolerance (${maxDrawdownPct}%)`);
  } else if (maxDrawdownPct < 35) {
    score += 12;
    factors.push(`high drawdown tolerance (${maxDrawdownPct}%)`);
  } else {
    score += 20;
    factors.push(`very high drawdown tolerance (${maxDrawdownPct}%)`);
  }

  // ── Volatility Preference (15 pts max) ───────────────────────────────────
  const vpMap: Record<string, number> = { low: 2, medium: 5, high: 10, 'very high': 15 };
  const vpScore = vpMap[(volatilityPreference ?? 'medium').toLowerCase()] ?? 5;
  score += vpScore;
  if (volatilityPreference) factors.push(`${volatilityPreference} volatility preference`);

  // ── Band ──────────────────────────────────────────────────────────────────
  let level: RiskLevel;
  if (score < 20)      level = 'Low';
  else if (score < 40) level = 'Medium';
  else if (score < 60) level = 'High';
  else                  level = 'Very High';

  const explanation = `Classified as ${level} based on: ${factors.join(', ')}.`;

  return { level, score, explanation };
}
