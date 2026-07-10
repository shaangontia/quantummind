/**
 * riskClassifier.ts
 *
 * Derives a portfolio risk level from objective inputs rather than
 * requiring the user to self-classify. Weighted scoring across four signals:
 *
 *   Target Return %       — 45 pts  (primary intent signal — dominant weight)
 *   Investment Horizon    — 20 pts  (shorter = higher risk)
 *   Max Drawdown %        — 20 pts  (pain tolerance — capped for conservative targets)
 *   Volatility Preference — 15 pts  (stated comfort level — capped for conservative targets)
 *
 * Consistency guard: very conservative return targets (<5%, <15%) cap the
 * effective drawdown and volatility contributions so that a 1%-return
 * portfolio accepting 20% drawdown is not mis-classified as Medium simply
 * because of an internally inconsistent drawdown setting.
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

  // ── Max Drawdown Tolerance (20 pts max — with consistency guard) ──────────
  // A portfolio targeting <5% return accepting 20% drawdown is internally
  // inconsistent. Cap the effective drawdown so the classification reflects
  // the return intent, not an accidental mismatch in settings.
  const effectiveDrawdown =
    targetReturnPct < 5  ? Math.min(maxDrawdownPct, 10) :   // very conservative: max 10%
    targetReturnPct < 15 ? Math.min(maxDrawdownPct, 20) :   // moderate: max 20%
    maxDrawdownPct;                                           // aggressive: use as stated

  if (effectiveDrawdown < 10) {
    score += 2;
    factors.push(`low drawdown tolerance (${effectiveDrawdown}%)`);
  } else if (effectiveDrawdown < 20) {
    score += 6;
    factors.push(`moderate drawdown tolerance (${effectiveDrawdown}%)`);
  } else if (effectiveDrawdown < 35) {
    score += 12;
    factors.push(`high drawdown tolerance (${effectiveDrawdown}%)`);
  } else {
    score += 20;
    factors.push(`very high drawdown tolerance (${effectiveDrawdown}%)`);
  }

  // ── Volatility Preference (15 pts max — with consistency guard) ───────────
  const vpRaw = (volatilityPreference ?? 'medium').toLowerCase();
  const vpMap: Record<string, number> = { low: 2, medium: 5, high: 10, 'very high': 15 };
  let vpScore = vpMap[vpRaw] ?? 5;

  // Consistency guard: a sub-5% return target should not be penalised for
  // a stated preference that is higher than medium (inconsistent intent).
  if (targetReturnPct < 5 && vpScore > 5) {
    vpScore = 5;
    factors.push(`${volatilityPreference} volatility preference (capped — target <5%)`);
  } else if (volatilityPreference) {
    factors.push(`${volatilityPreference} volatility preference`);
  }
  score += vpScore;

  // ── Band ──────────────────────────────────────────────────────────────────
  let level: RiskLevel;
  if (score < 20)      level = 'Low';
  else if (score < 40) level = 'Medium';
  else if (score < 60) level = 'High';
  else                  level = 'Very High';

  const explanation = `Classified as ${level} based on: ${factors.join(', ')}.`;

  return { level, score, explanation };
}
