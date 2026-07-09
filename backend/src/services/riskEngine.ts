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

import { queryOne } from '../db/turso.js';
import {
  isTradingEnabled,
  isNseHoliday,
  isUnderDailyTradeLimit,
  isUnderDailyTurnoverLimit,
  isUnderPositionCap,
} from './tradingGuards.js';
import { isNseMarketOpen, type StockQuote, getSymbolSector, isInEarningsBlackout } from './marketData.js';
import { query as dbQuery } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  /** Quantity adjusted down if position cap would be breached partially */
  maxAllowedQty?: number;
  checksRun: string[];
}

export interface RiskContext {
  portfolioId: number;
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  portfolioNAV: number;
  quote: StockQuote;
}

// Maximum portfolio drawdown from peak before halting buys (20%)
const MAX_DRAWDOWN_HALT_PCT = 0.20;


export async function evaluateRisk(ctx: RiskContext): Promise<RiskDecision> {
  const checks: string[] = [];

  // 1. Kill switch
  const tradingEnabled = await isTradingEnabled();
  checks.push('kill_switch');
  if (!tradingEnabled) {
    logger.riskBlock(ctx.portfolioId, ctx.symbol, 'Kill switch active');
    return { approved: false, reason: 'Kill switch: global_trading_enabled=false', checksRun: checks };
  }

  // 2. Market hours + holiday
  checks.push('market_hours');
  if (isNseHoliday()) {
    return { approved: false, reason: 'NSE holiday — market closed', checksRun: checks };
  }
  if (!isNseMarketOpen()) {
    return { approved: false, reason: 'Market closed (outside 09:15–15:30 IST)', checksRun: checks };
  }

  // 3. Price freshness
  checks.push('price_freshness');
  if (!ctx.quote.isFresh) {
    logger.riskBlock(ctx.portfolioId, ctx.symbol, `Stale price from ${ctx.quote.provider}`);
    return { approved: false, reason: `Stale price from ${ctx.quote.provider} — no trade`, checksRun: checks };
  }

  // 4. Provider confidence: Groww unofficial with no cross-validation = LOW confidence on large trades
  checks.push('provider_confidence');
  if (ctx.quote.provider === 'groww_unofficial' && ctx.action === 'BUY') {
    const tradeAmt = ctx.quantity * ctx.price;
    if (tradeAmt > 100_000) { // block large buys on unofficial-only data
      logger.riskBlock(ctx.portfolioId, ctx.symbol, `Groww unofficial source confidence LOW for large BUY ₹${tradeAmt.toFixed(0)}`);
      return { approved: false, reason: 'Provider confidence LOW (Groww unofficial, amount > ₹1L) — no trade', checksRun: checks };
    }
  }

  // 5. Daily trade limit
  checks.push('daily_trade_limit');
  if (!(await isUnderDailyTradeLimit(ctx.portfolioId))) {
    return { approved: false, reason: 'Daily trade limit reached', checksRun: checks };
  }

  // 6. Daily turnover limit (BUY only)
  checks.push('daily_turnover');
  if (ctx.action === 'BUY') {
    const amount = ctx.quantity * ctx.price;
    if (!(await isUnderDailyTurnoverLimit(ctx.portfolioId, ctx.portfolioNAV, amount))) {
      return { approved: false, reason: 'Daily turnover limit reached', checksRun: checks };
    }
  }

  // 7. Position concentration cap (BUY only) — max 10% NAV per symbol (only per-symbol limit)
  checks.push('position_cap');
  if (ctx.action === 'BUY') {
    const amount = ctx.quantity * ctx.price;
    if (!(await isUnderPositionCap(ctx.portfolioId, ctx.symbol, ctx.portfolioNAV, amount))) {
      // Try a smaller quantity that fits under cap
      const cap = ctx.portfolioNAV * 0.10;
      const existing = await queryOne(
        'SELECT quantity, current_price FROM holdings WHERE portfolio_id=? AND symbol=?',
        [ctx.portfolioId, ctx.symbol]
      );
      const existingValue = existing ? Number(existing.quantity) * Number(existing.current_price) : 0;
      const remainingCap = cap - existingValue;
      const maxQty = Math.floor(remainingCap / ctx.price);
      if (maxQty <= 0) {
        return { approved: false, reason: `Position cap reached for ${ctx.symbol} (10% NAV)`, checksRun: checks };
      }
      logger.warn({ job: 'risk-engine', portfolioId: ctx.portfolioId, symbol: ctx.symbol, phase: 'risk', reason: `Position cap: reducing qty from ${ctx.quantity} to ${maxQty}` });
      return { approved: true, reason: `Position cap applied — qty reduced to ${maxQty}`, maxAllowedQty: maxQty, checksRun: checks };
    }
  }

  // 8. Portfolio drawdown check (BUY only — respects portfolio-level max_drawdown_pct)
  // Drawdown = decline from peak NAV (not from initial capital, which would miss intra-period peaks).
  checks.push('drawdown_check');
  if (ctx.action === 'BUY') {
    const portfolio = await queryOne('SELECT initial_capital, peak_nav, max_drawdown_pct FROM portfolios WHERE id=?', [ctx.portfolioId]);
    if (portfolio) {
      const drawdownLimit = portfolio.max_drawdown_pct != null
        ? Number(portfolio.max_drawdown_pct) / 100
        : MAX_DRAWDOWN_HALT_PCT;
      // Use peak_nav if available; fall back to initial_capital for portfolios without a recorded peak yet
      const peakNAV = portfolio.peak_nav != null ? Number(portfolio.peak_nav) : Number(portfolio.initial_capital);
      const drawdown = peakNAV > 0 ? 1 - ctx.portfolioNAV / peakNAV : 0;
      if (drawdown > drawdownLimit) {
        logger.riskBlock(ctx.portfolioId, ctx.symbol, `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% from peak exceeds ${(drawdownLimit * 100).toFixed(0)}% limit`);
        return { approved: false, reason: `Portfolio drawdown ${(drawdown * 100).toFixed(1)}% from peak — BUY halted (limit: ${(drawdownLimit * 100).toFixed(0)}%)`, checksRun: checks };
      }
    }
  }

  // 9. Sector concentration cap (BUY only) — no single sector may exceed 35% of portfolio NAV
  checks.push('sector_cap');
  if (ctx.action === 'BUY') {
    const sector = getSymbolSector(ctx.symbol);
    if (sector !== 'Other') {
      const holdings = await dbQuery(
        'SELECT h.symbol, h.quantity, h.current_price FROM holdings h WHERE h.portfolio_id = ?',
        [ctx.portfolioId]
      );
      const sectorValue = holdings
        .filter((h: any) => getSymbolSector(h.symbol as string) === sector)
        .reduce((s: number, h: any) => s + Number(h.quantity) * Number(h.current_price), 0);
      const buyValue = ctx.quantity * ctx.price;
      const newSectorPct = (sectorValue + buyValue) / ctx.portfolioNAV;
      if (newSectorPct > 0.35) {
        logger.riskBlock(ctx.portfolioId, ctx.symbol, `Sector cap: ${sector} would reach ${(newSectorPct * 100).toFixed(1)}% NAV (limit 35%)`);
        return { approved: false, reason: `Sector concentration cap: ${sector} sector at ${(newSectorPct * 100).toFixed(1)}% (max 35%)`, checksRun: checks };
      }
    }
  }

  // 10. Earnings blackout gate (BUY only) — block within ±48h of earnings announcement
  checks.push('earnings_blackout');
  if (ctx.action === 'BUY') {
    const inBlackout = await isInEarningsBlackout(ctx.symbol).catch(() => false);
    if (inBlackout) {
      logger.riskBlock(ctx.portfolioId, ctx.symbol, `Earnings blackout: announcement within ±48h`);
      return { approved: false, reason: `Earnings blackout: ${ctx.symbol} has earnings within 48h — BUY blocked to avoid event risk`, checksRun: checks };
    }
  }

  logger.info({ job: 'risk-engine', portfolioId: ctx.portfolioId, symbol: ctx.symbol, phase: 'risk', action: ctx.action, riskApproved: true, checks: checks.join(',') });
  return { approved: true, reason: 'All risk checks passed', checksRun: checks };
}
