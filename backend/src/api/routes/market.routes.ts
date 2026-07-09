/**
 * market.routes.ts — news, market quotes, watchlist, portfolio signals
 */
import { Router, Request, Response } from 'express';
import { getQuote, DEFAULT_WATCHLIST } from '../../services/marketData.js';
import { fetchAnnouncements, getHighSignalAnnouncements } from '../../services/newsService.js';
import { getMarketIntelligence } from '../../services/groqService.js';
import { cache, TTL } from '../../lib/cache.js';
import { parseIntParam } from './helpers.js';
import { query } from '../../db/turso.js';

const router = Router();

// ─── News ─────────────────────────────────────────────────────────────────────
router.get('/news', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('news_all', fetchAnnouncements, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/news/high-signal', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('news_high_signal', getHighSignalAnnouncements, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/news/intelligence', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('news_intelligence', getMarketIntelligence, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Market data ──────────────────────────────────────────────────────────────
router.get('/market/quote/:symbol', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await getQuote(req.params.symbol) }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/market/watchlist', (_req: Request, res: Response) => {
  res.json({ success: true, data: DEFAULT_WATCHLIST });
});

// ─── Portfolio signals ────────────────────────────────────────────────────────
router.get('/portfolios/:id/signals', async (req: Request, res: Response) => {
  const pid = parseIntParam(req.params.id);
  if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
  res.json({ success: true, data: await query('SELECT * FROM market_signals WHERE portfolio_id = ? ORDER BY signal_time DESC LIMIT 100', [pid]) });
});

export default router;
