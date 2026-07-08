"use strict";
/**
 * RiskEngine — pre-execution gate between Signal Engine and Execution Simulator.
 *
 * The Signal Engine says "BUY TCS with strength STRONG."
 * The Risk Engine independently checks all guards and either approves or rejects.
 * The Execution Simulator only acts on APPROVED decisions.
 *
 * Checks (in order):
 *   1. Global kill switch
 *   2. Market open (NSE hours + holiday)
 *   3. Price freshness
 *   4. Daily trade limit
 *   5. Daily turnover limit
 *   6. Position concentration cap
 *   7. Portfolio drawdown cap
 *   8. Provider confidence level
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateRisk = evaluateRisk;
const turso_js_1 = require("../db/turso.js");
const tradingGuards_js_1 = require("./tradingGuards.js");
const marketData_js_1 = require("./marketData.js");
const logger_js_1 = require("../lib/logger.js");
// Maximum portfolio drawdown from peak before halting buys (20%)
const MAX_DRAWDOWN_HALT_PCT = 0.20;
async function evaluateRisk(ctx) {
    const checks = [];
    // 1. Kill switch
    const tradingEnabled = await (0, tradingGuards_js_1.isTradingEnabled)();
    checks.push('kill_switch');
    if (!tradingEnabled) {
        logger_js_1.logger.riskBlock(ctx.portfolioId, ctx.symbol, 'Kill switch active');
        return { approved: false, reason: 'Kill switch: global_trading_enabled=false', checksRun: checks };
    }
    // 2. Market hours + holiday
    checks.push('market_hours');
    if ((0, tradingGuards_js_1.isNseHoliday)()) {
        return { approved: false, reason: 'NSE holiday — market closed', checksRun: checks };
    }
    if (!(0, marketData_js_1.isNseMarketOpen)()) {
        return { approved: false, reason: 'Market closed (outside 09:15–15:30 IST)', checksRun: checks };
    }
    // 3. Price freshness
    checks.push('price_freshness');
    if (!ctx.quote.isFresh) {
        logger_js_1.logger.riskBlock(ctx.portfolioId, ctx.symbol, `Stale price from ${ctx.quote.provider}`);
        return { approved: false, reason: `Stale price from ${ctx.quote.provider} — no trade`, checksRun: checks };
    }
    // 4. Provider confidence: Groww unofficial with no cross-validation = LOW confidence on large trades
    checks.push('provider_confidence');
    if (ctx.quote.provider === 'groww_unofficial' && ctx.action === 'BUY') {
        const tradeAmt = ctx.quantity * ctx.price;
        if (tradeAmt > 100000) { // block large buys on unofficial-only data
            logger_js_1.logger.riskBlock(ctx.portfolioId, ctx.symbol, `Groww unofficial source confidence LOW for large BUY ₹${tradeAmt.toFixed(0)}`);
            return { approved: false, reason: 'Provider confidence LOW (Groww unofficial, amount > ₹1L) — no trade', checksRun: checks };
        }
    }
    // 5. Daily trade limit
    checks.push('daily_trade_limit');
    if (!(await (0, tradingGuards_js_1.isUnderDailyTradeLimit)(ctx.portfolioId))) {
        return { approved: false, reason: 'Daily trade limit reached', checksRun: checks };
    }
    // 6. Daily turnover limit (BUY only)
    checks.push('daily_turnover');
    if (ctx.action === 'BUY') {
        const amount = ctx.quantity * ctx.price;
        if (!(await (0, tradingGuards_js_1.isUnderDailyTurnoverLimit)(ctx.portfolioId, ctx.portfolioNAV, amount))) {
            return { approved: false, reason: 'Daily turnover limit reached', checksRun: checks };
        }
    }
    // 7. Position concentration cap (BUY only)
    checks.push('position_cap');
    if (ctx.action === 'BUY') {
        const amount = ctx.quantity * ctx.price;
        if (!(await (0, tradingGuards_js_1.isUnderPositionCap)(ctx.portfolioId, ctx.symbol, ctx.portfolioNAV, amount))) {
            // Try a smaller quantity that fits under cap
            const cap = ctx.portfolioNAV * 0.10;
            const existing = await (0, turso_js_1.queryOne)('SELECT quantity, current_price FROM holdings WHERE portfolio_id=? AND symbol=?', [ctx.portfolioId, ctx.symbol]);
            const existingValue = existing ? Number(existing.quantity) * Number(existing.current_price) : 0;
            const remainingCap = cap - existingValue;
            const maxQty = Math.floor(remainingCap / ctx.price);
            if (maxQty <= 0) {
                return { approved: false, reason: `Position cap reached for ${ctx.symbol} (10% NAV)`, checksRun: checks };
            }
            logger_js_1.logger.warn({ job: 'risk-engine', portfolioId: ctx.portfolioId, symbol: ctx.symbol, phase: 'risk', reason: `Position cap: reducing qty from ${ctx.quantity} to ${maxQty}` });
            return { approved: true, reason: `Position cap applied — qty reduced to ${maxQty}`, maxAllowedQty: maxQty, checksRun: checks };
        }
    }
    // 8. Portfolio drawdown check (BUY only — don't add exposure in drawdown)
    checks.push('drawdown_check');
    if (ctx.action === 'BUY') {
        const portfolio = await (0, turso_js_1.queryOne)('SELECT initial_capital, current_cash FROM portfolios WHERE id=?', [ctx.portfolioId]);
        if (portfolio) {
            const drawdown = 1 - ctx.portfolioNAV / Number(portfolio.initial_capital);
            if (drawdown > MAX_DRAWDOWN_HALT_PCT) {
                logger_js_1.logger.riskBlock(ctx.portfolioId, ctx.symbol, `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% exceeds ${MAX_DRAWDOWN_HALT_PCT * 100}% halt threshold`);
                return { approved: false, reason: `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% — BUY halted`, checksRun: checks };
            }
        }
    }
    logger_js_1.logger.info({ job: 'risk-engine', portfolioId: ctx.portfolioId, symbol: ctx.symbol, phase: 'risk', action: ctx.action, riskApproved: true, checks: checks.join(',') });
    return { approved: true, reason: 'All risk checks passed', checksRun: checks };
}
