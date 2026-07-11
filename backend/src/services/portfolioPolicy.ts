/**
 * portfolioPolicy.ts — Phase 19: Portfolio policy profiles
 *
 * Derives a PortfolioPolicy from the portfolio's existing DB fields.
 * No new DB column needed — policy type is computed at runtime and
 * snapshotted in portfolio_policy_evaluations for audit integrity.
 *
 * Policy types:
 *   LOW_RISK_24M     — conservative, long-horizon, value/quality focus
 *   MEDIUM_RISK_12M  — balanced, 6–18 month horizon
 *   HIGH_RISK_3M     — aggressive, short-term, momentum/news focus
 *   VALUE_LONG       — fundamental quality, long-horizon (growth goal)
 *   MOMENTUM_SWING   — high-risk but longer horizon, swing/momentum focus
 *   AGGRESSIVE_SHORT — very high return target, short horizon
 *
 * IMPORTANT: every portfolio_policy_evaluations row stores a policy_snapshot_json
 * so that historical evaluations are never reinterpreted if portfolio settings change.
 */

import { queryOne } from '../db/turso.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PolicyType =
  | 'LOW_RISK_24M'
  | 'MEDIUM_RISK_12M'
  | 'HIGH_RISK_3M'
  | 'VALUE_LONG'
  | 'MOMENTUM_SWING'
  | 'AGGRESSIVE_SHORT';

export type StrategyTypeWeight = 'MOMENTUM' | 'VALUE' | 'MEAN_REVERSION' | 'NEWS_CATALYST';

export type NegativeEpsPolicy = 'VETO' | 'PENALTY' | 'ALLOW_WITH_RISK' | 'BANK_EXCEPTION';

export interface PortfolioPolicy {
  policyType: PolicyType;
  policyVersion: string;                            // bump when derivation rules change
  strategyWeights: Record<StrategyTypeWeight, number>; // must sum to 1.0
  labelHorizonDays: number;                         // 15 | 30 | 60 | 120
  minFundamentalScore: number;                      // 0–100
  maxAtrPct: number;                                // ATR as % of price
  minLiquidityScore: number;                        // 0–1
  maxBeta: number;
  volatilityAversion: number;                       // 0..1 — multiplied into volatility penalty
  allowedStrategyTypes: StrategyTypeWeight[];
  allowedRegimes: string[];                         // 'BULL' | 'NEUTRAL' | 'BEAR'
  minPwin: number;                                  // only enforced when model stage >= ADVISORY
  evThresholdPct: number;                           // only enforced when model stage >= ADVISORY
  maxSectorExposure: number;                        // 0..1 fraction of NAV
  negativeEpsPolicy: NegativeEpsPolicy;
}

// ── Policy version — bump when derivation rules change ───────────────────────
export const POLICY_VERSION = 'v1';

// ── Policy definitions ───────────────────────────────────────────────────────

const POLICY_DEFINITIONS: Record<PolicyType, Omit<PortfolioPolicy, 'policyType' | 'policyVersion'>> = {
  LOW_RISK_24M: {
    strategyWeights:    { VALUE: 0.45, MOMENTUM: 0.35, MEAN_REVERSION: 0.10, NEWS_CATALYST: 0.10 },
    labelHorizonDays:   120,
    minFundamentalScore: 70,
    maxAtrPct:           3.0,
    minLiquidityScore:   0.7,
    maxBeta:             1.0,
    volatilityAversion:  0.8,
    allowedStrategyTypes: ['VALUE', 'MOMENTUM'],
    allowedRegimes:      ['BULL', 'NEUTRAL'],
    minPwin:             0.60,
    evThresholdPct:      1.5,
    maxSectorExposure:   0.30,
    negativeEpsPolicy:  'VETO',
  },

  MEDIUM_RISK_12M: {
    strategyWeights:    { MOMENTUM: 0.35, VALUE: 0.35, MEAN_REVERSION: 0.20, NEWS_CATALYST: 0.10 },
    labelHorizonDays:   60,
    minFundamentalScore: 55,
    maxAtrPct:           5.0,
    minLiquidityScore:   0.5,
    maxBeta:             1.3,
    volatilityAversion:  0.5,
    allowedStrategyTypes: ['MOMENTUM', 'VALUE', 'MEAN_REVERSION', 'NEWS_CATALYST'],
    allowedRegimes:      ['BULL', 'NEUTRAL'],
    minPwin:             0.54,
    evThresholdPct:      1.0,
    maxSectorExposure:   0.35,
    negativeEpsPolicy:  'PENALTY',
  },

  HIGH_RISK_3M: {
    strategyWeights:    { MOMENTUM: 0.40, NEWS_CATALYST: 0.30, MEAN_REVERSION: 0.20, VALUE: 0.10 },
    labelHorizonDays:   30,
    minFundamentalScore: 40,
    maxAtrPct:           9.0,
    minLiquidityScore:   0.4,
    maxBeta:             1.8,
    volatilityAversion:  0.2,
    allowedStrategyTypes: ['MOMENTUM', 'NEWS_CATALYST', 'MEAN_REVERSION', 'VALUE'],
    allowedRegimes:      ['BULL', 'NEUTRAL', 'BEAR'],
    minPwin:             0.52,
    evThresholdPct:      1.0,
    maxSectorExposure:   0.40,
    negativeEpsPolicy:  'ALLOW_WITH_RISK',
  },

  VALUE_LONG: {
    strategyWeights:    { VALUE: 0.55, MOMENTUM: 0.30, MEAN_REVERSION: 0.10, NEWS_CATALYST: 0.05 },
    labelHorizonDays:   120,
    minFundamentalScore: 72,
    maxAtrPct:           3.5,
    minLiquidityScore:   0.6,
    maxBeta:             1.1,
    volatilityAversion:  0.7,
    allowedStrategyTypes: ['VALUE', 'MOMENTUM'],
    allowedRegimes:      ['BULL', 'NEUTRAL'],
    minPwin:             0.58,
    evThresholdPct:      1.3,
    maxSectorExposure:   0.30,
    negativeEpsPolicy:  'VETO',
  },

  MOMENTUM_SWING: {
    strategyWeights:    { MOMENTUM: 0.50, NEWS_CATALYST: 0.25, MEAN_REVERSION: 0.15, VALUE: 0.10 },
    labelHorizonDays:   30,
    minFundamentalScore: 45,
    maxAtrPct:           7.0,
    minLiquidityScore:   0.5,
    maxBeta:             1.6,
    volatilityAversion:  0.3,
    allowedStrategyTypes: ['MOMENTUM', 'NEWS_CATALYST', 'MEAN_REVERSION'],
    allowedRegimes:      ['BULL', 'NEUTRAL'],
    minPwin:             0.53,
    evThresholdPct:      1.0,
    maxSectorExposure:   0.38,
    negativeEpsPolicy:  'PENALTY',
  },

  AGGRESSIVE_SHORT: {
    strategyWeights:    { MOMENTUM: 0.45, NEWS_CATALYST: 0.30, MEAN_REVERSION: 0.20, VALUE: 0.05 },
    labelHorizonDays:   15,
    minFundamentalScore: 35,
    maxAtrPct:           10.0,
    minLiquidityScore:   0.45,
    maxBeta:             2.0,
    volatilityAversion:  0.15,
    allowedStrategyTypes: ['MOMENTUM', 'NEWS_CATALYST', 'MEAN_REVERSION', 'VALUE'],
    allowedRegimes:      ['BULL', 'NEUTRAL', 'BEAR'],
    minPwin:             0.52,
    evThresholdPct:      0.8,
    maxSectorExposure:   0.45,
    negativeEpsPolicy:  'ALLOW_WITH_RISK',
  },
};

// ── Policy derivation ─────────────────────────────────────────────────────────

/**
 * Derives the PortfolioPolicy from a portfolio's stored fields.
 * Uses risk_tolerance + investment_horizon_months + target_return_pct + investment_goal.
 *
 * Rules applied in priority order — first match wins.
 */
export function derivePolicy(portfolio: {
  risk_tolerance: string | null;
  investment_horizon_months: number | null;
  target_return_pct: number | null;
  investment_goal: string | null;
  volatility_preference: string | null;
}): PortfolioPolicy {
  const risk      = (portfolio.risk_tolerance ?? 'medium').toLowerCase();
  const horizon   = portfolio.investment_horizon_months ?? 12;
  const target    = portfolio.target_return_pct ?? 15;
  const goal      = (portfolio.investment_goal ?? 'growth').toLowerCase();
  const volPref   = (portfolio.volatility_preference ?? 'medium').toLowerCase();

  let policyType: PolicyType;

  if (target >= 35 && horizon <= 6) {
    policyType = 'AGGRESSIVE_SHORT';
  } else if (risk === 'high' && horizon <= 6) {
    policyType = 'HIGH_RISK_3M';
  } else if (risk === 'high' && horizon > 6) {
    policyType = 'MOMENTUM_SWING';
  } else if (risk === 'low' && horizon >= 18) {
    policyType = 'LOW_RISK_24M';
  } else if ((goal === 'growth' || goal === 'retirement') && horizon >= 18 && volPref === 'low') {
    policyType = 'VALUE_LONG';
  } else if (risk === 'medium' || (risk === 'low' && horizon < 18)) {
    policyType = 'MEDIUM_RISK_12M';
  } else {
    policyType = 'MEDIUM_RISK_12M'; // safe default
  }

  return {
    policyType,
    policyVersion: POLICY_VERSION,
    ...POLICY_DEFINITIONS[policyType],
  };
}

/**
 * Loads a portfolio from DB and returns its derived policy.
 * The returned policy should be snapshotted (JSON.stringify) into
 * portfolio_policy_evaluations.policy_snapshot_json at evaluation time.
 */
export async function getPortfolioPolicy(portfolioId: number): Promise<PortfolioPolicy> {
  const row = await queryOne(
    `SELECT risk_tolerance, investment_horizon_months, target_return_pct, investment_goal, volatility_preference
     FROM portfolios WHERE id = ?`,
    [portfolioId],
  );
  if (!row) throw new Error(`Portfolio ${portfolioId} not found`);
  return derivePolicy(row as {
    risk_tolerance: string | null;
    investment_horizon_months: number | null;
    target_return_pct: number | null;
    investment_goal: string | null;
    volatility_preference: string | null;
  });
}

/**
 * Returns a stable JSON snapshot of the policy for storage in
 * portfolio_policy_evaluations.policy_snapshot_json.
 * Changing portfolio settings later does NOT retroactively change stored snapshots.
 */
export function snapshotPolicy(policy: PortfolioPolicy): string {
  return JSON.stringify({
    policyType:          policy.policyType,
    policyVersion:       policy.policyVersion,
    strategyWeights:     policy.strategyWeights,
    labelHorizonDays:    policy.labelHorizonDays,
    minFundamentalScore: policy.minFundamentalScore,
    maxAtrPct:           policy.maxAtrPct,
    minLiquidityScore:   policy.minLiquidityScore,
    maxBeta:             policy.maxBeta,
    volatilityAversion:  policy.volatilityAversion,
    allowedStrategyTypes: policy.allowedStrategyTypes,
    allowedRegimes:      policy.allowedRegimes,
    minPwin:             policy.minPwin,
    evThresholdPct:      policy.evThresholdPct,
    maxSectorExposure:   policy.maxSectorExposure,
    negativeEpsPolicy:   policy.negativeEpsPolicy,
  });
}
