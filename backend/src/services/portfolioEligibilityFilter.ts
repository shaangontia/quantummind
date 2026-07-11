/**
 * portfolioEligibilityFilter.ts — Phase 19: Per-portfolio pre-ranking eligibility gate
 *
 * Evaluates each candidate against a portfolio's policy BEFORE utility scoring.
 * Candidates that fail eligibility are still stored (with eligible=false and
 * rejection_reasons_json) so we can learn from rejected opportunities.
 *
 * Gate order matters: first failure adds a reason and collection continues
 * to capture ALL reasons (not just the first blocker).
 *
 * Critical rule: P(win) and EV gates are ONLY enforced when the ML model
 * is at ADVISORY or PRODUCTION lifecycle stage — never during cold-start.
 */

import type { PortfolioPolicy } from './portfolioPolicy.js';
import type { StrategyType } from './strategyClassifier.js';
import type { ModelStage } from './modelLifecycle.js';
import type { SelectionReason } from './policyEvaluationStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Current portfolio exposure snapshot — built from live holdings before the BUY loop */
export interface PortfolioExposure {
  sectorPct: Record<string, number>;   // sector → fraction of NAV (0..1)
  currentPositionCount: number;
  cashPct: number;
  drawdownPct: number;                 // current portfolio drawdown from peak
}

/** Features extracted from a candidate signal for eligibility evaluation */
export interface CandidateEligibilityInput {
  symbol: string;
  strategyType: StrategyType;
  fundamentalScore: number | null;
  atrPct: number | null;               // ATR as % of price
  beta: number | null;
  liquidityScore: number | null;       // 0..1; derived from avg daily traded value
  sector: string | null;
  eps: number | null;                  // positive = profitable; negative = loss-making
  mlPwin: number | null;               // ML P(win) — null if model not available
  evPct: number | null;                // Expected value % — null if insufficient data
  marketRegime: string;                // 'BULL' | 'NEUTRAL' | 'BEAR'
}

export interface EligibilityResult {
  eligible: boolean;
  rejectionReasons: string[];          // machine-readable; stored as JSON array
  selectionReason: SelectionReason | null;
  pwinAdvisory: boolean;               // true = P(win)/EV gates skipped (immature model)
}

// Banking/NBFC sectors that should not be evaluated via normal EPS gate
const BANK_LIKE_SECTORS = new Set([
  'Banking', 'Financial Services', 'Insurance', 'NBFC',
  'Capital Markets', 'Diversified Financials',
]);

// ── Main gate ─────────────────────────────────────────────────────────────────

/**
 * Evaluates a candidate against a portfolio policy.
 * Collects ALL rejection reasons (not short-circuit).
 * Returns eligible=false even if only one gate fails.
 */
export function checkEligibility(
  candidate: CandidateEligibilityInput,
  policy: PortfolioPolicy,
  exposure: PortfolioExposure,
  modelStage: ModelStage,
): EligibilityResult {
  const rejections: string[] = [];
  let pwinAdvisory = false;
  const modelMature = modelStage === 'ADVISORY' || modelStage === 'PRODUCTION';

  // ── Gate 1: Strategy type ───────────────────────────────────────────────────
  const stratOk = candidate.strategyType === 'UNKNOWN' || candidate.strategyType === 'MIXED'
    ? false  // UNKNOWN/MIXED never eligible
    : (policy.allowedStrategyTypes as string[]).includes(candidate.strategyType);
  if (!stratOk) {
    rejections.push(`STRATEGY_TYPE_NOT_ALLOWED:${candidate.strategyType}`);
  }

  // ── Gate 2: Fundamental score ───────────────────────────────────────────────
  if (candidate.fundamentalScore !== null) {
    if (candidate.fundamentalScore < policy.minFundamentalScore) {
      rejections.push(`FUNDAMENTAL_BELOW_THRESHOLD:${candidate.fundamentalScore}<${policy.minFundamentalScore}`);
    }
  }
  // If fundamentalScore is null and policy requires high quality, penalise
  else if (policy.minFundamentalScore >= 65) {
    rejections.push('FUNDAMENTAL_SCORE_UNAVAILABLE');
  }

  // ── Gate 3: ATR / volatility ────────────────────────────────────────────────
  if (candidate.atrPct !== null && candidate.atrPct > policy.maxAtrPct) {
    rejections.push(`VOLATILITY_TOO_HIGH:${candidate.atrPct.toFixed(2)}%>${policy.maxAtrPct}%`);
  }

  // ── Gate 4: Market regime ───────────────────────────────────────────────────
  if (!policy.allowedRegimes.includes(candidate.marketRegime)) {
    rejections.push(`REGIME_NOT_ALLOWED:${candidate.marketRegime}`);
  }

  // ── Gate 5: Liquidity ───────────────────────────────────────────────────────
  if (candidate.liquidityScore !== null && candidate.liquidityScore < policy.minLiquidityScore) {
    rejections.push(`LIQUIDITY_INSUFFICIENT:${candidate.liquidityScore.toFixed(2)}<${policy.minLiquidityScore}`);
  }

  // ── Gate 6: Sector concentration ───────────────────────────────────────────
  if (candidate.sector) {
    const currentSectorPct = exposure.sectorPct[candidate.sector] ?? 0;
    if (currentSectorPct >= policy.maxSectorExposure) {
      rejections.push(`SECTOR_OVEREXPOSED:${candidate.sector}@${(currentSectorPct * 100).toFixed(1)}%`);
    }
  }

  // ── Gate 7: Beta ────────────────────────────────────────────────────────────
  if (candidate.beta !== null && candidate.beta > policy.maxBeta) {
    rejections.push(`BETA_TOO_HIGH:${candidate.beta.toFixed(2)}>${policy.maxBeta}`);
  }

  // ── Gate 8: Negative EPS (sector-aware) ────────────────────────────────────
  if (candidate.eps !== null && candidate.eps < 0) {
    const negPolicy = getNegativeEpsPolicy(policy, candidate.sector);
    if (negPolicy === 'VETO') {
      rejections.push(`NEGATIVE_EPS_VETO:EPS=${candidate.eps.toFixed(2)}`);
    } else if (negPolicy === 'PENALTY') {
      // Penalty is applied in utility scoring; not a hard block but flagged
      rejections.push(`NEGATIVE_EPS_PENALTY_APPLIED`);
      // Note: does NOT add to hard rejections — candidate remains eligible
      // Remove the last push since it's advisory only
      rejections.pop();
    }
    // ALLOW_WITH_RISK and BANK_EXCEPTION: no rejection
  }

  // ── Gate 9: P(win) (model lifecycle aware) ──────────────────────────────────
  if (modelMature && candidate.mlPwin !== null) {
    if (candidate.mlPwin < policy.minPwin) {
      rejections.push(`PWIN_BELOW_THRESHOLD:${candidate.mlPwin.toFixed(3)}<${policy.minPwin}`);
    }
  } else if (!modelMature) {
    pwinAdvisory = true; // log but do not block
  }

  // ── Gate 10: Expected value (model lifecycle aware) ─────────────────────────
  if (modelMature && candidate.evPct !== null) {
    if (candidate.evPct < policy.evThresholdPct) {
      rejections.push(`EV_BELOW_THRESHOLD:${candidate.evPct.toFixed(2)}%<${policy.evThresholdPct}%`);
    }
  }
  // If model not mature, already marked pwinAdvisory above

  const eligible = rejections.length === 0;

  // ── Selection reason ────────────────────────────────────────────────────────
  let selectionReason: SelectionReason | null = null;
  if (!eligible) {
    if (rejections.some(r => r.startsWith('SECTOR_OVEREXPOSED'))) {
      selectionReason = 'DIVERSIFICATION_BLOCKED';
    } else if (rejections.some(r => r.startsWith('REGIME_NOT_ALLOWED'))) {
      selectionReason = 'REGIME_DRIVEN';
    } else if (rejections.some(r => r.startsWith('STRATEGY_TYPE_NOT_ALLOWED'))) {
      selectionReason = 'RISK_REJECTED';
    } else {
      selectionReason = 'RISK_REJECTED';
    }
  } else if (pwinAdvisory) {
    selectionReason = 'MODEL_INSUFFICIENT';
  } else {
    selectionReason = 'STRATEGY_FIT'; // refined later by overlap analytics
  }

  return { eligible, rejectionReasons: rejections, selectionReason, pwinAdvisory };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type NegativeEpsOutcome = 'VETO' | 'PENALTY' | 'ALLOW_WITH_RISK' | 'BANK_EXCEPTION';

function getNegativeEpsPolicy(
  policy: PortfolioPolicy,
  sector: string | null,
): NegativeEpsOutcome {
  // Banks/NBFCs — standard EPS gate doesn't apply
  if (sector && BANK_LIKE_SECTORS.has(sector)) return 'BANK_EXCEPTION';

  return policy.negativeEpsPolicy;
}

/**
 * Compute a normalised liquidity score (0..1) from avg daily traded value (INR)
 * and the intended trade size.
 * Score >= 1.0 is clamped to 1.0 (very liquid).
 */
export function computeLiquidityScore(avgDailyTradedValueInr: number, tradeValueInr: number): number {
  if (tradeValueInr <= 0) return 0;
  const ratio = avgDailyTradedValueInr / (tradeValueInr * 20); // 20× rule
  return Math.min(ratio, 1.0);
}
