/**
 * walkForwardEngine.ts — Phase 14: Walk-Forward Backtesting
 *
 * Uses the existing backtestEngine to replay signals in rolling windows:
 *   Train window: 12 months (used to calibrate weights/thresholds via backtest)
 *   Test window:  3 months  (out-of-sample performance)
 *   Stride:       3 months  (next window slides forward by 3 months)
 *
 * Reports per window:
 *   - Total trades, win rate, Sharpe ratio, max drawdown, avg hold days
 *   - Strategy-type breakdown (which strategy worked best in this window)
 *
 * Results stored in walk_forward_results table and exposed via API.
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export interface WalkForwardWindow {
  trainStart: string;   // ISO date
  trainEnd:   string;
  testStart:  string;
  testEnd:    string;
}

export interface WalkForwardResult {
  trainStart: string;
  trainEnd:   string;
  testStart:  string;
  testEnd:    string;
  totalTrades: number;
  winRate: number;          // 0–1
  sharpeRatio: number | null;
  maxDrawdownPct: number;
  avgHoldDays: number;
  strategyBreakdown: Record<string, { trades: number; winRate: number }>;
  // Phase 15: Expectancy metrics
  expectancyPct: number;    // win_rate × avg_win - loss_rate × avg_loss - costs
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null; // total_wins / total_losses (gross)
  maxConsecutiveLosses: number;
  embargoDays: number;      // recorded for audit
}

const EMBARGO_TRADING_DAYS = 20; // ~4 calendar weeks
const CALENDAR_DAYS_PER_TRADING_DAY = 1.4; // approximation

/**
 * Phase 15: Generate purged walk-forward windows with embargo gap.
 *
 * Uses EXPANDING train window (all history to train_end) rather than rolling,
 * so older regime data is preserved. A 20-trading-day embargo (~28 calendar days)
 * is inserted between train_end and test_start to prevent label leakage from
 * overlapping forward-return periods.
 *
 * Structure:
 *   Train: dataStart → trainEnd (expanding)
 *   Embargo: trainEnd → embargoEnd (20 trading days ≈ 28 calendar days)
 *   Test: embargoEnd → testEnd (3 months)
 *   Stride: 3 months forward
 */
export function generateWindows(
  dataStartDate: Date,
  endDate: Date = new Date(),
  testMonths = 3,
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  const embargoDays = Math.ceil(EMBARGO_TRADING_DAYS * CALENDAR_DAYS_PER_TRADING_DAY);

  // First test window starts at: dataStart + 6 months minimum train period + embargo
  let trainEnd = new Date(dataStartDate);
  trainEnd.setMonth(trainEnd.getMonth() + 6); // minimum 6 months training data

  while (true) {
    const embargoEnd = new Date(trainEnd);
    embargoEnd.setDate(embargoEnd.getDate() + embargoDays);

    const testEnd = new Date(embargoEnd);
    testEnd.setMonth(testEnd.getMonth() + testMonths);
    if (testEnd > endDate) break;

    windows.push({
      trainStart: dataStartDate.toISOString().slice(0, 10),
      trainEnd:   trainEnd.toISOString().slice(0, 10),
      testStart:  embargoEnd.toISOString().slice(0, 10),
      testEnd:    testEnd.toISOString().slice(0, 10),
    });

    // Stride: advance trainEnd by testMonths
    trainEnd.setMonth(trainEnd.getMonth() + testMonths);
  }
  return windows;
}

/**
 * Evaluate a single test window using resolved signal_patterns as proxy trades.
 * Uses the signal_patterns table (already has outcome='WIN'/'LOSS' with pnl).
 */
async function evaluateWindow(
  portfolioId: number,
  win: WalkForwardWindow,
): Promise<WalkForwardResult | null> {
  const rows = await query(
    `SELECT outcome, realized_pnl_pct, strategy_type, created_at
     FROM signal_patterns
     WHERE portfolio_id = ?
       AND action = 'BUY'
       AND outcome IN ('WIN','LOSS')
       AND created_at >= ?
       AND created_at < ?
     ORDER BY created_at ASC`,
    [portfolioId, win.testStart, win.testEnd],
  ).catch(() => []);

  if (rows.length === 0) return null;

  const wins   = rows.filter(r => r.outcome === 'WIN');
  const winRate = wins.length / rows.length;

  // Sharpe approximation: mean return / stdev of returns × sqrt(252/avgHoldDays)
  const returns = rows.map(r => Number(r.realized_pnl_pct ?? 0) / 100);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdev = Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / Math.max(1, returns.length - 1));
  const sharpeRatio = stdev > 0 ? (meanReturn / stdev) * Math.sqrt(252) : null;

  // Max drawdown: simulate cumulative NAV
  let nav = 1.0, peak = 1.0, maxDd = 0;
  for (const ret of returns) {
    nav *= (1 + ret);
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  // Per-strategy breakdown
  const stratMap: Record<string, { trades: number; wins: number }> = {};
  for (const r of rows) {
    const st = (r.strategy_type as string | null) ?? 'UNKNOWN';
    if (!stratMap[st]) stratMap[st] = { trades: 0, wins: 0 };
    stratMap[st].trades++;
    if (r.outcome === 'WIN') stratMap[st].wins++;
  }
  const strategyBreakdown: Record<string, { trades: number; winRate: number }> = {};
  for (const [k, v] of Object.entries(stratMap)) {
    strategyBreakdown[k] = { trades: v.trades, winRate: v.trades > 0 ? v.wins / v.trades : 0 };
  }

  // Expectancy metrics
  const winReturns  = rows.filter(r => r.outcome === 'WIN').map(r => Number(r.realized_pnl_pct ?? 0));
  const lossReturns = rows.filter(r => r.outcome === 'LOSS').map(r => Number(r.realized_pnl_pct ?? 0));
  const avgWinPct  = winReturns.length  > 0 ? winReturns.reduce((a, b) => a + b, 0)  / winReturns.length  : 0;
  const avgLossPct = lossReturns.length > 0 ? Math.abs(lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length) : 0;
  // Single-source-of-truth cost fix (2026-07-22): realized_pnl_pct is already
  // net of the actual itemized round-trip transaction cost (see
  // tradingEngine.executeTrade / tradingCosts.ts) — subtracting a further
  // hardcoded 0.4% here double-charged cost and disagreed with the ledger's
  // real cost model. See QuantumMind_Algorithm_Analysis.md §2.4.
  const expectancyPct = winRate * avgWinPct - (1 - winRate) * avgLossPct;

  const grossWins  = winReturns.reduce((a, b)  => a + b, 0);
  const grossLoss  = lossReturns.reduce((a, b) => a + Math.abs(b), 0);
  const profitFactor = grossLoss > 0 ? grossWins / grossLoss : null;

  // Max consecutive losses
  let maxConsecLoss = 0, consecLoss = 0;
  for (const r of rows) {
    if (r.outcome === 'LOSS') { consecLoss++; if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss; }
    else consecLoss = 0;
  }

  return {
    trainStart: win.trainStart, trainEnd: win.trainEnd,
    testStart: win.testStart,   testEnd: win.testEnd,
    totalTrades: rows.length,
    winRate,
    sharpeRatio,
    maxDrawdownPct: maxDd * 100,
    avgHoldDays: 5, // placeholder
    strategyBreakdown,
    expectancyPct,
    avgWinPct,
    avgLossPct,
    profitFactor,
    maxConsecutiveLosses: maxConsecLoss,
    embargoDays: 20,
  };
}

/**
 * Run all walk-forward windows for a portfolio and persist results.
 */
export async function runWalkForward(portfolioId: number): Promise<WalkForwardResult[]> {
  // Find earliest resolved pattern
  const earliest = await query(
    `SELECT MIN(created_at) as earliest FROM signal_patterns WHERE portfolio_id=? AND outcome IN ('WIN','LOSS')`,
    [portfolioId],
  ).then(r => r[0]?.earliest as string | null).catch(() => null);

  if (!earliest) {
    logger.info({ job: 'walk-forward', portfolioId, reason: 'No resolved trades — skipping' });
    return [];
  }

  const dataStart = new Date(earliest);
  const windows = generateWindows(dataStart);
  if (windows.length === 0) {
    logger.info({ job: 'walk-forward', portfolioId, reason: 'Insufficient data for walk-forward windows' });
    return [];
  }

  const results: WalkForwardResult[] = [];
  for (const win of windows) {
    const result = await evaluateWindow(portfolioId, win);
    if (!result) continue;
    results.push(result);

    await run(
      `INSERT INTO walk_forward_results
         (portfolio_id, train_start, train_end, test_start, test_end,
          total_trades, win_rate, sharpe_ratio, max_drawdown_pct, avg_hold_days, strategy_breakdown)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [portfolioId, win.trainStart, win.trainEnd, win.testStart, win.testEnd,
       result.totalTrades, result.winRate, result.sharpeRatio, result.maxDrawdownPct,
       result.avgHoldDays, JSON.stringify(result.strategyBreakdown)],
    ).catch(() => null);
  }

  logger.info({ job: 'walk-forward', portfolioId, windows: results.length, reason: 'Walk-forward complete' });
  return results;
}

/**
 * Fetch latest walk-forward results for a portfolio.
 */
export async function getWalkForwardResults(portfolioId: number): Promise<WalkForwardResult[]> {
  const rows = await query(
    `SELECT train_start, train_end, test_start, test_end,
            total_trades, win_rate, sharpe_ratio, max_drawdown_pct, avg_hold_days, strategy_breakdown
     FROM walk_forward_results
     WHERE portfolio_id=?
     ORDER BY test_start DESC LIMIT 20`,
    [portfolioId],
  ).catch(() => []);

  return rows.map(r => ({
    trainStart: String(r.train_start),
    trainEnd:   String(r.train_end),
    testStart:  String(r.test_start),
    testEnd:    String(r.test_end),
    totalTrades: Number(r.total_trades),
    winRate: Number(r.win_rate),
    sharpeRatio: r.sharpe_ratio != null ? Number(r.sharpe_ratio) : null,
    maxDrawdownPct: Number(r.max_drawdown_pct),
    avgHoldDays: Number(r.avg_hold_days),
    strategyBreakdown: (() => { try { return JSON.parse(String(r.strategy_breakdown ?? '{}')); } catch { return {}; } })(),
    expectancyPct: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: null, maxConsecutiveLosses: 0, embargoDays: 20,
  }));
}
