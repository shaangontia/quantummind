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

import { query, queryOne, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const TRADING_DAYS_TIME_STOP = 10;

// ── Trailing stop configuration ────────────────────────────────────────────
// Previously trailing used the same 1.5×ATR distance as the initial hard stop
// (~2.25% below current price with atrPct=0.015), which meant every routine
// intraday pullback triggered an exit at 0.3–3% "locked profit". Indian mid-
// caps routinely swing 2–4% on normal days, so the trailing fired on noise.
// Widened to 3.5×ATR (~5.25% breathing room) and gated so trailing only
// engages after the position is comfortably in profit — small pullbacks in
// the first cycles after entry no longer flip us out for pennies.
const TRAILING_STOP_ATR_MULT = 3.5;
const HARD_STOP_ATR_MULT     = 1.5;
const TRAILING_ACTIVATION_PROFIT_PCT = 5.0;

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
 * Compute the initial ATR-based hard stop and trailing stop for a new position.
 *
 * Hard stop uses the tighter HARD_STOP_ATR_MULT — protecting against a bad
 * entry.  Trailing stop uses the wider TRAILING_STOP_ATR_MULT so that once
 * the position is in profit, routine pullbacks don't flip us out prematurely.
 * The trailing stop is inert at the very start (below entry) — evaluateExits
 * additionally gates its firing on TRAILING_ACTIVATION_PROFIT_PCT, so exits
 * on tiny profits are impossible.
 */
export function computeATRStop(entryPrice: number, atrPct: number = 0.015): { atrStop: number; trailingStop: number } {
  const atr = entryPrice * atrPct;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    atrStop:      r2(entryPrice - HARD_STOP_ATR_MULT     * atr),
    trailingStop: r2(entryPrice - TRAILING_STOP_ATR_MULT * atr),
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
 *
 * Only widens once the position has cleared TRAILING_ACTIVATION_PROFIT_PCT
 * above the entry price — before that, the initial (wider) trailing stop
 * from computeATRStop stays in place, and evaluateExits refuses to fire
 * the trailing exit anyway.  Uses TRAILING_STOP_ATR_MULT (wide) so mature
 * winners keep room to breathe through normal daily swings.
 */
export async function updateTrailingStop(
  portfolioId: number,
  symbol: string,
  currentPrice: number,
  atrPct: number = 0.015,
): Promise<void> {
  const row = await queryOne(
    'SELECT trailing_stop_price, avg_buy_price FROM holdings WHERE portfolio_id=? AND symbol=?',
    [portfolioId, symbol],
  );
  if (!row) return;
  const avgBuyPrice = Number(row.avg_buy_price ?? 0);
  if (avgBuyPrice <= 0) return;
  const pnlPct = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
  if (pnlPct < TRAILING_ACTIVATION_PROFIT_PCT) return;
  const existing = Number(row.trailing_stop_price ?? 0);
  const atr = currentPrice * atrPct;
  const newTrailing = currentPrice - TRAILING_STOP_ATR_MULT * atr;
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
  // Activation guard: refuse to fire the trailing exit until the position is
  // comfortably in profit (>= TRAILING_ACTIVATION_PROFIT_PCT above entry).
  // The previous `pnlPct > 0` check let a routine 2–3% pullback right after
  // entry exit us at 0.3–1% "locked profit" — the "meager sell" pattern that
  // dominates the sell log. Below the activation threshold the position is
  // protected only by the hard ATR stop (case 1 above), which is what we want.
  if (
    h.trailingStopPrice !== null &&
    h.currentPrice <= h.trailingStopPrice &&
    pnlPct >= TRAILING_ACTIVATION_PROFIT_PCT
  ) {
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
