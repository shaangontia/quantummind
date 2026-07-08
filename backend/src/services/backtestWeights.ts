/**
 * backtestWeights.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bootstraps signal_weights from backtest outcomes.
 *
 * Flow:
 *  1. fetchAndStoreHistory()  — download 2-yr OHLCV for NSE_UNIVERSE
 *  2. runBacktest()           — replay signals, compute win rates per type
 *  3. bootstrapSignalWeights()— write historically-learned weights to DB
 *
 * Maps backtest SignalType → signal_weights.source names used by the live engine.
 * Weight formula mirrors adaptiveEngine.ts recalibrateWeights() so live updates
 * continue seamlessly from the bootstrapped baseline.
 */

import { run, query } from '../db/turso.js';
import { fetchAndStoreHistory } from './backtestData.js';
import { runBacktest, type BacktestSummary } from './backtestEngine.js';
import { NSE_UNIVERSE } from './marketData.js';
import { logger } from '../lib/logger.js';

// Mapping from backtestEngine SignalType → signal_weights.source row
const SIGNAL_TYPE_MAP: Record<string, string> = {
  rsi_oversold:       'rsi',
  momentum_breakout:  'momentum',
  range_low:          'range',
  combined:           'combined',
};

/**
 * Compute a weight multiplier from win rate.
 * Same formula as adaptiveEngine.ts recalibrateWeights() for consistency.
 * winRate 0.6 → weight ≈ 1.4  |  winRate 0.4 → weight ≈ 0.6
 */
function winRateToWeight(winRate: number, totalSignals: number): number {
  const FULL_CONFIDENCE = 200; // backtest gives many more signals than live
  const confidence = Math.min(1.0, totalSignals / FULL_CONFIDENCE);
  const base = Math.max(0.3, Math.min(2.0, (winRate - 0.5) * 4 + 1.0));
  // Blend toward 1.0 for low confidence
  return 1.0 + (base - 1.0) * confidence;
}

/**
 * Upsert a signal_weights row with backtest-derived values.
 * Uses INSERT OR REPLACE to handle both fresh DB and existing rows.
 */
async function upsertWeight(
  source: string,
  summary: BacktestSummary
): Promise<void> {
  const weight = winRateToWeight(summary.winRate, summary.totalSignals);
  await run(
    `INSERT OR REPLACE INTO signal_weights
       (source, weight, win_rate, total_signals, winning_signals, last_updated)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      source,
      weight,
      summary.winRate,
      summary.totalSignals,
      summary.wins,
    ]
  );
  logger.info({ reason: `[BacktestWeights] ${source}: winRate=${(summary.winRate * 100).toFixed(1)}% (${summary.totalSignals} signals) => weight=${weight.toFixed(3)}` });
}

export interface BootstrapResult {
  symbolsFetched: number;
  symbolsSkipped: number;
  fetchFailed: string[];
  signalsProcessed: number;
  weightsWritten: number;
  summaries: BacktestSummary[];
}

/**
 * Full bootstrap pipeline:
 *  1. Download historical prices for NSE_UNIVERSE (skips already-stored symbols)
 *  2. Run backtest signal replay
 *  3. Write bootstrapped weights to signal_weights table
 *
 * Safe to call multiple times — skips symbols with >400 stored rows.
 * Live adaptive engine continues updating from the bootstrapped baseline.
 */
export async function bootstrapSignalWeights(
  symbolOverride?: string[]
): Promise<BootstrapResult> {
  const symbols = symbolOverride ?? NSE_UNIVERSE;
  logger.info({ reason: `[BacktestWeights] Starting bootstrap for ${symbols.length} symbols` });

  // Step 1: Fetch historical data
  const { fetched, skipped, failed } = await fetchAndStoreHistory(symbols, {
    skipExisting: true,
    delayMs: 300,
  });
  logger.info({ reason: `[BacktestWeights] Data fetch: ${fetched} new, ${skipped} skipped, ${failed.length} failed` });

  // Step 2: Run backtest
  const { summaries, totalSignalsProcessed } = await runBacktest(symbols);

  // Step 3: Write weights
  let weightsWritten = 0;
  for (const summary of summaries) {
    if (summary.totalSignals < 10) {
      logger.warn({ reason: `[BacktestWeights] ${summary.signalType}: too few signals (${summary.totalSignals}), skipping` });
      continue;
    }
    const source = SIGNAL_TYPE_MAP[summary.signalType];
    if (!source) continue;
    await upsertWeight(source, summary);
    weightsWritten++;
  }

  // Ensure all expected signal_weights rows exist (init missing ones to 1.0)
  const existingSources = (await query('SELECT source FROM signal_weights')).map((r: any) => r.source as string);
  const allExpected = ['rsi', 'momentum', 'range', 'combined', 'news', 'regime'];
  for (const src of allExpected) {
    if (!existingSources.includes(src)) {
      await run(
        `INSERT OR IGNORE INTO signal_weights (source, weight, win_rate, total_signals, winning_signals, last_updated)
         VALUES (?, 1.0, 0.5, 0, 0, CURRENT_TIMESTAMP)`,
        [src]
      );
      logger.info({ reason: `[BacktestWeights] Initialised missing source: ${src} → 1.0` });
    }
  }

  logger.info({ reason: `[BacktestWeights] Bootstrap complete — ${weightsWritten} weights written` });
  return {
    symbolsFetched: fetched,
    symbolsSkipped: skipped,
    fetchFailed: failed,
    signalsProcessed: totalSignalsProcessed,
    weightsWritten,
    summaries,
  };
}
