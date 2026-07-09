/**
 * riskClassifier.ts
 *
 * Derives a portfolio risk level from objective inputs rather than
 * requiring the user to self-classify. Weighted scoring across four signals:
 *
 *   Target Return %      — 35 pts  (primary intent signal)
 *   Investment Horizon   — 25 pts  (shorter = higher risk)
 *   Max Drawdown %       — 25 pts  (pain tolerance)
 *   Volatility Preference — 15 pts (stated comfort level)
 *
 * Score → Band:
 *   0–24  → Low
 *   25–49 → Medium
 *   50–74 → High
 *   75+   → Very High
 *
 * Users may override the derived label. The computed value is stored in
 * risk_tolerance; the override (if any) is stored in the same column.
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

  // ── Target Return (35 pts max) ────────────────────────────────────────────
  if (targetReturnPct < 10) {
    score += 5;
    factors.push(`conservative return target (${targetReturnPct}%)`);
  } else if (targetReturnPct < 20) {
    score += 15;
    factors.push(`moderate return target (${targetReturnPct}%)`);
  } else if (targetReturnPct < 50) {
    score += 25;
    factors.push(`aggressive return target (${targetReturnPct}%)`);
  } else {
    score += 35;
    factors.push(`very aggressive return target (${targetReturnPct}%)`);
  }

  // ── Investment Horizon (25 pts max) — shorter = higher score ─────────────
  if (investmentHorizonMonths > 60) {
    score += 5;
    factors.push(`long horizon (${investmentHorizonMonths}m)`);
  } else if (investmentHorizonMonths > 36) {
    score += 10;
    factors.push(`medium-long horizon (${investmentHorizonMonths}m)`);
  } else if (investmentHorizonMonths > 12) {
    score += 18;
    factors.push(`medium horizon (${investmentHorizonMonths}m)`);
  } else {
    score += 25;
    factors.push(`short horizon (${investmentHorizonMonths}m)`);
  }

  // ── Max Drawdown Tolerance (25 pts max) ───────────────────────────────────
  if (maxDrawdownPct < 10) {
    score += 5;
    factors.push(`low drawdown tolerance (${maxDrawdownPct}%)`);
  } else if (maxDrawdownPct < 20) {
    score += 12;
    factors.push(`moderate drawdown tolerance (${maxDrawdownPct}%)`);
  } else if (maxDrawdownPct < 35) {
    score += 20;
    factors.push(`high drawdown tolerance (${maxDrawdownPct}%)`);
  } else {
    score += 25;
    factors.push(`very high drawdown tolerance (${maxDrawdownPct}%)`);
  }

  // ── Volatility Preference (15 pts max) ───────────────────────────────────
  const vpMap: Record<string, number> = { low: 2, medium: 7, high: 12, 'very high': 15 };
  const vpScore = vpMap[(volatilityPreference ?? 'medium').toLowerCase()] ?? 7;
  score += vpScore;
  if (volatilityPreference) factors.push(`${volatilityPreference} volatility preference`);

  // ── Band ──────────────────────────────────────────────────────────────────
  let level: RiskLevel;
  if (score < 25)      level = 'Low';
  else if (score < 50) level = 'Medium';
  else if (score < 75) level = 'High';
  else                  level = 'Very High';

  const explanation = `Classified as ${level} based on: ${factors.join(', ')}.`;

  return { level, score, explanation };
}
