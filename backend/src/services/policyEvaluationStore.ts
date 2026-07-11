/**
 * policyEvaluationStore.ts — Phase 19: Policy evaluation persistence
 *
 * Stores one row per candidate × portfolio evaluation in
 * portfolio_policy_evaluations. Covers ALL decisions: BUY, SKIP, WATCH, VETO.
 * Skipped/vetoed candidates are just as important for learning as executed ones.
 *
 * The UNIQUE(candidate_id, portfolio_id, policy_version) constraint prevents
 * duplicate evaluations if a candidate is processed multiple times in a cycle.
 */

import { run, query, queryOne } from '../db/turso.js';
import type { PolicyType } from './portfolioPolicy.js';
import type { StrategyType } from './strategyClassifier.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EvaluationDecision = 'BUY' | 'SKIP' | 'WATCH' | 'VETO';

export type SelectionReason =
  | 'GLOBAL_CONSENSUS'       // utility score high across 3+ portfolio types
  | 'POLICY_MATCH'           // utility high only for this specific policy type
  | 'REGIME_DRIVEN'          // eligible primarily because regime forced limited universe
  | 'STRATEGY_FIT'           // candidate strategy type matches policy preference strongly
  | 'RISK_REJECTED'          // blocked by ATR/beta/fundamental gates
  | 'HORIZON_MISMATCH'       // expected holding period incompatible with policy horizon
  | 'DIVERSIFICATION_BLOCKED' // sector cap prevented inclusion
  | 'MODEL_INSUFFICIENT';    // ML model too immature — P(win)/EV not used

export type DataSource =
  | 'LIVE_PAPER'
  | 'LIVE_REAL'
  | 'HISTORICAL_BACKTEST'
  | 'POLICY_SIMULATION';

export interface PolicyEvaluationInsert {
  candidateId: number;
  portfolioId: number;
  // Policy snapshot (immutable — stored even if portfolio settings change later)
  policyType: PolicyType;
  policyVersion: string;
  policySnapshotJson: string;   // JSON.stringify(PortfolioPolicy)
  riskLevel: string;
  horizonDays: number;
  targetReturnPct: number | null;
  strategyWeightsJson: string | null;
  // Decision
  eligible: boolean;
  utilityScore: number | null;
  portfolioRank: number | null;
  decision: EvaluationDecision;
  selectionReason: SelectionReason | null;
  rejectionReasonsJson: string | null;  // JSON array of rejection reason strings
  // Utility components
  expectedValuePct: number | null;
  portfolioAdjustedPwin: number | null;
  strategyFitMultiplier: number | null;
  horizonFitMultiplier: number | null;
  regimeFitMultiplier: number | null;
  volatilityPenalty: number | null;
  drawdownPenalty: number | null;
  sectorConcentrationPenalty: number | null;
  liquidityPenalty: number | null;
  // Sizing
  positionSizePct: number | null;
  maxPositionAllowedPct: number | null;
  // Label
  labelHorizonDays: number | null;
  dataSource: DataSource;
}

export interface PolicyEvaluation extends PolicyEvaluationInsert {
  id: number;
  symbol: string;           // from trade_candidates join
  labelStatus: 'PENDING' | 'FINAL' | 'INVALID';
  createdAt: string;
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Insert a policy evaluation row.
 * Uses INSERT OR IGNORE — if the UNIQUE(candidate_id, portfolio_id, policy_version)
 * constraint fires, the duplicate is silently skipped.
 * Returns the inserted row id, or 0 if skipped (duplicate).
 */
export async function storePolicyEvaluation(row: PolicyEvaluationInsert): Promise<number> {
  const result = await run(
    `INSERT OR IGNORE INTO portfolio_policy_evaluations (
       candidate_id, portfolio_id,
       policy_type, policy_version, policy_snapshot_json,
       risk_level, horizon_days, target_return_pct, strategy_weights_json,
       eligible, utility_score, portfolio_rank, decision, selection_reason,
       rejection_reasons_json,
       expected_value_pct, portfolio_adjusted_pwin,
       strategy_fit_multiplier, horizon_fit_multiplier, regime_fit_multiplier,
       volatility_penalty, drawdown_penalty, sector_concentration_penalty, liquidity_penalty,
       position_size_pct, max_position_allowed_pct,
       label_horizon_days, label_status, data_source
     ) VALUES (
       ?,?,  ?,?,?,  ?,?,?,?,  ?,?,?,?,?,  ?,  ?,?,  ?,?,?,  ?,?,?,?,  ?,?,  ?,?,?
     )`,
    [
      row.candidateId, row.portfolioId,
      row.policyType, row.policyVersion, row.policySnapshotJson,
      row.riskLevel, row.horizonDays, row.targetReturnPct, row.strategyWeightsJson,
      row.eligible ? 1 : 0, row.utilityScore, row.portfolioRank, row.decision, row.selectionReason,
      row.rejectionReasonsJson,
      row.expectedValuePct, row.portfolioAdjustedPwin,
      row.strategyFitMultiplier, row.horizonFitMultiplier, row.regimeFitMultiplier,
      row.volatilityPenalty, row.drawdownPenalty, row.sectorConcentrationPenalty, row.liquidityPenalty,
      row.positionSizePct, row.maxPositionAllowedPct,
      row.labelHorizonDays, 'PENDING', row.dataSource,
    ],
  ).catch(() => ({ lastInsertRowid: 0 }));
  return result.lastInsertRowid;
}

/**
 * Update the label status of an evaluation once its outcome label has been generated.
 */
export async function updatePolicyEvaluationLabelStatus(
  evaluationId: number,
  status: 'PENDING' | 'FINAL' | 'INVALID',
): Promise<void> {
  await run(
    `UPDATE portfolio_policy_evaluations SET label_status = ? WHERE id = ?`,
    [status, evaluationId],
  ).catch(() => null);
}

/**
 * Returns evaluations ready for label generation:
 * - label_status = 'PENDING'
 * - created_at + label_horizon_days <= now
 * - data_source IN ('LIVE_PAPER', 'LIVE_REAL') — production labels only
 */
export async function getPendingLabelEvaluations(): Promise<PolicyEvaluation[]> {
  const rows = await query(
    `SELECT ppe.*, tc.symbol
     FROM portfolio_policy_evaluations ppe
     JOIN trade_candidates tc ON tc.id = ppe.candidate_id
     WHERE ppe.label_status = 'PENDING'
       AND ppe.data_source IN ('LIVE_PAPER', 'LIVE_REAL')
       AND ppe.label_horizon_days IS NOT NULL
       AND datetime(ppe.created_at, '+' || ppe.label_horizon_days || ' days') <= datetime('now')
     LIMIT 500`,
  ).catch(() => []);
  return rows.map(r => ({ ...mapRow(r), symbol: r.symbol as string }));
}

/**
 * Returns all BUY evaluations for a portfolio (for overlap analytics).
 */
export async function getBuyEvaluationsForPortfolio(
  portfolioId: number,
  fromDate: string,
): Promise<PolicyEvaluation[]> {
  const rows = await query(
    `SELECT * FROM portfolio_policy_evaluations
     WHERE portfolio_id = ? AND decision = 'BUY' AND created_at >= ?
     ORDER BY created_at DESC`,
    [portfolioId, fromDate],
  ).catch(() => []);
  return rows.map(mapRow);
}

/**
 * Returns evaluation count breakdown by decision and policy type for a portfolio.
 */
export async function getEvaluationSummary(portfolioId: number, fromDate: string): Promise<
  Array<{ policyType: string; decision: string; count: number }>
> {
  return query(
    `SELECT policy_type as policyType, decision, COUNT(*) as count
     FROM portfolio_policy_evaluations
     WHERE portfolio_id = ? AND created_at >= ?
     GROUP BY policy_type, decision`,
    [portfolioId, fromDate],
  ).catch(() => []);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapRow(r: any): PolicyEvaluation {
  return {
    id:                     Number(r.id),
    symbol:                 (r.symbol as string) ?? '',
    candidateId:            Number(r.candidate_id),
    portfolioId:            Number(r.portfolio_id),
    policyType:             r.policy_type as PolicyType,
    policyVersion:          r.policy_version,
    policySnapshotJson:     r.policy_snapshot_json,
    riskLevel:              r.risk_level,
    horizonDays:            Number(r.horizon_days),
    targetReturnPct:        r.target_return_pct != null ? Number(r.target_return_pct) : null,
    strategyWeightsJson:    r.strategy_weights_json ?? null,
    eligible:               Number(r.eligible) === 1,
    utilityScore:           r.utility_score != null ? Number(r.utility_score) : null,
    portfolioRank:          r.portfolio_rank != null ? Number(r.portfolio_rank) : null,
    decision:               r.decision as EvaluationDecision,
    selectionReason:        r.selection_reason as SelectionReason | null,
    rejectionReasonsJson:   r.rejection_reasons_json ?? null,
    expectedValuePct:       r.expected_value_pct != null ? Number(r.expected_value_pct) : null,
    portfolioAdjustedPwin:  r.portfolio_adjusted_pwin != null ? Number(r.portfolio_adjusted_pwin) : null,
    strategyFitMultiplier:  r.strategy_fit_multiplier != null ? Number(r.strategy_fit_multiplier) : null,
    horizonFitMultiplier:   r.horizon_fit_multiplier != null ? Number(r.horizon_fit_multiplier) : null,
    regimeFitMultiplier:    r.regime_fit_multiplier != null ? Number(r.regime_fit_multiplier) : null,
    volatilityPenalty:      r.volatility_penalty != null ? Number(r.volatility_penalty) : null,
    drawdownPenalty:        r.drawdown_penalty != null ? Number(r.drawdown_penalty) : null,
    sectorConcentrationPenalty: r.sector_concentration_penalty != null ? Number(r.sector_concentration_penalty) : null,
    liquidityPenalty:       r.liquidity_penalty != null ? Number(r.liquidity_penalty) : null,
    positionSizePct:        r.position_size_pct != null ? Number(r.position_size_pct) : null,
    maxPositionAllowedPct:  r.max_position_allowed_pct != null ? Number(r.max_position_allowed_pct) : null,
    labelHorizonDays:       r.label_horizon_days != null ? Number(r.label_horizon_days) : null,
    labelStatus:            (r.label_status ?? 'PENDING') as 'PENDING' | 'FINAL' | 'INVALID',
    dataSource:             r.data_source as DataSource,
    createdAt:              r.created_at,
  };
}
