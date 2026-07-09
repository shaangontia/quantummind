/**
 * repair-zero-price-trades.ts
 *
 * One-time data repair: voided 28 bad SELL trades (price=0) caused by Yahoo Finance
 * being blocked on Vercel cloud IPs. The zero price triggered stop-loss at -100%,
 * recording full cost basis as a loss and crediting ₹0 cash.
 *
 * Executed: 2026-07-09 on Turso (libsql://quantummind-shaangontia.aws-ap-south-1.turso.io)
 * Commit: 7ab52a8 (code guards), a0eebc4 (Twelve Data primary source)
 *
 * Root cause: Yahoo Finance blocks cloud IPs → getExecutableQuote returns price=0
 *   → lossRatio = (0 - avgBuyPrice) / avgBuyPrice = -100%
 *   → stop-loss threshold (-8%) falsely triggered
 *   → SELL executed at ₹0, realizedPnl = -full_cost_basis
 *
 * Repair applied to portfolios 1–6 (all active portfolios).
 *
 * To re-run if needed:
 *   cd QuantumMind && npx ts-node scripts/repair-zero-price-trades.ts
 */

import 'dotenv/config';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.turso_region!,
  authToken: process.env.turso_sb_key!,
});

async function main() {
  // ── Step 1: Audit ────────────────────────────────────────────────────────
  const bad = await db.execute(
    "SELECT id, portfolio_id, symbol, quantity, realized_pnl FROM trades WHERE action='SELL' AND price=0 ORDER BY portfolio_id, symbol"
  );
  console.log(`Found ${bad.rows.length} bad SELL trades (price=0):`);
  bad.rows.forEach(r => console.log(`  Trade#${r.id} P${r.portfolio_id} ${r.symbol} qty=${r.quantity} pnl=${r.realized_pnl}`));

  if (bad.rows.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  // ── Step 2: Void realized_pnl on all bad trades ───────────────────────────
  await db.execute({
    sql: "UPDATE trades SET realized_pnl=NULL, signal_reason=? WHERE action='SELL' AND price=0",
    args: ['VOIDED: zero-price data error (Yahoo Finance blocked)'],
  });
  console.log(`✓ Voided realized_pnl on ${bad.rows.length} trades`);

  // ── Step 3: Reconstruct holdings from BUY history ────────────────────────
  const affected: Record<string, Set<string>> = {};
  for (const r of bad.rows) {
    const pid = String(r.portfolio_id);
    if (!affected[pid]) affected[pid] = new Set();
    affected[pid].add(String(r.symbol));
  }

  for (const [pid, symbols] of Object.entries(affected)) {
    for (const sym of symbols) {
      const buys = await db.execute({
        sql: "SELECT SUM(quantity) as qty, SUM(amount) as cost FROM trades WHERE portfolio_id=? AND symbol=? AND action='BUY' AND price>0",
        args: [pid, sym],
      });
      const sells = await db.execute({
        sql: "SELECT SUM(quantity) as qty FROM trades WHERE portfolio_id=? AND symbol=? AND action='SELL' AND price>0",
        args: [pid, sym],
      });

      const totalBuyQty = Number(buys.rows[0]?.qty ?? 0);
      const totalSellQty = Number(sells.rows[0]?.qty ?? 0);
      const totalBuyCost = Number(buys.rows[0]?.cost ?? 0);
      const netQty = totalBuyQty - totalSellQty;

      if (netQty <= 0) {
        await db.execute({ sql: 'DELETE FROM holdings WHERE portfolio_id=? AND symbol=?', args: [pid, sym] });
        console.log(`  P${pid} ${sym}: no net position — holding removed`);
        continue;
      }

      const avgBuyPrice = totalBuyCost / totalBuyQty;
      const existing = await db.execute({ sql: 'SELECT id FROM holdings WHERE portfolio_id=? AND symbol=?', args: [pid, sym] });

      if (existing.rows.length > 0) {
        await db.execute({
          sql: 'UPDATE holdings SET quantity=?, avg_buy_price=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?',
          args: [netQty, avgBuyPrice, pid, sym],
        });
      } else {
        const cname = sym.replace('.NS', '');
        await db.execute({
          sql: 'INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price) VALUES (?,?,?,?,?,?)',
          args: [pid, sym, cname, netQty, avgBuyPrice, avgBuyPrice],
        });
      }
      console.log(`  P${pid} ${sym}: reconstructed qty=${netQty.toFixed(0)} avg=₹${avgBuyPrice.toFixed(2)}`);
    }

    // ── Step 4: Recalculate portfolio cash ──────────────────────────────────
    const port = await db.execute({ sql: 'SELECT initial_capital FROM portfolios WHERE id=?', args: [pid] });
    const initCap = Number(port.rows[0]?.initial_capital ?? 0);
    const validBuys = await db.execute({
      sql: "SELECT COALESCE(SUM(net_amount),0) as total FROM trades WHERE portfolio_id=? AND action='BUY' AND price>0",
      args: [pid],
    });
    const validSells = await db.execute({
      sql: "SELECT COALESCE(SUM(net_amount),0) as total FROM trades WHERE portfolio_id=? AND action='SELL' AND price>0",
      args: [pid],
    });
    const correctCash = initCap - Number(validBuys.rows[0].total) + Number(validSells.rows[0].total);
    await db.execute({ sql: 'UPDATE portfolios SET current_cash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [correctCash, pid] });
    console.log(`  P${pid}: cash recalculated ₹${correctCash.toFixed(0)}`);
  }

  // ── Step 5: Verify ───────────────────────────────────────────────────────
  const remaining = await db.execute(
    "SELECT COUNT(*) as cnt FROM trades WHERE action='SELL' AND price=0 AND realized_pnl IS NOT NULL"
  );
  console.log(`\nVerification — bad trades still with pnl: ${remaining.rows[0].cnt} ${remaining.rows[0].cnt === 0 ? '✓' : '✗ PROBLEM'}`);
  console.log('Repair complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
