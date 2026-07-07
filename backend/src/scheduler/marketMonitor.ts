import cron from 'node-cron';
import { query, queryOne, run } from '../db/turso.js';
import { generateSignal, executeTrade, getPortfolioSummary } from '../services/tradingEngine.js';
import { getMultipleQuotes, DEFAULT_WATCHLIST, isNseMarketOpen } from '../services/marketData.js';
import { isNseHoliday, acquireCycleLock, acquireDbCycleLock, releaseCycleLock, ensureTradingConfigTable } from '../services/tradingGuards.js';
import { logger } from '../lib/logger.js';

async function updateAllPrices(): Promise<void> {
  const holdings = await query(`
    SELECT DISTINCT h.symbol FROM holdings h
    JOIN portfolios p ON p.id = h.portfolio_id
    WHERE p.is_active = 1
  `);
  if (!holdings.length) return;

  try {
    const quotes = await getMultipleQuotes(holdings.map((h: any) => h.symbol as string));
    for (const q of quotes) {
      await run('UPDATE holdings SET current_price=?, last_price_updated=datetime("now") WHERE symbol=?', [q.price, q.symbol]);
    }
    console.log(`[Monitor] Updated ${quotes.length} prices`);
  } catch (err) {
    // Yahoo Finance may block cloud IPs — continue with stale DB prices
    console.warn('[Monitor] Price fetch failed, using cached prices:', String(err));
  }
}

async function runPortfolioTradingCycle(portfolioId: number, riskTolerance: string): Promise<{ trades: number; signals: number }> {
  const marketOpen = isNseMarketOpen();
  const summary = await getPortfolioSummary(portfolioId);
  const stopLoss = riskTolerance === 'High' ? 0.12 : riskTolerance === 'Low' ? 0.05 : 0.08;
  const takeProfit = riskTolerance === 'High' ? 0.30 : riskTolerance === 'Low' ? 0.15 : 0.25;

  let sellSignalCount = 0;
  // Sell scan
  for (const h of summary.holdings) {
    const signal = await generateSignal(h.symbol, riskTolerance);
    if (!signal) continue;
    const lossRatio = (signal.price - h.avgBuyPrice) / h.avgBuyPrice;
    let shouldSell = false, reason = signal.reason;

    if (lossRatio < -stopLoss) { shouldSell = true; reason = `Stop-loss: ${(lossRatio*100).toFixed(1)}%`; }
    else if (lossRatio > takeProfit && signal.action === 'SELL') { shouldSell = true; reason = `Take-profit +${(lossRatio*100).toFixed(1)}%. ${reason}`; }
    else if (signal.action === 'SELL' && signal.strength !== 'WEAK') { shouldSell = true; }

    // Log every signal (including HOLDs) for audit trail
    logger.signal(portfolioId, h.symbol, signal.action, signal.strength, signal.reason, signal.price);

    if (shouldSell) {
      sellSignalCount++;
      await run('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal,acted_upon) VALUES (?,?,?,?,?,?,1)',
        [portfolioId, h.symbol, 'SELL', signal.strength, reason, signal.price]);
      if (!marketOpen) {
        logger.info({ job: 'market-cycle', portfolioId, symbol: h.symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
        continue;
      }
      await executeTrade(portfolioId, h.symbol, h.companyName, 'SELL', h.quantity, signal.price, reason);
    }
  }

  // Buy scan
  const refreshed = await getPortfolioSummary(portfolioId);
  const held = new Set(refreshed.holdings.map(h => h.symbol));
  let tradeCount = 0, signalCount = sellSignalCount;
  if (refreshed.cashBalance < 10000) return { trades: tradeCount, signals: signalCount };

  const maxPosPct = riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05;
  const candidates = DEFAULT_WATCHLIST.filter(s => !held.has(s)).slice(0, 5);

  for (const symbol of candidates) {
    const signal = await generateSignal(symbol, riskTolerance);
    if (!signal || signal.action !== 'BUY' || signal.strength === 'WEAK') continue;
    signalCount++;
    logger.signal(portfolioId, symbol, signal.action, signal.strength, signal.reason, signal.price);

    const invest = Math.min(refreshed.totalValue * maxPosPct, refreshed.cashBalance * 0.3);
    const qty = Math.floor(invest / signal.price);
    if (qty <= 0) continue;

    const sigRes = await run('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal) VALUES (?,?,?,?,?,?)',
      [portfolioId, symbol, 'BUY', signal.strength, signal.reason, signal.price]);
    if (!marketOpen) {
      logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
      continue;
    }
    const tradeId = await executeTrade(portfolioId, symbol, symbol.replace('.NS', ''), 'BUY', qty, signal.price, signal.reason);
    if (tradeId && sigRes.lastInsertRowid) {
      await run('UPDATE market_signals SET acted_upon=1, trade_id=? WHERE id=?', [tradeId, sigRes.lastInsertRowid]);
      tradeCount++;
    }
  }
  return { trades: tradeCount, signals: signalCount };
}

async function snapshotAll(): Promise<void> {
  const portfolios = await query('SELECT id FROM portfolios WHERE is_active = 1');
  for (const { id } of portfolios) {
    const s = await getPortfolioSummary(Number(id));
    await run('INSERT INTO performance_snapshots (portfolio_id,total_portfolio_value,invested_value,cash_balance,unrealized_pnl,realized_pnl,total_pnl,return_pct,target_return_pct,holdings_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, s.totalValue, s.investedValue, s.cashBalance, s.unrealizedPnl, s.realizedPnl, s.totalPnl, s.returnPct, s.targetReturnPct, s.holdings.length]);
    console.log(`[P${id}] Snapshot ₹${s.totalValue.toFixed(0)} | ${s.returnPct.toFixed(2)}%`);
  }
}

// Exported for Vercel cron endpoint + API trigger
export async function runMarketCycle(): Promise<void> {
  const cycleStart = Date.now();
  // Idempotency: in-memory guard first (fast), then DB lock (survives cold starts)
  if (!acquireCycleLock()) return;
  if (!(await acquireDbCycleLock())) return;

  if (isNseHoliday()) {
    logger.cronCycle({ portfolioCount: 0, tradesExecuted: 0, signalsGenerated: 0, durationMs: 0, skipped: true, skipReason: 'NSE holiday' });
    await releaseCycleLock();
    return;
  }
  if (!isNseMarketOpen()) {
    logger.info({ job: 'market-cycle', phase: 'cron', reason: 'Market closed — price update only, no trades' });
  }

  let tradesExecuted = 0;
  let signalsGenerated = 0;

  try {
    await updateAllPrices();
    const portfolios = await query('SELECT * FROM portfolios WHERE is_active = 1');
    for (const p of portfolios) {
      const { trades, signals } = await runPortfolioTradingCycle(Number(p.id), p.risk_tolerance as string);
      tradesExecuted += trades;
      signalsGenerated += signals;
    }
    await snapshotAll();
    logger.cronCycle({ portfolioCount: portfolios.length, tradesExecuted, signalsGenerated, durationMs: Date.now() - cycleStart });
  } finally {
    await releaseCycleLock();
  }
}

export function startScheduler(): void {
  // Market hours: every 5 min (IST 9:00–15:45 Mon-Fri)
  cron.schedule('*/5 9-15 * * 1-5', () => { runMarketCycle().catch(console.error); }, { timezone: 'Asia/Kolkata' });
  // Pre-market
  cron.schedule('55 8 * * 1-5', () => { updateAllPrices().catch(console.error); }, { timezone: 'Asia/Kolkata' });
  // Hourly snapshot
  cron.schedule('0 * * * *', () => { snapshotAll().catch(console.error); }, { timezone: 'Asia/Kolkata' });
  // After-market snapshot
  cron.schedule('0 16 * * 1-5', () => { snapshotAll().catch(console.error); }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] All cron jobs active (IST)');
}
