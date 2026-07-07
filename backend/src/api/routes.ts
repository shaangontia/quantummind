import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../db/turso.js';
import { getQuote } from '../services/marketData.js';
import { getPortfolioSummary, executeTrade } from '../services/tradingEngine.js';
import { fetchAnnouncements, getHighSignalAnnouncements } from '../services/newsService.js';
import { getMarketIntelligence } from '../services/groqService.js';
import { computeCorrelationMatrix, computeMomentumScore, computeKellySize } from '../services/mlEngine.js';
import { getAdaptiveLearningReport, detectMarketRegime, resolveSignalOutcomes } from '../services/adaptiveEngine.js';
import { DEFAULT_WATCHLIST } from '../services/marketData.js';
import { cache, TTL } from '../lib/cache.js';

const router = Router();

// ─── Portfolios ──────────────────────────────────────────────────────────────

router.get('/portfolios', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await query('SELECT * FROM portfolios ORDER BY created_at DESC') });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.post('/portfolios', async (req: Request, res: Response) => {
  const { name, description, initialCapital, riskTolerance, investmentHorizonMonths, targetReturnPct, preferredSectors } = req.body;
  if (!name || !initialCapital) return res.status(400).json({ success: false, error: 'name and initialCapital required' });
  const result = await run(
    'INSERT INTO portfolios (name,description,initial_capital,current_cash,risk_tolerance,investment_horizon_months,target_return_pct,preferred_sectors) VALUES (?,?,?,?,?,?,?,?)',
    [name, description||null, initialCapital, initialCapital, riskTolerance||'Medium', investmentHorizonMonths||12, targetReturnPct||15.0, preferredSectors ? JSON.stringify(preferredSectors) : null]
  );
  res.status(201).json({ success: true, data: await queryOne('SELECT * FROM portfolios WHERE id = ?', [result.lastInsertRowid]) });
});

router.get('/portfolios/:id/summary', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const data = await cache.getOrSet(`portfolio_summary_${id}`, () => getPortfolioSummary(id), TTL.PORTFOLIO_SUMMARY);
    res.set('Cache-Control', 'no-store');  // Portfolio NAV must never be served stale
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.patch('/portfolios/:id', async (req: Request, res: Response) => {
  const { name, riskTolerance, investmentHorizonMonths, targetReturnPct } = req.body;
  const id = parseInt(req.params.id);
  await run('UPDATE portfolios SET name=COALESCE(?,name), risk_tolerance=COALESCE(?,risk_tolerance), investment_horizon_months=COALESCE(?,investment_horizon_months), target_return_pct=COALESCE(?,target_return_pct), updated_at=datetime("now") WHERE id=?',
    [name, riskTolerance, investmentHorizonMonths, targetReturnPct, id]);
  res.json({ success: true, data: await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]) });
});

router.delete('/portfolios/:id', async (req: Request, res: Response) => {
  await run('UPDATE portfolios SET is_active=0, updated_at=datetime("now") WHERE id=?', [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ─── Trades ───────────────────────────────────────────────────────────────────

router.get('/portfolios/:id/trades', async (req: Request, res: Response) => {
  const pid = parseInt(req.params.id);
  const page = parseInt(req.query.page as string || '1');
  const limit = parseInt(req.query.limit as string || '50');
  const offset = (page - 1) * limit;
  const totalRow = await queryOne('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ?', [pid]);
  const total = Number(totalRow?.cnt ?? 0);
  const trades = await query('SELECT * FROM trades WHERE portfolio_id = ? ORDER BY trade_time DESC LIMIT ? OFFSET ?', [pid, limit, offset]);
  res.json({ success: true, data: trades, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// ─── Performance ──────────────────────────────────────────────────────────────

router.get('/portfolios/:id/performance', async (req: Request, res: Response) => {
  try {
    const pid = parseInt(req.params.id);
    const days = parseInt(req.query.days as string || '30');
    const cacheKey = `perf_${pid}_${days}`;
    const data = await cache.getOrSet(cacheKey, async () => {
      // If no snapshots yet, return synthetic baseline from portfolio creation
      const snapshots = await query(
        `SELECT * FROM performance_snapshots WHERE portfolio_id = ? AND snapshot_time >= datetime('now','-${days} days') ORDER BY snapshot_time ASC`,
        [pid]
      );
      if (snapshots.length === 0) {
        // Return a single baseline data point so chart isn't empty
        const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [pid]);
        if (portfolio) {
          return [{ snapshot_time: portfolio.created_at, total_portfolio_value: portfolio.initial_capital, return_pct: 0, target_return_pct: portfolio.target_return_pct }];
        }
      }
      return snapshots;
    }, TTL.PERFORMANCE);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Signals ──────────────────────────────────────────────────────────────────

router.get('/portfolios/:id/signals', async (req: Request, res: Response) => {
  res.json({ success: true, data: await query(
    'SELECT * FROM market_signals WHERE portfolio_id = ? ORDER BY signal_time DESC LIMIT 100',
    [parseInt(req.params.id)]
  )});
});

// ─── News ─────────────────────────────────────────────────────────────────────

router.get('/news', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');  // Vercel CDN caches 5 min
    res.json({ success: true, data: await cache.getOrSet('news_all', fetchAnnouncements, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.get('/news/high-signal', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('news_high_signal', getHighSignalAnnouncements, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// GET /api/news/intelligence — Groq LLM analysis (expensive — CDN cached)
router.get('/news/intelligence', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('news_intelligence', getMarketIntelligence, TTL.NEWS) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── ML Insights ──────────────────────────────────────────────────────────────

// GET /api/ml/momentum/:symbol — ML momentum score (public, CDN cached)
router.get('/ml/momentum/:symbol', async (req: Request, res: Response) => {
  try {
    const sym = req.params.symbol;
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet(`ml_momentum_${sym}`, () => computeMomentumScore(sym), TTL.ML_MOMENTUM) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// GET /api/ml/kelly/:symbol — Kelly Criterion position size
router.get('/ml/kelly/:symbol', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await computeKellySize(req.params.symbol) }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// GET /api/ml/correlation/:id — correlation matrix for portfolio holdings
router.get('/ml/correlation/:id', async (req: Request, res: Response) => {
  try {
    const holdings = await query('SELECT symbol FROM holdings WHERE portfolio_id = ?', [parseInt(req.params.id)]);
    const symbols = holdings.map((h: any) => h.symbol as string);
    res.json({ success: true, data: await computeCorrelationMatrix(symbols) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Market Data ──────────────────────────────────────────────────────────────

router.get('/market/quote/:symbol', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await getQuote(req.params.symbol) }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.get('/market/watchlist', async (_req: Request, res: Response) => {
  res.json({ success: true, data: DEFAULT_WATCHLIST });
});

// ─── Adaptive Learning ───────────────────────────────────────────────────────

router.get('/adaptive/report', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('adaptive_report', getAdaptiveLearningReport, TTL.ADAPTIVE_REPORT) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.get('/adaptive/regime', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');  // 1 hour — regime doesn't change intra-day
    res.json({ success: true, data: await cache.getOrSet('market_regime', detectMarketRegime, TTL.MARKET_REGIME) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.post('/adaptive/resolve-outcomes', async (_req: Request, res: Response) => {
  try { await resolveSignalOutcomes(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Manual Trade ─────────────────────────────────────────────────────────────

router.post('/portfolios/:id/trade', async (req: Request, res: Response) => {
  const { symbol, companyName, action, quantity, price, reason } = req.body;
  if (!symbol || !action || !quantity || !price) return res.status(400).json({ success: false, error: 'symbol, action, quantity, price required' });
  const pid = parseInt(req.params.id);
  const tradeId = await executeTrade(pid, symbol, companyName||symbol, action, quantity, price, reason||'Manual trade');
  if (tradeId) {
    cache.invalidate(`portfolio_summary_${pid}`);
    res.json({ success: true, tradeId });
  } else res.status(400).json({ success: false, error: 'Trade failed — check cash or holdings' });
});

// ─── Cron trigger (called by Vercel Cron / external scheduler) ────────────────

router.post('/cron/market-cycle', async (req: Request, res: Response) => {
  // Auth: require CRON_SECRET env var to match Authorization header or ?secret= query param
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided =
      req.headers.authorization?.replace('Bearer ', '') ??
      (req.query.secret as string | undefined);
    if (provided !== cronSecret) {
      console.warn('[Cron] Unauthorized cycle trigger attempt from', req.ip);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }
  try {
    const { runMarketCycle } = await import('../scheduler/marketMonitor.js');
    await runMarketCycle();
    res.json({ success: true, ran: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
