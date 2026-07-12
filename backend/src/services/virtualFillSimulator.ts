/**
 * virtualFillSimulator.ts — Phase 22: Simulated Virtual Fill Engine
 *
 * Makes virtual/paper trading execution more realistic by modelling:
 *   - Market impact slippage (ATR volatility + volume ratio + order size)
 *   - Bid-ask spread adjustment
 *   - Partial fills (low liquidity)
 *   - Order rejection (extreme illiquidity)
 *   - Simulated execution latency
 *
 * v1 logic is deliberately simple and deterministic — no random noise.
 * This keeps fills reproducible and auditable.
 *
 * Author: Vinidicare (Phase 22)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type VirtualFillInput = {
  symbol:              string;
  side:                'BUY' | 'SELL';
  signalPrice:         number;
  intendedPrice:       number;
  currentPrice:        number;
  quantity:            number;
  orderValue:          number;

  atrPct?:             number;   // ATR as % of price (e.g. 2.5 means 2.5%)
  volumeRatio?:        number;   // today's volume / 20-day avg (e.g. 0.6)
  averageDailyValue?:  number;   // avg daily traded value in INR
  bidAskSpreadPct?:    number;   // bid-ask spread as % of price
  marketRegime?:       string;   // e.g. 'BEAR' | 'BULL' | 'SIDEWAYS'
};

export type VirtualFillResult = {
  fillStatus:           'FULL' | 'PARTIAL' | 'REJECTED' | 'FAILED';
  quantityFilled:       number;
  simulatedFillPrice:   number;
  slippagePct:          number;
  slippageAbs:          number;
  simulatedLatencyMs:   number;
  rejectionReason?:     string;
};

// ── Fee constants (Indian market approximations) ──────────────────────────────

export type VirtualCharges = {
  brokerage:        number;  // Flat ₹5 per order (matching platform config)
  stt:              number;  // Securities Transaction Tax
  exchangeCharges:  number;  // NSE exchange transaction charges
  sebiCharges:      number;  // SEBI turnover fee
  gst:              number;  // GST on brokerage + exchange charges
  stampDuty:        number;  // State stamp duty (BUY only)
  totalCharges:     number;
};

/**
 * Calculate Indian market virtual charges for a trade.
 * Rates as of 2025 NSE equity delivery segment.
 */
export function calculateVirtualCharges(
  side: 'BUY' | 'SELL',
  turnover: number,
): VirtualCharges {
  const brokerage      = 5;                              // Flat ₹5
  const stt            = side === 'SELL'
    ? turnover * 0.001                                   // 0.1% on SELL delivery
    : turnover * 0.001;                                  // 0.1% on BUY delivery too (budget 2024)
  const exchangeCharges = turnover * 0.0000297;          // NSE: ₹29.70 per crore
  const sebiCharges    = turnover * 0.000001;            // ₹10 per crore (₹1/lakh)
  const gst            = (brokerage + exchangeCharges) * 0.18; // 18% GST
  const stampDuty      = side === 'BUY' ? turnover * 0.00015 : 0; // 0.015% BUY delivery

  const totalCharges = brokerage + stt + exchangeCharges + sebiCharges + gst + stampDuty;

  return {
    brokerage,
    stt:             Math.round(stt * 100) / 100,
    exchangeCharges: Math.round(exchangeCharges * 100) / 100,
    sebiCharges:     Math.round(sebiCharges * 100) / 100,
    gst:             Math.round(gst * 100) / 100,
    stampDuty:       Math.round(stampDuty * 100) / 100,
    totalCharges:    Math.round(totalCharges * 100) / 100,
  };
}

// ── Main simulator ────────────────────────────────────────────────────────────

/**
 * Simulate a virtual order fill with realistic slippage and execution quality.
 *
 * Slippage model (additive, v1):
 *   Base: 0.05%
 *   + ATR > 3%:           +0.05%
 *   + ATR > 5%:           +0.10% (cumulative with above)
 *   + volumeRatio < 0.8:  +0.05%
 *   + volumeRatio < 0.5:  +0.10% (cumulative)
 *   + orderValue > 1% ADV: +0.10%
 *   + orderValue > 3% ADV: +0.25% (cumulative)
 *   + BEAR regime:         +0.05% extra on BUY
 *
 * Partial fill: when volumeRatio < 0.3 — fill only ~60% of requested qty
 * Rejection: when volumeRatio < 0.1 or order too large (> 10% ADV)
 *
 * Latency:
 *   Base 200ms + market impact (high slippage = slower)
 */
export function simulateVirtualFill(input: VirtualFillInput): VirtualFillResult {
  const {
    side,
    currentPrice,
    quantity,
    orderValue,
    atrPct       = 1.5,
    volumeRatio  = 1.0,
    averageDailyValue,
    bidAskSpreadPct = 0.02,
    marketRegime = 'BULL',
  } = input;

  // ── Rejection check ──────────────────────────────────────────────────────
  if (volumeRatio < 0.1) {
    return {
      fillStatus:         'REJECTED',
      quantityFilled:     0,
      simulatedFillPrice: currentPrice,
      slippagePct:        0,
      slippageAbs:        0,
      simulatedLatencyMs: 100,
      rejectionReason:    'ILLIQUID_NO_MARKET — volume ratio < 0.1',
    };
  }

  if (averageDailyValue && orderValue > averageDailyValue * 0.10) {
    return {
      fillStatus:         'REJECTED',
      quantityFilled:     0,
      simulatedFillPrice: currentPrice,
      slippagePct:        0,
      slippageAbs:        0,
      simulatedLatencyMs: 100,
      rejectionReason:    'ORDER_TOO_LARGE — order exceeds 10% of average daily traded value',
    };
  }

  // ── Slippage model ───────────────────────────────────────────────────────
  let slippagePct = 0.05; // base 5bps

  // ATR-based volatility premium
  if (atrPct > 3)  slippagePct += 0.05;
  if (atrPct > 5)  slippagePct += 0.10;

  // Volume/liquidity premium
  if (volumeRatio < 0.8) slippagePct += 0.05;
  if (volumeRatio < 0.5) slippagePct += 0.10;

  // Market impact: order size vs ADV
  if (averageDailyValue) {
    if (orderValue > averageDailyValue * 0.01) slippagePct += 0.10;
    if (orderValue > averageDailyValue * 0.03) slippagePct += 0.25;
  }

  // Bid-ask spread (half-spread added on top)
  slippagePct += bidAskSpreadPct / 2;

  // Regime premium on BUYs in bear market
  if (side === 'BUY' && (marketRegime === 'BEAR' || marketRegime === 'DOWNTREND')) {
    slippagePct += 0.05;
  }

  // ── Fill price ───────────────────────────────────────────────────────────
  const simulatedFillPrice =
    side === 'BUY'
      ? currentPrice * (1 + slippagePct / 100)
      : currentPrice * (1 - slippagePct / 100);

  const slippageAbs = Math.abs(simulatedFillPrice - currentPrice);

  // ── Partial fill check ───────────────────────────────────────────────────
  let fillStatus: VirtualFillResult['fillStatus'] = 'FULL';
  let quantityFilled = quantity;

  if (volumeRatio < 0.3 && quantity > 1) {
    fillStatus     = 'PARTIAL';
    quantityFilled = Math.max(1, Math.floor(quantity * 0.6));
  }

  // ── Latency model ────────────────────────────────────────────────────────
  // Base 200ms + 10ms per 0.1% slippage (high-impact orders take longer)
  const simulatedLatencyMs = Math.round(200 + (slippagePct / 0.1) * 10);

  return {
    fillStatus,
    quantityFilled,
    simulatedFillPrice: Math.round(simulatedFillPrice * 100) / 100,
    slippagePct:        Math.round(slippagePct * 10000) / 10000,
    slippageAbs:        Math.round(slippageAbs * 100) / 100,
    simulatedLatencyMs,
  };
}
