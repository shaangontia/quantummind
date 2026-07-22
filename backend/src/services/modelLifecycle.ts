/**
 * modelLifecycle.ts — Phase 16: Model governance + cold-start safety mode
 *
 * Model lifecycle stages:
 *   CANDIDATE  → insufficient data, ML gate is a no-op
 *   SHADOW     → 200+ true labels + positive expectancy: ML logs predictions but doesn't block
 *   ADVISORY   → 500+ true labels + 3+ positive WF windows + beats rule baseline: ML reduces position size
 *   PRODUCTION → 1000+ true labels + 6+ positive WF windows + calibration OK: ML can block/approve
 *   RETIRED    → model replaced by newer version
 *
 * Cold-start mode:
 *   Active when model is CANDIDATE or SHADOW
 *   Caps: position size 1% NAV, max 5 trades/day, max 5 open positions
 *   Blocks all WEAK signals (score < 3)
 *
 *   (2026-07-22: daily trade cap raised 2→5 for CANDIDATE, 3→5 for SHADOW.
 *   Worst-case cold-start exposure is actually bounded by position size ×
 *   max open positions = 1% × 5 = 5% NAV, completely independent of the
 *   daily entry count — once 5 positions are open, marketMonitor.ts blocks
 *   further entries outright regardless of the daily cap. The daily cap was
 *   therefore a second, redundant throttle that mostly just slowed down how
 *   fast the model could accumulate the executedMin-labelled trades needed
 *   for promotion, without reducing worst-case risk. Aligning it to the
 *   position-count ceiling (5) removes that redundant throttle. ADVISORY is
 *   NOT cold-start — it uses normal (non-capped) position sizing — so its
 *   daily limit was left unchanged; raising it would be a real risk
 *   decision, not just a redundant-throttle removal.)
 *
 * Promotion evaluated nightly — automatic, no manual intervention.
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import { getSymbolSector } from './marketData.js';

export type ModelStage = 'CANDIDATE' | 'SHADOW' | 'ADVISORY' | 'PRODUCTION' | 'RETIRED';

export interface ModelGovernanceState {
  stage: ModelStage;
  trueLabelCount: number;
  positiveWFWindows: number;
  isColdStart: boolean;
  maxPositionPctOverride: number | null;   // null = use normal sizing
  maxTradesPerDayOverride: number | null;
  maxOpenPositionsOverride: number | null;
  // Phase 16: Explainability — why not promoted?
  promotionGaps: {
    labelsNeeded: number;         // 0 when met
    wfWindowsNeeded: number;      // 0 when met
    nextStage: ModelStage;
    weakSignalsBlocked: boolean;
  };
  calibration: {
    available: boolean;
    maxErrorPct: number | null;
    activeBuckets: number;
  };
}

/**
 * Phase 23: Promotion thresholds updated with executed-minimum + strategy diversity.
 * executedMin  = minimum number of ACTUAL_EXECUTED labels (shadow alone is not enough).
 * strategyTypes = minimum distinct strategy_type values in executed labels.
 * maxSingleStrategyPct = maximum % of executed labels from any one strategy (concentration cap).
 */
const THRESHOLDS = {
  SHADOW:     { labels: 200,  wfWindows: 1, executedMin: 30,  strategyTypes: 2, sectors: 2, maxSingleStrategyPct: 90 },
  ADVISORY:   { labels: 500,  wfWindows: 3, executedMin: 100, strategyTypes: 4, sectors: 5, maxSingleStrategyPct: 60 },
  PRODUCTION: { labels: 1000, wfWindows: 6, executedMin: 250, strategyTypes: 4, sectors: 6, maxSingleStrategyPct: 60 },
};

/**
 * Phase 23: Stage-aware daily trade limits (cold-start caps still apply for position size).
 *
 * CANDIDATE/SHADOW raised 2/3 → 5 (2026-07-22): both stages are cold-start
 * (isColdStart = true), meaning worst-case exposure is already hard-bounded
 * by maxPositionPctOverride (1% NAV) × maxOpenPositionsOverride (5 positions)
 * = 5% NAV, enforced independently in marketMonitor.ts regardless of the
 * daily entry count. Setting the daily cap to 5 aligns it with that
 * position-count ceiling so it's no longer a second, tighter throttle on
 * top of a cap that already does the job — it was previously the binding
 * constraint on how fast the model could accumulate the executed-trade
 * labels (executedMin: 30 for SHADOW) needed to be promoted.
 *
 * ADVISORY is NOT cold-start (uses normal, non-capped position sizing per
 * riskTolerance) — its limit was intentionally left unchanged since raising
 * it is a real risk decision, not a redundant-throttle removal.
 */
const STAGE_TRADE_LIMITS: Record<string, number | null> = {
  CANDIDATE:  5,
  SHADOW:     5,
  ADVISORY:   5,
  PRODUCTION: null,  // policy-based — no hard override
  RETIRED:    2,
};

// ─── In-process cache ─────────────────────────────────────────────────────────

let _stateCache: Map<number, { state: ModelGovernanceState; ts: number }> = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

/**
 * Evaluate and persist model governance state for a portfolio.
 * Called nightly after walk-forward and model training.
 */
export async function evaluateModelGovernance(portfolioId: number): Promise<ModelGovernanceState> {
  // Count TARGET_BEFORE_STOP labels (total = executed + shadow)
  const labelCount = await query(
    `SELECT COUNT(*) as cnt FROM trade_candidates
     WHERE portfolio_id=? AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL`,
    [portfolioId],
  ).then(r => Number(r[0]?.cnt ?? 0)).catch(() => 0);

  // Phase 23: Count EXECUTED-only labels (for promotion diversity gate)
  const executedLabelCount = await query(
    `SELECT COUNT(*) as cnt FROM trade_candidates
     WHERE portfolio_id=? AND action_taken='EXECUTED'
       AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL`,
    [portfolioId],
  ).then(r => Number(r[0]?.cnt ?? 0)).catch(() => 0);

  // Phase 23: Count distinct strategy types in executed labels (diversity gate)
  const strategyTypeCount = await query(
    `SELECT COUNT(DISTINCT strategy_type) as cnt FROM trade_candidates
     WHERE portfolio_id=? AND action_taken='EXECUTED'
       AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL
       AND strategy_type IS NOT NULL`,
    [portfolioId],
  ).then(r => Number(r[0]?.cnt ?? 0)).catch(() => 0);

  // Phase 23: Sector diversity — count distinct GICS sectors across executed-label symbols.
  // No sector column on trade_candidates; resolved in-process via getSymbolSector (O(n) lookup,
  // acceptable for promotion check which runs nightly on at most a few hundred symbols).
  const executedSymbols = await query(
    `SELECT DISTINCT symbol FROM trade_candidates
     WHERE portfolio_id=? AND action_taken='EXECUTED'
       AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL`,
    [portfolioId],
  ).then(r => r.map((x: any) => String(x.symbol))).catch(() => [] as string[]);
  const sectorCount = new Set(executedSymbols.map(sym => getSymbolSector(sym)).filter(Boolean)).size;

  // Phase 23: Concentration check — max single strategy share of executed labels
  const maxStrategyConcPct = await query(
    `SELECT MAX(strategy_cnt * 100.0 / total_cnt) as max_pct
     FROM (
       SELECT strategy_type, COUNT(*) as strategy_cnt,
              (SELECT COUNT(*) FROM trade_candidates WHERE portfolio_id=? AND action_taken='EXECUTED'
               AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL) as total_cnt
       FROM trade_candidates
       WHERE portfolio_id=? AND action_taken='EXECUTED'
         AND label_type='TARGET_BEFORE_STOP' AND target_hit_before_stop IS NOT NULL
         AND strategy_type IS NOT NULL
       GROUP BY strategy_type
     )`,
    [portfolioId, portfolioId],
  ).then(r => Number(r[0]?.max_pct ?? 100)).catch(() => 100);

  // Count walk-forward windows with positive expectancy
  const posWFWindows = await query(
    `SELECT COUNT(*) as cnt FROM walk_forward_results
     WHERE portfolio_id=? AND win_rate >= 0.5`,
    [portfolioId],
  ).then(r => Number(r[0]?.cnt ?? 0)).catch(() => 0);

  // Determine stage — Phase 23: all gates must pass (labels + executed + strategy + sector + WF)
  let stage: ModelStage = 'CANDIDATE';
  if (labelCount >= THRESHOLDS.PRODUCTION.labels
    && posWFWindows >= THRESHOLDS.PRODUCTION.wfWindows
    && executedLabelCount >= THRESHOLDS.PRODUCTION.executedMin
    && strategyTypeCount >= THRESHOLDS.PRODUCTION.strategyTypes
    && sectorCount >= THRESHOLDS.PRODUCTION.sectors
    && maxStrategyConcPct <= THRESHOLDS.PRODUCTION.maxSingleStrategyPct) {
    stage = 'PRODUCTION';
  } else if (labelCount >= THRESHOLDS.ADVISORY.labels
    && posWFWindows >= THRESHOLDS.ADVISORY.wfWindows
    && executedLabelCount >= THRESHOLDS.ADVISORY.executedMin
    && strategyTypeCount >= THRESHOLDS.ADVISORY.strategyTypes
    && sectorCount >= THRESHOLDS.ADVISORY.sectors
    && maxStrategyConcPct <= THRESHOLDS.ADVISORY.maxSingleStrategyPct) {
    stage = 'ADVISORY';
  } else if (labelCount >= THRESHOLDS.SHADOW.labels
    && posWFWindows >= THRESHOLDS.SHADOW.wfWindows
    && executedLabelCount >= THRESHOLDS.SHADOW.executedMin
    && strategyTypeCount >= THRESHOLDS.SHADOW.strategyTypes
    && sectorCount >= THRESHOLDS.SHADOW.sectors) {
    stage = 'SHADOW';
  }

  const isColdStart = stage === 'CANDIDATE' || stage === 'SHADOW';

  // Compute "why not promoted" gaps
  const nextStage: ModelStage = stage === 'CANDIDATE' ? 'SHADOW'
    : stage === 'SHADOW' ? 'ADVISORY'
    : stage === 'ADVISORY' ? 'PRODUCTION' : 'RETIRED';
  const nextThresh = THRESHOLDS[nextStage as keyof typeof THRESHOLDS] ?? THRESHOLDS.PRODUCTION;
  const labelsNeeded = Math.max(0, nextThresh.labels - labelCount);
  const wfWindowsNeeded = Math.max(0, nextThresh.wfWindows - posWFWindows);

  const calibrationSummary = await getCalibrationSummary('buy_win_probability_v1').catch(() => ({
    available: false, maxErrorPct: null, activeBuckets: 0,
  }));

  // Phase 23: Stage-aware daily trade limit (no longer flat 2 for all cold-start stages)
  const stageTradeLimit = STAGE_TRADE_LIMITS[stage] ?? null;

  const state: ModelGovernanceState = {
    stage,
    trueLabelCount: labelCount,
    positiveWFWindows: posWFWindows,
    isColdStart,
    maxPositionPctOverride: isColdStart ? 0.01 : null,
    maxTradesPerDayOverride: stageTradeLimit,
    maxOpenPositionsOverride: isColdStart ? 5 : null,
    promotionGaps: { labelsNeeded, wfWindowsNeeded, nextStage, weakSignalsBlocked: isColdStart },
    calibration: calibrationSummary,
  };

  // Persist
  await run(
    `INSERT INTO cold_start_state
       (portfolio_id, is_cold_start, lifecycle_stage, true_label_count, positive_wf_windows, last_evaluated)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       is_cold_start=excluded.is_cold_start,
       lifecycle_stage=excluded.lifecycle_stage,
       true_label_count=excluded.true_label_count,
       positive_wf_windows=excluded.positive_wf_windows,
       last_evaluated=excluded.last_evaluated`,
    [portfolioId, isColdStart ? 1 : 0, stage, labelCount, posWFWindows],
  ).catch(() => null);

  if (stage !== 'CANDIDATE') {
    logger.info({ job: 'model-lifecycle', portfolioId, stage, trueLabelCount: labelCount, positiveWFWindows: posWFWindows });
  }

  _stateCache.set(portfolioId, { state, ts: Date.now() });
  return state;
}

/**
 * Get cached governance state (loads from DB if cache is stale or missing).
 */
export async function getModelGovernanceState(portfolioId: number): Promise<ModelGovernanceState> {
  const cached = _stateCache.get(portfolioId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.state;

  // Load from DB
  const row = await query(
    `SELECT is_cold_start, lifecycle_stage, true_label_count, positive_wf_windows
     FROM cold_start_state WHERE portfolio_id=?`,
    [portfolioId],
  ).then(r => r[0]).catch(() => null);

  if (!row) {
    // Cold start by default — no DB record yet
    const defaultState: ModelGovernanceState = {
      stage: 'CANDIDATE',
      trueLabelCount: 0,
      positiveWFWindows: 0,
      isColdStart: true,
      maxPositionPctOverride: 0.01,
      maxTradesPerDayOverride: STAGE_TRADE_LIMITS['CANDIDATE'] ?? 2,
      maxOpenPositionsOverride: 5,
      promotionGaps: { labelsNeeded: 200, wfWindowsNeeded: 1, nextStage: 'SHADOW', weakSignalsBlocked: true },
      calibration: { available: false, maxErrorPct: null, activeBuckets: 0 },
    };
    _stateCache.set(portfolioId, { state: defaultState, ts: Date.now() });
    return defaultState;
  }

  const loadedStage = (row.lifecycle_stage as ModelStage) ?? 'CANDIDATE';
  const loadedLabels = Number(row.true_label_count ?? 0);
  const loadedWF = Number(row.positive_wf_windows ?? 0);
  const loadedCold = Boolean(row.is_cold_start);
  const loadedNextStage: ModelStage = loadedStage === 'CANDIDATE' ? 'SHADOW'
    : loadedStage === 'SHADOW' ? 'ADVISORY'
    : loadedStage === 'ADVISORY' ? 'PRODUCTION' : 'RETIRED';
  const loadedNextThresh = THRESHOLDS[loadedNextStage as keyof typeof THRESHOLDS] ?? THRESHOLDS.PRODUCTION;
  const loadedCalib = await getCalibrationSummary('buy_win_probability_v1').catch(() => ({ available: false, maxErrorPct: null, activeBuckets: 0 }));

  const loadedTradeLimit = STAGE_TRADE_LIMITS[loadedStage] ?? null;

  const state: ModelGovernanceState = {
    stage: loadedStage,
    trueLabelCount: loadedLabels,
    positiveWFWindows: loadedWF,
    isColdStart: loadedCold,
    maxPositionPctOverride: loadedCold ? 0.01 : null,
    maxTradesPerDayOverride: loadedTradeLimit,
    maxOpenPositionsOverride: loadedCold ? 5 : null,
    promotionGaps: {
      labelsNeeded: Math.max(0, loadedNextThresh.labels - loadedLabels),
      wfWindowsNeeded: Math.max(0, loadedNextThresh.wfWindows - loadedWF),
      nextStage: loadedNextStage,
      weakSignalsBlocked: loadedCold,
    },
    calibration: loadedCalib,
  };

  _stateCache.set(portfolioId, { state, ts: Date.now() });
  return state;
}

/**
 * Phase 16: Compute calibration buckets for the model.
 * Groups trade_candidates by prediction_pwin bands and compares with actual win rate.
 * Alert if calibration error > 15% in any populated bucket.
 */
export async function computeCalibration(modelName: string): Promise<void> {
  const bands = [
    { low: 0.50, high: 0.55 },
    { low: 0.55, high: 0.60 },
    { low: 0.60, high: 0.65 },
    { low: 0.65, high: 0.70 },
    { low: 0.70, high: 1.01 },
  ];

  for (const band of bands) {
    const rows = await query(
      `SELECT prediction_pwin, target_hit_before_stop as win_int,
              cost_adjusted_return_pct as ret
       FROM trade_candidates
       WHERE action_taken='EXECUTED'
         AND label_type='TARGET_BEFORE_STOP' AND label_status='FINAL'
         AND prediction_pwin >= ? AND prediction_pwin < ?
         AND prediction_pwin IS NOT NULL
         AND target_hit_before_stop IS NOT NULL`,
      [band.low, band.high],
    ).catch(() => []);

    if (rows.length === 0) continue;

    const winCount = rows.filter(r => Number(r.win_int) === 1).length;
    const actualWinRate = winCount / rows.length;
    const predictedAvg = rows.reduce((s, r) => s + Number(r.prediction_pwin ?? 0), 0) / rows.length;
    const calibrationError = Math.abs(predictedAvg - actualWinRate);

    const winRets  = rows.filter(r => Number(r.win_int) === 1).map(r => Number(r.ret ?? 0));
    const lossRets = rows.filter(r => Number(r.win_int) === 0).map(r => Math.abs(Number(r.ret ?? 0)));
    const avgWin  = winRets.length  > 0 ? winRets.reduce((a, b) => a + b, 0) / winRets.length : 0;
    const avgLoss = lossRets.length > 0 ? lossRets.reduce((a, b) => a + b, 0) / lossRets.length : 0;
    // Single-source-of-truth cost fix (2026-07-22): `ret` is
    // cost_adjusted_return_pct, already net of round-trip transaction cost —
    // subtracting a further hardcoded 0.4% double-charged cost. See
    // QuantumMind_Algorithm_Analysis.md §2.4.
    const expectancy = actualWinRate * avgWin - (1 - actualWinRate) * avgLoss;

    const grossW = winRets.reduce((a, b) => a + b, 0);
    const grossL = lossRets.reduce((a, b) => a + b, 0);
    const profitFactor = grossL > 0 ? grossW / grossL : null;

    await run(
      `INSERT INTO model_calibration_buckets
         (model_name, bucket_low, bucket_high, sample_count, predicted_avg,
          actual_win_rate, calibration_error, expectancy_pct, profit_factor)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [modelName, band.low, band.high, rows.length, predictedAvg,
       actualWinRate, calibrationError, expectancy, profitFactor],
    ).catch(() => null);

    if (calibrationError > 0.15) {
      logger.warn({ job: 'calibration', modelName, band: `${band.low}-${band.high}`,
        predictedAvg: (predictedAvg * 100).toFixed(1) + '%',
        actualWinRate: (actualWinRate * 100).toFixed(1) + '%',
        error: (calibrationError * 100).toFixed(1) + '%',
        reason: 'CALIBRATION ALERT: error > 15%' });
    }
  }

  logger.info({ job: 'calibration', modelName, reason: 'Calibration buckets updated' });
}

/**
 * Get latest calibration data for the governance API.
 */
export async function getCalibrationSummary(modelName: string): Promise<{
  available: boolean; maxErrorPct: number | null; activeBuckets: number;
}> {
  const rows = await query(
    `SELECT calibration_error FROM model_calibration_buckets
     WHERE model_name=? AND sample_count >= 5
     ORDER BY evaluated_at DESC LIMIT 10`,
    [modelName],
  ).catch(() => []);

  if (rows.length === 0) return { available: false, maxErrorPct: null, activeBuckets: 0 };
  const maxError = Math.max(...rows.map(r => Number(r.calibration_error)));
  return { available: true, maxErrorPct: maxError * 100, activeBuckets: rows.length };
}
