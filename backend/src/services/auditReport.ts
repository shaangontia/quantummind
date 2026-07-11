/**
 * auditReport.ts — Phase 18: Daily operational audit + paper-vs-backtest drift
 *
 * Surfaces operational health at a glance:
 * - Trades today (BUY/SELL count, kill-switch events, DEDUP_BLOCKED)
 * - Missing exit plans
 * - Exit types that fired (stop-loss, trailing, etc.)
 * - Paper-vs-backtest drift: live resolved outcomes vs most recent WF window
 */

import { query, queryOne } from '../db/turso.js';

// ─── Daily audit report ───────────────────────────────────────────────────────

export interface DailyAuditReport {
  date: string;
  portfolioId: number;
  trades: {
    buys: number;
    sells: number;
    dedupBlocked: number;
    emergencyLiquidations: number;
  };
  signals: {
    evaluated: number;
    skipped: number;
    vetoed: number;
  };
  exits: {
    stopLoss: number;
    trailingStop: number;
    timeStop: number;
    profitTarget: number;
    thesisInvalidated: number;
    regimeExit: number;
  };
  killSwitchEvents: {
    dailyHalt: boolean;
    weeklyHalt: boolean;
    drawdownPause: boolean;
    drawdownProtection: boolean;
    consecutiveLossCooldown: boolean;
    dataStaleHalt: boolean;
    circuitBreaker: boolean;
  };
  openPositions: number;
  missingExitPlans: number;
  cashBalance: number;
  totalNAV: number;
  dailyPnlPct: number | null;
}

export async function getDailyAuditReport(portfolioId: number): Promise<DailyAuditReport> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  const [trades, signals, holdingsRaw, ksRow, snapshots, portfolio] = await Promise.all([
    query(
      `SELECT action, reason FROM trades WHERE portfolio_id=? AND created_at >= ?`,
      [portfolioId, todayStr],
    ),
    query(
      `SELECT signal_type, acted_upon, reason FROM market_signals WHERE portfolio_id=? AND created_at >= ?`,
      [portfolioId, todayStr],
    ),
    query('SELECT atr_stop_price FROM holdings WHERE portfolio_id=?', [portfolioId]),
    queryOne(
      `SELECT daily_loss_halted, weekly_loss_halted, drawdown_paused, drawdown_protection,
              cooldown_active, data_stale_halted, circuit_breaker_active
       FROM kill_switch_state WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null),
    query(
      `SELECT total_portfolio_value FROM performance_snapshots
       WHERE portfolio_id=? AND created_at >= ? ORDER BY created_at ASC`,
      [portfolioId, todayStr],
    ),
    queryOne('SELECT current_cash FROM portfolios WHERE id=?', [portfolioId]),
  ]);

  const buys  = trades.filter(t => t.action === 'BUY').length;
  const sells = trades.filter(t => t.action === 'SELL').length;
  const dedupBlocked       = trades.filter(t => String(t.reason ?? '').includes('DEDUP_BLOCKED')).length;
  const emergencyLiquidations = trades.filter(t => String(t.reason ?? '').includes('Emergency liquidation')).length;

  // Exit type breakdown from trade reasons
  const exitCounts = {
    stopLoss:          trades.filter(t => String(t.reason ?? '').includes('Stop-loss') || String(t.reason ?? '').includes('ATR stop')).length,
    trailingStop:      trades.filter(t => String(t.reason ?? '').includes('Trailing stop')).length,
    timeStop:          trades.filter(t => String(t.reason ?? '').includes('Time stop')).length,
    profitTarget:      trades.filter(t => String(t.reason ?? '').includes('profit target')).length,
    thesisInvalidated: trades.filter(t => String(t.reason ?? '').includes('thesis invalidated')).length,
    regimeExit:        trades.filter(t => String(t.reason ?? '').includes('regime')).length,
  };

  const evaluated = signals.length;
  const skipped   = signals.filter(s => s.acted_upon === 0 || s.acted_upon === false).length;
  const vetoed    = signals.filter(s => String(s.reason ?? '').toLowerCase().includes('veto')).length;

  const missingExitPlans = holdingsRaw.filter(h => h.atr_stop_price === null || h.atr_stop_price === undefined).length;

  const cashBalance = Number(portfolio?.current_cash ?? 0);
  const nav = snapshots.length > 0
    ? Number(snapshots[snapshots.length - 1].total_portfolio_value)
    : cashBalance;

  let dailyPnlPct: number | null = null;
  if (snapshots.length >= 2) {
    const start = Number(snapshots[0].total_portfolio_value);
    const end   = Number(snapshots[snapshots.length - 1].total_portfolio_value);
    dailyPnlPct = start > 0 ? ((end - start) / start) * 100 : null;
  }

  return {
    date: today.toISOString().slice(0, 10),
    portfolioId,
    trades: { buys, sells, dedupBlocked, emergencyLiquidations },
    signals: { evaluated, skipped, vetoed },
    exits: exitCounts,
    killSwitchEvents: {
      dailyHalt:            ksRow ? Number(ksRow.daily_loss_halted  ?? 0) === 1 : false,
      weeklyHalt:           ksRow ? Number(ksRow.weekly_loss_halted ?? 0) === 1 : false,
      drawdownPause:        ksRow ? Number(ksRow.drawdown_paused    ?? 0) === 1 : false,
      drawdownProtection:   ksRow ? Number(ksRow.drawdown_protection ?? 0) === 1 : false,
      consecutiveLossCooldown: ksRow ? Number(ksRow.cooldown_active ?? 0) === 1 : false,
      dataStaleHalt:        ksRow ? Number(ksRow.data_stale_halted  ?? 0) === 1 : false,
      circuitBreaker:       ksRow ? Number(ksRow.circuit_breaker_active ?? 0) === 1 : false,
    },
    openPositions: holdingsRaw.length,
    missingExitPlans,
    cashBalance,
    totalNAV: nav,
    dailyPnlPct,
  };
}

// ─── Paper-vs-backtest drift report ──────────────────────────────────────────

export interface DriftReport {
  portfolioId: number;
  period: { start: string; end: string };
  live: {
    resolvedTrades: number;
    winRate: number | null;
    expectancyPct: number | null;
    profitFactor: number | null;
  };
  backtest: {
    windowStart: string | null;
    windowEnd: string | null;
    winRate: number | null;
    expectancyPct: number | null;
    profitFactor: number | null;
  };
  drift: {
    winRateDrift: number | null;     // live - backtest (percentage points)
    expectancyDrift: number | null;  // live - backtest (pct)
    profitFactorDrift: number | null;
    isSignificant: boolean;          // any drift > ±15%
    driftFlags: string[];
  };
}

const DRIFT_THRESHOLD = 15; // flag when live metric drifts > ±15% from backtest

export async function getDriftReport(portfolioId: number): Promise<DriftReport> {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const periodStart = threeMonthsAgo.toISOString();
  const periodEnd   = new Date().toISOString();

  // ── Live resolved trades (signal_patterns with outcome) ──────────────────
  const liveResolved = await query(
    `SELECT outcome, pnl_pct FROM signal_patterns
     WHERE portfolio_id=? AND resolved=1 AND resolved_at >= ?`,
    [portfolioId, periodStart],
  ).catch(() => []);

  const wins  = liveResolved.filter(r => r.outcome === 'WIN');
  const losses = liveResolved.filter(r => r.outcome === 'LOSS');
  const liveWinRate = liveResolved.length > 0 ? wins.length / liveResolved.length : null;
  const avgWin  = wins.length  > 0 ? wins.reduce((s, r) => s + Number(r.pnl_pct ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + Math.abs(Number(r.pnl_pct ?? 0)), 0) / losses.length : 0;
  const liveExpectancy = liveWinRate !== null && liveResolved.length >= 5
    ? (liveWinRate * avgWin) - ((1 - liveWinRate) * avgLoss) - 0.4  // 0.4% cost
    : null;
  const grossWin  = wins.reduce((s, r) => s + Number(r.pnl_pct ?? 0), 0);
  const grossLoss = losses.reduce((s, r) => s + Math.abs(Number(r.pnl_pct ?? 0)), 0);
  const livePF = grossLoss > 0 ? grossWin / grossLoss : null;

  // ── Most recent WF window ─────────────────────────────────────────────────
  const wfRow = await queryOne(
    `SELECT test_start, test_end, win_rate, expectancy_pct, profit_factor
     FROM walk_forward_results WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 1`,
    [portfolioId],
  ).catch(() => null);

  // ── Drift computation ─────────────────────────────────────────────────────
  const driftFlags: string[] = [];
  let winRateDrift: number | null = null;
  let expectancyDrift: number | null = null;
  let profitFactorDrift: number | null = null;

  if (liveWinRate !== null && wfRow?.win_rate != null) {
    winRateDrift = (liveWinRate * 100) - (Number(wfRow.win_rate) * 100);
    if (Math.abs(winRateDrift) > DRIFT_THRESHOLD) driftFlags.push(`Win rate drift ${winRateDrift.toFixed(1)}pp vs backtest`);
  }
  if (liveExpectancy !== null && wfRow?.expectancy_pct != null) {
    expectancyDrift = liveExpectancy - Number(wfRow.expectancy_pct);
    if (Math.abs(expectancyDrift) > DRIFT_THRESHOLD) driftFlags.push(`Expectancy drift ${expectancyDrift.toFixed(1)}% vs backtest`);
  }
  if (livePF !== null && wfRow?.profit_factor != null) {
    profitFactorDrift = livePF - Number(wfRow.profit_factor);
    if (Math.abs(profitFactorDrift) > 1.0) driftFlags.push(`Profit factor drift ${profitFactorDrift.toFixed(2)} vs backtest`);
  }

  return {
    portfolioId,
    period: { start: periodStart, end: periodEnd },
    live: {
      resolvedTrades: liveResolved.length,
      winRate: liveWinRate !== null ? Math.round(liveWinRate * 1000) / 10 : null,
      expectancyPct: liveExpectancy !== null ? Math.round(liveExpectancy * 100) / 100 : null,
      profitFactor: livePF !== null ? Math.round(livePF * 100) / 100 : null,
    },
    backtest: {
      windowStart: wfRow?.test_start ? String(wfRow.test_start) : null,
      windowEnd:   wfRow?.test_end   ? String(wfRow.test_end)   : null,
      winRate:     wfRow?.win_rate   != null ? Number(wfRow.win_rate) * 100 : null,
      expectancyPct: wfRow?.expectancy_pct != null ? Number(wfRow.expectancy_pct) : null,
      profitFactor: wfRow?.profit_factor != null ? Number(wfRow.profit_factor) : null,
    },
    drift: {
      winRateDrift,
      expectancyDrift,
      profitFactorDrift,
      isSignificant: driftFlags.length > 0,
      driftFlags,
    },
  };
}
