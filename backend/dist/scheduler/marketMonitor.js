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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMarketCycle = runMarketCycle;
exports.startScheduler = startScheduler;
const node_cron_1 = __importDefault(require("node-cron"));
const turso_js_1 = require("../db/turso.js");
const tradingEngine_js_1 = require("../services/tradingEngine.js");
const marketData_js_1 = require("../services/marketData.js");
const tradingGuards_js_1 = require("../services/tradingGuards.js");
const logger_js_1 = require("../lib/logger.js");
async function updateAllPrices() {
    const holdings = await (0, turso_js_1.query)(`
    SELECT DISTINCT h.symbol FROM holdings h
    JOIN portfolios p ON p.id = h.portfolio_id
    WHERE p.is_active = 1
  `);
    if (!holdings.length)
        return;
    try {
        const quotes = await (0, marketData_js_1.getMultipleQuotes)(holdings.map((h) => h.symbol));
        for (const q of quotes) {
            await (0, turso_js_1.run)('UPDATE holdings SET current_price=?, last_price_updated=CURRENT_TIMESTAMP WHERE symbol=?', [q.price, q.symbol]);
        }
        console.log(`[Monitor] Updated ${quotes.length} prices`);
    }
    catch (err) {
        // Yahoo Finance may block cloud IPs — continue with stale DB prices
        console.warn('[Monitor] Price fetch failed, using cached prices:', String(err));
    }
}
async function runPortfolioTradingCycle(portfolioId, riskTolerance) {
    const marketOpen = (0, marketData_js_1.isNseMarketOpen)();
    const summary = await (0, tradingEngine_js_1.getPortfolioSummary)(portfolioId);
    const stopLoss = riskTolerance === 'High' ? 0.12 : riskTolerance === 'Low' ? 0.05 : 0.08;
    const takeProfit = riskTolerance === 'High' ? 0.30 : riskTolerance === 'Low' ? 0.15 : 0.25;
    // Load advanced risk profile for this portfolio
    const portfolioProfile = await (0, turso_js_1.queryOne)('SELECT volatility_preference, investment_goal FROM portfolios WHERE id = ?', [portfolioId]);
    const _volPref = portfolioProfile?.volatility_preference ?? null;
    const _invGoal = portfolioProfile?.investment_goal ?? null;
    let sellSignalCount = 0;
    // Sell scan
    for (const h of summary.holdings) {
        const signal = await (0, tradingEngine_js_1.generateSignal)(h.symbol, riskTolerance, _volPref, _invGoal);
        if (!signal)
            continue;
        const lossRatio = (signal.price - h.avgBuyPrice) / h.avgBuyPrice;
        let shouldSell = false, reason = signal.reason;
        if (lossRatio < -stopLoss) {
            shouldSell = true;
            reason = `Stop-loss: ${(lossRatio * 100).toFixed(1)}%`;
        }
        else if (lossRatio > takeProfit && signal.action === 'SELL') {
            shouldSell = true;
            reason = `Take-profit +${(lossRatio * 100).toFixed(1)}%. ${reason}`;
        }
        else if (signal.action === 'SELL' && signal.strength !== 'WEAK') {
            shouldSell = true;
        }
        // Log every signal (including HOLDs) for audit trail
        logger_js_1.logger.signal(portfolioId, h.symbol, signal.action, signal.strength, signal.reason, signal.price);
        if (shouldSell) {
            sellSignalCount++;
            await (0, turso_js_1.run)('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal,acted_upon) VALUES (?,?,?,?,?,?,1)', [portfolioId, h.symbol, 'SELL', signal.strength, reason, signal.price]);
            if (!marketOpen) {
                logger_js_1.logger.info({ job: 'market-cycle', portfolioId, symbol: h.symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
                continue;
            }
            await (0, tradingEngine_js_1.executeTrade)(portfolioId, h.symbol, h.companyName, 'SELL', h.quantity, signal.price, reason);
        }
    }
    // Buy scan
    const refreshed = await (0, tradingEngine_js_1.getPortfolioSummary)(portfolioId);
    const held = new Set(refreshed.holdings.map(h => h.symbol));
    let tradeCount = 0, signalCount = sellSignalCount;
    if (refreshed.cashBalance < 10000)
        return { trades: tradeCount, signals: signalCount };
    const maxPosPct = riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05;
    // Dynamic open-market universe: full NSE equity list (fetched from NSE, cached 24h)
    // Rotating 50-stock sample per cycle. Falls back to static ~150 list if NSE blocks.
    const cycleSlot = Math.floor(Date.now() / (5 * 60 * 1000)); // bucket changes every 5 min
    const fullUniverse = await (0, marketData_js_1.getDynamicCycleWatchlist)(cycleSlot, 200); // get 200 to allow biasing
    // Apply cap preference if portfolio has one set
    // preferred_caps: JSON array e.g. ["small"] | ["mid","large"] | null (null = open market, no bias)
    // When multiple caps selected, the first one drives the 50% bias; others are included in the "rest" pool
    const portfolio = await (0, turso_js_1.queryOne)('SELECT preferred_caps, volatility_preference, investment_goal FROM portfolios WHERE id = ?', [portfolioId]);
    let preferredCap = null;
    if (portfolio?.preferred_caps) {
        try {
            const caps = JSON.parse(String(portfolio.preferred_caps));
            if (caps.length > 0)
                preferredCap = caps[0];
        }
        catch { /* malformed JSON — treat as open market */ }
    }
    const cycleUniverse = preferredCap
        ? (0, marketData_js_1.getBiasedCycleWatchlist)(fullUniverse, preferredCap, cycleSlot, 50, 0.5)
        : fullUniverse.slice(0, 50);
    const candidates = cycleUniverse.filter(s => !held.has(s)).slice(0, 8); // up to 8 new position candidates
    const volatilityPref = portfolio?.volatility_preference ?? null;
    const investmentGoal = portfolio?.investment_goal ?? null;
    for (const symbol of candidates) {
        const signal = await (0, tradingEngine_js_1.generateSignal)(symbol, riskTolerance, volatilityPref, investmentGoal);
        if (!signal || signal.action !== 'BUY' || signal.strength === 'WEAK')
            continue;
        signalCount++;
        logger_js_1.logger.signal(portfolioId, symbol, signal.action, signal.strength, signal.reason, signal.price);
        const invest = Math.min(refreshed.totalValue * maxPosPct, refreshed.cashBalance * 0.3);
        const qty = Math.floor(invest / signal.price);
        if (qty <= 0)
            continue;
        const sigRes = await (0, turso_js_1.run)('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal) VALUES (?,?,?,?,?,?)', [portfolioId, symbol, 'BUY', signal.strength, signal.reason, signal.price]);
        if (!marketOpen) {
            logger_js_1.logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
            continue;
        }
        const tradeId = await (0, tradingEngine_js_1.executeTrade)(portfolioId, symbol, symbol.replace('.NS', ''), 'BUY', qty, signal.price, signal.reason, undefined, { groqSentiment: signal.groqSentiment, momentumScore: signal.mlBoost, regime: refreshed.riskTolerance });
        if (tradeId && sigRes.lastInsertRowid) {
            await (0, turso_js_1.run)('UPDATE market_signals SET acted_upon=1, trade_id=? WHERE id=?', [tradeId, sigRes.lastInsertRowid]);
            tradeCount++;
        }
    }
    return { trades: tradeCount, signals: signalCount };
}
async function snapshotAll() {
    const portfolios = await (0, turso_js_1.query)('SELECT id FROM portfolios WHERE is_active = 1');
    for (const { id } of portfolios) {
        const s = await (0, tradingEngine_js_1.getPortfolioSummary)(Number(id));
        await (0, turso_js_1.run)('INSERT INTO performance_snapshots (portfolio_id,total_portfolio_value,invested_value,cash_balance,unrealized_pnl,realized_pnl,total_pnl,return_pct,target_return_pct,holdings_count) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, s.totalValue, s.investedValue, s.cashBalance, s.unrealizedPnl, s.realizedPnl, s.totalPnl, s.returnPct, s.targetReturnPct, s.holdings.length]);
        console.log(`[P${id}] Snapshot ₹${s.totalValue.toFixed(0)} | ${s.returnPct.toFixed(2)}%`);
    }
}
// Exported for Vercel cron endpoint + API trigger
async function runMarketCycle() {
    const cycleStart = Date.now();
    // Idempotency: in-memory guard first (fast), then DB lock (survives cold starts)
    if (!(0, tradingGuards_js_1.acquireCycleLock)())
        return;
    if (!(await (0, tradingGuards_js_1.acquireDbCycleLock)()))
        return;
    if ((0, tradingGuards_js_1.isNseHoliday)()) {
        logger_js_1.logger.cronCycle({ portfolioCount: 0, tradesExecuted: 0, signalsGenerated: 0, durationMs: 0, skipped: true, skipReason: 'NSE holiday' });
        await (0, tradingGuards_js_1.releaseCycleLock)();
        return;
    }
    if (!(0, marketData_js_1.isNseMarketOpen)()) {
        logger_js_1.logger.info({ job: 'market-cycle', phase: 'cron', reason: 'Market closed — price update only, no trades' });
    }
    let tradesExecuted = 0;
    let signalsGenerated = 0;
    try {
        await updateAllPrices();
        // Refresh index prices once per day (check if last stored date is today)
        const today = new Date().toISOString().slice(0, 10);
        const lastIdx = await (0, turso_js_1.queryOne)("SELECT date FROM index_prices ORDER BY date DESC LIMIT 1").catch(() => null);
        if (!lastIdx || String(lastIdx.date) < today) {
            const { fetchAndStoreIndexHistory } = await Promise.resolve().then(() => __importStar(require('../services/indexData.js')));
            fetchAndStoreIndexHistory().catch(e => logger_js_1.logger.warn({ reason: `[IndexData] refresh failed: ${e}` }));
        }
        const portfolios = await (0, turso_js_1.query)('SELECT * FROM portfolios WHERE is_active = 1');
        for (const p of portfolios) {
            const { trades, signals } = await runPortfolioTradingCycle(Number(p.id), p.risk_tolerance);
            tradesExecuted += trades;
            signalsGenerated += signals;
        }
        await snapshotAll();
        logger_js_1.logger.cronCycle({ portfolioCount: portfolios.length, tradesExecuted, signalsGenerated, durationMs: Date.now() - cycleStart });
    }
    finally {
        await (0, tradingGuards_js_1.releaseCycleLock)();
    }
}
function startScheduler() {
    // Market hours: every 5 min (IST 9:00–15:45 Mon-Fri)
    node_cron_1.default.schedule('*/5 9-15 * * 1-5', () => { runMarketCycle().catch(console.error); }, { timezone: 'Asia/Kolkata' });
    // Pre-market
    node_cron_1.default.schedule('55 8 * * 1-5', () => { updateAllPrices().catch(console.error); }, { timezone: 'Asia/Kolkata' });
    // Hourly snapshot
    node_cron_1.default.schedule('0 * * * *', () => { snapshotAll().catch(console.error); }, { timezone: 'Asia/Kolkata' });
    // After-market snapshot
    node_cron_1.default.schedule('0 16 * * 1-5', () => { snapshotAll().catch(console.error); }, { timezone: 'Asia/Kolkata' });
    console.log('[Scheduler] All cron jobs active (IST)');
}
