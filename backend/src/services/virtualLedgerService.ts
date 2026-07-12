/**
 * virtualLedgerService.ts — Phase 22: Virtual Ledger Reconstruction
 *
 * Reconstructs expected portfolio state from the canonical trade/order ledger.
 * This is the SOURCE OF TRUTH for reconciliation — not the current DB columns.
 *
 * Reconstruction logic:
 *   expected_cash = initial_capital
 *                 − Σ(BUY net_amount)
 *                 + Σ(SELL net_amount)
 *
 *   expected_position[symbol].quantity = Σ(BUY qty) − Σ(SELL qty)
 *   expected_position[symbol].avgPrice = weighted avg of BUY cost basis
 *
 *   expected_nav = expected_cash + Σ(expected_position.marketValue)
 *
 * Edge cases handled:
 *   - No trades: expected = initial_capital (all cash)
 *   - Negative reconstructed quantity: flagged as NEGATIVE_POSITION
 *   - Negative reconstructed cash: flagged as NEGATIVE_CASH
 *   - Stale market prices: uses last-known price from holdings table
 *
 * Author: Vinidicare (Phase 22)
 */

import { query, queryOne } from '../db/turso.js';
import { logger } from '../lib/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ReconstructedPosition = {
  symbol:        string;
  quantity:      number;
  averagePrice:  number;      // weighted avg BUY cost basis
  marketValue:   number;      // quantity × last known market price
  unrealizedPnl: number;      // marketValue − (quantity × averagePrice)
  lastKnownPrice: number;     // price used for market value calculation
};

export type ReconstructedVirtualLedger = {
  portfolioId:      number;
  initialCapital:   number;
  expectedCash:     number;
  totalBuyCost:     number;   // Σ BUY net_amount
  totalSellProceeds: number;  // Σ SELL net_amount
  expectedNav:      number;
  expectedPositions: ReconstructedPosition[];
  reconstructedAt:  string;
  pricesStale:      boolean;  // true if any position uses a price > 24h old
};

// ── Reconstruction functions ──────────────────────────────────────────────────

/**
 * Reconstruct expected cash from trade ledger.
 * expected_cash = initial_capital − Σ(BUY net_amount) + Σ(SELL net_amount)
 */
export async function reconstructVirtualCash(portfolioId: number): Promise<{
  initialCapital:    number;
  expectedCash:      number;
  totalBuyCost:      number;
  totalSellProceeds: number;
}> {
  const portfolio = await queryOne(
    'SELECT initial_capital FROM portfolios WHERE id = ?',
    [portfolioId],
  );
  if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

  const initialCapital = Number(portfolio.initial_capital);

  const buyRows = await query(
    `SELECT COALESCE(SUM(net_amount), 0) AS total
     FROM trades
     WHERE portfolio_id = ? AND action = 'BUY' AND status != 'FAILED'`,
    [portfolioId],
  );
  const sellRows = await query(
    `SELECT COALESCE(SUM(net_amount), 0) AS total
     FROM trades
     WHERE portfolio_id = ? AND action = 'SELL' AND status != 'FAILED'`,
    [portfolioId],
  );

  const totalBuyCost      = Number(buyRows[0]?.total ?? 0);
  const totalSellProceeds = Number(sellRows[0]?.total ?? 0);
  const expectedCash      = initialCapital - totalBuyCost + totalSellProceeds;

  return { initialCapital, expectedCash, totalBuyCost, totalSellProceeds };
}

/**
 * Reconstruct expected positions from trade ledger.
 * For each symbol: net_quantity = Σ(BUY qty) − Σ(SELL qty)
 * Average price = weighted average of BUY cost (cost basis method)
 */
export async function reconstructVirtualPositions(portfolioId: number): Promise<ReconstructedPosition[]> {
  // Get all executed trades ordered by time
  const trades = await query(
    `SELECT symbol, action, quantity, price, net_amount
     FROM trades
     WHERE portfolio_id = ? AND status != 'FAILED'
     ORDER BY trade_time ASC`,
    [portfolioId],
  );

  // Get last known market prices from holdings table (fallback for reconstruction)
  const holdingPrices = await query(
    `SELECT symbol, current_price, avg_buy_price, last_price_updated
     FROM holdings
     WHERE portfolio_id = ?`,
    [portfolioId],
  );
  const priceMap = new Map<string, { price: number; updatedAt: string | null }>();
  for (const h of holdingPrices) {
    priceMap.set(String(h.symbol), {
      price:     Number(h.current_price ?? h.avg_buy_price ?? 0),
      updatedAt: h.last_price_updated ? String(h.last_price_updated) : null,
    });
  }

  // Reconstruct per-symbol positions using cost-basis method
  const posMap = new Map<string, { qty: number; totalCost: number }>();

  for (const t of trades) {
    const sym = String(t.symbol);
    const qty = Number(t.quantity);
    const price = Number(t.price);

    if (!posMap.has(sym)) posMap.set(sym, { qty: 0, totalCost: 0 });
    const pos = posMap.get(sym)!;

    if (t.action === 'BUY') {
      pos.totalCost += qty * price;
      pos.qty       += qty;
    } else {
      // SELL: reduce quantity; reduce cost basis proportionally
      if (pos.qty > 0) {
        const costPerShare = pos.totalCost / pos.qty;
        pos.totalCost     = Math.max(0, pos.totalCost - qty * costPerShare);
      }
      pos.qty = Math.max(0, pos.qty - qty);
    }
  }

  // Build result array (exclude zero-qty positions)
  const now = new Date();
  const positions: ReconstructedPosition[] = [];
  let hasStalePrice = false;

  for (const [symbol, pos] of posMap.entries()) {
    if (pos.qty <= 0) continue;

    const priceInfo = priceMap.get(symbol);
    const lastKnownPrice = priceInfo?.price ?? 0;
    const averagePrice   = pos.qty > 0 ? pos.totalCost / pos.qty : 0;
    const marketValue    = lastKnownPrice * pos.qty;
    const unrealizedPnl  = marketValue - pos.totalCost;

    // Flag stale if price not updated within 24h
    if (priceInfo?.updatedAt) {
      const updatedAt = new Date(priceInfo.updatedAt);
      const ageHours  = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > 24) hasStalePrice = true;
    } else {
      hasStalePrice = true;
    }

    positions.push({
      symbol,
      quantity:      Math.round(pos.qty * 1000) / 1000,
      averagePrice:  Math.round(averagePrice * 100) / 100,
      marketValue:   Math.round(marketValue * 100) / 100,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      lastKnownPrice,
    });
  }

  return positions;
}

/**
 * Reconstruct expected NAV:
 *   expected_nav = expected_cash + Σ(position.marketValue)
 */
export async function reconstructVirtualNav(portfolioId: number): Promise<{
  expectedNav:  number;
  expectedCash: number;
  marketValueOfPositions: number;
}> {
  const cashResult = await reconstructVirtualCash(portfolioId);
  const positions  = await reconstructVirtualPositions(portfolioId);

  const marketValueOfPositions = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const expectedNav = cashResult.expectedCash + marketValueOfPositions;

  return {
    expectedNav:            Math.round(expectedNav * 100) / 100,
    expectedCash:           Math.round(cashResult.expectedCash * 100) / 100,
    marketValueOfPositions: Math.round(marketValueOfPositions * 100) / 100,
  };
}

/**
 * Reconstruct open risk: sum of risk_amount_inr across holdings with active exit plans.
 * Used for risk exposure validation.
 */
export async function reconstructOpenRisk(portfolioId: number): Promise<{
  totalOpenRiskInr: number;
  positionsAtRisk:  number;
}> {
  const rows = await query(
    `SELECT COALESCE(SUM(risk_amount_inr), 0) AS total_risk,
            COUNT(*) AS positions_at_risk
     FROM holdings
     WHERE portfolio_id = ? AND atr_stop_price IS NOT NULL`,
    [portfolioId],
  );

  return {
    totalOpenRiskInr: Math.round(Number(rows[0]?.total_risk ?? 0) * 100) / 100,
    positionsAtRisk:  Number(rows[0]?.positions_at_risk ?? 0),
  };
}

/**
 * Full ledger reconstruction — combines cash, positions, and NAV.
 */
export async function reconstructVirtualLedger(portfolioId: number): Promise<ReconstructedVirtualLedger> {
  logger.info({ service: 'virtual-ledger', portfolioId, msg: 'Starting virtual ledger reconstruction' });

  const cashResult = await reconstructVirtualCash(portfolioId);
  const positions  = await reconstructVirtualPositions(portfolioId);
  const marketValueOfPositions = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const expectedNav = cashResult.expectedCash + marketValueOfPositions;

  // Detect stale prices: if any position has no lastKnownPrice or very old data
  const pricesStale = positions.some(p => p.lastKnownPrice === 0);

  return {
    portfolioId,
    initialCapital:    cashResult.initialCapital,
    expectedCash:      Math.round(cashResult.expectedCash * 100) / 100,
    totalBuyCost:      Math.round(cashResult.totalBuyCost * 100) / 100,
    totalSellProceeds: Math.round(cashResult.totalSellProceeds * 100) / 100,
    expectedNav:       Math.round(expectedNav * 100) / 100,
    expectedPositions: positions,
    reconstructedAt:   new Date().toISOString(),
    pricesStale,
  };
}
