/**
 * tradingCosts.ts — single source of truth for transaction cost assumptions.
 *
 * Added 2026-07-22 to fix the finding in QuantumMind_Algorithm_Analysis.md §2.4:
 * four different cost assumptions existed across the codebase (README's 0.2%,
 * the ledger's flat ₹5, the EV/walk-forward gates' hardcoded 0.4%, and the
 * itemized STT/exchange/SEBI/GST/stamp-duty model in virtualFillSimulator.ts —
 * which was computed correctly but never actually reconciled with the other
 * three).
 *
 * Per explicit product decision:
 *   - The BROKERAGE commission is a flat ₹5 per order. This one constant is
 *     the single source of truth for that line item — virtualFillSimulator's
 *     calculateVirtualCharges() imports it rather than hardcoding its own `5`.
 *   - The regulatory/itemized components (STT, exchange charges, SEBI
 *     turnover fee, GST, stamp duty) in calculateVirtualCharges() are KEPT
 *     UNCHANGED (explicit instruction — do not simplify/reweight that
 *     formula). calculateVirtualCharges()'s `totalCharges` output — brokerage
 *     + all itemized components — is the authoritative total transaction
 *     cost figure, and every module that needs a cost assumption (the
 *     ledger in tradingEngine.executeTrade, the EV gate in patternEngine,
 *     the walk-forward expectancy formulas) now derives its number from the
 *     same function via the helpers below, instead of each guessing its own
 *     percentage.
 */

// Re-exported (not redefined) from virtualFillSimulator.ts, which owns the
// charge calculation, to avoid a circular import between the two files.
export { FLAT_BROKERAGE_INR, calculateVirtualCharges } from './virtualFillSimulator.js';
import { calculateVirtualCharges } from './virtualFillSimulator.js';

/**
 * Round-trip (BUY + SELL) transaction cost as a percentage of trade value,
 * using the same itemized charge model (brokerage + STT + exchange + SEBI +
 * GST + stamp duty) that actually gets applied to the ledger.
 *
 * Unlike a flat percentage assumption, this correctly reflects that a flat
 * ₹5 brokerage is a much smaller fraction of a ₹50,000 trade than a ₹5,000
 * one — small positions pay proportionally more in fixed costs.
 */
export function roundTripCostPct(tradeValueInr: number): number {
  if (!tradeValueInr || tradeValueInr <= 0) return 0;
  const buyCharges = calculateVirtualCharges('BUY', tradeValueInr);
  const sellCharges = calculateVirtualCharges('SELL', tradeValueInr);
  return ((buyCharges.totalCharges + sellCharges.totalCharges) / tradeValueInr) * 100;
}

/**
 * Round-trip transaction cost in absolute INR, for a given trade value.
 */
export function roundTripCostInr(tradeValueInr: number): number {
  if (!tradeValueInr || tradeValueInr <= 0) return 0;
  const buyCharges = calculateVirtualCharges('BUY', tradeValueInr);
  const sellCharges = calculateVirtualCharges('SELL', tradeValueInr);
  return buyCharges.totalCharges + sellCharges.totalCharges;
}

/**
 * Typical position size to assume when a caller needs a cost-% estimate but
 * doesn't have an actual trade value in scope (e.g. EV gate called during
 * signal generation, before position sizing runs). Set to a representative
 * mid-sized position (~₹40,000) — for context, a ₹50L portfolio at 8% max
 * position sizing tops out at ₹4L, but the median position across risk tiers
 * (3–10% of a range of portfolio sizes) tends to land in the ₹20-60k band.
 * Callers that DO know the real trade value should always pass it explicitly
 * instead of relying on this default.
 */
export const TYPICAL_POSITION_VALUE_INR = 40_000;
