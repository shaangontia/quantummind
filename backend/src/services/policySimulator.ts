/**
 * policySimulator.ts — Phase 19: Historical policy simulation
 *
 * Replays historical trade_candidates through all 6 portfolio policy types
 * WITHOUT creating fake portfolios. Stores evaluations with:
 *   data_source = 'POLICY_SIMULATION'
 *   portfolio_id = -1  (sentinel — no real portfolio)
 *
 * CRITICAL:
 *   POLICY_SIMULATION rows MUST NEVER enter production ML training.
 *   The ML training query in mlProbabilityModel.ts explicitly filters:
 *     WHERE data_source IN ('LIVE_PAPER', 'LIVE_REAL')
 *
 * Use policy simulation for:
 *   - Bootstrapping portfolio differentiation analysis
 *   - Comparing policy behaviour against the same historical opportunity set
 *   - Validating that eligibility filters produce meaningfully different candidate sets
 *
 * NOT for:
 *   - Training the production ML model
 *   - Generating signals for live portfolios
 */

import { query, run } from '../db/turso.js';
import {
  POLICY_VERSION,
  snapshotPolicy,
  derivePolicy,
  type PolicyType,
} from './portfolioPolicy.js';
import { checkEligibility, type CandidateEligibilityInput, type PortfolioExposure } from './portfolioEligibilityFilter.js';
import { computePortfolioUtility, estimateHoldingDays, type CandidateUtilityInput } from './portfolioUtilityScore.js';
import { storePolicyEvaluation } from './policyEvaluationStore.js';

// ── All policy configurations for simulation ──────────────────────────────────

/** Synthetic portfolio specs representing each policy type */
const SIMULATION_POLICY_SPECS: Array<{
  policyType: PolicyType;
  portfolioSpec: {
    risk_tolerance: string;
    investment_horizon_months: number;
    target_return_pct: number;
    investment_goal: string;
    volatility_preference: string;
  };
}> = [
  {
    policyType: 'LOW_RISK_24M',
    portfolioSpec: { risk_tolerance: 'low', investment_horizon_months: 24, target_return_pct: 12, investment_goal: 'retirement', volatility_preference: 'low' },
  },
  {
    policyType: 'MEDIUM_RISK_12M',
    portfolioSpec: { risk_tolerance: 'medium', investment_horizon_months: 12, target_return_pct: 18, investment_goal: 'growth', volatility_preference: 'medium' },
  },
  {
    policyType: 'HIGH_RISK_3M',
    portfolioSpec: { risk_tolerance: 'high', investment_horizon_months: 3, target_return_pct: 25, investment_goal: 'growth', volatility_preference: 'high' },
  },
  {
    policyType: 'VALUE_LONG',
    portfolioSpec: { risk_tolerance: 'low', investment_horizon_months: 24, target_return_pct: 15, investment_goal: 'growth', volatility_preference: 'low' },
  },
  {
    policyType: 'MOMENTUM_SWING',
    portfolioSpec: { risk_tolerance: 'high', investment_horizon_months: 9, target_return_pct: 28, investment_goal: 'growth', volatility_preference: 'high' },
  },
  {
    policyType: 'AGGRESSIVE_SHORT',
    portfolioSpec: { risk_tolerance: 'high', investment_horizon_months: 3, target_return_pct: 40, investment_goal: 'growth', volatility_preference: 'high' },
  },
];

// Sentinel portfolio_id for simulated evaluations (no real portfolio)
const SIMULATION_PORTFOLIO_ID = -1;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolicySimulationOptions {
  fromDate: string;    // ISO date: 'YYYY-MM-DD'
  toDate: string;      // ISO date: 'YYYY-MM-DD'
  policies?: PolicyType[];  // subset to run; defaults to all 6
  dryRun?: boolean;    // compute but do not insert
}

export interface PolicySimulationSummary {
  candidatesProcessed: number;
  evaluationsInserted: number;
  byPolicyType: Record<PolicyType, {
    eligible: number;
    ineligible: number;
    topRejectionReason: string | null;
  }>;
}

// ── Main simulation ───────────────────────────────────────────────────────────

/**
 * Run historical trade_candidates through all (or specified) policy types.
 * Stores results as POLICY_SIMULATION data_source — never used in production training.
 */
export async function runPolicySimulation(
  options: PolicySimulationOptions,
): Promise<PolicySimulationSummary> {
  const { fromDate, toDate, policies, dryRun = false } = options;
  const targetPolicies = policies ?? SIMULATION_POLICY_SPECS.map(s => s.policyType);

  // Load historical candidates with FINAL labels in the date range
  const candidates = await query(
    `SELECT tc.*
     FROM trade_candidates tc
     WHERE tc.evaluated_at >= ?
       AND tc.evaluated_at <= ?
       AND tc.label_status = 'FINAL'
       AND tc.strategy_type IS NOT NULL
       AND tc.strategy_type != 'UNKNOWN'
     ORDER BY tc.evaluated_at ASC
     LIMIT 5000`,
    [fromDate, toDate],
  ).catch(() => []);

  const summary: PolicySimulationSummary = {
    candidatesProcessed: candidates.length,
    evaluationsInserted: 0,
    byPolicyType: {} as Record<PolicyType, { eligible: number; ineligible: number; topRejectionReason: string | null }>,
  };

  // Initialise summary buckets
  for (const pt of targetPolicies) {
    summary.byPolicyType[pt] = { eligible: 0, ineligible: 0, topRejectionReason: null };
  }

  const rejectionCounts: Record<PolicyType, Record<string, number>> = {} as any;
  for (const pt of targetPolicies) rejectionCounts[pt] = {};

  // Empty exposure (historical simulation — no live portfolio state)
  const exposure: PortfolioExposure = {
    sectorPct:            {},
    currentPositionCount: 0,
    cashPct:              1.0,
    drawdownPct:          0,
  };

  for (const candidate of candidates) {
    for (const spec of SIMULATION_POLICY_SPECS) {
      if (!targetPolicies.includes(spec.policyType)) continue;

      const policy = derivePolicy(spec.portfolioSpec);

      const eligInput: CandidateEligibilityInput = {
        symbol:            candidate.symbol,
        strategyType:      (candidate.strategy_type ?? 'UNKNOWN') as any,
        fundamentalScore:  candidate.fundamental_score != null ? Number(candidate.fundamental_score) : null,
        atrPct:            candidate.atr_pct != null ? Number(candidate.atr_pct) : null,
        beta:              null, // not stored in trade_candidates currently
        liquidityScore:    null, // not stored; skip liquidity gate
        sector:            null, // sector not stored in trade_candidates; skip sector gate
        eps:               null, // not stored; skip EPS gate
        mlPwin:            candidate.prediction_pwin != null ? Number(candidate.prediction_pwin) : null,
        evPct:             null, // not stored per-candidate currently
        marketRegime:      candidate.market_regime ?? 'UNKNOWN',
      };

      const eligResult = checkEligibility(eligInput, policy, exposure, 'PRODUCTION');

      let utilityScore: number | null = null;
      let utilComponents = null;

      if (eligResult.eligible && candidate.entry_price) {
        const utilInput: CandidateUtilityInput = {
          symbol:               candidate.symbol,
          strategyType:         (candidate.strategy_type ?? 'UNKNOWN') as any,
          evPct:                Number(candidate.prediction_pwin ?? 0.52) * 2 - 1, // rough EV proxy
          mlPwin:               candidate.prediction_pwin != null ? Number(candidate.prediction_pwin) : null,
          atrPct:               candidate.atr_pct != null ? Number(candidate.atr_pct) : 2.0,
          liquidityScore:       0.6, // assume average liquidity for historical sim
          sector:               null,
          expectedHoldingDays:  estimateHoldingDays((candidate.strategy_type ?? 'UNKNOWN') as any),
          marketRegime:         candidate.market_regime ?? 'UNKNOWN',
        };
        utilComponents = computePortfolioUtility(utilInput, policy, exposure);
        utilityScore = utilComponents.finalScore;
      }

      // Track stats
      if (eligResult.eligible) {
        summary.byPolicyType[spec.policyType].eligible++;
      } else {
        summary.byPolicyType[spec.policyType].ineligible++;
        for (const r of eligResult.rejectionReasons) {
          const key = r.split(':')[0]; // strip value suffix
          rejectionCounts[spec.policyType][key] = (rejectionCounts[spec.policyType][key] ?? 0) + 1;
        }
      }

      if (!dryRun) {
        await storePolicyEvaluation({
          candidateId:          Number(candidate.id),
          portfolioId:          SIMULATION_PORTFOLIO_ID,
          policyType:           spec.policyType,
          policyVersion:        POLICY_VERSION,
          policySnapshotJson:   snapshotPolicy(policy),
          riskLevel:            spec.portfolioSpec.risk_tolerance,
          horizonDays:          policy.labelHorizonDays,
          targetReturnPct:      spec.portfolioSpec.target_return_pct,
          strategyWeightsJson:  JSON.stringify(policy.strategyWeights),
          eligible:             eligResult.eligible,
          utilityScore,
          portfolioRank:        null, // not ranked in simulation (no portfolio ordering)
          decision:             eligResult.eligible ? 'SKIP' : 'VETO', // historical — not real BUYs
          selectionReason:      eligResult.selectionReason,
          rejectionReasonsJson: eligResult.rejectionReasons.length > 0
            ? JSON.stringify(eligResult.rejectionReasons) : null,
          expectedValuePct:     utilComponents?.expectedValuePct ?? null,
          portfolioAdjustedPwin: null,
          strategyFitMultiplier:  utilComponents?.strategyFitMultiplier ?? null,
          horizonFitMultiplier:   utilComponents?.horizonFitMultiplier ?? null,
          regimeFitMultiplier:    utilComponents?.regimeFitMultiplier ?? null,
          volatilityPenalty:      utilComponents?.volatilityPenalty ?? null,
          drawdownPenalty:        utilComponents?.drawdownPenalty ?? null,
          sectorConcentrationPenalty: utilComponents?.sectorConcentrationPenalty ?? null,
          liquidityPenalty:       utilComponents?.liquidityPenalty ?? null,
          positionSizePct:        null,
          maxPositionAllowedPct:  null,
          labelHorizonDays:       policy.labelHorizonDays,
          dataSource:             'POLICY_SIMULATION',
        }).catch(() => null); // best-effort; idempotency via UNIQUE constraint
        summary.evaluationsInserted++;
      }
    }
  }

  // Compute top rejection reason per policy
  for (const pt of targetPolicies) {
    const counts = rejectionCounts[pt];
    const topKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    summary.byPolicyType[pt].topRejectionReason = topKey;
  }

  return summary;
}
