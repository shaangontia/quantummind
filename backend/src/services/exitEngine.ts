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

const TRADING_DAYS_TIME_STOP = 15;

// ── Stop configuration ─────────────────────────────────────────────────────
// Hard ATR stop protects against a bad entry (loss-limiting).
// Trailing stop is PROGRESSIVE: it widens and installs profit floors as
// unrealized gain grows, so a stock that runs from +5% to +30% is not
// choked off with a 5% locked profit — the position gets progressively
// more room while still guaranteeing an increasing minimum gain.
//
// Guiding principle (Livermore / Zweig / Turtle): "give back at most
// 30–40% of your peak unrealized gain, never more". That's what turns
// a portfolio's occasional +40% winner into a portfolio-level advantage
// instead of a series of clipped +5% exits.
//
// HARD_STOP widened from 1.5×1.5% (−2.25%) to 2.0×2.0% (−4%): NSE mid/
// small-caps routinely see 3–5% intraday swings, so the old −2.25% stop
// was firing on normal noise and clustering losses at exactly the stop
// level. −4% still sits well under the 8% marketMonitor stopLoss ceiling
// while giving positions enough room to breathe. Kept in sync with
// marketMonitor.ts stopDistance formula and buildCandidateLabelPlan.ts.
const HARD_STOP_ATR_MULT             = 2.0;
const TRAILING_ACTIVATION_PROFIT_PCT = 5.0;

/**
 * Trailing distance as a fraction of current price, indexed by unrealized
 * pnl%. Wider tiers mean bigger winners are given more room to breathe
 * through normal daily volatility (Indian mid-caps easily see 3–5% intraday).
 */
function trailingDistancePctFor(pnlPct: number): number | null {
  if (pnlPct < TRAILING_ACTIVATION_PROFIT_PCT) return null; // no trailing yet
  if (pnlPct < 10)  return 0.06;  //  5–10%:  6% distance (modest — protecting a small gain)
  if (pnlPct < 20)  return 0.08;  // 10–20%:  8% distance (let it run)
  if (pnlPct < 40)  return 0.10;  // 20–40%: 10% distance (trend-follower zone)
  if (pnlPct < 80)  return 0.12;  // 40–80%: 12% distance (big winner — wide berth)
  return 0.15;                    //   >80%: 15% distance (multi-bagger territory)
}

/**
 * Minimum profit floor (as pnl%) that trailing must lock in once peak pnl
 * reaches given levels. Enforces the "give back at most X% of peak" rule.
 * Example: peak +25% → floor +15% (lock 60% of the peak gain).
 */
function profitFloorPctFor(peakPnlPct: number): number {
  // Floor must be ≥ TRAILING_ACTIVATION_PROFIT_PCT — otherwise the exit's
  // `pnlPct >= TRAILING_ACTIVATION_PROFIT_PCT` guard blocks the exit even
  // when price crosses the trailing stop, making the trailing set in
  // [5,10) dead weight and letting winners ride all the way back to the
  // hard stop. Was `return 2` (below the 5% activation → never fired).
  if (peakPnlPct < 10) return TRAILING_ACTIVATION_PROFIT_PCT;   //  5–10% peak: lock exactly the activation floor
  if (peakPnlPct < 20) return peakPnlPct * 0.50;    // 10–20% peak: lock 50% of gain
  if (peakPnlPct < 40) return peakPnlPct * 0.60;    // 20–40% peak: lock 60%
  if (peakPnlPct < 80) return peakPnlPct * 0.70;    // 40–80% peak: lock 70%
  return peakPnlPct * 0.75;                          //   >80% peak: lock 75%
}

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
 * Trailing stop is intentionally seeded BELOW entry (as a no-op placeholder)
 * — trailing does not truly engage until updateTrailingStop lifts it once
 * the position clears the activation threshold. Until then, only the hard
 * ATR stop protects the trade.
 */
export function computeATRStop(entryPrice: number, atrPct: number = 0.02): { atrStop: number; trailingStop: number } {
  const atr = entryPrice * atrPct;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    atrStop:      r2(entryPrice - HARD_STOP_ATR_MULT * atr),
    // Seed trailing 5% below entry — well below the hard stop, so the trailing
    // check in evaluateExits is a no-op until updateTrailingStop raises it.
    trailingStop: r2(entryPrice * 0.95),
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
  atrPct: number = 0.02,
): Promise<void> {
  const { atrStop, trailingStop } = computeATRStop(entryPrice, atrPct);

  // Time stop: 15 trading days from today (approximate as 21 calendar days)
  const timeStop = new Date();
  timeStop.setDate(timeStop.getDate() + 21);
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
 * TIERED / PROGRESSIVE trailing:
 *   - Below +5% pnl: no trailing update at all — position protected only by
 *     the hard ATR stop.
 *   - Above +5%: two candidates are computed and the HIGHER wins:
 *       (a) currentPrice × (1 − tier trailing distance) — dynamic trailing
 *           whose distance widens as unrealized gain grows
 *       (b) avgBuyPrice × (1 + tier profit floor) — absolute lock-in floor
 *           that guarantees never giving back more than a fixed fraction
 *           of peak gain
 *   - Result is only written if it exceeds the existing trailing (monotonic).
 *
 * Example trace: entry ₹100.
 *   Peak +10%: dist=6%, floor=5%. Candidates: 110×0.94=103.4  vs 100×1.05=105.
 *              → 105 wins. Exit if price drops to ₹105 (+5% locked).
 *   Peak +25%: dist=10%, floor=15%. Candidates: 125×0.90=112.5 vs 100×1.15=115.
 *              → 115 wins. Exit at ₹115 (+15% locked, gave back 40% of peak).
 *   Peak +50%: dist=12%, floor=35%. Candidates: 150×0.88=132   vs 100×1.35=135.
 *              → 135 wins. Exit at ₹135 (+35% locked, gave back 30% of peak).
 *   Peak +100% (2×): dist=15%, floor=75%. Candidates: 200×0.85=170 vs 175.
 *              → 175 wins. Exit at ₹175 (+75% locked, gave back 25%).
 *
 * The atrPct parameter is retained for signature compatibility but no longer
 * gates trailing width — the tier function is the sole source of truth.
 */
export async function updateTrailingStop(
  portfolioId: number,
  symbol: string,
  currentPrice: number,
  _atrPct: number = 0.02,
): Promise<void> {
  const row = await queryOne(
    'SELECT trailing_stop_price, avg_buy_price FROM holdings WHERE portfolio_id=? AND symbol=?',
    [portfolioId, symbol],
  );
  if (!row) return;
  const avgBuyPrice = Number(row.avg_buy_price ?? 0);
  if (avgBuyPrice <= 0) return;

  const pnlPct = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
  const trailingDistancePct = trailingDistancePctFor(pnlPct);
  if (trailingDistancePct === null) return; // below activation threshold

  const dynamicTrailing = currentPrice * (1 - trailingDistancePct);
  const floorPct        = profitFloorPctFor(pnlPct);
  const floorTrailing   = avgBuyPrice * (1 + floorPct / 100);
  const newTrailing     = Math.max(dynamicTrailing, floorTrailing);

  const existing = Number(row.trailing_stop_price ?? 0);
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
  // Threshold tightened from ±2% to ±1% so genuinely-oscillating positions
  // are given more room to trend. Previous ±2% band was closing normal
  // ±1.5% intraday drift at day-10 for a small cost-only loss (~−0.5%
  // after round-trip fees) — a systematic drain across the portfolio.
  if (h.timeStopDate) {
    const dueDate = new Date(h.timeStopDate);
    const today = new Date();
    if (today >= dueDate && Math.abs(pnlPct) < 1) {
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

  // 6. Profit target — fixed multiple of position risk.
  // Raised from 2R (~4.5% return, prematurely capped winners) to a much
  // higher 10R multiple that only fires on genuinely large moves. The
  // tiered trailing stop is now the primary mechanism for booking profits;
  // this remains as a safety valve for extraordinary runs where trailing
  // hasn't yet caught up.
  if (h.riskAmountInr !== null && h.riskAmountInr > 0) {
    const targetPnlInr = h.riskAmountInr * 10;
    const actualPnlInr = (h.currentPrice - h.avgBuyPrice) * h.quantity;
    if (actualPnlInr >= targetPnlInr) {
      return {
        shouldExit: true, isHardStop: false,
        exitType: 'PROFIT_TARGET',
        reason: `10R profit target hit: +₹${actualPnlInr.toFixed(0)} vs target ₹${targetPnlInr.toFixed(0)} (${pnlPct.toFixed(1)}%)`,
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
