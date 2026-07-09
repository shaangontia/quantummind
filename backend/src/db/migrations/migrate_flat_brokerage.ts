/**
 * Migration: Recalculate historical brokerage to flat ₹5 per trade
 *
 * Reason: Platform moved from percentage-based brokerage (0.2% of trade amount)
 *         to a flat ₹5 fee per trade.
 *
 * Changes per trade row:
 *   - brokerage         → 5 (flat)
 *   - net_amount (BUY)  → amount + 5
 *   - net_amount (SELL) → amount - 5
 *   - realized_pnl (SELL only) → realized_pnl + (old_brokerage - 5)
 *     Derivation: old realized_pnl = gross_pnl - old_brokerage
 *                 new realized_pnl = gross_pnl - 5
 *                                  = old_realized_pnl + old_brokerage - 5
 *
 * Run once. Safe to re-run (idempotent via brokerage = 5 guard).
 *
 * Author: Vinidicare (migration 2026-07-09)
 */

import { getClient } from '../turso.js';
import 'dotenv/config';

async function migrate() {
  const db = getClient();
  const FLAT_FEE = 5;

  console.log('[migration] Starting flat brokerage recalculation...');

  // Fetch all trades not already on flat fee
  const { rows } = await db.execute(
    `SELECT id, action, amount, brokerage, net_amount, realized_pnl
     FROM trades
     WHERE brokerage != ${FLAT_FEE}
     ORDER BY id`
  );

  if (rows.length === 0) {
    console.log('[migration] No trades to update — already on flat fee.');
    return;
  }

  console.log(`[migration] Found ${rows.length} trade(s) to update.`);

  let updated = 0;
  for (const row of rows) {
    const id            = Number(row.id);
    const action        = String(row.action);
    const amount        = Number(row.amount);
    const oldBrokerage  = Number(row.brokerage);
    const oldRealizedPnl = row.realized_pnl !== null ? Number(row.realized_pnl) : null;

    const newNetAmount = action === 'BUY' ? amount + FLAT_FEE : amount - FLAT_FEE;

    // Recalculate realized_pnl only for SELL trades where it was set
    const newRealizedPnl =
      action === 'SELL' && oldRealizedPnl !== null
        ? oldRealizedPnl + oldBrokerage - FLAT_FEE
        : oldRealizedPnl;

    await db.execute({
      sql: `UPDATE trades
            SET brokerage = ?,
                net_amount = ?,
                realized_pnl = ?
            WHERE id = ?`,
      args: [FLAT_FEE, newNetAmount, newRealizedPnl, id],
    });

    updated++;
    if (updated % 50 === 0) console.log(`[migration] Updated ${updated}/${rows.length}...`);
  }

  console.log(`[migration] Complete. ${updated} trade(s) updated to flat ₹${FLAT_FEE} brokerage.`);
  console.log('[migration] Note: performance_snapshots are pre-computed aggregates.');
  console.log('[migration] Trigger a portfolio refresh or snapshot recalculation to propagate changes to UI metrics.');
}

migrate().catch(err => {
  console.error('[migration] FAILED:', err);
  process.exit(1);
});
