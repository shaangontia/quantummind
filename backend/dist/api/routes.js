"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const turso_js_1 = require("../db/turso.js");
const marketData_js_1 = require("../services/marketData.js");
const tradingEngine_js_1 = require("../services/tradingEngine.js");
const newsService_js_1 = require("../services/newsService.js");
const groqService_js_1 = require("../services/groqService.js");
const mlEngine_js_1 = require("../services/mlEngine.js");
const adaptiveEngine_js_1 = require("../services/adaptiveEngine.js");
const marketData_js_2 = require("../services/marketData.js");
const cache_js_1 = require("../lib/cache.js");
const router = (0, express_1.Router)();
// ─── Portfolios ──────────────────────────────────────────────────────────────
router.get('/portfolios', async (_req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        // Enrich each portfolio with live return_pct computed from holdings + cash vs initial_capital
        const portfolios = await (0, turso_js_1.query)('SELECT * FROM portfolios ORDER BY created_at DESC');
        const enriched = await Promise.all(portfolios.map(async (p) => {
            const holdingsValue = await (0, turso_js_1.query)('SELECT COALESCE(SUM(quantity * COALESCE(current_price, avg_buy_price)), 0) as nav FROM holdings WHERE portfolio_id = ?', [p.id]);
            const nav = Number(holdingsValue[0]?.nav ?? 0) + Number(p.current_cash);
            const returnPct = Number(p.initial_capital) > 0
                ? ((nav - Number(p.initial_capital)) / Number(p.initial_capital)) * 100
                : 0;
            return { ...p, current_nav: nav, return_pct: returnPct };
        }));
        res.json({ success: true, data: enriched });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.post('/portfolios', async (req, res) => {
    const { name, description, initialCapital, riskTolerance, investmentHorizonMonths, targetReturnPct, preferredSectors, preferredCaps } = req.body;
    if (!name || !initialCapital)
        return res.status(400).json({ success: false, error: 'name and initialCapital required' });
    const result = await (0, turso_js_1.run)('INSERT INTO portfolios (name,description,initial_capital,current_cash,risk_tolerance,investment_horizon_months,target_return_pct,preferred_sectors,preferred_caps) VALUES (?,?,?,?,?,?,?,?,?)', [name, description || null, initialCapital, initialCapital, riskTolerance || 'Medium', investmentHorizonMonths || 12, targetReturnPct || 15.0, preferredSectors ? JSON.stringify(preferredSectors) : null, preferredCaps ? JSON.stringify(preferredCaps) : null]);
    res.status(201).json({ success: true, data: await (0, turso_js_1.queryOne)('SELECT * FROM portfolios WHERE id = ?', [result.lastInsertRowid]) });
});
router.get('/portfolios/:id/summary', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = await cache_js_1.cache.getOrSet(`portfolio_summary_${id}`, () => (0, tradingEngine_js_1.getPortfolioSummary)(id), cache_js_1.TTL.PORTFOLIO_SUMMARY);
        res.set('Cache-Control', 'no-store'); // Portfolio NAV must never be served stale
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.patch('/portfolios/:id', async (req, res) => {
    const { name, riskTolerance, investmentHorizonMonths, targetReturnPct } = req.body;
    const id = parseInt(req.params.id);
    await (0, turso_js_1.run)('UPDATE portfolios SET name=COALESCE(?,name), risk_tolerance=COALESCE(?,risk_tolerance), investment_horizon_months=COALESCE(?,investment_horizon_months), target_return_pct=COALESCE(?,target_return_pct), updated_at=CURRENT_TIMESTAMP WHERE id=?', [name, riskTolerance, investmentHorizonMonths, targetReturnPct, id]);
    res.json({ success: true, data: await (0, turso_js_1.queryOne)('SELECT * FROM portfolios WHERE id = ?', [id]) });
});
router.delete('/portfolios/:id', async (req, res) => {
    await (0, turso_js_1.run)('UPDATE portfolios SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?', [parseInt(req.params.id)]);
    res.json({ success: true });
});
// ─── Trades ───────────────────────────────────────────────────────────────────
router.get('/portfolios/:id/trades', async (req, res) => {
    const pid = parseInt(req.params.id);
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;
    const totalRow = await (0, turso_js_1.queryOne)('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ?', [pid]);
    const total = Number(totalRow?.cnt ?? 0);
    const trades = await (0, turso_js_1.query)('SELECT * FROM trades WHERE portfolio_id = ? ORDER BY trade_time DESC LIMIT ? OFFSET ?', [pid, limit, offset]);
    res.json({ success: true, data: trades, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});
// ─── Trade Explainability ──────────────────────────────────────────────────────
router.get('/portfolios/:id/trades/:tradeId/explanation', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300');
        const trade = await (0, turso_js_1.queryOne)('SELECT * FROM trades WHERE id = ? AND portfolio_id = ?', [parseInt(req.params.tradeId), parseInt(req.params.id)]);
        if (!trade)
            return res.status(404).json({ success: false, error: 'Trade not found' });
        let ctx = {};
        if (trade.trade_reason) {
            try {
                ctx = JSON.parse(String(trade.trade_reason));
            }
            catch { /* use reason string */ }
        }
        const contextBlock = Object.keys(ctx).length > 0
            ? `Structured data: ${JSON.stringify(ctx)}`
            : `Signal reason text: ${trade.signal_reason}`;
        const prompt = `You are TARS, the AI for QuantumMind virtual trading. Explain this trade decision in 2-3 clear sentences.\nTrade: ${trade.action} ${trade.quantity} shares of ${trade.symbol} at ₹${trade.price} on ${trade.trade_time}.\n${contextBlock}\n\nMention the key indicators that drove the decision (RSI, news, momentum). Keep it concise.`;
        const Groq = (await Promise.resolve().then(() => __importStar(require('groq-sdk')))).default;
        const groq = new Groq({ apiKey: process.env.groq_key });
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.4,
            max_tokens: 200,
        });
        const explanation = response.choices[0]?.message?.content?.trim() ?? 'Explanation unavailable.';
        res.json({ success: true, tradeId: trade.id, symbol: trade.symbol, action: trade.action, explanation, context: ctx, signalReason: trade.signal_reason });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Performance ──────────────────────────────────────────────────────────────
router.get('/portfolios/:id/performance', async (req, res) => {
    try {
        const pid = parseInt(req.params.id);
        const days = parseInt(req.query.days || '30');
        const cacheKey = `perf_${pid}_${days}`;
        const data = await cache_js_1.cache.getOrSet(cacheKey, async () => {
            // If no snapshots yet, return synthetic baseline from portfolio creation
            const snapshots = await (0, turso_js_1.query)(`SELECT * FROM performance_snapshots WHERE portfolio_id = ? AND snapshot_time >= datetime('now','-${days} days') ORDER BY snapshot_time ASC`, [pid]);
            if (snapshots.length === 0) {
                // Return a single baseline data point so chart isn't empty
                const portfolio = await (0, turso_js_1.queryOne)('SELECT * FROM portfolios WHERE id = ?', [pid]);
                if (portfolio) {
                    return [{ snapshot_time: portfolio.created_at, total_portfolio_value: portfolio.initial_capital, return_pct: 0, target_return_pct: portfolio.target_return_pct }];
                }
            }
            return snapshots;
        }, cache_js_1.TTL.PERFORMANCE);
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Signals ──────────────────────────────────────────────────────────────────
router.get('/portfolios/:id/signals', async (req, res) => {
    res.json({ success: true, data: await (0, turso_js_1.query)('SELECT * FROM market_signals WHERE portfolio_id = ? ORDER BY signal_time DESC LIMIT 100', [parseInt(req.params.id)]) });
});
// ─── News ─────────────────────────────────────────────────────────────────────
router.get('/news', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); // Vercel CDN caches 5 min
        res.json({ success: true, data: await cache_js_1.cache.getOrSet('news_all', newsService_js_1.fetchAnnouncements, cache_js_1.TTL.NEWS) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.get('/news/high-signal', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.json({ success: true, data: await cache_js_1.cache.getOrSet('news_high_signal', newsService_js_1.getHighSignalAnnouncements, cache_js_1.TTL.NEWS) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// GET /api/news/intelligence — Groq LLM analysis (expensive — CDN cached)
router.get('/news/intelligence', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.json({ success: true, data: await cache_js_1.cache.getOrSet('news_intelligence', groqService_js_1.getMarketIntelligence, cache_js_1.TTL.NEWS) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── ML Insights ──────────────────────────────────────────────────────────────
// GET /api/ml/momentum/:symbol — ML momentum score (public, CDN cached)
router.get('/ml/momentum/:symbol', async (req, res) => {
    try {
        const sym = req.params.symbol;
        res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.json({ success: true, data: await cache_js_1.cache.getOrSet(`ml_momentum_${sym}`, () => (0, mlEngine_js_1.computeMomentumScore)(sym), cache_js_1.TTL.ML_MOMENTUM) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// GET /api/ml/kelly/:symbol — Kelly Criterion position size
router.get('/ml/kelly/:symbol', async (req, res) => {
    try {
        res.json({ success: true, data: await (0, mlEngine_js_1.computeKellySize)(req.params.symbol) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// GET /api/ml/correlation/:id — correlation matrix for portfolio holdings
router.get('/ml/correlation/:id', async (req, res) => {
    try {
        const holdings = await (0, turso_js_1.query)('SELECT symbol FROM holdings WHERE portfolio_id = ?', [parseInt(req.params.id)]);
        const symbols = holdings.map((h) => h.symbol);
        res.json({ success: true, data: await (0, mlEngine_js_1.computeCorrelationMatrix)(symbols) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Market Data ──────────────────────────────────────────────────────────────
router.get('/market/quote/:symbol', async (req, res) => {
    try {
        res.json({ success: true, data: await (0, marketData_js_1.getQuote)(req.params.symbol) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.get('/market/watchlist', async (_req, res) => {
    res.json({ success: true, data: marketData_js_2.DEFAULT_WATCHLIST });
});
// ─── Adaptive Learning ───────────────────────────────────────────────────────
router.get('/adaptive/report', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.json({ success: true, data: await cache_js_1.cache.getOrSet('adaptive_report', adaptiveEngine_js_1.getAdaptiveLearningReport, cache_js_1.TTL.ADAPTIVE_REPORT) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.get('/adaptive/regime', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600'); // 1 hour — regime doesn't change intra-day
        res.json({ success: true, data: await cache_js_1.cache.getOrSet('market_regime', adaptiveEngine_js_1.detectMarketRegime, cache_js_1.TTL.MARKET_REGIME) });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
router.post('/adaptive/resolve-outcomes', async (_req, res) => {
    try {
        await (0, adaptiveEngine_js_1.resolveSignalOutcomes)();
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Manual Trade ─────────────────────────────────────────────────────────────
router.post('/portfolios/:id/trade', async (req, res) => {
    const { symbol, companyName, action, quantity, price, reason } = req.body;
    if (!symbol || !action || !quantity || !price)
        return res.status(400).json({ success: false, error: 'symbol, action, quantity, price required' });
    const pid = parseInt(req.params.id);
    const tradeId = await (0, tradingEngine_js_1.executeTrade)(pid, symbol, companyName || symbol, action, quantity, price, reason || 'Manual trade');
    if (tradeId) {
        cache_js_1.cache.invalidate(`portfolio_summary_${pid}`);
        res.json({ success: true, tradeId });
    }
    else
        res.status(400).json({ success: false, error: 'Trade failed — check cash or holdings' });
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
async function tarsLiveContext(message) {
    const { getDisplayQuote, NSE_UNIVERSE } = await Promise.resolve().then(() => __importStar(require('../services/marketData.js')));
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
    const candidates = [];
    if (explicitSym)
        candidates.push(explicitSym);
    upperTokens.forEach(t => { if (!candidates.includes(t + '.NS'))
        candidates.push(t + '.NS'); });
    // Try each candidate until one succeeds
    for (const sym of candidates.slice(0, 3)) { // cap at 3 lookups per message
        try {
            const q = await getDisplayQuote(sym);
            if (q.price > 0) {
                const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                const sign = q.change >= 0 ? '+' : '';
                return `\n\n[LIVE MARKET DATA — as of ${ist} IST]\nStock: ${sym} (${q.shortName ?? ''})\nLTP: ₹${q.price.toFixed(2)}\nChange: ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)\nProvider: ${q.provider} | Fresh: ${q.isFresh}`;
            }
        }
        catch { /* try next candidate */ }
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
router.post('/tars/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, error: 'message required' });
    }
    try {
        res.set('Cache-Control', 'no-store');
        const Groq = (await Promise.resolve().then(() => __importStar(require('groq-sdk')))).default;
        const groq = new Groq({ apiKey: process.env.groq_key });
        const messages = [
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
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Health checks ───────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({ status: 'OK', service: 'QuantumMind', ts: new Date().toISOString() });
});
router.get('/health/db', async (_req, res) => {
    try {
        await (0, turso_js_1.query)('SELECT 1');
        res.json({ status: 'OK', db: 'turso' });
    }
    catch (err) {
        res.status(503).json({ status: 'DOWN', db: 'turso', error: String(err) });
    }
});
router.get('/health/market-data', async (_req, res) => {
    const start = Date.now();
    try {
        const { getExecutableQuote } = await Promise.resolve().then(() => __importStar(require('../services/marketData.js')));
        const q = await getExecutableQuote('RELIANCE.NS');
        const latencyMs = Date.now() - start;
        const status = q.isFresh ? 'OK' : 'DEGRADED';
        res.json({ status, provider: q.provider, price: q.price, isFresh: q.isFresh, latencyMs });
    }
    catch (err) {
        res.status(503).json({ status: 'DOWN', latencyMs: Date.now() - start, error: String(err) });
    }
});
router.get('/health/cron', async (_req, res) => {
    try {
        const row = await (0, turso_js_1.queryOne)(`SELECT * FROM cron_lock WHERE key='market-cycle'`);
        const lastRun = row ? row.locked_until : null;
        res.json({ status: 'OK', lastCycleLockedUntil: lastRun });
    }
    catch {
        res.json({ status: 'OK', lastCycleLockedUntil: null });
    }
});
// ─── Kill switch admin endpoint ───────────────────────────────────────────────────────────
router.post('/admin/trading-enabled', async (req, res) => {
    const adminSecret = process.env.CRON_SECRET;
    const provided = req.headers.authorization?.replace('Bearer ', '');
    if (adminSecret && provided !== adminSecret)
        return res.status(401).json({ error: 'Unauthorized' });
    const { enabled } = req.body;
    await (0, turso_js_1.run)('UPDATE trading_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key=?', [String(enabled), 'global_trading_enabled']);
    res.json({ success: true, global_trading_enabled: enabled });
});
// ─── Backtest bootstrap admin endpoint ────────────────────────────────────────────────────────
router.post('/admin/backtest/run', async (req, res) => {
    const adminSecret = process.env.CRON_SECRET;
    const provided = req.headers.authorization?.replace('Bearer ', '');
    if (adminSecret && provided !== adminSecret)
        return res.status(401).json({ error: 'Unauthorized' });
    try {
        res.json({ success: true, message: 'Backtest bootstrap started asynchronously. Check logs for progress.' });
        // Run async — don’t block the HTTP response (may take 10+ min for full universe)
        const { symbols } = req.body;
        setImmediate(async () => {
            const { bootstrapSignalWeights } = await Promise.resolve().then(() => __importStar(require('../services/backtestWeights.js')));
            const result = await bootstrapSignalWeights(symbols);
            console.log('[Admin] Backtest bootstrap complete:', JSON.stringify(result, null, 2));
        });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Backtest status / results ────────────────────────────────────────────────────────────────
router.get('/admin/backtest/weights', async (req, res) => {
    const adminSecret = process.env.CRON_SECRET;
    const provided = req.headers.authorization?.replace('Bearer ', '');
    if (adminSecret && provided !== adminSecret)
        return res.status(401).json({ error: 'Unauthorized' });
    try {
        const weights = await (0, turso_js_1.query)('SELECT * FROM signal_weights ORDER BY source');
        const priceRows = await (0, turso_js_1.query)('SELECT COUNT(*) as cnt FROM backtesting_prices').catch(() => [{ cnt: 0 }]);
        res.json({ success: true, weights, backtestingPricesRows: priceRows[0]?.cnt ?? 0 });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Cron trigger ────────────────────────────────────────────────────────────────────────
router.post('/cron/market-cycle', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const provided = req.headers.authorization?.replace('Bearer ', '') ??
            req.query.secret;
        if (provided !== cronSecret) {
            console.warn('[Cron] Unauthorized cycle trigger attempt from', req.ip);
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }
    try {
        const { runMarketCycle } = await Promise.resolve().then(() => __importStar(require('../scheduler/marketMonitor.js')));
        await runMarketCycle();
        res.json({ success: true, ran: new Date().toISOString() });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
// ─── Lightweight price-only refresh ───────────────────────────────────────────────────────
router.post('/cron/price-update', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const provided = req.headers.authorization?.replace('Bearer ', '') ?? req.query.secret;
        if (provided !== cronSecret)
            return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { getMultipleQuotes } = await Promise.resolve().then(() => __importStar(require('../services/marketData.js')));
        const holdings = await (0, turso_js_1.query)('SELECT DISTINCT symbol FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.is_active = 1');
        if (!holdings.length)
            return res.json({ success: true, updated: 0 });
        const symbols = holdings.map((h) => h.symbol);
        const quotes = await getMultipleQuotes(symbols);
        let updated = 0;
        for (const q of quotes) {
            await (0, turso_js_1.run)('UPDATE holdings SET current_price = ?, last_price_updated = CURRENT_TIMESTAMP WHERE symbol = ?', [q.price, q.symbol]);
            updated++;
        }
        res.json({ success: true, updated, ts: new Date().toISOString() });
    }
    catch (err) {
        res.status(500).json({ success: false, error: String(err) });
    }
});
exports.default = router;
