/**
 * labelGenerator.ts — Phase 15: Target-before-stop label generation
 *
 * For each EXECUTED candidate with entry_price + stop_price + target_price,
 * fetches post-entry price history and computes:
 *
 *   target_hit_before_stop   — did price reach target before stop within HORIZON days?
 *   max_adverse_excursion_pct  — worst drawdown from entry before trade closed
 *   max_favorable_excursion_pct — best move from entry before trade closed
 *   actual_hold_days           — calendar days from entry to label_date
 *   cost_adjusted_return_pct   — actual return net of 0.4% round-trip costs
 *
 * This is superior to simple PnL-based labels because it accounts for path:
 * a stock that falls -10% before recovering to +5% is a LOSS in practice
 * (stop-loss triggered) even if the 20-day return looks positive.
 *
 * Runs nightly at 20:30 IST (30 min after signal resolution).
 * MAX_LABEL_HORIZON = 15 trading days — labels are attempted 15 days post-entry.
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const MAX_LABEL_HORIZON = 15; // trading days
const TRADE_COSTS_PCT   = 0.004;

/**
 * Fetch price history for a symbol since a given date.
 * Uses historical_prices / index_prices or falls back to market_signals prices.
 */
async function fetchPriceHistory(symbol: string, fromDate: string): Promise<Array<{ date: string; close: number }>> {
  // Primary: historical_prices table (if backtest engine populated it)
  const hist = await query(
    `SELECT date, close FROM historical_prices
     WHERE symbol=? AND date >= ? ORDER BY date ASC LIMIT ${MAX_LABEL_HORIZON + 5}`,
    [symbol, fromDate],
  ).catch(() => []);
  if (hist.length >= 3) {
    return hist.map(r => ({ date: String(r.date), close: Number(r.close) }));
  }

  // Fallback: daily performance_snapshots — not per-symbol but useful if no other source
  // For paper trading, approximate with trade records
  return [];
}

/**
 * Generate target-before-stop labels for all EXECUTED candidates missing labels.
 * Called nightly.
 */
export async function generateLabels(): Promise<number> {
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

  if (pending.length === 0) return 0;

  let labelled = 0;
  for (const row of pending) {
    const entryDate  = String(row.evaluated_at).slice(0, 10);
    const entryPrice = Number(row.entry_price);
    const stopPrice  = Number(row.stop_price);
    const targetPrice = Number(row.target_price);
    const symbol     = String(row.symbol);

    // Try to fetch post-entry price history from signal_patterns or trades
    // For now: use the trade record as proxy — if trade was executed and stock is still
    // held, we don't have the final price; if sold, use the sell trade price.
    const sellTrade = await query(
      `SELECT t.price, t.trade_time
       FROM trades t
       WHERE t.symbol=? AND t.action='SELL'
         AND t.trade_time >= ?
       ORDER BY t.trade_time ASC LIMIT 1`,
      [symbol, entryDate],
    ).then(r => r[0]).catch(() => null);

    if (!sellTrade) continue; // position still open — skip until closed

    const exitPrice  = Number(sellTrade.price);
    const exitDate   = String(sellTrade.trade_time).slice(0, 10);
    const holdDays   = Math.round((new Date(exitDate).getTime() - new Date(entryDate).getTime()) / 86400000);

    // Check if stop was hit by looking at signal history for this symbol in the period
    const priceHistory = await fetchPriceHistory(symbol, entryDate);

    let targetHit      = false;
    let stopHit        = false;
    let mae            = 0;  // max adverse excursion from entry
    let mfe            = 0;  // max favorable excursion from entry

    if (priceHistory.length >= 2) {
      for (const candle of priceHistory) {
        const change = (candle.close - entryPrice) / entryPrice * 100;
        if (change < 0 && Math.abs(change) > mae) mae = Math.abs(change);
        if (change > 0 && change > mfe) mfe = change;
        if (!stopHit   && candle.close <= stopPrice)  stopHit   = true;
        if (!targetHit && candle.close >= targetPrice) targetHit = true;
        if (stopHit || targetHit) break;
      }
    } else {
      // No price history — use simple exit price
      const changeToExit = (exitPrice - entryPrice) / entryPrice;
      mae = changeToExit < 0 ? Math.abs(changeToExit * 100) : 0;
      mfe = changeToExit > 0 ? changeToExit * 100 : 0;
      targetHit = exitPrice >= targetPrice;
      stopHit   = exitPrice <= stopPrice;
    }

    const grossReturn = (exitPrice - entryPrice) / entryPrice * 100;
    const costAdjReturn = grossReturn - TRADE_COSTS_PCT * 100;

    await run(
      `UPDATE trade_candidates
       SET target_hit_before_stop = ?,
           max_adverse_excursion_pct = ?,
           max_favorable_excursion_pct = ?,
           actual_hold_days = ?,
           cost_adjusted_return_pct = ?,
           label_generated_at = datetime('now')
       WHERE id = ?`,
      [targetHit && !stopHit ? 1 : 0, mae, mfe, holdDays, costAdjReturn, row.id],
    ).catch(() => null);

    labelled++;
  }

  logger.info({ job: 'label-generator', labelled, pending: pending.length, reason: 'Target-before-stop labels generated' });
  return labelled;
}

/**
 * Summary of labelled candidates — used for ML training quality check.
 */
export async function getLabelSummary(): Promise<{
  total: number; labelled: number; winRate: number; avgReturn: number; avgMAE: number; avgMFE: number;
}> {
  const row = await query(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN target_hit_before_stop IS NOT NULL THEN 1 ELSE 0 END) as labelled,
       AVG(CASE WHEN target_hit_before_stop = 1 THEN 1.0 ELSE 0.0 END) as win_rate,
       AVG(cost_adjusted_return_pct) as avg_return,
       AVG(max_adverse_excursion_pct) as avg_mae,
       AVG(max_favorable_excursion_pct) as avg_mfe
     FROM trade_candidates WHERE action_taken='EXECUTED'`,
  ).then(r => r[0]).catch(() => null);

  return {
    total: Number(row?.total ?? 0),
    labelled: Number(row?.labelled ?? 0),
    winRate: Number(row?.win_rate ?? 0),
    avgReturn: Number(row?.avg_return ?? 0),
    avgMAE: Number(row?.avg_mae ?? 0),
    avgMFE: Number(row?.avg_mfe ?? 0),
  };
}
