import { query, queryOne, run } from '../db/turso.js';
import { getQuote, getExecutableQuote, getRsi, isNseMarketOpen } from './marketData.js';
import {
  isTradingEnabled,
  isUnderDailyTradeLimit,
  isUnderDailyTurnoverLimit,
  isUnderPositionCap,
} from './tradingGuards.js';
import { getStockSentiment } from './newsService.js';
import { getMLBoost } from './mlEngine.js';
import { getGroqStockSentiment } from './groqService.js';
import { getSignalWeights, getCurrentRegime, recordSignalForTracking } from './adaptiveEngine.js';

export interface TradeSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: 'STRONG' | 'MODERATE' | 'WEAK';
  reason: string;
  price: number;
  mlBoost?: number;
  groqSentiment?: string;
}

export interface HoldingSummary {
  symbol: string;
  companyName: string;
  sector?: string;
  quantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
}

export interface PortfolioSummary {
  id: number;
  name: string;
  totalValue: number;
  investedValue: number;
  cashBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  returnPct: number;
  targetReturnPct: number;
  riskTolerance: string;
  investmentHorizonMonths: number;
  holdings: HoldingSummary[];
}

function getThresholds(risk: string) {
  if (risk === 'High') return { rsiBuy: 40, rsiSell: 65, stopLoss: 0.12, takeProfit: 0.30, maxPosPct: 0.08 };
  if (risk === 'Low')  return { rsiBuy: 28, rsiSell: 75, stopLoss: 0.05, takeProfit: 0.15, maxPosPct: 0.03 };
  return                       { rsiBuy: 35, rsiSell: 70, stopLoss: 0.08, takeProfit: 0.25, maxPosPct: 0.05 };
}

const MIN_STOCK_PRICE = 50;

export async function generateSignal(symbol: string, risk = 'Medium'): Promise<TradeSignal | null> {
  try {
    // Run all data fetches in parallel
    // getExecutableQuote: always fresh, cross-validated, never cached
    const [quote, rsi, sentiment, mlBoost, groqResult] = await Promise.allSettled([
      getExecutableQuote(symbol),
      getRsi(symbol),
      getStockSentiment(symbol).catch(() => null),
      getMLBoost(symbol, risk).catch(() => null),
      getGroqStockSentiment(symbol).catch(() => null),
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
      getCurrentRegime().catch(() => null),
      getSignalWeights().catch(() => new Map()),
    ]);
    if (regime) {
      t = { ...t, rsiBuy: regime.rsiBuy, rsiSell: regime.rsiSell, stopLoss: regime.stopLoss };
    }

    const w = (src: string) => weights.get(src)?.weight ?? 1.0;
    const notes: string[] = [];
    let buy = 0, sell = 0;

    // ── Technical ──────────────────────────────────────────────────────────
    const rsiWeight = w('RSI');
    if (rsiVal !== null) {
      if (rsiVal < t.rsiBuy - 5)   { buy  += 2 * rsiWeight; notes.push(`RSI oversold (${rsiVal.toFixed(1)}) [w=${rsiWeight.toFixed(1)}]`); }
      else if (rsiVal < t.rsiBuy)  { buy  += 1 * rsiWeight; notes.push(`RSI low (${rsiVal.toFixed(1)})`); }
      if (rsiVal > t.rsiSell + 5)  { sell += 2 * rsiWeight; notes.push(`RSI overbought (${rsiVal.toFixed(1)})`); }
      else if (rsiVal > t.rsiSell) { sell += 1 * rsiWeight; notes.push(`RSI high (${rsiVal.toFixed(1)})`); }
    }

    if (q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh) {
      const range = q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow;
      const pos = (q.price - q.fiftyTwoWeekLow) / range;
      if (pos < 0.15) { buy += 2; notes.push('Near 52W low'); }
      else if (pos < 0.25) { buy += 1; notes.push('Below 52W midpoint'); }
      if (pos > 0.90) { sell += 1; notes.push('Near 52W high'); }
    }

    if (q.changePct < -4) { buy  += 1; notes.push(`Day drop ${q.changePct.toFixed(1)}%`); }
    if (q.changePct >  5) { sell += 1; notes.push(`Day surge ${q.changePct.toFixed(1)}%`); }

    // ── Rule-based news sentiment ───────────────────────────────────────────
    if (sent && sent.score !== 0) {
      if (sent.score >= 2)       { buy  += 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === 1) { buy  += 1; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score <= -2) { sell += 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === -1){ sell += 1; notes.push(`NSE: ${sent.label}`); }
    }

    // ── ML momentum boost ──────────────────────────────────────────────────
    if (ml && ml.momentumBoost !== 0) {
      if (ml.momentumBoost > 0) { buy  += ml.momentumBoost; notes.push(ml.reason); }
      else                       { sell += Math.abs(ml.momentumBoost); notes.push(ml.reason); }
    }

    // ── Groq LLM (highest quality signal, weighted ×2) ────────────────────
    let groqSentiment: string | undefined;
    if (groq) {
      groqSentiment = `${groq.sentiment}: ${groq.summary}`;
      if (groq.score >= 2)       { buy  += 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === 1) { buy  += 1; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score <= -2) { sell += 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === -1){ sell += 1; notes.push(`Groq: ${groq.tradeImplication}`); }
    }

    const reason = notes.join('; ') || 'No signal';
    if (buy > sell && buy >= 2) {
      return { symbol, action: 'BUY',  strength: buy  >= 4 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
    }
    if (sell > buy && sell >= 2) {
      return { symbol, action: 'SELL', strength: sell >= 4 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
    }
    return { symbol, action: 'HOLD', strength: 'WEAK', reason, price: q.price };
  } catch (err) {
    console.error(`[Signal] Error for ${symbol}:`, err);
    return null;
  }
}

/**
 * Execute a simulated trade. All guards run before any DB write.
 * Returns tradeId on success, null if any guard blocks execution.
 */
export async function executeTrade(
  portfolioId: number,
  symbol: string,
  companyName: string,
  action: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  reason: string
): Promise<number | null> {
  // ── Pre-execution guards ───────────────────────────────────────────────────
  const [tradingEnabled, underTradeLimit] = await Promise.all([
    isTradingEnabled(),
    isUnderDailyTradeLimit(portfolioId),
  ]);
  if (!tradingEnabled) {
    console.warn(`[P${portfolioId}] Trade blocked: kill switch active`);
    return null;
  }
  if (!underTradeLimit) {
    console.warn(`[P${portfolioId}] Trade blocked: daily trade limit reached`);
    return null;
  }

  const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [portfolioId]);
  if (!portfolio || !portfolio.is_active) return null;

  const amount = quantity * price;
  const brokerage = amount * 0.002;
  const netAmount = action === 'BUY' ? amount + brokerage : amount - brokerage;

  // Compute portfolio NAV for concentration + turnover checks
  const holdingsForNAV = await query('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]);
  const portfolioNAV = holdingsForNAV.reduce(
    (s: number, h: any) => s + Number(h.quantity) * Number(h.current_price || h.avg_buy_price), 0
  ) + Number(portfolio.current_cash);

  if (action === 'BUY') {
    const [underCap, underTurnover] = await Promise.all([
      isUnderPositionCap(portfolioId, symbol, portfolioNAV, amount),
      isUnderDailyTurnoverLimit(portfolioId, portfolioNAV, amount),
    ]);
    if (!underCap) { console.warn(`[P${portfolioId}] BUY blocked: position cap for ${symbol}`); return null; }
    if (!underTurnover) { console.warn(`[P${portfolioId}] BUY blocked: daily turnover limit`); return null; }
  }

  if (action === 'BUY' && portfolio.current_cash < netAmount) {
    console.warn(`[P${portfolioId}] Insufficient cash for BUY ${symbol}`);
    return null;
  }

  if (action === 'SELL') {
    const h = await queryOne('SELECT * FROM holdings WHERE portfolio_id = ? AND symbol = ?', [portfolioId, symbol]);
    if (!h || h.quantity < quantity) return null;
  }

  const holdingsBefore = await query('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]);
  const valueBefore = holdingsBefore.reduce(
    (s: number, h: any) => s + h.quantity * (h.current_price || h.avg_buy_price),
    portfolio.current_cash
  );

  const tradeRes = await run(
    'INSERT INTO trades (portfolio_id, symbol, company_name, action, quantity, price, amount, brokerage, net_amount, signal_reason, portfolio_value_before) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [portfolioId, symbol, companyName, action, quantity, price, amount, brokerage, netAmount, reason, valueBefore]
  );

  if (action === 'BUY') {
    const existing = await queryOne('SELECT * FROM holdings WHERE portfolio_id = ? AND symbol = ?', [portfolioId, symbol]);
    if (existing) {
      const newQty = existing.quantity + quantity;
      const newAvg = (existing.quantity * existing.avg_buy_price + amount) / newQty;
      await run('UPDATE holdings SET quantity=?, avg_buy_price=?, current_price=?, updated_at=datetime("now") WHERE portfolio_id=? AND symbol=?', [newQty, newAvg, price, portfolioId, symbol]);
    } else {
      await run('INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price) VALUES (?,?,?,?,?,?)', [portfolioId, symbol, companyName, quantity, price, price]);
    }
    await run('UPDATE portfolios SET current_cash=current_cash-?, updated_at=datetime("now") WHERE id=?', [netAmount, portfolioId]);
  } else {
    const h = await queryOne('SELECT * FROM holdings WHERE portfolio_id = ? AND symbol = ?', [portfolioId, symbol]);
    // Compute realized PnL: (sell_price - avg_buy_price) × qty - brokerage
    const realizedPnlOnTrade = (price - Number(h.avg_buy_price)) * quantity - brokerage;
    await run('UPDATE trades SET realized_pnl=? WHERE id=?', [realizedPnlOnTrade, tradeRes.lastInsertRowid]);
    const newQty = h.quantity - quantity;
    if (newQty <= 0.001) {
      await run('DELETE FROM holdings WHERE portfolio_id=? AND symbol=?', [portfolioId, symbol]);
    } else {
      await run('UPDATE holdings SET quantity=?, updated_at=datetime("now") WHERE portfolio_id=? AND symbol=?', [newQty, portfolioId, symbol]);
    }
    await run('UPDATE portfolios SET current_cash=current_cash+?, updated_at=datetime("now") WHERE id=?', [netAmount, portfolioId]);
  }

  console.log(`[P${portfolioId}] ${action} ${quantity}×${symbol} @₹${price} | ₹${netAmount.toFixed(0)} | ${reason}`);
  return tradeRes.lastInsertRowid;
}

export async function getPortfolioSummary(portfolioId: number): Promise<PortfolioSummary> {
  const [portfolio, holdings] = await Promise.all([
    queryOne('SELECT * FROM portfolios WHERE id = ?', [portfolioId]),
    query('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]),
  ]);

  // Realized PnL: only from closed positions (SELL trades minus their cost basis)
  // Approximated as: sum(sell_proceeds) - sum(buy_cost for matching lots)
  // For now: track via explicit pnl column when available, else 0 until sells occur
  const realizedRows = await query(
    `SELECT COALESCE(SUM(realized_pnl), 0) as pnl FROM trades WHERE portfolio_id = ? AND action = 'SELL' AND realized_pnl IS NOT NULL`,
    [portfolioId]
  );
  const realizedPnl = Number(realizedRows[0]?.pnl ?? 0);

  let invested = 0, current = 0;
  const hSummaries: HoldingSummary[] = [];
  for (const h of holdings) {
    const cp = Number(h.current_price ?? h.avg_buy_price);
    const cv = Number(h.quantity) * cp;
    const cost = Number(h.quantity) * Number(h.avg_buy_price);
    invested += cost; current += cv;
    hSummaries.push({
      symbol: h.symbol as string, companyName: h.company_name as string, sector: h.sector as string | undefined,
      quantity: Number(h.quantity), avgBuyPrice: Number(h.avg_buy_price), currentPrice: cp,
      currentValue: cv, pnl: cv - cost, pnlPct: ((cv - cost) / cost) * 100,
    });
  }

  const totalValue = current + Number(portfolio.current_cash);
  const returnPct = ((totalValue - Number(portfolio.initial_capital)) / Number(portfolio.initial_capital)) * 100;

  return {
    id: Number(portfolio.id), name: portfolio.name as string,
    totalValue, investedValue: invested, cashBalance: Number(portfolio.current_cash),
    unrealizedPnl: current - invested, realizedPnl, totalPnl: (current - invested) + realizedPnl,
    returnPct, targetReturnPct: Number(portfolio.target_return_pct),
    riskTolerance: portfolio.risk_tolerance as string, investmentHorizonMonths: Number(portfolio.investment_horizon_months),
    holdings: hSummaries,
  };
}
