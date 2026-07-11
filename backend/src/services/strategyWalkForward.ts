/**
 * strategyWalkForward.ts — Phase 16: Per-strategy walk-forward validation
 *
 * Splits walk-forward results by strategy_type (MEAN_REVERSION, MOMENTUM, VALUE, NEWS_CATALYST).
 * A strategy is auto-disabled when expectancy is negative for 3+ consecutive test windows.
 *
 * Per-strategy metrics:
 *   win_rate, expectancy_pct, profit_factor, max_consecutive_losses, avg_mae, avg_mfe
 *
 * This prevents global positive expectancy masking a losing strategy.
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export type StrategyType = 'MEAN_REVERSION' | 'MOMENTUM' | 'VALUE' | 'NEWS_CATALYST' | 'UNKNOWN';

export interface StrategyWFResult {
  strategyType: StrategyType;
  testStart: string;
  testEnd: string;
  candidateCount: number;
  winRate: number;
  expectancyPct: number;
  profitFactor: number | null;
  maxConsecutiveLosses: number;
  avgMaePct: number;
  avgMfePct: number;
  autoDisabled: boolean;
}

const TRADE_COSTS_PCT = 0.004;
const CONSECUTIVE_NEGATIVE_DISABLE = 3; // disable after 3 consecutive negative-expectancy windows

/**
 * Evaluate strategy-level metrics for a given test window.
 * Uses trade_candidates (EXECUTED, labelled) as primary; falls back to signal_patterns.
 */
async function evaluateStrategyWindow(
  portfolioId: number,
  strategy: StrategyType,
  testStart: string,
  testEnd: string,
): Promise<StrategyWFResult | null> {
  // Primary: trade_candidates with TARGET_BEFORE_STOP labels
  let rows = await query(
    `SELECT target_hit_before_stop as win_int, cost_adjusted_return_pct as ret,
            max_adverse_excursion_pct as mae, max_favorable_excursion_pct as mfe
     FROM trade_candidates
     WHERE portfolio_id=? AND strategy_type=? AND action_taken='EXECUTED'
       AND label_type='TARGET_BEFORE_STOP' AND label_status='FINAL'
       AND evaluated_at >= ? AND evaluated_at < ?`,
    [portfolioId, strategy, testStart, testEnd],
  ).catch(() => []);

  // Fallback: signal_patterns
  if (rows.length === 0) {
    rows = await query(
      `SELECT (CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as win_int,
              realized_pnl_pct as ret, 0 as mae, 0 as mfe
       FROM signal_patterns
       WHERE portfolio_id=? AND strategy_type=? AND outcome IN ('WIN','LOSS')
         AND created_at >= ? AND created_at < ?`,
      [portfolioId, strategy, testStart, testEnd],
    ).catch(() => []);
  }

  if (rows.length === 0) return null;

  const wins = rows.filter(r => Number(r.win_int) === 1);
  const losses = rows.filter(r => Number(r.win_int) === 0);
  const winRate = wins.length / rows.length;

  const avgWin   = wins.length   > 0 ? wins.reduce((s, r) => s + Number(r.ret ?? 0), 0) / wins.length : 0;
  const avgLoss  = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + Number(r.ret ?? 0), 0) / losses.length) : 0;
  const expectancyPct = winRate * avgWin - (1 - winRate) * avgLoss - TRADE_COSTS_PCT * 100;

  const grossWins = wins.reduce((s, r) => s + Number(r.ret ?? 0), 0);
  const grossLoss = losses.reduce((s, r) => s + Math.abs(Number(r.ret ?? 0)), 0);
  const profitFactor = grossLoss > 0 ? grossWins / grossLoss : null;

  let maxCL = 0, cl = 0;
  for (const r of rows) {
    if (Number(r.win_int) === 0) { cl++; if (cl > maxCL) maxCL = cl; }
    else cl = 0;
  }

  const avgMae = rows.reduce((s, r) => s + Number(r.mae ?? 0), 0) / rows.length;
  const avgMfe = rows.reduce((s, r) => s + Number(r.mfe ?? 0), 0) / rows.length;

  return {
    strategyType: strategy,
    testStart, testEnd,
    candidateCount: rows.length,
    winRate,
    expectancyPct,
    profitFactor,
    maxConsecutiveLosses: maxCL,
    avgMaePct: avgMae,
    avgMfePct: avgMfe,
    autoDisabled: false,
  };
}

/**
 * Run strategy-level walk-forward for a portfolio and persist results.
 * Also checks auto-disable rule.
 */
export async function runStrategyWalkForward(portfolioId: number): Promise<void> {
  const strategies: StrategyType[] = ['MEAN_REVERSION', 'MOMENTUM', 'VALUE', 'NEWS_CATALYST'];

  // Fetch all WF windows for this portfolio
  const wfWindows = await query(
    `SELECT DISTINCT test_start, test_end FROM walk_forward_results
     WHERE portfolio_id=? ORDER BY test_start ASC`,
    [portfolioId],
  ).catch(() => []);

  if (wfWindows.length === 0) return;

  for (const strategy of strategies) {
    const results: StrategyWFResult[] = [];

    for (const win of wfWindows) {
      const result = await evaluateStrategyWindow(
        portfolioId, strategy, String(win.test_start), String(win.test_end),
      );
      if (!result) continue;
      results.push(result);
    }

    // Check auto-disable: 3+ consecutive negative expectancy windows
    let consecutiveNegative = 0;
    let shouldDisable = false;
    for (const r of results) {
      if (r.expectancyPct < 0) {
        consecutiveNegative++;
        if (consecutiveNegative >= CONSECUTIVE_NEGATIVE_DISABLE) { shouldDisable = true; break; }
      } else {
        consecutiveNegative = 0;
      }
    }

    // Persist latest window result
    if (results.length > 0) {
      const latest = results[results.length - 1];
      await run(
        `INSERT INTO strategy_wf_results
           (portfolio_id, strategy_type, test_start, test_end, candidate_count,
            win_rate, expectancy_pct, profit_factor, max_consecutive_losses,
            avg_mae_pct, avg_mfe_pct, auto_disabled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [portfolioId, strategy, latest.testStart, latest.testEnd, latest.candidateCount,
         latest.winRate, latest.expectancyPct, latest.profitFactor, latest.maxConsecutiveLosses,
         latest.avgMaePct, latest.avgMfePct, shouldDisable ? 1 : 0],
      ).catch(() => null);

      if (shouldDisable) {
        logger.warn({ job: 'strategy-wf', portfolioId, strategy,
          reason: `Auto-disabled: negative expectancy for ${CONSECUTIVE_NEGATIVE_DISABLE}+ consecutive windows` });
      }
    }
  }
}

/**
 * Get latest strategy-level walk-forward results for a portfolio.
 */
export async function getStrategyWFResults(portfolioId: number): Promise<StrategyWFResult[]> {
  const rows = await query(
    `SELECT strategy_type, test_start, test_end, candidate_count,
            win_rate, expectancy_pct, profit_factor, max_consecutive_losses,
            avg_mae_pct, avg_mfe_pct, auto_disabled
     FROM strategy_wf_results
     WHERE portfolio_id=?
       AND (strategy_type, test_start) IN (
         SELECT strategy_type, MAX(test_start) FROM strategy_wf_results
         WHERE portfolio_id=? GROUP BY strategy_type
       )`,
    [portfolioId, portfolioId],
  ).catch(() => []);

  return rows.map(r => ({
    strategyType: r.strategy_type as StrategyType,
    testStart: String(r.test_start),
    testEnd: String(r.test_end),
    candidateCount: Number(r.candidate_count),
    winRate: Number(r.win_rate),
    expectancyPct: Number(r.expectancy_pct),
    profitFactor: r.profit_factor != null ? Number(r.profit_factor) : null,
    maxConsecutiveLosses: Number(r.max_consecutive_losses),
    avgMaePct: Number(r.avg_mae_pct),
    avgMfePct: Number(r.avg_mfe_pct),
    autoDisabled: Boolean(r.auto_disabled),
  }));
}

/**
 * Get set of auto-disabled strategies for a portfolio (for regime gate integration).
 */
export async function getDisabledStrategies(portfolioId: number): Promise<Set<string>> {
  const rows = await query(
    `SELECT DISTINCT strategy_type FROM strategy_wf_results
     WHERE portfolio_id=? AND auto_disabled=1
       AND test_start = (SELECT MAX(test_start) FROM strategy_wf_results WHERE portfolio_id=?)`,
    [portfolioId, portfolioId],
  ).catch(() => []);
  return new Set(rows.map(r => String(r.strategy_type)));
}
