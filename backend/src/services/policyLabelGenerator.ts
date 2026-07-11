/**
 * policyLabelGenerator.ts — Phase 19: Horizon-specific outcome labels
 *
 * Generates one policy_outcome_label per portfolio_policy_evaluation.
 * Label horizon is policy-specific (15 / 30 / 60 / 120 days depending on policy type).
 *
 * ML training must use ONLY:
 *   label_type = 'TARGET_BEFORE_STOP'
 *   label_status = 'FINAL'
 *   data_source IN ('LIVE_PAPER', 'LIVE_REAL')
 *
 * POLICY_SIMULATION labels are never used in production ML training.
 *
 * Runs nightly alongside the existing labelGenerator.ts job.
 */

import { run, query } from '../db/turso.js';
import { getPendingLabelEvaluations, updatePolicyEvaluationLabelStatus } from './policyEvaluationStore.js';
import { loadSymbolHistory, type OHLCVRow } from './backtestData.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_R_MULTIPLE = 2.0;  // target = entry + 2 × ATR
const STOP_R_MULTIPLE   = 1.0;  // stop   = entry - 1 × ATR

// Approx brokerage + impact cost (one-way)
const ROUND_TRIP_COST_PCT = 0.004; // 0.4%

// ── Main job ──────────────────────────────────────────────────────────────────

/**
 * Nightly job: generate policy outcome labels for all evaluations
 * whose label_horizon_days have elapsed.
 *
 * Uses INSERT OR IGNORE on policy_outcome_labels to be idempotent.
 */
export async function generatePolicyOutcomeLabels(): Promise<{
  processed: number;
  labelled: number;
  invalid: number;
}> {
  const evaluations = await getPendingLabelEvaluations();
  let processed = 0;
  let labelled  = 0;
  let invalid   = 0;

  for (const evaluation of evaluations) {
    processed++;
    try {
      // Load OHLCV for the candidate's symbol
      // We need rows from evaluation.createdAt onward
      const history = await loadSymbolHistory(evaluation.symbol).catch(() => null);
      if (!history || history.length === 0) {
        await invalidateEvaluation(evaluation.id, 'NO_HISTORY');
        invalid++;
        continue;
      }

      // Slice to the relevant window: from evaluation date forward
      const evalDate = evaluation.createdAt.slice(0, 10); // ISO date
      const windowRows = history
        .filter(r => r.date >= evalDate)
        .slice(0, evaluation.labelHorizonDays! + 5); // small buffer

      if (windowRows.length < 2) {
        await invalidateEvaluation(evaluation.id, 'INSUFFICIENT_WINDOW');
        invalid++;
        continue;
      }

      // Recover entry price from trade_candidates
      const candidateRow = await queryCandidateById(evaluation.candidateId);
      if (!candidateRow) {
        await invalidateEvaluation(evaluation.id, 'CANDIDATE_NOT_FOUND');
        invalid++;
        continue;
      }

      const entryPrice = candidateRow.entry_price ?? windowRows[0].close;
      if (!entryPrice || entryPrice <= 0) {
        await invalidateEvaluation(evaluation.id, 'INVALID_ENTRY_PRICE');
        invalid++;
        continue;
      }

      // Compute ATR-based target and stop
      const atrAbs  = entryPrice * ((candidateRow.atr_pct ?? 2.0) / 100);
      const targetPrice = entryPrice + TARGET_R_MULTIPLE * atrAbs;
      const stopPrice   = entryPrice - STOP_R_MULTIPLE  * atrAbs;

      // Walk the price path
      const label = walkPricePath(windowRows, entryPrice, targetPrice, stopPrice, evaluation.labelHorizonDays!);

      // Insert label (INSERT OR IGNORE for idempotency)
      await run(
        `INSERT OR IGNORE INTO policy_outcome_labels (
           policy_evaluation_id, candidate_id, portfolio_id, symbol,
           label_type, label_horizon_days, target_r_multiple, stop_r_multiple,
           target_hit_before_stop, target_hit_days, stop_hit_days,
           forward_return_pct, cost_adjusted_return_pct, mae_pct, mfe_pct, hold_days,
           label_status, label_generated_at
         ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, 'FINAL', datetime('now'))`,
        [
          evaluation.id, evaluation.candidateId, evaluation.portfolioId, evaluation.symbol,
          'TARGET_BEFORE_STOP', evaluation.labelHorizonDays, TARGET_R_MULTIPLE, STOP_R_MULTIPLE,
          label.targetHitBeforeStop ? 1 : 0, label.targetHitDays, label.stopHitDays,
          label.forwardReturnPct, label.costAdjustedReturnPct, label.maePct, label.mfePct, label.holdDays,
        ],
      );

      // Mark evaluation as labelled
      await updatePolicyEvaluationLabelStatus(evaluation.id, 'FINAL');
      labelled++;
    } catch (_err) {
      // Best-effort — never crash the nightly job on a single row
      await invalidateEvaluation(evaluation.id, 'ERROR').catch(() => null);
      invalid++;
    }
  }

  return { processed, labelled, invalid };
}

// ── Price path walker ─────────────────────────────────────────────────────────

interface LabelResult {
  targetHitBeforeStop: boolean;
  targetHitDays:       number | null;
  stopHitDays:         number | null;
  forwardReturnPct:    number;
  costAdjustedReturnPct: number;
  maePct:              number;  // max adverse excursion
  mfePct:              number;  // max favourable excursion
  holdDays:            number;
}

function walkPricePath(
  rows: OHLCVRow[],
  entryPrice: number,
  targetPrice: number,
  stopPrice: number,
  maxHorizon: number,
): LabelResult {
  let maePct = 0;
  let mfePct = 0;
  let targetHitBeforeStop = false;
  let targetHitDays: number | null = null;
  let stopHitDays:   number | null = null;
  let exitPrice = rows[rows.length - 1]?.close ?? entryPrice;
  let holdDays  = 0;

  for (let i = 0; i < Math.min(rows.length, maxHorizon); i++) {
    const row = rows[i];
    holdDays = i + 1;

    const dayLow  = row.low;
    const dayHigh = row.high;
    const dayClose = row.close;

    // MAE/MFE relative to entry
    const dayLowPct  = ((dayLow  - entryPrice) / entryPrice) * 100;
    const dayHighPct = ((dayHigh - entryPrice) / entryPrice) * 100;
    if (dayLowPct  < maePct) maePct = dayLowPct;
    if (dayHighPct > mfePct) mfePct = dayHighPct;

    // Target hit (intraday high touches target)
    if (dayHigh >= targetPrice && stopHitDays === null && targetHitDays === null) {
      targetHitBeforeStop = true;
      targetHitDays = holdDays;
      exitPrice = targetPrice;
      break;
    }

    // Stop hit (intraday low touches stop)
    if (dayLow <= stopPrice && targetHitDays === null) {
      stopHitDays = holdDays;
      exitPrice = stopPrice;
      break;
    }

    exitPrice = dayClose;
  }

  const forwardReturnPct     = ((exitPrice - entryPrice) / entryPrice) * 100;
  const costAdjustedReturnPct = forwardReturnPct - ROUND_TRIP_COST_PCT * 100;

  return {
    targetHitBeforeStop,
    targetHitDays: targetHitDays ?? null,
    stopHitDays:   stopHitDays  ?? null,
    forwardReturnPct,
    costAdjustedReturnPct,
    maePct:   Math.abs(maePct),  // stored as positive
    mfePct,
    holdDays,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function invalidateEvaluation(evaluationId: number, reason: string): Promise<void> {
  await updatePolicyEvaluationLabelStatus(evaluationId, 'INVALID');
  // Store minimal INVALID label row so the evaluation is not re-processed
  await run(
    `INSERT OR IGNORE INTO policy_outcome_labels (
       policy_evaluation_id, candidate_id, portfolio_id, symbol,
       label_type, label_horizon_days, label_status, label_generated_at
     )
     SELECT id, candidate_id, portfolio_id, symbol,
       'UNKNOWN', label_horizon_days, 'INVALID', datetime('now')
     FROM portfolio_policy_evaluations WHERE id = ?`,
    [evaluationId],
  ).catch(() => null);
}

async function queryCandidateById(candidateId: number): Promise<any | null> {
  const rows = await query(
    `SELECT entry_price, atr_pct FROM trade_candidates WHERE id = ? LIMIT 1`,
    [candidateId],
  ).catch(() => []);
  return rows[0] ?? null;
}
