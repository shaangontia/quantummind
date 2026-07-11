/**
 * killSwitch.ts — Phase 13: Automated trading halt engine
 *
 * Thresholds (per architectural spec):
 *   Daily loss   > 1% NAV  → stop all new BUYs for the day
 *   Weekly loss  > 3% NAV  → halve all new position sizes
 *   Drawdown     > 8% NAV  → pause all new entries
 *   Drawdown     > 12% NAV → protection mode: close weakest positions
 */

import { query, queryOne, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export type KillSwitchState = {
  dailyLossHalted: boolean;
  weeklyLossHalted: boolean;
  drawdownPaused: boolean;
  drawdownProtection: boolean;
};

const DAILY_LOSS_LIMIT_PCT   = 1.0;   // % of NAV
const WEEKLY_LOSS_LIMIT_PCT  = 3.0;
const DRAWDOWN_PAUSE_PCT     = 8.0;
const DRAWDOWN_PROTECT_PCT   = 12.0;

/**
 * Evaluate and persist kill-switch state for a portfolio.
 * Called at the start of each market cycle before BUY scanning.
 */
export async function evaluateKillSwitch(portfolioId: number): Promise<KillSwitchState> {
  // Fetch portfolio NAV + peak for drawdown
  const port = await queryOne(
    'SELECT peak_nav FROM portfolios WHERE id=?',
    [portfolioId],
  );
  const summary = await queryOne(
    `SELECT total_portfolio_value, realized_pnl FROM (
       SELECT * FROM performance_snapshots
       WHERE portfolio_id=?
       ORDER BY created_at DESC LIMIT 1
     )`,
    [portfolioId],
  ).catch(() => null);

  const currentNav = summary ? Number(summary.total_portfolio_value) : 0;
  const peakNav = port?.peak_nav ? Number(port.peak_nav) : currentNav;
  if (peakNav <= 0 || currentNav <= 0) {
    return { dailyLossHalted: false, weeklyLossHalted: false, drawdownPaused: false, drawdownProtection: false };
  }

  // Drawdown from peak
  const drawdownPct = ((peakNav - currentNav) / peakNav) * 100;

  // Daily P&L: compare today's first vs latest snapshot
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailySnaps = await query(
    `SELECT total_portfolio_value FROM performance_snapshots
     WHERE portfolio_id=? AND created_at >= ?
     ORDER BY created_at ASC`,
    [portfolioId, todayStart.toISOString()],
  );
  let dailyLossPct = 0;
  if (dailySnaps.length >= 2) {
    const startVal = Number(dailySnaps[0].total_portfolio_value);
    const endVal   = Number(dailySnaps[dailySnaps.length - 1].total_portfolio_value);
    dailyLossPct = ((startVal - endVal) / startVal) * 100;
  }

  // Weekly P&L: compare week-start vs latest
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekSnaps = await query(
    `SELECT total_portfolio_value FROM performance_snapshots
     WHERE portfolio_id=? AND created_at >= ?
     ORDER BY created_at ASC`,
    [portfolioId, weekStart.toISOString()],
  );
  let weeklyLossPct = 0;
  if (weekSnaps.length >= 2) {
    const startVal = Number(weekSnaps[0].total_portfolio_value);
    const endVal   = Number(weekSnaps[weekSnaps.length - 1].total_portfolio_value);
    weeklyLossPct = ((startVal - endVal) / startVal) * 100;
  }

  const state: KillSwitchState = {
    dailyLossHalted:   dailyLossPct  > DAILY_LOSS_LIMIT_PCT,
    weeklyLossHalted:  weeklyLossPct > WEEKLY_LOSS_LIMIT_PCT,
    drawdownPaused:    drawdownPct   > DRAWDOWN_PAUSE_PCT,
    drawdownProtection: drawdownPct  > DRAWDOWN_PROTECT_PCT,
  };

  // Persist state
  await run(
    `INSERT INTO kill_switch_state
       (portfolio_id, daily_loss_halted, weekly_loss_halted, drawdown_paused, drawdown_protection, last_updated)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       daily_loss_halted=excluded.daily_loss_halted,
       weekly_loss_halted=excluded.weekly_loss_halted,
       drawdown_paused=excluded.drawdown_paused,
       drawdown_protection=excluded.drawdown_protection,
       last_updated=excluded.last_updated`,
    [portfolioId,
     state.dailyLossHalted   ? 1 : 0,
     state.weeklyLossHalted  ? 1 : 0,
     state.drawdownPaused    ? 1 : 0,
     state.drawdownProtection ? 1 : 0],
  ).catch(() => null);

  if (state.drawdownProtection) {
    logger.warn({ job: 'kill-switch', portfolioId, drawdownPct: drawdownPct.toFixed(1), reason: 'PROTECTION MODE ACTIVE — new entries blocked, weakest positions queued for close' });
  } else if (state.drawdownPaused) {
    logger.warn({ job: 'kill-switch', portfolioId, drawdownPct: drawdownPct.toFixed(1), reason: 'DRAWDOWN PAUSE — new entries blocked' });
  } else if (state.dailyLossHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, dailyLossPct: dailyLossPct.toFixed(1), reason: 'DAILY LOSS LIMIT — new BUYs halted for today' });
  } else if (state.weeklyLossHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, weeklyLossPct: weeklyLossPct.toFixed(1), reason: 'WEEKLY LOSS LIMIT — position sizes halved' });
  }

  return state;
}

/**
 * Apply kill-switch to a proposed position size multiplier.
 *  - Protection/paused/dailyHalt → 0 (no new buy allowed)
 *  - weeklyHalt → 0.5 (halve size)
 *  - clean → 1.0
 */
export function killSwitchSizeMultiplier(state: KillSwitchState): number {
  if (state.drawdownProtection || state.drawdownPaused || state.dailyLossHalted) return 0;
  if (state.weeklyLossHalted) return 0.5;
  return 1.0;
}
