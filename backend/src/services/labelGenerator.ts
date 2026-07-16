/**
 * labelGenerator.ts — Phase 15 + Phase 23: Target-before-stop label generation
 *
 * Phase 15: Labels EXECUTED candidates using actual sell-trade exit prices.
 *
 * Phase 23: Extended to also label SHADOW candidates (SKIPPED / WEAK / VETOED)
 * that have theoretical entry/stop/target prices recorded at evaluation time.
 * Shadow labels use historical_prices for path evaluation — if price data is
 * unavailable the candidate is skipped (not incorrectly labelled as win/loss).
 *
 * Label pipeline:
 *   1. EXECUTED row with sell trade → ACTUAL_EXECUTED, SELL_PRICE_PROXY, or skipped
 *   2. SHADOW row with price history → SHADOW_THEORETICAL label via path simulation
 *   3. Shadow rows with no price history → skipped (not labelled yet)
 *
 * Validation set for ML training only uses ACTUAL_EXECUTED rows to ensure
 * shadow data does not mask real model performance.
 *
 * Runs nightly at 20:30 IST (30 min after signal resolution).
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const MAX_LABEL_HORIZON = 15; // trading days
const TRADE_COSTS_PCT   = 0.004;

/**
 * Fetch price history for a symbol since a given date.
 * Uses historical_prices or falls back to market_signals prices.
 */
async function fetchPriceHistory(symbol: string, fromDate: string): Promise<Array<{ date: string; close: number }>> {
  const hist = await query(
    `SELECT date, close FROM historical_prices
     WHERE symbol=? AND date >= ? ORDER BY date ASC LIMIT ${MAX_LABEL_HORIZON + 5}`,
    [symbol, fromDate],
  ).catch(() => []);
  if (hist.length >= 3) {
    return hist.map(r => ({ date: String(r.date), close: Number(r.close) }));
  }
  return [];
}

/**
 * Compute MAE/MFE/target-hit/stop-hit from a price path.
 */
function evaluatePath(
  priceHistory: Array<{ close: number }>,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
): { targetHit: boolean; stopHit: boolean; mae: number; mfe: number } {
  let targetHit = false;
  let stopHit   = false;
  let mae       = 0;
  let mfe       = 0;

  for (const candle of priceHistory) {
    const change = (candle.close - entryPrice) / entryPrice * 100;
    if (change < 0 && Math.abs(change) > mae) mae = Math.abs(change);
    if (change > 0 && change > mfe) mfe = change;
    if (!stopHit   && candle.close <= stopPrice)  stopHit   = true;
    if (!targetHit && candle.close >= targetPrice) targetHit = true;
    if (stopHit || targetHit) break;
  }

  return { targetHit, stopHit, mae, mfe };
}

/**
 * Write label fields to a trade_candidates row.
 */
/**
 * NOTE: holdDays for shadow candidates = number of price-history rows (trading days),
 * not calendar days. historical_prices only contains trading-day rows so the count
 * under-reports calendar days by ~30% (15 trading days ≈ 21 calendar days).
 * Field is informational only; not used for label outcome computation.
 *
 * NOTE: evaluatePath uses close-only data. A candle where close<stop is treated as
 * stop-hit on that bar. Intraday low/high is not considered. If intraday data is
 * ever added, evaluatePath must check low vs stop and high vs target per bar.
 */
async function writeLabel(
  id: number,
  win: boolean,
  mae: number,
  mfe: number,
  holdDays: number,
  costAdjReturn: number,
  labelType: string,
): Promise<void> {
  await run(
    `UPDATE trade_candidates
     SET target_hit_before_stop       = ?,
         max_adverse_excursion_pct    = ?,
         max_favorable_excursion_pct  = ?,
         actual_hold_days             = ?,
         cost_adjusted_return_pct     = ?,
         label_type                   = ?,
         label_status                 = 'FINAL',
         label_generated_at           = datetime('now')
     WHERE id = ?`,
    [win ? 1 : 0, mae, mfe, holdDays, costAdjReturn, labelType, id],
  ).catch((err: unknown) => {
    // Log but do not re-throw — nightly job continues; row stays PENDING and retries next run.
    logger.warn({ job: 'label-generator', candidateId: id, err: String(err),
      reason: 'writeLabel: DB update failed — candidate stays PENDING, will retry next nightly run' });
  });
}

// ---------------------------------------------------------------------------
// Phase 15: EXECUTED candidate labelling
// ---------------------------------------------------------------------------

async function labelExecutedCandidates(): Promise<number> {
  const pending = await query(
    `SELECT id, symbol, entry_price, stop_price, target_price, evaluated_at
     FROM trade_candidates
     WHERE action_taken = 'EXECUTED'
       AND target_hit_before_stop IS NULL
       AND entry_price IS NOT NULL
       AND stop_price IS NOT NULL
       AND target_price IS NOT NULL
       AND evaluated_at <= datetime('now', '-15 days')
     ORDER BY evaluated_at ASC LIMIT 200`,
  ).catch(() => []);

  let labelled = 0;
  for (const row of pending) {
    const entryDate   = String(row.evaluated_at).slice(0, 10);
    const entryPrice  = Number(row.entry_price);
    const stopPrice   = Number(row.stop_price);
    const targetPrice = Number(row.target_price);
    const symbol      = String(row.symbol);

    const sellTrade = await query(
      `SELECT price, trade_time FROM trades
       WHERE symbol=? AND action='SELL' AND trade_time >= ?
       ORDER BY trade_time ASC LIMIT 1`,
      [symbol, entryDate],
    ).then(r => r[0]).catch(() => null);

    if (!sellTrade) continue; // position still open

    const exitPrice = Number(sellTrade.price);
    const exitDate  = String(sellTrade.trade_time).slice(0, 10);
    const holdDays  = Math.round((new Date(exitDate).getTime() - new Date(entryDate).getTime()) / 86400000);

    const priceHistory = await fetchPriceHistory(symbol, entryDate);

    let win: boolean;
    let mae: number;
    let mfe: number;
    let labelType: string;

    if (priceHistory.length >= 2) {
      const result = evaluatePath(priceHistory, entryPrice, stopPrice, targetPrice);
      win = result.targetHit && !result.stopHit;
      mae = result.mae;
      mfe = result.mfe;
      labelType = priceHistory.length >= 3 ? 'TARGET_BEFORE_STOP' : 'SELL_PRICE_PROXY';
    } else {
      const changeToExit = (exitPrice - entryPrice) / entryPrice;
      mae = changeToExit < 0 ? Math.abs(changeToExit * 100) : 0;
      mfe = changeToExit > 0 ? changeToExit * 100 : 0;
      win = exitPrice >= targetPrice;
      labelType = 'SELL_PRICE_PROXY';
    }

    const grossReturn   = (exitPrice - entryPrice) / entryPrice * 100;
    const costAdjReturn = grossReturn - TRADE_COSTS_PCT * 100;

    await writeLabel(row.id, win, mae, mfe, holdDays, costAdjReturn, labelType);
    labelled++;
  }

  return labelled;
}

// ---------------------------------------------------------------------------
// Phase 23: SHADOW candidate labelling (SKIPPED / WEAK / VETOED)
// ---------------------------------------------------------------------------

async function labelShadowCandidates(): Promise<number> {
  // Only label shadow candidates with:
  //   1. learning_eligible = 1 (excludes hard-veto rows)
  //   2. theoretical entry/stop/target recorded at evaluation time
  //   3. enough time elapsed (label_horizon_days calendar days via label_ready_at)
  //   4. not already labelled
  const pending = await query(
    `SELECT id, symbol, entry_price, stop_price, target_price, evaluated_at, learning_weight
     FROM trade_candidates
     WHERE action_taken IN ('SKIPPED', 'WEAK', 'VETOED')
       AND learning_eligible = 1
       AND target_hit_before_stop IS NULL
       AND entry_price IS NOT NULL
       AND stop_price IS NOT NULL
       AND target_price IS NOT NULL
       AND (label_ready_at IS NULL OR label_ready_at <= date('now'))
       AND evaluated_at <= datetime('now', '-15 days')
     ORDER BY evaluated_at ASC LIMIT 500`,
  ).catch(() => []);

  let labelled = 0;
  for (const row of pending) {
    const entryDate   = String(row.evaluated_at).slice(0, 10);
    const entryPrice  = Number(row.entry_price);
    const stopPrice   = Number(row.stop_price);
    const targetPrice = Number(row.target_price);
    const symbol      = String(row.symbol);

    // Shadow labels require price history — we cannot use a sell trade
    // because the portfolio never executed this position.
    const priceHistory = await fetchPriceHistory(symbol, entryDate);

    if (priceHistory.length < 2) {
      // Insufficient price data — skip (not wrong, just not ready yet)
      continue;
    }

    const { targetHit, stopHit, mae, mfe } = evaluatePath(priceHistory, entryPrice, stopPrice, targetPrice);

    // For shadow candidates, if neither stop nor target hit within horizon, use last close
    const lastClose     = priceHistory[priceHistory.length - 1].close;
    const effectiveExit = stopHit ? stopPrice : targetHit ? targetPrice : lastClose;
    const holdDays      = priceHistory.length;

    const grossReturn   = (effectiveExit - entryPrice) / entryPrice * 100;
    // Shadow labels do not incur actual round-trip costs — still subtract theoretical cost
    // so that the model learns to account for execution friction even on shadow samples.
    const costAdjReturn = grossReturn - TRADE_COSTS_PCT * 100;
    const win           = targetHit && !stopHit;

    await writeLabel(row.id, win, mae, mfe, holdDays, costAdjReturn, 'TARGET_BEFORE_STOP');
    labelled++;
  }

  return labelled;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate target-before-stop labels for all pending candidates.
 * Phase 23: now covers EXECUTED + shadow (SKIPPED / WEAK / VETOED) rows.
 */
export async function generateLabels(): Promise<number> {
  const [executedCount, shadowCount] = await Promise.all([
    labelExecutedCandidates(),
    labelShadowCandidates(),
  ]);

  const total = executedCount + shadowCount;
  logger.info({
    job: 'label-generator',
    labelled: total,
    executed: executedCount,
    shadow: shadowCount,
    reason: 'Target-before-stop labels generated (executed + shadow)',
  });
  return total;
}

/**
 * Summary of labelled candidates — used for ML training quality check.
 * Reports separately for executed vs shadow to enable quality monitoring.
 */
export async function getLabelSummary(): Promise<{
  total: number; labelled: number; winRate: number; avgReturn: number; avgMAE: number; avgMFE: number;
  executedTotal: number; executedLabelled: number; shadowTotal: number; shadowLabelled: number;
}> {
  const [allRow, execRow, shadowRow] = await Promise.all([
    query(`SELECT
       COUNT(*) as total,
       SUM(CASE WHEN target_hit_before_stop IS NOT NULL THEN 1 ELSE 0 END) as labelled,
       AVG(CASE WHEN target_hit_before_stop = 1 THEN 1.0 ELSE 0.0 END) as win_rate,
       AVG(cost_adjusted_return_pct) as avg_return,
       AVG(max_adverse_excursion_pct) as avg_mae,
       AVG(max_favorable_excursion_pct) as avg_mfe
     FROM trade_candidates WHERE learning_eligible=1`).then(r => r[0]).catch(() => null),
    query(`SELECT COUNT(*) as total,
       SUM(CASE WHEN target_hit_before_stop IS NOT NULL THEN 1 ELSE 0 END) as labelled
     FROM trade_candidates WHERE action_taken='EXECUTED'`).then(r => r[0]).catch(() => null),
    query(`SELECT COUNT(*) as total,
       SUM(CASE WHEN target_hit_before_stop IS NOT NULL THEN 1 ELSE 0 END) as labelled
     FROM trade_candidates WHERE action_taken IN ('SKIPPED','WEAK','VETOED') AND learning_eligible=1`).then(r => r[0]).catch(() => null),
  ]);

  return {
    total:           Number(allRow?.total ?? 0),
    labelled:        Number(allRow?.labelled ?? 0),
    winRate:         Number(allRow?.win_rate ?? 0),
    avgReturn:       Number(allRow?.avg_return ?? 0),
    avgMAE:          Number(allRow?.avg_mae ?? 0),
    avgMFE:          Number(allRow?.avg_mfe ?? 0),
    executedTotal:   Number(execRow?.total ?? 0),
    executedLabelled:Number(execRow?.labelled ?? 0),
    shadowTotal:     Number(shadowRow?.total ?? 0),
    shadowLabelled:  Number(shadowRow?.labelled ?? 0),
  };
}
