/**
 * admin.routes.ts — health checks, admin controls, cron triggers, backtest
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../../db/turso.js';
import { requireAdminAuth } from './helpers.js';

const router = Router();

// ─── Health checks ────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', service: 'QuantumMind', ts: new Date().toISOString() });
});
router.get('/health/db', async (_req: Request, res: Response) => {
  try { await query('SELECT 1'); res.json({ status: 'OK', db: 'turso' }); }
  catch (err) { res.status(503).json({ status: 'DOWN', db: 'turso', error: String(err) }); }
});
router.get('/health/market-data', async (_req: Request, res: Response) => {
  const start = Date.now();
  try {
    const { getExecutableQuote } = await import('../../services/marketData.js');
    const q = await getExecutableQuote('RELIANCE.NS');
    res.json({ status: q.isFresh ? 'OK' : 'DEGRADED', provider: q.provider, price: q.price, isFresh: q.isFresh, latencyMs: Date.now() - start });
  } catch (err) { res.status(503).json({ status: 'DOWN', latencyMs: Date.now() - start, error: String(err) }); }
});
router.get('/health/cron', async (_req: Request, res: Response) => {
  try {
    const row = await queryOne("SELECT * FROM cron_lock WHERE key='market-cycle'");
    res.json({ status: 'OK', lastCycleLockedUntil: row ? row.locked_until : null });
  } catch { res.json({ status: 'OK', lastCycleLockedUntil: null }); }
});

// ─── Admin: kill switch ───────────────────────────────────────────────────────
router.post('/admin/trading-enabled', requireAdminAuth, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  await run("UPDATE trading_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='global_trading_enabled'", [String(enabled)]);
  res.json({ success: true, global_trading_enabled: enabled });
});

// ─── Admin: backtest ──────────────────────────────────────────────────────────
router.post('/admin/backtest/run', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, message: 'Backtest bootstrap started asynchronously.' });
    const { symbols } = req.body as { symbols?: string[] };
    setImmediate(() => {
      (async () => {
        const { bootstrapSignalWeights } = await import('../../services/backtestWeights.js');
        const result = await bootstrapSignalWeights(symbols);
        console.log('[Admin] Backtest bootstrap complete:', JSON.stringify(result, null, 2));
      })().catch(e => console.error('[Admin] Backtest bootstrap FAILED:', String(e)));
    });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/admin/backtest/weights', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const weights     = await query('SELECT * FROM signal_weights ORDER BY source');
    const priceRows   = await query('SELECT COUNT(*) as cnt FROM backtesting_prices').catch(() => [{ cnt: 0 }]);
    res.json({ success: true, weights, backtestingPricesRows: priceRows[0]?.cnt ?? 0 });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Cron triggers ────────────────────────────────────────────────────────────
router.post('/cron/market-cycle', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const { runMarketCycle } = await import('../../scheduler/marketMonitor.js');
    await runMarketCycle();
    res.json({ success: true, ran: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.post('/cron/price-update', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const { getMultipleQuotes } = await import('../../services/marketData.js');
    const holdings = await query('SELECT DISTINCT symbol FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.is_active = 1');
    if (!holdings.length) return res.json({ success: true, updated: 0 });
    const quotes = await getMultipleQuotes(holdings.map((h: any) => h.symbol as string));
    let updated = 0;
    for (const q of quotes) {
      await run('UPDATE holdings SET current_price = ?, last_price_updated = CURRENT_TIMESTAMP WHERE symbol = ?', [q.price, q.symbol]);
      updated++;
    }
    res.json({ success: true, updated, ts: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

export default router;
