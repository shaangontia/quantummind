/**
 * Migration: Fix portfolio current_cash after flat brokerage migration
 *
 * Context: migrate_flat_brokerage.ts updated trade brokerage and net_amount
 * records to use flat ₹5, but portfolios.current_cash still reflects
 * the old percentage-based brokerage deductions from trade execution.
 *
 * Fix: Recompute current_cash from source of truth:
 *   current_cash = initial_capital
 *                - SUM(net_amount WHERE action = 'BUY')
 *                + SUM(net_amount WHERE action = 'SELL')
 *
 * This is authoritative — net_amount in trades is already correct (updated
 * by migrate_flat_brokerage). Safe to re-run (idempotent).
 *
 * Author: Vinidicare (migration 2026-07-09)
 */

import { getClient } from '../turso.js';
import 'dotenv/config';

async function migrate() {
  const db = getClient();

  console.log('[cash-fix] Starting current_cash recalculation...');

  const { rows: portfolios } = await db.execute(
    'SELECT id, name, initial_capital, current_cash FROM portfolios'
  );

  let fixed = 0;
  for (const p of portfolios) {
    const portfolioId   = Number(p.id);
    const initialCapital = Number(p.initial_capital);
    const oldCash       = Number(p.current_cash);

    const { rows: tradeRows } = await db.execute({
      sql: `SELECT
              COALESCE(SUM(CASE WHEN action = 'BUY'  THEN net_amount ELSE 0 END), 0) as buy_total,
              COALESCE(SUM(CASE WHEN action = 'SELL' THEN net_amount ELSE 0 END), 0) as sell_total
            FROM trades
            WHERE portfolio_id = ? AND price > 0`,
      args: [portfolioId],
    });

    const buyTotal  = Number(tradeRows[0]?.buy_total  ?? 0);
    const sellTotal = Number(tradeRows[0]?.sell_total ?? 0);
    const correctCash = initialCapital - buyTotal + sellTotal;
    const delta = correctCash - oldCash;

    if (Math.abs(delta) < 0.01) {
      console.log(`[cash-fix] Portfolio ${portfolioId} (${p.name}): already correct (₹${correctCash.toFixed(2)})`);
      continue;
    }

    await db.execute({
      sql: 'UPDATE portfolios SET current_cash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [correctCash, portfolioId],
    });

    console.log(`[cash-fix] Portfolio ${portfolioId} (${p.name}): ${oldCash.toFixed(2)} → ${correctCash.toFixed(2)} (delta: ${delta > 0 ? '+' : ''}${delta.toFixed(2)})`);
    fixed++;
  }

  console.log(`[cash-fix] Complete. ${fixed} portfolio(s) corrected.`);
}

migrate().catch(err => {
  console.error('[cash-fix] FAILED:', err);
  process.exit(1);
});
