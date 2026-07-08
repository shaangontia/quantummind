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
    // Enrich each portfolio with live return_pct computed from holdings + cash vs initial_capital
    const portfolios = await query('SELECT * FROM portfolios ORDER BY created_at DESC');
    const enriched = await Promise.all(portfolios.map(async (p: any) => {
      const holdingsValue = await query(
        'SELECT COALESCE(SUM(quantity * COALESCE(current_price, avg_buy_price)), 0) as nav FROM holdings WHERE portfolio_id = ?',
        [p.id]
      );
      const nav = Number(holdingsValue[0]?.nav ?? 0) + Number(p.current_cash);
      const returnPct = Number(p.initial_capital) > 0
        ? ((nav - Number(p.initial_capital)) / Number(p.initial_capital)) * 100
        : 0;
      return { ...p, current_nav: nav, return_pct: returnPct };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.post('/portfolios', async (req: Request, res: Response) => {
  const { name, description, initialCapital, riskTolerance, investmentHorizonMonths, targetReturnPct, preferredSectors, preferredCaps } = req.body;
  if (!name || !initialCapital) return res.status(400).json({ success: false, error: 'name and initialCapital required' });
  const result = await run(
    'INSERT INTO portfolios (name,description,initial_capital,current_cash,risk_tolerance,investment_horizon_months,target_return_pct,preferred_sectors,preferred_caps) VALUES (?,?,?,?,?,?,?,?,?)',
    [name, description||null, initialCapital, initialCapital, riskTolerance||'Medium', investmentHorizonMonths||12, targetReturnPct||15.0, preferredSectors ? JSON.stringify(preferredSectors) : null, preferredCaps ? JSON.stringify(preferredCaps) : null]
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
  try {
    const {
      name, description, initialCapital,
      riskTolerance, investmentHorizonMonths, targetReturnPct,
      rebalanceFrequency, preferredSectors, preferredCaps,
      volatilityPreference, investmentGoal, maxDrawdownPct,
      force = false,  // override drawdown lock
    } = req.body;
    const id = parseInt(req.params.id);

    const existing = await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Portfolio not found' });

    // ── Guard 1: Capital reduction floor ─────────────────────────────────────
    // Cannot reduce capital below currently invested value (would make cash negative)
    if (initialCapital != null) {
      const investedValue = Number(existing.initial_capital ?? 0) - Number(existing.current_cash ?? 0);
      if (Number(initialCapital) < investedValue) {
        return res.status(422).json({
          success: false,
          error: `Cannot reduce capital below invested value (₹${investedValue.toLocaleString('en-IN')}). Sell positions first.`,
          code: 'CAPITAL_FLOOR_BREACH',
        });
      }
    }

    // ── Guard 2: Drawdown breach lock on strategy fields ─────────────────────
    // During an active drawdown breach, strategy fields are frozen.
    // Capital top-ups and max_drawdown_pct relaxation are still allowed.
    const STRATEGY_FIELDS = [riskTolerance, preferredSectors, preferredCaps,
                             volatilityPreference, investmentGoal, investmentHorizonMonths,
                             targetReturnPct, rebalanceFrequency];
    const strategyChangeRequested = STRATEGY_FIELDS.some(f => f != null);

    if (strategyChangeRequested && !force) {
      const holdingsRow = await queryOne('SELECT COUNT(*) as cnt FROM holdings WHERE portfolio_id = ?', [id]);
      const holdingsCount = Number(holdingsRow?.cnt ?? 0);

      if (holdingsCount > 0) {
        // Check drawdown: compare latest portfolio snapshot NAV vs initial capital
        const latestSnap = await queryOne(
          'SELECT total_portfolio_value FROM performance_snapshots WHERE portfolio_id = ? ORDER BY snapshot_time DESC LIMIT 1',
          [id],
        );
        const currentNAV  = latestSnap ? Number(latestSnap.total_portfolio_value) : Number(existing.initial_capital);
        const initCapital = Number(existing.initial_capital ?? 0);
        const drawdownPct = initCapital > 0 ? ((initCapital - currentNAV) / initCapital) * 100 : 0;
        const drawdownLimit = Number(existing.max_drawdown_pct ?? 20);

        if (drawdownPct >= drawdownLimit) {
          return res.status(423).json({
            success: false,
            error: `Portfolio is in active drawdown (${drawdownPct.toFixed(1)}% ≥ ${drawdownLimit}% limit). Strategy fields are locked. Top up capital or wait for recovery. Pass force:true to override.`,
            code: 'DRAWDOWN_LOCK',
            meta: { drawdownPct: Math.round(drawdownPct * 10) / 10, drawdownLimit, holdingsCount },
          });
        }
      }
    }

    // ── Capital delta: credit increase to cash ────────────────────────────────
    let cashDelta = 0;
    if (initialCapital != null) {
      cashDelta = Number(initialCapital) - Number(existing.initial_capital ?? 0);
    }

    await run(
      `UPDATE portfolios SET
        name                      = COALESCE(?, name),
        description               = COALESCE(?, description),
        initial_capital           = COALESCE(?, initial_capital),
        current_cash              = CASE WHEN ? IS NOT NULL THEN MAX(0, current_cash + ?) ELSE current_cash END,
        risk_tolerance            = COALESCE(?, risk_tolerance),
        investment_horizon_months = COALESCE(?, investment_horizon_months),
        target_return_pct         = COALESCE(?, target_return_pct),
        rebalance_frequency       = COALESCE(?, rebalance_frequency),
        preferred_sectors         = COALESCE(?, preferred_sectors),
        preferred_caps            = COALESCE(?, preferred_caps),
        volatility_preference     = COALESCE(?, volatility_preference),
        investment_goal           = COALESCE(?, investment_goal),
        max_drawdown_pct          = COALESCE(?, max_drawdown_pct),
        updated_at                = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        name ?? null,
        description ?? null,
        initialCapital ?? null,
        initialCapital ?? null, cashDelta,
        riskTolerance ?? null,
        investmentHorizonMonths ?? null,
        targetReturnPct ?? null,
        rebalanceFrequency ?? null,
        preferredSectors != null ? JSON.stringify(preferredSectors) : null,
        preferredCaps    != null ? JSON.stringify(preferredCaps)    : null,
        volatilityPreference ?? null,
        investmentGoal ?? null,
        maxDrawdownPct ?? null,
        id,
      ],
    );

    // Return updated portfolio + state metadata for the frontend
    const updated = await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]);
    const holdingsRow = await queryOne('SELECT COUNT(*) as cnt FROM holdings WHERE portfolio_id = ?', [id]);
    const hasActiveHoldings = Number(holdingsRow?.cnt ?? 0) > 0;

    res.json({ success: true, data: updated, meta: { hasActiveHoldings, strategyQueued: strategyChangeRequested && hasActiveHoldings } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.delete('/portfolios/:id', async (req: Request, res: Response) => {
  await run('UPDATE portfolios SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?', [parseInt(req.params.id)]);
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

// ─── Trade Explainability ──────────────────────────────────────────────────────
router.get('/portfolios/:id/trades/:tradeId/explanation', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    const trade = await queryOne(
      'SELECT * FROM trades WHERE id = ? AND portfolio_id = ?',
      [parseInt(req.params.tradeId), parseInt(req.params.id)]
    );
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });

    let ctx: Record<string, unknown> = {};
    if (trade.trade_reason) {
      try { ctx = JSON.parse(String(trade.trade_reason)); } catch { /* use reason string */ }
    }

    const contextBlock = Object.keys(ctx).length > 0
      ? `Structured data: ${JSON.stringify(ctx)}`
      : `Signal reason text: ${trade.signal_reason}`;

    const prompt = `You are TARS, the AI for QuantumMind virtual trading. Explain this trade decision in 2-3 clear sentences.\nTrade: ${trade.action} ${trade.quantity} shares of ${trade.symbol} at ₹${trade.price} on ${trade.trade_time}.\n${contextBlock}\n\nMention the key indicators that drove the decision (RSI, news, momentum). Keep it concise.`;

    const Groq = (await import('groq-sdk')).default;
    const groq = new Groq({ apiKey: process.env.groq_key });
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 200,
    });
    const explanation = response.choices[0]?.message?.content?.trim() ?? 'Explanation unavailable.';

    res.json({ success: true, tradeId: trade.id, symbol: trade.symbol, action: trade.action, explanation, context: ctx, signalReason: trade.signal_reason });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
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

// ─── Sector Allocation ─────────────────────────────────────────────────────────
router.get('/portfolios/:id/sectors', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    const pid = parseInt(req.params.id);
    const { getSymbolSector } = await import('../services/marketData.js');
    const holdings = await query(
      'SELECT symbol, quantity, current_price, avg_buy_price FROM holdings WHERE portfolio_id = ?', [pid]
    );
    const sectorMap: Record<string, { value: number; symbols: string[] }> = {};
    let totalValue = 0;
    for (const h of holdings) {
      const price = Number(h.current_price || h.avg_buy_price);
      const value = Number(h.quantity) * price;
      const sector = getSymbolSector(h.symbol as string);
      if (!sectorMap[sector]) sectorMap[sector] = { value: 0, symbols: [] };
      sectorMap[sector].value += value;
      sectorMap[sector].symbols.push(h.symbol as string);
      totalValue += value;
    }
    const allocation = Object.entries(sectorMap)
      .map(([sector, { value, symbols }]) => ({
        sector, value, symbols,
        pct: totalValue > 0 ? Math.round((value / totalValue) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.value - a.value);
    res.json({ success: true, data: allocation, totalHoldingsValue: totalValue });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Also expose as /sector-allocation for backward compat
router.get('/portfolios/:id/sector-allocation', async (req: Request, res: Response) => {
  return req.app._router.handle(
    { ...req, url: req.url.replace('sector-allocation', 'sectors') } as any, res, () => {}
  );
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

// ─── Index Benchmarking ─────────────────────────────────────────────────────
router.get('/portfolios/:id/benchmark', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    const pid = parseInt(req.params.id);
    const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [pid]);
    if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found' });

    const { getIndexHistory, fetchAndStoreIndexHistory, INDEX_SYMBOLS } = await import('../services/indexData.js');

    // Ensure we have index data (fetch if table is empty)
    const existing = await query('SELECT COUNT(*) as cnt FROM index_prices');
    if ((existing[0]?.cnt ?? 0) < 10) {
      await fetchAndStoreIndexHistory(); // lazy-load on first benchmark request
    }

    // Portfolio inception date
    const fromDate = String(portfolio.created_at ?? '').slice(0, 10) || new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);

    // Performance snapshots for portfolio NAV over time
    const snapshots = await query(
      "SELECT date(snapshot_time) as snapshot_date, total_portfolio_value as total_value FROM performance_snapshots WHERE portfolio_id = ? AND date(snapshot_time) >= ? ORDER BY snapshot_time ASC",
      [pid, fromDate]
    );

    // Index histories
    const [nifty50History, nifty500History] = await Promise.all([
      getIndexHistory(INDEX_SYMBOLS.NIFTY50, fromDate, toDate),
      getIndexHistory(INDEX_SYMBOLS.NIFTY500, fromDate, toDate),
    ]);

    // Compute returns normalised to 100 at inception
    const portfolioBase = snapshots.length > 0 ? Number(snapshots[0].total_value) : Number(portfolio.initial_capital);
    const nifty50Base  = nifty50History.length  > 0 ? nifty50History[0].close  : null;
    const nifty500Base = nifty500History.length > 0 ? nifty500History[0].close : null;

    const portfolioNow = snapshots.length > 0 ? Number(snapshots[snapshots.length - 1].total_value) : portfolioBase;
    const portfolioReturnPct = portfolioBase > 0 ? ((portfolioNow - portfolioBase) / portfolioBase) * 100 : 0;

    const nifty50Now = nifty50History.length > 0 ? nifty50History[nifty50History.length - 1].close : null;
    const nifty500Now = nifty500History.length > 0 ? nifty500History[nifty500History.length - 1].close : null;
    const nifty50ReturnPct  = nifty50Base  && nifty50Now  ? ((nifty50Now  - nifty50Base)  / nifty50Base)  * 100 : null;
    const nifty500ReturnPct = nifty500Base && nifty500Now ? ((nifty500Now - nifty500Base) / nifty500Base) * 100 : null;

    const alpha = nifty50ReturnPct != null ? portfolioReturnPct - nifty50ReturnPct : null;

    // Chart series: portfolio NAV normalised to 100
    const portfolioSeries = snapshots.map(s => ({
      date: String(s.snapshot_date).slice(0, 10),
      value: portfolioBase > 0 ? (Number(s.total_value) / portfolioBase) * 100 : 100,
    }));
    const nifty50Series  = nifty50History.map(r  => ({ date: r.date,  value: nifty50Base  ? (r.close  / nifty50Base)  * 100 : 100 }));
    const nifty500Series = nifty500History.map(r => ({ date: r.date, value: nifty500Base ? (r.close / nifty500Base) * 100 : 100 }));

    res.json({
      success: true,
      data: {
        portfolioReturnPct: Math.round(portfolioReturnPct * 100) / 100,
        nifty50ReturnPct:   nifty50ReturnPct  != null ? Math.round(nifty50ReturnPct  * 100) / 100 : null,
        nifty500ReturnPct:  nifty500ReturnPct != null ? Math.round(nifty500ReturnPct * 100) / 100 : null,
        alpha:              alpha != null ? Math.round(alpha * 100) / 100 : null,
        period: { from: fromDate, to: toDate },
        series: { portfolio: portfolioSeries, nifty50: nifty50Series, nifty500: nifty500Series },
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
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

// ─── TARS Chatbot ───────────────────────────────────────────────────────────

/**
 * TARS live price context — no hardcoded map.
 *
 * Strategy:
 * 1. Look for explicit .NS symbols in the message (e.g. TCS.NS, RELIANCE.NS)
 * 2. Look for uppercase words (2–15 chars) that could be NSE tickers — try each against Yahoo Finance
 * 3. Use the NSE_UNIVERSE from marketData as the known-ticker reference for quick validation
 * No separate company map needed — same data the trading engine uses.
 */
async function tarsLiveContext(message: string): Promise<string> {
  const { getDisplayQuote, NSE_UNIVERSE } = await import('../services/marketData.js');

  // Build a fast ticker set from the app's own NSE_UNIVERSE
  const universeSet = new Set(NSE_UNIVERSE.map(s => s.replace('.NS', '')));

  // 1. Explicit .NS match
  const explicitMatch = message.match(/\b([A-Za-z0-9&-]+)\.NS\b/i);
  const explicitSym = explicitMatch ? explicitMatch[1].toUpperCase() + '.NS' : null;

  // 2. Uppercase potential tickers (2–15 chars, no spaces) that exist in our universe
  const upperTokens = [...message.matchAll(/\b([A-Z][A-Z0-9&-]{1,14})\b/g)]
    .map(m => m[1])
    .filter(t => universeSet.has(t));

  // Candidates to try (explicit first, then universe matches, then raw uppercase tokens as a fallback)
  const candidates: string[] = [];
  if (explicitSym) candidates.push(explicitSym);
  upperTokens.forEach(t => { if (!candidates.includes(t + '.NS')) candidates.push(t + '.NS'); });

  // Try each candidate until one succeeds
  for (const sym of candidates.slice(0, 3)) { // cap at 3 lookups per message
    try {
      const q = await getDisplayQuote(sym);
      if (q.price > 0) {
        const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const sign = q.change >= 0 ? '+' : '';
        return `\n\n[LIVE MARKET DATA — as of ${ist} IST]\nStock: ${sym} (${q.shortName ?? ''})\nLTP: ₹${q.price.toFixed(2)}\nChange: ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)\nProvider: ${q.provider} | Fresh: ${q.isFresh}`;
      }
    } catch { /* try next candidate */ }
  }
  return ''; // no stock found in message
}

const TARS_SYSTEM_PROMPT = `You are TARS, the AI assistant for QuantumMind — an AI-driven virtual Indian stock trading portal.
You are named after the robot from the movie Interstellar. Honesty setting: 90%. Humor setting: 75%.

CRITICAL RULE: You have access to LIVE market data via Yahoo Finance. When the user asks for a stock price, LTP, or current value, the system automatically fetches a real-time quote and injects it into this conversation as [LIVE MARKET DATA]. Use those exact figures in your answer. NEVER say you cannot access real-time data. NEVER mention a "knowledge cutoff" for prices — you have live data.

About QuantumMind:
- Fully autonomous AI-managed virtual trading system for NSE-listed Indian stocks
- Targets 15% annual return (30% over 2 years) with aggressive strategy
- Real-time NSE prices via Yahoo Finance (query2 → query1 CDN fallback) + Groww unofficial fallback
- LLM (Groq llama-3.1-8b-instant) analyses corporate news for trade signals
- ML stack: RSI(14), 52-week range, linear regression momentum, Kelly Criterion
- Adaptive feedback loop: signal weights auto-adjust based on win/loss history
- Market regime detection: BULL / BEAR / SIDEWAYS gates trade thresholds
- Brokerage: 0.2% flat per trade (STT + NSE charges + stamp duty + GST ≈ 0.2–0.25%)
- Safety guards: kill switch, 10% NAV per symbol cap, daily trade limits, NSE holiday calendar
- No real money — simulation only. All trades are virtual.
- Database: Turso cloud SQLite (Mumbai ap-south-1 region)
- Universe: ~1800+ NSE EQ-series stocks above ₹30

When [LIVE MARKET DATA] is present in this conversation, cite those exact figures. Keep answers concise and accurate.`;

router.post('/tars/chat', async (req: Request, res: Response) => {
  const { message, history } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'message required' });
  }
  try {
    res.set('Cache-Control', 'no-store');
    const Groq = (await import('groq-sdk')).default;
    const groq = new Groq({ apiKey: process.env.groq_key });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: TARS_SYSTEM_PROMPT },
    ];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h.role === 'user' || h.role === 'assistant') {
          messages.push({ role: h.role, content: String(h.content) });
        }
      }
    }
    // Inject live market data if the message mentions a known stock
    const liveCtx = await tarsLiveContext(message);
    const userContent = message.slice(0, 500) + liveCtx;
    messages.push({ role: 'user', content: userContent });

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.6,
      max_tokens: 400,
    });

    const reply = response.choices[0]?.message?.content?.trim() ?? 'No response from TARS.';
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Health checks ───────────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', service: 'QuantumMind', ts: new Date().toISOString() });
});

router.get('/health/db', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'OK', db: 'turso' });
  } catch (err) {
    res.status(503).json({ status: 'DOWN', db: 'turso', error: String(err) });
  }
});

router.get('/health/market-data', async (_req: Request, res: Response) => {
  const start = Date.now();
  try {
    const { getExecutableQuote } = await import('../services/marketData.js');
    const q = await getExecutableQuote('RELIANCE.NS');
    const latencyMs = Date.now() - start;
    const status = q.isFresh ? 'OK' : 'DEGRADED';
    res.json({ status, provider: q.provider, price: q.price, isFresh: q.isFresh, latencyMs });
  } catch (err) {
    res.status(503).json({ status: 'DOWN', latencyMs: Date.now() - start, error: String(err) });
  }
});

router.get('/health/cron', async (_req: Request, res: Response) => {
  try {
    const row = await queryOne(`SELECT * FROM cron_lock WHERE key='market-cycle'`);
    const lastRun = row ? row.locked_until : null;
    res.json({ status: 'OK', lastCycleLockedUntil: lastRun });
  } catch {
    res.json({ status: 'OK', lastCycleLockedUntil: null });
  }
});

// ─── Kill switch admin endpoint ───────────────────────────────────────────────────────────
router.post('/admin/trading-enabled', async (req: Request, res: Response) => {
  const adminSecret = process.env.CRON_SECRET;
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (adminSecret && provided !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
  const { enabled } = req.body as { enabled: boolean };
  await run('UPDATE trading_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key=?', [String(enabled), 'global_trading_enabled']);
  res.json({ success: true, global_trading_enabled: enabled });
});

// ─── Backtest bootstrap admin endpoint ────────────────────────────────────────────────────────
router.post('/admin/backtest/run', async (req: Request, res: Response) => {
  const adminSecret = process.env.CRON_SECRET;
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (adminSecret && provided !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json({ success: true, message: 'Backtest bootstrap started asynchronously. Check logs for progress.' });
    // Run async — don’t block the HTTP response (may take 10+ min for full universe)
    const { symbols } = req.body as { symbols?: string[] };
    setImmediate(async () => {
      const { bootstrapSignalWeights } = await import('../services/backtestWeights.js');
      const result = await bootstrapSignalWeights(symbols);
      console.log('[Admin] Backtest bootstrap complete:', JSON.stringify(result, null, 2));
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Backtest status / results ────────────────────────────────────────────────────────────────
router.get('/admin/backtest/weights', async (req: Request, res: Response) => {
  const adminSecret = process.env.CRON_SECRET;
  const provided = req.headers.authorization?.replace('Bearer ', '');
  if (adminSecret && provided !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const weights = await query('SELECT * FROM signal_weights ORDER BY source');
    const priceRows = await query('SELECT COUNT(*) as cnt FROM backtesting_prices').catch(() => [{ cnt: 0 }]);
    res.json({ success: true, weights, backtestingPricesRows: priceRows[0]?.cnt ?? 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Cron trigger ────────────────────────────────────────────────────────────────────────
router.post('/cron/market-cycle', async (req: Request, res: Response) => {
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

// ─── Lightweight price-only refresh ───────────────────────────────────────────────────────
router.post('/cron/price-update', async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = req.headers.authorization?.replace('Bearer ', '') ?? (req.query.secret as string | undefined);
    if (provided !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { getMultipleQuotes } = await import('../services/marketData.js');
    const holdings = await query('SELECT DISTINCT symbol FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.is_active = 1');
    if (!holdings.length) return res.json({ success: true, updated: 0 });
    const symbols = holdings.map((h: any) => h.symbol as string);
    const quotes = await getMultipleQuotes(symbols);
    let updated = 0;
    for (const q of quotes) {
      await run('UPDATE holdings SET current_price = ?, last_price_updated = CURRENT_TIMESTAMP WHERE symbol = ?', [q.price, q.symbol]);
      updated++;
    }
    res.json({ success: true, updated, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;

