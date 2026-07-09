/**
 * analytics.routes.ts
 * Per-portfolio analytics: trades, performance, signals, sectors, benchmark, ML.
 */
import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { query, queryOne } from '../../db/turso.js';
import { cache, TTL } from '../../lib/cache.js';
import { computeCorrelationMatrix, computeMomentumScore, computeKellySize } from '../../services/mlEngine.js';
import { getAdaptiveLearningReport, detectMarketRegime, resolveSignalOutcomes } from '../../services/adaptiveEngine.js';
import { parseIntParam } from './helpers.js';

const router = Router();
const groqClient = new Groq({ apiKey: process.env.groq_key });

// ─── Trades ───────────────────────────────────────────────────────────────────
router.get('/portfolios/:id/trades', async (req: Request, res: Response) => {
  const pid = parseIntParam(req.params.id);
  if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
  const page  = parseIntParam(req.query.page  as string, 1)  ?? 1;
  const limit = parseIntParam(req.query.limit as string, 50) ?? 50;
  const offset = (Math.max(page, 1) - 1) * Math.min(limit, 200);
  const totalRow = await queryOne('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ?', [pid]);
  const total    = Number(totalRow?.cnt ?? 0);
  const trades   = await query('SELECT * FROM trades WHERE portfolio_id = ? ORDER BY trade_time DESC LIMIT ? OFFSET ?', [pid, limit, offset]);
  res.json({ success: true, data: trades, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// ─── Trade explainability ──────────────────────────────────────────────────────
router.get('/portfolios/:id/trades/:tradeId/explanation', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    const pid = parseIntParam(req.params.id); const tradeId = parseIntParam(req.params.tradeId);
    if (pid === null || tradeId === null) return res.status(400).json({ success: false, error: 'Invalid id' });
    const trade = await queryOne('SELECT * FROM trades WHERE id = ? AND portfolio_id = ?', [tradeId, pid]);
    if (!trade) return res.status(404).json({ success: false, error: 'Trade not found' });
    let ctx: Record<string, unknown> = {};
    if (trade.trade_reason) { try { ctx = JSON.parse(String(trade.trade_reason)); } catch { /* raw string */ } }
    const contextBlock = Object.keys(ctx).length > 0 ? `Structured data: ${JSON.stringify(ctx)}` : `Signal reason text: ${trade.signal_reason}`;
    const prompt = `You are TARS, the AI for QuantumMind virtual trading. Explain this trade decision in 2-3 clear sentences.\nTrade: ${trade.action} ${trade.quantity} shares of ${trade.symbol} at ₹${trade.price} on ${trade.trade_time}.\n${contextBlock}\n\nMention the key indicators that drove the decision (RSI, news, momentum). Keep it concise.`;
    const response = await groqClient.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 200 });
    const explanation = response.choices[0]?.message?.content?.trim() ?? 'Explanation unavailable.';
    res.json({ success: true, tradeId: trade.id, symbol: trade.symbol, action: trade.action, explanation, context: ctx, signalReason: trade.signal_reason });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Performance snapshots ────────────────────────────────────────────────────
router.get('/portfolios/:id/performance', async (req: Request, res: Response) => {
  try {
    const pid = parseIntParam(req.params.id);
    if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const days = Math.min(Math.max(parseIntParam(req.query.days as string, 30) ?? 30, 1), 365);
    const data = await cache.getOrSet(`perf_${pid}_${days}`, async () => {
      const snapshots = await query(
        "SELECT * FROM performance_snapshots WHERE portfolio_id = ? AND snapshot_time >= datetime('now', '-' || ? || ' days') ORDER BY snapshot_time ASC",
        [pid, days]
      );
      if (snapshots.length === 0) {
        const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [pid]);
        if (portfolio) return [{ snapshot_time: portfolio.created_at, total_portfolio_value: portfolio.initial_capital, return_pct: 0, target_return_pct: portfolio.target_return_pct }];
      }
      return snapshots;
    }, TTL.PERFORMANCE);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Signals ──────────────────────────────────────────────────────────────────
router.get('/portfolios/:id/signals', async (req: Request, res: Response) => {
  const pid = parseIntParam(req.params.id);
  if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
  res.json({ success: true, data: await query('SELECT * FROM market_signals WHERE portfolio_id = ? ORDER BY signal_time DESC LIMIT 100', [pid]) });
});

// ─── Sector allocation ────────────────────────────────────────────────────────
async function sectorAllocationHandler(req: Request, res: Response): Promise<void> {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    const pid = parseIntParam(req.params.id);
    if (pid === null) { res.status(400).json({ success: false, error: 'Invalid portfolio id' }); return; }
    const { getSymbolSector } = await import('../../services/marketData.js');
    const holdings = await query('SELECT symbol, quantity, current_price, avg_buy_price FROM holdings WHERE portfolio_id = ?', [pid]);
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
      .map(([sector, { value, symbols }]) => ({ sector, value, symbols, pct: totalValue > 0 ? Math.round((value / totalValue) * 1000) / 10 : 0 }))
      .sort((a, b) => b.value - a.value);
    res.json({ success: true, data: allocation, totalHoldingsValue: totalValue });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
}
router.get('/portfolios/:id/sectors', sectorAllocationHandler);
router.get('/portfolios/:id/sector-allocation', sectorAllocationHandler); // backward compat

// ─── Index benchmarking ───────────────────────────────────────────────────────
router.get('/portfolios/:id/benchmark', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    const pid = parseIntParam(req.params.id);
    if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [pid]);
    if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found' });
    const { getIndexHistory, fetchAndStoreIndexHistory, INDEX_SYMBOLS } = await import('../../services/indexData.js');
    const existing = await query('SELECT COUNT(*) as cnt FROM index_prices');
    if ((existing[0]?.cnt ?? 0) < 10) await fetchAndStoreIndexHistory();
    const fromDate = String(portfolio.created_at ?? '').slice(0, 10) || new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const toDate   = new Date().toISOString().slice(0, 10);
    const snapshots = await query("SELECT date(snapshot_time) as snapshot_date, total_portfolio_value as total_value FROM performance_snapshots WHERE portfolio_id = ? AND date(snapshot_time) >= ? ORDER BY snapshot_time ASC", [pid, fromDate]);
    const [nifty50History, nifty500History] = await Promise.all([getIndexHistory(INDEX_SYMBOLS.NIFTY50, fromDate, toDate), getIndexHistory(INDEX_SYMBOLS.NIFTY500, fromDate, toDate)]);
    const portfolioBase  = snapshots.length > 0 ? Number(snapshots[0].total_value) : Number(portfolio.initial_capital);
    const nifty50Base    = nifty50History.length > 0 ? nifty50History[0].close : null;
    const nifty500Base   = nifty500History.length > 0 ? nifty500History[0].close : null;
    const portfolioNow   = snapshots.length > 0 ? Number(snapshots[snapshots.length - 1].total_value) : portfolioBase;
    const portfolioReturnPct = portfolioBase > 0 ? ((portfolioNow - portfolioBase) / portfolioBase) * 100 : 0;
    const nifty50Now     = nifty50History.length > 0 ? nifty50History[nifty50History.length - 1].close : null;
    const nifty500Now    = nifty500History.length > 0 ? nifty500History[nifty500History.length - 1].close : null;
    const nifty50ReturnPct  = nifty50Base && nifty50Now   ? ((nifty50Now  - nifty50Base) / nifty50Base) * 100   : null;
    const nifty500ReturnPct = nifty500Base && nifty500Now ? ((nifty500Now - nifty500Base) / nifty500Base) * 100 : null;
    const alpha = nifty50ReturnPct != null ? portfolioReturnPct - nifty50ReturnPct : null;
    const normalise = (val: number, base: number) => base > 0 ? (val / base) * 100 : 100;
    const chart = snapshots.map((s: any) => ({ date: s.snapshot_date, portfolioValue: normalise(Number(s.total_value), portfolioBase) }));
    res.json({ success: true, data: { portfolioReturnPct, nifty50ReturnPct, nifty500ReturnPct, alpha, chart, nifty50History: nifty50History.map(h => ({ date: h.date, value: nifty50Base ? normalise(h.close, nifty50Base) : 100 })), nifty500History: nifty500History.map(h => ({ date: h.date, value: nifty500Base ? normalise(h.close, nifty500Base) : 100 })) } });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── ML insights ──────────────────────────────────────────────────────────────
router.get('/ml/momentum/:symbol', async (req: Request, res: Response) => {
  try {
    const sym = req.params.symbol;
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet(`ml_momentum_${sym}`, () => computeMomentumScore(sym), TTL.ML_MOMENTUM) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/ml/kelly/:symbol', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await computeKellySize(req.params.symbol) }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/ml/correlation/:id', async (req: Request, res: Response) => {
  try {
    const corrId = parseIntParam(req.params.id);
    if (corrId === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const holdings = await query('SELECT symbol FROM holdings WHERE portfolio_id = ?', [corrId]);
    res.json({ success: true, data: await computeCorrelationMatrix(holdings.map((h: any) => h.symbol as string)) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Adaptive learning ────────────────────────────────────────────────────────
router.get('/adaptive/report', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ success: true, data: await cache.getOrSet('adaptive_report', getAdaptiveLearningReport, TTL.ADAPTIVE_REPORT) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/adaptive/regime', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.json({ success: true, data: await cache.getOrSet('market_regime', detectMarketRegime, TTL.MARKET_REGIME) });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.post('/adaptive/resolve-outcomes', async (_req: Request, res: Response) => {
  try { await resolveSignalOutcomes(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

export default router;
