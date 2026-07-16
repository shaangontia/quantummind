/**
 * exitEngine.ts — Phase 13: Comprehensive exit logic
 *
 * Six exit types checked per holding per cycle:
 *   1. Stop-loss      — price falls below atr_stop_price
 *   2. Trailing stop  — price falls below trailing_stop_price (updated as price rises)
 *   3. Time stop      — no positive move within 10 trading days of entry
 *   4. Profit target  — price exceeds 2R from entry
 *   5. Thesis invalidation — post-entry fundamental/news red flag
 *   6. Portfolio-regime exit — NIFTY regime turned BEARISH since entry
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const TRADING_DAYS_TIME_STOP = 10;

export interface HoldingExitContext {
  portfolioId: number;
  symbol: string;
  companyName: string;
  quantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  createdAt: string;           // ISO timestamp of BUY trade
  atrStopPrice: number | null;
  trailingStopPrice: number | null;
  timeStopDate: string | null; // ISO date
  riskAmountInr: number | null;
  thesisInvalidated: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  exitType: 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_STOP' | 'PROFIT_TARGET' | 'THESIS_INVALIDATED' | 'REGIME_EXIT' | null;
  /**
   * True when this exit is a hard protective stop (STOP_LOSS or TRAILING_STOP).
   * Set explicitly at source — never derived from reason strings.
   * Used by circuit breaker gate: hard stops are allowed even when circuit breaker is active.
   */
  isHardStop: boolean;
  reason: string;
  urgency: 'IMMEDIATE' | 'NEXT_CYCLE' | 'MONITOR';
}

/**
 * Compute ATR using simple True Range approximation over recent price history.
 * Falls back to 1.5% of price when history unavailable.
 */
export function computeATRStop(entryPrice: number, atrPct: number = 0.015): { atrStop: number; trailingStop: number } {
  const atr = entryPrice * atrPct;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    atrStop: r2(entryPrice - 1.5 * atr),
    trailingStop: r2(entryPrice - 1.5 * atr),
  };
}

/**
 * Register exit plan on a holding immediately after BUY execution.
 * Called from marketMonitor after successful trade.
 */
export async function registerExitPlan(
  portfolioId: number,
  symbol: string,
  entryPrice: number,
  riskAmountInr: number,
  atrPct: number = 0.015,
): Promise<void> {
  const { atrStop, trailingStop } = computeATRStop(entryPrice, atrPct);

  // Time stop: 10 trading days from today (approximate as 14 calendar days)
  const timeStop = new Date();
  timeStop.setDate(timeStop.getDate() + 14);
  const timeStopDate = timeStop.toISOString().slice(0, 10);

  await run(
    `UPDATE holdings
     SET atr_stop_price = ?, trailing_stop_price = ?, time_stop_date = ?, risk_amount_inr = ?
     WHERE portfolio_id = ? AND symbol = ?`,
    [atrStop, trailingStop, timeStopDate, riskAmountInr, portfolioId, symbol],
  ).catch(() => null);
}

/**
 * Update trailing stop upward as price rises (never lower it).
 */
export async function updateTrailingStop(
  portfolioId: number,
  symbol: string,
  currentPrice: number,
  atrPct: number = 0.015,
): Promise<void> {
  const rows = await query(
    'SELECT trailing_stop_price FROM holdings WHERE portfolio_id=? AND symbol=?',
    [portfolioId, symbol],
  );
  if (!rows.length) return;
  const existing = Number(rows[0].trailing_stop_price ?? 0);
  const atr = currentPrice * atrPct;
  const newTrailing = currentPrice - 1.5 * atr;
  if (newTrailing > existing) {
    await run(
      'UPDATE holdings SET trailing_stop_price=? WHERE portfolio_id=? AND symbol=?',
      [newTrailing, portfolioId, symbol],
    ).catch(() => null);
  }
}

/**
 * Evaluate all exit conditions for a holding.
 * Returns the strongest exit reason if any exit should fire.
 */
export function evaluateExits(h: HoldingExitContext, marketRegimeLabel: 'BULLISH' | 'NEUTRAL' | 'BEARISH'): ExitDecision {
  const pnlPct = ((h.currentPrice - h.avgBuyPrice) / h.avgBuyPrice) * 100;

  // 1. Hard stop-loss (ATR-based)
  if (h.atrStopPrice !== null && h.currentPrice <= h.atrStopPrice) {
    return {
      shouldExit: true, isHardStop: true,
      exitType: 'STOP_LOSS',
      reason: `ATR stop hit: ₹${h.currentPrice.toFixed(2)} ≤ stop ₹${h.atrStopPrice.toFixed(2)} (${pnlPct.toFixed(1)}%)`,
      urgency: 'IMMEDIATE',
    };
  }

  // 2. Trailing stop
  if (h.trailingStopPrice !== null && h.currentPrice <= h.trailingStopPrice && pnlPct > 0) {
    return {
      shouldExit: true, isHardStop: true,
      exitType: 'TRAILING_STOP',
      reason: `Trailing stop hit: ₹${h.currentPrice.toFixed(2)} ≤ trailing ₹${h.trailingStopPrice.toFixed(2)} (locked profit: ${pnlPct.toFixed(1)}%)`,
      urgency: 'IMMEDIATE',
    };
  }

  // 3. Thesis invalidated post-entry
  if (h.thesisInvalidated === 1) {
    return {
      shouldExit: true, isHardStop: false,
      exitType: 'THESIS_INVALIDATED',
      reason: `Post-entry red flag detected — thesis invalidated`,
      urgency: 'IMMEDIATE',
    };
  }

  // 4. Time stop — no meaningful move in expected window
  if (h.timeStopDate) {
    const dueDate = new Date(h.timeStopDate);
    const today = new Date();
    if (today >= dueDate && Math.abs(pnlPct) < 2) {
      return {
        shouldExit: true, isHardStop: false,
        exitType: 'TIME_STOP',
        reason: `Time stop: ${TRADING_DAYS_TIME_STOP} trading days elapsed with no directional move (${pnlPct.toFixed(1)}%)`,
        urgency: 'NEXT_CYCLE',
      };
    }
  }

  // 5. Portfolio regime exit — bearish market, position underwater
  if (marketRegimeLabel === 'BEARISH' && pnlPct < -2) {
    return {
      shouldExit: true, isHardStop: false,
      exitType: 'REGIME_EXIT',
      reason: `Market regime: BEARISH + position underwater ${pnlPct.toFixed(1)}% — exit to preserve capital`,
      urgency: 'NEXT_CYCLE',
    };
  }

  // 6. Profit target hit (2R)
  if (h.riskAmountInr !== null && h.riskAmountInr > 0) {
    const targetPnlInr = h.riskAmountInr * 2;
    const actualPnlInr = (h.currentPrice - h.avgBuyPrice) * h.quantity;
    if (actualPnlInr >= targetPnlInr) {
      return {
        shouldExit: true, isHardStop: false,
        exitType: 'PROFIT_TARGET',
        reason: `2R profit target hit: +₹${actualPnlInr.toFixed(0)} vs target ₹${targetPnlInr.toFixed(0)} (${pnlPct.toFixed(1)}%)`,
        urgency: 'NEXT_CYCLE',
      };
    }
  }

  return { shouldExit: false, isHardStop: false, exitType: null, reason: '', urgency: 'MONITOR' };
}

/**
 * Mark a holding's thesis as invalidated (post-entry fundamental/news red flag).
 * Called by the news/event processor or Gemini structured output handler.
 */
export async function invalidateThesis(portfolioId: number, symbol: string, reason: string): Promise<void> {
  await run(
    'UPDATE holdings SET thesis_invalidated=1 WHERE portfolio_id=? AND symbol=?',
    [portfolioId, symbol],
  ).catch(() => null);
  logger.warn({ job: 'exit-engine', portfolioId, symbol, reason: `[ThesisInvalidated] ${reason}` });
}
