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
import { SIGNAL_SOURCES, ALL_SIGNAL_SOURCES } from './adaptiveEngine.js';

// P0.1/P0.2 fix (2026-07-22): this used to map to 'rsi'/'momentum'/'range'/
// 'combined' (lowercase, backtest-specific names) while the live engine read
// weights via w('RSI') (uppercase) — the two never matched, so the backtest
// bootstrap silently never influenced live scoring. Now maps onto the same
// canonical SIGNAL_SOURCES used by tradingEngine.ts and adaptiveEngine.ts.
// rsi_oversold + momentum_breakout + combined all map to the live engine's
// blended trend_composite (RSI/MACD/EMA/momentum); range_low maps to
// price_action (52W range is part of that composite in the live engine).
const SIGNAL_TYPE_MAP: Record<string, string> = {
  rsi_oversold:       SIGNAL_SOURCES.TREND_COMPOSITE,
  momentum_breakout:  SIGNAL_SOURCES.TREND_COMPOSITE,
  range_low:          SIGNAL_SOURCES.PRICE_ACTION,
  combined:           SIGNAL_SOURCES.TREND_COMPOSITE,
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
  summary: { totalSignals: number; wins: number; winRate: number }
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
  /** P1.9 fix: surfaced from runBacktest() so any caller of this bootstrap
   * (admin API, scheduled job logs) sees the look-ahead-bias caveat instead
   * of it being buried in a source comment. */
  lookAheadBiasWarning: string | null;
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
  const { summaries, totalSignalsProcessed, lookAheadBiasWarning } = await runBacktest(symbols);
  if (lookAheadBiasWarning) {
    logger.warn({ reason: `[BacktestWeights] ${lookAheadBiasWarning}` });
  }

  // Step 3: Write weights.
  // P0.1/P0.2 fix (2026-07-22): multiple backtest signal types now map onto
  // the same canonical live source (rsi_oversold/momentum_breakout/combined
  // all → trend_composite), so they're aggregated here first — otherwise
  // upserting each in a loop with INSERT OR REPLACE would just clobber the
  // previous one and silently drop most of the backtest evidence.
  const bySource = new Map<string, { totalSignals: number; wins: number; losses: number }>();
  for (const summary of summaries) {
    const source = SIGNAL_TYPE_MAP[summary.signalType];
    if (!source) continue;
    const agg = bySource.get(source) ?? { totalSignals: 0, wins: 0, losses: 0 };
    agg.totalSignals += summary.totalSignals;
    agg.wins += summary.wins;
    agg.losses += summary.losses;
    bySource.set(source, agg);
  }

  let weightsWritten = 0;
  for (const [source, agg] of bySource) {
    if (agg.totalSignals < 10) {
      logger.warn({ reason: `[BacktestWeights] ${source}: too few signals (${agg.totalSignals}), skipping` });
      continue;
    }
    const winRate = agg.totalSignals > 0 ? agg.wins / agg.totalSignals : 0.5;
    await upsertWeight(source, { totalSignals: agg.totalSignals, wins: agg.wins, winRate });
    weightsWritten++;
  }

  // Ensure all expected signal_weights rows exist (init missing ones to 1.0).
  // 'valuation', 'news_sentiment', and 'news_llm' have no backtest coverage
  // (backtestEngine.ts only replays RSI/momentum/range technical signals —
  // see P1.8/§3.3 in QuantumMind_Algorithm_Analysis.md for the broader gap
  // that the backtest doesn't replay the full live generateSignal() pipeline)
  // so those three always start neutral at 1.0 and are only ever updated by
  // the live adaptiveEngine.recalibrateWeights() feedback loop.
  const existingSources = (await query('SELECT source FROM signal_weights')).map((r: any) => r.source as string);
  const allExpected = ALL_SIGNAL_SOURCES;
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
    lookAheadBiasWarning,
  };
}
