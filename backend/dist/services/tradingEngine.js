"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyAdvancedRiskProfile = applyAdvancedRiskProfile;
exports.generateSignal = generateSignal;
exports.executeTrade = executeTrade;
exports.getPortfolioSummary = getPortfolioSummary;
const turso_js_1 = require("../db/turso.js");
const marketData_js_1 = require("./marketData.js");
const riskEngine_js_1 = require("./riskEngine.js");
const turso_js_2 = require("../db/turso.js");
const logger_js_1 = require("../lib/logger.js");
const newsService_js_1 = require("./newsService.js");
const mlEngine_js_1 = require("./mlEngine.js");
const groqService_js_1 = require("./groqService.js");
const adaptiveEngine_js_1 = require("./adaptiveEngine.js");
const geminiService_js_1 = require("./geminiService.js");
function getThresholds(risk) {
    if (risk === 'High')
        return { rsiBuy: 40, rsiSell: 65, stopLoss: 0.12, takeProfit: 0.30, maxPosPct: 0.08 };
    if (risk === 'Low')
        return { rsiBuy: 28, rsiSell: 75, stopLoss: 0.05, takeProfit: 0.15, maxPosPct: 0.03 };
    return { rsiBuy: 35, rsiSell: 70, stopLoss: 0.08, takeProfit: 0.25, maxPosPct: 0.05 };
}
/**
 * Adjust thresholds based on portfolio-level volatility_preference and investment_goal.
 * Called in generateSignal() after loading the base risk thresholds.
 */
function applyAdvancedRiskProfile(base, volatilityPref, investmentGoal) {
    let { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct } = base;
    // Volatility preference adjustments
    if (volatilityPref === 'low') {
        rsiBuy = Math.min(rsiBuy, 25); // tighter oversold threshold — only buy deeper dips
        maxPosPct = Math.min(maxPosPct, 0.03); // smaller positions
    }
    else if (volatilityPref === 'high') {
        rsiBuy = Math.max(rsiBuy, 38); // more permissive — buy before full oversold
        maxPosPct = Math.min(maxPosPct, 0.08); // allow larger positions
    }
    // Investment goal adjustments
    if (investmentGoal === 'income') {
        takeProfit = Math.min(takeProfit, 0.15); // take profits sooner for income
        stopLoss = Math.min(stopLoss, 0.07); // tighter stop — protect income
    }
    else if (investmentGoal === 'retirement') {
        rsiBuy = Math.min(rsiBuy, 28); // only buy strong oversold for retirement
        stopLoss = Math.min(stopLoss, 0.06); // tight stop — preserve capital
        maxPosPct = Math.min(maxPosPct, 0.04); // conservative sizing
    }
    else if (investmentGoal === 'growth') {
        takeProfit = Math.max(takeProfit, 0.25); // let winners run
    }
    return { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct };
}
const MIN_STOCK_PRICE = 30; // ₹30 min — any NSE equity above this is eligible
async function generateSignal(symbol, risk = 'Medium', volatilityPref = null, investmentGoal = null, portfolioCtx) {
    try {
        // Run all data fetches in parallel
        // getExecutableQuote: always fresh, cross-validated, never cached
        const [quote, rsi, sentiment, mlBoost, groqResult] = await Promise.allSettled([
            (0, marketData_js_1.getExecutableQuote)(symbol),
            (0, marketData_js_1.getRsi)(symbol),
            (0, newsService_js_1.getStockSentiment)(symbol).catch(() => null),
            (0, mlEngine_js_1.getMLBoost)(symbol, risk).catch(() => null),
            (0, groqService_js_1.getGroqStockSentiment)(symbol).catch(() => null),
        ]);
        const q = quote.status === 'fulfilled' ? quote.value : null;
        if (!q || q.price < MIN_STOCK_PRICE) {
            return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Penny stock or data error (price=${q?.price ?? 0})`, price: q?.price ?? 0 };
        }
        // Fail-closed: do not act on stale prices during market hours
        if (!q.isFresh) {
            console.warn(`[Signal] Stale price for ${symbol} from ${q.provider} — forcing HOLD`);
            return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Stale price from ${q.provider} — no trade`, price: q.price };
        }
        const rsiVal = rsi.status === 'fulfilled' ? rsi.value : null;
        const sent = sentiment.status === 'fulfilled' ? sentiment.value : null;
        const ml = mlBoost.status === 'fulfilled' ? mlBoost.value : null;
        const groq = groqResult.status === 'fulfilled' ? groqResult.value : null;
        // Use regime-calibrated thresholds if available, else fall back to risk tier
        let t = getThresholds(risk);
        const [regime, weights] = await Promise.all([
            (0, adaptiveEngine_js_1.getCurrentRegime)().catch(() => null),
            (0, adaptiveEngine_js_1.getSignalWeights)().catch(() => new Map()),
        ]);
        if (regime) {
            t = { ...t, rsiBuy: regime.rsiBuy, rsiSell: regime.rsiSell, stopLoss: regime.stopLoss };
        }
        // Apply advanced risk profile overrides (Phase 5)
        if (volatilityPref || investmentGoal) {
            t = applyAdvancedRiskProfile(t, volatilityPref, investmentGoal);
        }
        const w = (src) => weights.get(src)?.weight ?? 1.0;
        const notes = [];
        let buy = 0, sell = 0;
        // ── Technical ──────────────────────────────────────────────────────────
        const rsiWeight = w('RSI');
        if (rsiVal !== null) {
            if (rsiVal < t.rsiBuy - 5) {
                buy += 2 * rsiWeight;
                notes.push(`RSI oversold (${rsiVal.toFixed(1)}) [w=${rsiWeight.toFixed(1)}]`);
            }
            else if (rsiVal < t.rsiBuy) {
                buy += 1 * rsiWeight;
                notes.push(`RSI low (${rsiVal.toFixed(1)})`);
            }
            if (rsiVal > t.rsiSell + 5) {
                sell += 2 * rsiWeight;
                notes.push(`RSI overbought (${rsiVal.toFixed(1)})`);
            }
            else if (rsiVal > t.rsiSell) {
                sell += 1 * rsiWeight;
                notes.push(`RSI high (${rsiVal.toFixed(1)})`);
            }
        }
        if (q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh) {
            const range = q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow;
            const pos = (q.price - q.fiftyTwoWeekLow) / range;
            if (pos < 0.15) {
                buy += 2;
                notes.push('Near 52W low');
            }
            else if (pos < 0.25) {
                buy += 1;
                notes.push('Below 52W midpoint');
            }
            if (pos > 0.90) {
                sell += 1;
                notes.push('Near 52W high');
            }
        }
        if (q.changePct < -4) {
            buy += 1;
            notes.push(`Day drop ${q.changePct.toFixed(1)}%`);
        }
        if (q.changePct > 5) {
            sell += 1;
            notes.push(`Day surge ${q.changePct.toFixed(1)}%`);
        }
        // ── Rule-based news sentiment ───────────────────────────────────────────
        if (sent && sent.score !== 0) {
            if (sent.score >= 2) {
                buy += 2;
                notes.push(`NSE: ${sent.label}`);
            }
            else if (sent.score === 1) {
                buy += 1;
                notes.push(`NSE: ${sent.label}`);
            }
            else if (sent.score <= -2) {
                sell += 2;
                notes.push(`NSE: ${sent.label}`);
            }
            else if (sent.score === -1) {
                sell += 1;
                notes.push(`NSE: ${sent.label}`);
            }
        }
        // ── ML momentum boost ──────────────────────────────────────────────────
        if (ml && ml.momentumBoost !== 0) {
            if (ml.momentumBoost > 0) {
                buy += ml.momentumBoost;
                notes.push(ml.reason);
            }
            else {
                sell += Math.abs(ml.momentumBoost);
                notes.push(ml.reason);
            }
        }
        // ── Groq LLM (highest quality signal, weighted ×2) ────────────────────
        let groqSentiment;
        if (groq) {
            groqSentiment = `${groq.sentiment}: ${groq.summary}`;
            if (groq.score >= 2) {
                buy += 2;
                notes.push(`Groq: ${groq.tradeImplication}`);
            }
            else if (groq.score === 1) {
                buy += 1;
                notes.push(`Groq: ${groq.tradeImplication}`);
            }
            else if (groq.score <= -2) {
                sell += 2;
                notes.push(`Groq: ${groq.tradeImplication}`);
            }
            else if (groq.score === -1) {
                sell += 1;
                notes.push(`Groq: ${groq.tradeImplication}`);
            }
        }
        const reason = notes.join('; ') || 'No signal';
        const topScore = Math.max(buy, sell);
        const topAction = buy > sell && buy >= 2 ? 'BUY' : sell > buy && sell >= 2 ? 'SELL' : null;
        if (topAction && portfolioCtx && topScore >= 4) {
            // Gemini pre-trade reasoning gate — only fires on STRONG signals (score ≥ 4)
            // MODERATE signals (score 2-3) proceed without veto to conserve Gemini quota
            const veto = await (0, geminiService_js_1.geminiTradeVeto)({
                symbol, action: topAction, price: q.price,
                rsiValue: rsiVal, momentumTrend: ml?.reason,
                groqSentiment,
                voteScore: topScore,
                portfolioContext: {
                    sectorExposurePct: portfolioCtx.sectorExposurePct,
                    // Use caller-supplied actual position size; fall back to 5% if not provided
                    positionSizePct: portfolioCtx.proposedPositionPct ??
                        (portfolioCtx.totalNAV > 0 ? (portfolioCtx.cashBalance * 0.05 / portfolioCtx.totalNAV) * 100 : 5),
                    totalHoldings: portfolioCtx.holdings,
                    cashBalancePct: portfolioCtx.totalNAV > 0
                        ? (portfolioCtx.cashBalance / portfolioCtx.totalNAV) * 100
                        : 100,
                },
            }).catch(() => ({ verdict: 'EXECUTE', reason: '' }));
            if (veto.verdict === 'SKIP') {
                return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Gemini veto: ${veto.reason}`, price: q.price };
            }
            const strength = veto.verdict === 'REDUCE'
                ? 'MODERATE' // cap to MODERATE so position sizing stays smaller
                : topScore >= 4 ? 'STRONG' : 'MODERATE';
            const finalReason = veto.reason ? `${reason} | Gemini: ${veto.reason}` : reason;
            return { symbol, action: topAction, strength, reason: finalReason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
        }
        if (topAction) {
            return { symbol, action: topAction, strength: topScore >= 4 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
        }
        return { symbol, action: 'HOLD', strength: 'WEAK', reason, price: q.price };
    }
    catch (err) {
        console.error(`[Signal] Error for ${symbol}:`, err);
        return null;
    }
}
async function executeTrade(portfolioId, symbol, companyName, action, quantity, price, reason, quote, // pass executable quote for risk engine
ctx // structured context for explainability
) {
    const portfolio = await (0, turso_js_1.queryOne)('SELECT * FROM portfolios WHERE id = ?', [portfolioId]);
    if (!portfolio || !portfolio.is_active)
        return null;
    const amount = quantity * price;
    const brokerage = amount * 0.002;
    const netAmount = action === 'BUY' ? amount + brokerage : amount - brokerage;
    // Compute NAV
    const holdingsForNAV = await (0, turso_js_1.query)('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]);
    const portfolioNAV = holdingsForNAV.reduce((s, h) => s + Number(h.quantity) * Number(h.current_price || h.avg_buy_price), 0) + Number(portfolio.current_cash);
    // ── Risk Engine gate ──────────────────────────────────────────────────
    if (quote) {
        const riskDecision = await (0, riskEngine_js_1.evaluateRisk)({
            portfolioId, symbol, action,
            quantity, price, portfolioNAV, quote,
        });
        const effectiveQty = riskDecision.maxAllowedQty ?? quantity;
        if (!riskDecision.approved) {
            logger_js_1.logger.riskBlock(portfolioId, symbol, riskDecision.reason);
            return null;
        }
        if (effectiveQty !== quantity) {
            // Risk engine reduced the quantity to fit under position cap
            return executeTrade(portfolioId, symbol, companyName, action, effectiveQty, price, `${reason} [qty-capped]`, quote);
        }
    }
    // Cash / holding pre-check (fast fail before touching DB)
    if (action === 'BUY' && portfolio.current_cash < netAmount) {
        logger_js_1.logger.warn({ job: 'trade-execution', portfolioId, symbol, phase: 'execution', reason: 'Insufficient cash' });
        return null;
    }
    if (action === 'SELL') {
        const h = await (0, turso_js_1.queryOne)('SELECT * FROM holdings WHERE portfolio_id=? AND symbol=?', [portfolioId, symbol]);
        if (!h || Number(h.quantity) < quantity) {
            logger_js_1.logger.warn({ job: 'trade-execution', portfolioId, symbol, phase: 'execution', reason: 'Insufficient holding for SELL' });
            return null;
        }
    }
    const valueBefore = portfolioNAV;
    // ── Atomic execution batch ───────────────────────────────────────────────
    // All statements execute in one LibSQL transaction — partial failures roll back entirely.
    const statements = [];
    // Step 1: Insert trade record
    const tradeReasonJson = ctx ? JSON.stringify({
        rsi: ctx.rsi,
        momentumScore: ctx.momentumScore,
        newsScore: ctx.newsScore,
        groqSentiment: ctx.groqSentiment,
        kellyFraction: ctx.kellyFraction,
        regime: ctx.regime,
        buyScore: ctx.buyScore,
        sellScore: ctx.sellScore,
        riskGates: ctx.riskGates,
        price,
        action,
        timestamp: new Date().toISOString(),
    }) : null;
    // For SELL: compute realized PnL before building statements so it can be
    // included in the INSERT itself — keeping the entire operation atomic.
    let realizedPnlOnTrade = null;
    if (action === 'SELL') {
        const h = holdingsForNAV.find((h) => h.symbol === symbol);
        if (!h) {
            logger_js_1.logger.warn({ job: 'trading-engine', portfolioId, symbol, reason: 'SELL skipped — holding not found in NAV snapshot' });
            return null;
        }
        realizedPnlOnTrade = (price - Number(h.avg_buy_price)) * quantity - brokerage;
        const newQty = Number(h.quantity) - quantity;
        if (newQty <= 0.001) {
            statements.push({ sql: 'DELETE FROM holdings WHERE portfolio_id=? AND symbol=?', args: [portfolioId, symbol] });
        }
        else {
            statements.push({ sql: 'UPDATE holdings SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, portfolioId, symbol] });
        }
        statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash+?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
    }
    else {
        const existing = holdingsForNAV.find((h) => h.symbol === symbol);
        if (existing) {
            const newQty = Number(existing.quantity) + quantity;
            const newAvg = (Number(existing.quantity) * Number(existing.avg_buy_price) + amount) / newQty;
            statements.push({ sql: 'UPDATE holdings SET quantity=?, avg_buy_price=?, current_price=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, newAvg, price, portfolioId, symbol] });
        }
        else {
            statements.push({ sql: 'INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price) VALUES (?,?,?,?,?,?)', args: [portfolioId, symbol, companyName, quantity, price, price] });
        }
        statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash-?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
    }
    // INSERT trade with realized_pnl included — fully atomic, no follow-up UPDATE needed
    statements.unshift({
        sql: 'INSERT INTO trades (portfolio_id, symbol, company_name, action, quantity, price, amount, brokerage, net_amount, signal_reason, portfolio_value_before, trade_reason, realized_pnl) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [portfolioId, symbol, companyName, action, quantity, price, amount, brokerage, netAmount, reason, valueBefore, tradeReasonJson, realizedPnlOnTrade],
    });
    if (action === 'SELL') {
        // statements already built above — execute and return
        const results = await (0, turso_js_2.batchWithResults)(statements);
        const tradeId = results[0].lastInsertRowid;
        logger_js_1.logger.trade(portfolioId, symbol, 'SELL', price, quote?.provider ?? 'unknown', true, reason, { qty: quantity, netAmount, realizedPnl: realizedPnlOnTrade });
        // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
        const signalSourceSell = ctx?.groqSentiment != null ? 'news_sentiment'
            : ctx?.momentumScore != null ? 'momentum'
                : 'technical';
        (0, adaptiveEngine_js_1.recordSignalForTracking)(portfolioId, symbol, 'SELL', signalSourceSell, price, new Date().toISOString()).catch(e => console.warn('[Adaptive] recordSignalForTracking failed:', e));
        return tradeId;
    }
    const results = await (0, turso_js_2.batchWithResults)(statements);
    const tradeId = results[0].lastInsertRowid;
    logger_js_1.logger.trade(portfolioId, symbol, 'BUY', price, quote?.provider ?? 'unknown', true, reason, { qty: quantity, netAmount });
    // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
    const signalSourceBuy = ctx?.groqSentiment != null ? 'news_sentiment'
        : ctx?.momentumScore != null ? 'momentum'
            : 'technical';
    (0, adaptiveEngine_js_1.recordSignalForTracking)(portfolioId, symbol, 'BUY', signalSourceBuy, price, new Date().toISOString()).catch(e => console.warn('[Adaptive] recordSignalForTracking failed:', e));
    return tradeId;
}
async function getPortfolioSummary(portfolioId) {
    const [portfolio, holdings] = await Promise.all([
        (0, turso_js_1.queryOne)('SELECT * FROM portfolios WHERE id = ?', [portfolioId]),
        (0, turso_js_1.query)('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]),
    ]);
    // Realized PnL: only from closed positions (SELL trades minus their cost basis)
    // Approximated as: sum(sell_proceeds) - sum(buy_cost for matching lots)
    // For now: track via explicit pnl column when available, else 0 until sells occur
    const realizedRows = await (0, turso_js_1.query)(`SELECT COALESCE(SUM(realized_pnl), 0) as pnl FROM trades WHERE portfolio_id = ? AND action = 'SELL' AND realized_pnl IS NOT NULL`, [portfolioId]);
    const realizedPnl = Number(realizedRows[0]?.pnl ?? 0);
    let invested = 0, current = 0;
    const hSummaries = [];
    for (const h of holdings) {
        const cp = Number(h.current_price ?? h.avg_buy_price);
        const cv = Number(h.quantity) * cp;
        const cost = Number(h.quantity) * Number(h.avg_buy_price);
        invested += cost;
        current += cv;
        const updatedAt = (h.last_price_updated ?? h.updated_at);
        const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;
        const priceStatus = ageMs < 15 * 60 * 1000 ? 'LIVE' : 'STALE';
        hSummaries.push({
            symbol: h.symbol, companyName: h.company_name, sector: h.sector,
            quantity: Number(h.quantity), avgBuyPrice: Number(h.avg_buy_price), currentPrice: cp,
            currentValue: cv, pnl: cv - cost, pnlPct: ((cv - cost) / cost) * 100,
            priceStatus, priceUpdatedAt: updatedAt,
        });
    }
    const totalValue = current + Number(portfolio.current_cash);
    const returnPct = ((totalValue - Number(portfolio.initial_capital)) / Number(portfolio.initial_capital)) * 100;
    return {
        id: Number(portfolio.id), name: portfolio.name,
        totalValue, investedValue: invested, cashBalance: Number(portfolio.current_cash),
        unrealizedPnl: current - invested, realizedPnl, totalPnl: (current - invested) + realizedPnl,
        returnPct, targetReturnPct: Number(portfolio.target_return_pct),
        riskTolerance: portfolio.risk_tolerance, investmentHorizonMonths: Number(portfolio.investment_horizon_months),
        holdings: hSummaries,
    };
}
