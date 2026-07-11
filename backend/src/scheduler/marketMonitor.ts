import cron from 'node-cron';
import { query, queryOne, run } from '../db/turso.js';
import { generateSignal, executeTrade, getPortfolioSummary } from '../services/tradingEngine.js';
import { getMultipleQuotes, getDynamicCycleWatchlist, getBiasedCycleWatchlist, isNseMarketOpen, warmTwelveDataCache, fetchEarningsCalendar, getAvgDailyTradedValue } from '../services/marketData.js';
import { isNseHoliday, acquireCycleLock, acquireDbCycleLock, releaseCycleLock, ensureTradingConfigTable } from '../services/tradingGuards.js';
import { logger } from '../lib/logger.js';
import { rememberFact, pruneMemory } from '../services/ragService.js';
import { resolveSignalOutcomes, computeSectorAccuracy } from '../services/adaptiveEngine.js';
import { geminiCycleFocus, geminiPortfolioInsight, geminiSellReview } from '../services/geminiService.js';
import { recordSignalPattern, resolvePatternOutcome } from '../services/patternEngine.js';
import { fetchAnnouncements } from '../services/newsService.js';
import { evaluateKillSwitch, killSwitchSizeMultiplier } from '../services/killSwitch.js';
import { registerExitPlan, evaluateExits, updateTrailingStop } from '../services/exitEngine.js';
import { classifyMarketRegime } from '../services/regimeEngine.js';

/**
 * Write a cycle-level summary to TARS memory so RAG can surface recent
 * market activity when the user asks questions about portfolio behaviour.
 */
async function writeMarketCycleMemory(
  portfolioCount: number,
  trades: number,
  signals: number,
): Promise<void> {
  const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const content = `Market cycle at ${ist} IST: ${portfolioCount} active portfolios scanned. `
    + `${signals} trade signals generated, ${trades} trades executed. `
    + `Market was ${isNseMarketOpen() ? 'OPEN' : 'CLOSED'} at cycle time.`;
  await rememberFact(content, 'cycle_summary');

  // Write last 5 trade narratives from the DB into memory
  // source_id = portfolio_id so retrieval can be scoped per-portfolio (no cross-portfolio leakage)
  const recentTrades = await query(
    `SELECT t.portfolio_id, t.symbol, t.action, t.quantity, t.price, t.trade_time, t.trade_reason
     FROM trades t ORDER BY t.trade_time DESC LIMIT 5`
  );
  for (const t of recentTrades) {
    const narrative = `Trade: ${t.action} ${t.quantity} shares of ${t.symbol} at ₹${t.price} on ${t.trade_time}.`
      + (t.trade_reason ? ` Reason: ${typeof t.trade_reason === 'string' ? t.trade_reason.slice(0, 300) : ''}` : '');
    await rememberFact(narrative, 'trade_narrative', String(t.portfolio_id));
  }

  await pruneMemory(5000);
}

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
      await run('UPDATE holdings SET current_price=?, last_price_updated=CURRENT_TIMESTAMP WHERE symbol=?', [q.price, q.symbol]);
    }
    console.log(`[Monitor] Updated ${quotes.length} prices`);
  } catch (err) {
    // Yahoo Finance may block cloud IPs — continue with stale DB prices
    console.warn('[Monitor] Price fetch failed, using cached prices:', String(err));
  }
}

async function runPortfolioTradingCycle(
  portfolioId: number,
  riskTolerance: string,
  geminiSectorFocus: string[] = [],
): Promise<{ trades: number; signals: number }> {
  const marketOpen = isNseMarketOpen();
  const summary = await getPortfolioSummary(portfolioId);
  const stopLoss = riskTolerance === 'High' ? 0.12 : riskTolerance === 'Low' ? 0.05 : 0.08;
  const takeProfit = riskTolerance === 'High' ? 0.30 : riskTolerance === 'Low' ? 0.15 : 0.25;

  // Load advanced risk profile for this portfolio
  const portfolioProfile = await queryOne('SELECT volatility_preference, investment_goal FROM portfolios WHERE id = ?', [portfolioId]);
  const _volPref = portfolioProfile?.volatility_preference as string | null ?? null;
  const _invGoal = portfolioProfile?.investment_goal as string | null ?? null;

  // Build portfolio context for Gemini veto gate
  const portfolioCtxBase = {
    totalNAV: summary.totalValue,
    cashBalance: summary.cashBalance,
    holdings: summary.holdings.length,
    targetReturnPct: summary.targetReturnPct,
    portfolioId,  // enables BUY veto recording in generateSignal for Gemini learning
  };

  let sellSignalCount = 0;
  // Sell scan
  for (const h of summary.holdings) {
    const { getSymbolSector } = await import('../services/marketData.js');
    const sector = getSymbolSector(h.symbol);
    const sectorNAV = summary.holdings
      .filter(x => getSymbolSector(x.symbol) === sector)
      .reduce((sum, x) => sum + x.quantity * x.currentPrice, 0);
    const sectorExposurePct = summary.totalValue > 0 ? (sectorNAV / summary.totalValue) * 100 : 0;
    const signal = await generateSignal(h.symbol, riskTolerance, _volPref, _invGoal,
      { ...portfolioCtxBase, sectorExposurePct });
    // Guard: null signal = no valid price data. Zero/invalid price must never reach stop-loss math.
    if (!signal || signal.price <= 0) continue;
    const lossRatio = (signal.price - h.avgBuyPrice) / h.avgBuyPrice;
    let shouldSell = false, reason = signal.reason;

    // Phase 13: Update trailing stop as price rises (before exit evaluation)
    const marketRegimeForExit = await classifyMarketRegime().catch(() => null);
    await updateTrailingStop(portfolioId, h.symbol, signal.price).catch(() => null);

    // Phase 13: Exit engine — check all 6 exit types
    const exitDecision = evaluateExits(
      {
        portfolioId, symbol: h.symbol, companyName: h.companyName ?? h.symbol,
        quantity: h.quantity, avgBuyPrice: h.avgBuyPrice, currentPrice: signal.price,
        createdAt: h.createdAt ?? new Date().toISOString(),
        atrStopPrice: (h as any).atrStopPrice ?? null,
        trailingStopPrice: (h as any).trailingStopPrice ?? null,
        timeStopDate: (h as any).timeStopDate ?? null,
        riskAmountInr: (h as any).riskAmountInr ?? null,
        thesisInvalidated: (h as any).thesisInvalidated ?? 0,
      },
      marketRegimeForExit?.label ?? 'NEUTRAL',
    );
    if (exitDecision.shouldExit && exitDecision.exitType !== null) {
      shouldSell = true;
      reason = exitDecision.reason;
    }

    const isStopLoss = lossRatio < -stopLoss;

    if (isStopLoss) {
      // Hard rule — no LLM involvement ever on stop-loss
      shouldSell = true;
      reason = `Stop-loss: ${(lossRatio*100).toFixed(1)}%`;
    } else if (lossRatio > takeProfit && signal.action === 'SELL') {
      shouldSell = true;
      reason = `Take-profit +${(lossRatio*100).toFixed(1)}%. ${reason}`;
    } else if (signal.action === 'SELL' && signal.strength !== 'WEAK') {
      // Non-stop-loss SELL: run through Gemini sell review
      const holdingRecord = await import('../db/turso.js').then(m =>
        m.queryOne('SELECT gemini_hold_count FROM holdings WHERE portfolio_id=? AND symbol=?', [portfolioId, h.symbol])
      );
      const holdCount = Number(holdingRecord?.gemini_hold_count ?? 0);

      // Resolve days held from holdings.created_at for richer Gemini context
      const holdingRecord2 = await import('../db/turso.js').then(m =>
        m.queryOne('SELECT created_at FROM holdings WHERE portfolio_id=? AND symbol=?', [portfolioId, h.symbol])
      );
      const buyDate = holdingRecord2?.created_at ? new Date(String(holdingRecord2.created_at)) : null;
      const daysHeld = buyDate ? Math.floor((Date.now() - buyDate.getTime()) / 86_400_000) : 0;

      // Gemini sell review — non-blocking on failure
      const sellReview = await geminiSellReview({
        symbol: h.symbol,
        unrealizedPnlPct: lossRatio * 100,
        daysHeld,
        rsiValue: undefined, // populated by signal context if available
        momentumTrend: signal.reason?.includes('bearish') ? 'bearish' : signal.reason?.includes('bullish') ? 'bullish' : 'neutral',
        groqSentiment: signal.groqSentiment,
        stopLossTriggered: false,
      }).catch(() => null);

      // Record ALL Gemini sell verdicts for learning (not just HOLDs)
      const recordSellDecision = async (verdict: string, score: number) => {
        await import('../db/turso.js').then(m =>
          m.run('INSERT INTO gemini_decisions (portfolio_id,symbol,decision_type,verdict,score) VALUES (?,?,?,?,?)',
            [portfolioId, h.symbol, 'sell_review', verdict, score])
        ).catch(() => null);
      };

      if (sellReview?.verdict === 'HOLD' && holdCount < 2) {
        // Delay this sell — increment hold count and skip
        await import('../db/turso.js').then(m =>
          m.run('UPDATE holdings SET gemini_hold_count=? WHERE portfolio_id=? AND symbol=?',
            [holdCount + 1, portfolioId, h.symbol])
        );
        logger.info({ job: 'market-cycle', portfolioId, symbol: h.symbol, phase: 'signal',
          action: 'HOLD', sellReason: sellReview.reason, holdCount: holdCount + 1 });
        await recordSellDecision('HOLD', sellReview.score);
        reason = `Gemini HOLD (${holdCount + 1}/2): ${sellReview.reason}`;
        shouldSell = false;
      } else {
        // EXECUTE or ACCELERATE or hold limit reached — record whichever verdict fired
        shouldSell = true;
        if (sellReview) {
          await recordSellDecision(sellReview.verdict, sellReview.score);
          reason = sellReview.verdict === 'ACCELERATE'
            ? `Gemini ACCELERATE: ${sellReview.reason} | ${reason}`
            : `${reason} | Gemini: ${sellReview.reason}`;
          // Reset hold count on execution
          await import('../db/turso.js').then(m =>
            m.run('UPDATE holdings SET gemini_hold_count=0 WHERE portfolio_id=? AND symbol=?', [portfolioId, h.symbol])
          );
        }
      }
    }

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
      const sellTradeId = await executeTrade(portfolioId, h.symbol, h.companyName, 'SELL', h.quantity, signal.price, reason);
      // Resolve pattern outcome: mark the corresponding BUY pattern WIN/LOSS
      const sellPnlPct = ((signal.price - h.avgBuyPrice) / h.avgBuyPrice) * 100;
      void resolvePatternOutcome(portfolioId, h.symbol, sellPnlPct).catch(() => null);
    }
  }

  // Buy scan
  const refreshed = await getPortfolioSummary(portfolioId);
  const held = new Set(refreshed.holdings.map(h => h.symbol));
  let tradeCount = 0, signalCount = sellSignalCount;
  if (refreshed.cashBalance < 10000) return { trades: tradeCount, signals: signalCount };

  // Phase 13: Kill-switch check before any BUY activity
  const ksState = await evaluateKillSwitch(portfolioId).catch(() => ({ dailyLossHalted: false, weeklyLossHalted: false, drawdownPaused: false, drawdownProtection: false }));
  const ksMult = killSwitchSizeMultiplier(ksState);
  if (ksMult === 0) {
    logger.info({ job: 'market-cycle', portfolioId, phase: 'execution', action: 'SKIP', reason: 'Kill-switch active: no new BUYs this cycle' });
    return { trades: tradeCount, signals: signalCount };
  }

  const maxPosPct = (riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05) * ksMult;
  // Dynamic open-market universe: full NSE equity list (fetched from NSE, cached 24h)
  // Rotating 50-stock sample per cycle. Falls back to static ~150 list if NSE blocks.
  const cycleSlot = Math.floor(Date.now() / (5 * 60 * 1000)); // bucket changes every 5 min
  const fullUniverse = await getDynamicCycleWatchlist(cycleSlot, 200); // get 200 to allow biasing

  // Apply cap preference if portfolio has one set
  // preferred_caps: JSON array e.g. ["small"] | ["mid","large"] | null (null = open market, no bias)
  // When multiple caps selected, the first one drives the 50% bias; others are included in the "rest" pool
  const portfolio = await queryOne('SELECT preferred_caps, volatility_preference, investment_goal FROM portfolios WHERE id = ?', [portfolioId]);
  let preferredCap: 'small' | 'mid' | 'large' | null = null;
  if (portfolio?.preferred_caps) {
    try {
      const caps = JSON.parse(String(portfolio.preferred_caps)) as string[];
      if (caps.length > 0) preferredCap = caps[0] as 'small' | 'mid' | 'large';
    } catch { /* malformed JSON — treat as open market */ }
  }
  let cycleUniverse = preferredCap
    ? getBiasedCycleWatchlist(fullUniverse, preferredCap, cycleSlot, 50, 0.5)
    : fullUniverse.slice(0, 50);

  // Gemini sector focus: promote stocks in Gemini-preferred sectors to the front of the scan list
  if (geminiSectorFocus.length > 0) {
    const { getSymbolSector: getSector } = await import('../services/marketData.js');
    const focusSet = new Set(geminiSectorFocus.map(s => s.toLowerCase()));
    const focusStocks = cycleUniverse.filter(s => focusSet.has(getSector(s).toLowerCase()));
    const otherStocks = cycleUniverse.filter(s => !focusSet.has(getSector(s).toLowerCase()));
    cycleUniverse = [...focusStocks, ...otherStocks];
  }

  const candidates = cycleUniverse.filter(s => !held.has(s)).slice(0, 8); // up to 8 new position candidates

  const volatilityPref = portfolio?.volatility_preference as string | null ?? null;
  const investmentGoal = portfolio?.investment_goal as string | null ?? null;

  for (const symbol of candidates) {
    const { getSymbolSector } = await import('../services/marketData.js');
    const buySector = getSymbolSector(symbol);
    const buySectorNAV = refreshed.holdings
      .filter(x => getSymbolSector(x.symbol) === buySector)
      .reduce((sum, x) => sum + x.quantity * x.currentPrice, 0);
    const buySectorPct = refreshed.totalValue > 0 ? (buySectorNAV / refreshed.totalValue) * 100 : 0;
    const proposedPositionPct = maxPosPct * 100;
    const signal = await generateSignal(symbol, riskTolerance, volatilityPref, investmentGoal,
      { totalNAV: refreshed.totalValue, cashBalance: refreshed.cashBalance,
        holdings: refreshed.holdings.length, sectorExposurePct: buySectorPct, proposedPositionPct });
    if (!signal || signal.action !== 'BUY' || signal.strength === 'WEAK') continue;

    // Phase 13: Liquidity gate — avg daily traded value must be ≥ 20× intended trade size
    const allocationCapInr = refreshed.totalValue * maxPosPct;
    const avgDTV = await getAvgDailyTradedValue(symbol).catch(() => null);
    if (avgDTV !== null && avgDTV < allocationCapInr * 20) {
      logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP', reason: `Liquidity gate: avg DTV ₹${(avgDTV/1e7).toFixed(1)}Cr < 20× trade size` });
      continue;
    }

    signalCount++;
    logger.signal(portfolioId, symbol, signal.action, signal.strength, signal.reason, signal.price);

    // Phase 13: Risk-based position sizing (ATR/stop-distance model)
    // risk_per_trade = 0.5% of NAV; stop_distance = 1.5 × ATR (approx 1.5% of price)
    const riskPerTradeInr = refreshed.totalValue * 0.005;
    const stopDistanceInr = signal.price * 0.015 * 1.5;  // 1.5 × ATR(~1.5% of price)
    const riskBasedQty = stopDistanceInr > 0 ? Math.floor(riskPerTradeInr / stopDistanceInr) : 0;
    const allocBasedQty = Math.floor(allocationCapInr / signal.price);
    const cashCapQty    = Math.floor(refreshed.cashBalance * 0.3 / signal.price);
    const qty = Math.min(riskBasedQty, allocBasedQty, cashCapQty);
    if (qty <= 0) continue;

    const sigRes = await run('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal) VALUES (?,?,?,?,?,?)',
      [portfolioId, symbol, 'BUY', signal.strength, signal.reason, signal.price]);
    if (!marketOpen) {
      logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
      continue;
    }
    const tradeId = await executeTrade(
      portfolioId, symbol, symbol.replace('.NS', ''), 'BUY', qty, signal.price, signal.reason,
      undefined,
      { groqSentiment: signal.groqSentiment, momentumScore: signal.mlBoost, regime: refreshed.riskTolerance,
        fundamentalScore: signal.fundamentalScore, fundamentalReasoning: signal.fundamentalReasoning }
    );
    if (tradeId && sigRes.lastInsertRowid) {
      await run('UPDATE market_signals SET acted_upon=1, trade_id=? WHERE id=?', [tradeId, sigRes.lastInsertRowid]);
      tradeCount++;
      // Phase 13: Register exit plan immediately after BUY (ATR stop, trailing stop, time stop)
      const riskAmountInr = refreshed.cashBalance * maxPosPct * 0.005; // 0.5% of NAV
      await registerExitPlan(portfolioId, symbol, signal.price, riskAmountInr).catch(() => null);
      // Phase 13: Persist strategy type on holding
      if (signal.strategyType) {
        await run('UPDATE holdings SET strategy_type=? WHERE portfolio_id=? AND symbol=?',
          [signal.strategyType, portfolioId, symbol]).catch(() => null);
      }
      // Record BUY pattern for learning
      const regime2 = await import('../services/adaptiveEngine.js').then(m => m.getCurrentRegime()).catch(() => null);
      void recordSignalPattern({
        portfolioId, symbol, action: 'BUY',
        rsiValue: signal.mlBoost ?? 50,
        momentumTrend: signal.reason?.includes('bullish') ? 'bullish' : signal.reason?.includes('bearish') ? 'bearish' : 'neutral',
        groqSentiment: signal.groqSentiment ?? 'NEUTRAL',
        fundamentalScore: signal.fundamentalScore ?? 50,
        marketRegime: regime2?.regime ?? signal.marketRegimeLabel ?? 'SIDEWAYS',
        sector: symbol.replace('.NS', ''),
        voteScore: 0,
        tradeId: Number(tradeId),
      }).catch(() => null);
    }
  }
  return { trades: tradeCount, signals: signalCount };
}

async function snapshotAll(): Promise<void> {
  const portfolios = await query('SELECT id, peak_nav FROM portfolios WHERE is_active = 1');
  for (const p of portfolios) {
    const id = Number(p.id);
    const s = await getPortfolioSummary(id);
    await run('INSERT INTO performance_snapshots (portfolio_id,total_portfolio_value,invested_value,cash_balance,unrealized_pnl,realized_pnl,total_pnl,return_pct,target_return_pct,holdings_count) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, s.totalValue, s.investedValue, s.cashBalance, s.unrealizedPnl, s.realizedPnl, s.totalPnl, s.returnPct, s.targetReturnPct, s.holdings.length]);
    // Update peak_nav whenever current value exceeds recorded peak (for true drawdown calculation)
    const currentPeak = p.peak_nav != null ? Number(p.peak_nav) : 0;
    if (s.totalValue > currentPeak) {
      await run('UPDATE portfolios SET peak_nav=? WHERE id=?', [s.totalValue, id]);
    }
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
    // Refresh index prices once per day (check if last stored date is today)
    const today = new Date().toISOString().slice(0, 10);
    const lastIdx = await queryOne("SELECT date FROM index_prices ORDER BY date DESC LIMIT 1").catch(() => null);
    if (!lastIdx || String(lastIdx.date) < today) {
      const { fetchAndStoreIndexHistory } = await import('../services/indexData.js');
      await fetchAndStoreIndexHistory().catch(e => logger.warn({ reason: `[IndexData] refresh failed: ${e}` }));
    }
    const portfolios = await query('SELECT * FROM portfolios WHERE is_active = 1');

    // Pre-warm Twelve Data cache for ALL symbols we'll scan this cycle.
    // One batch API call covers holdings + candidate watchlist — reduces per-symbol
    // calls to zero (cache hits) for the remainder of this cycle.
    // Without this, 50 signals × 84 cycles = 4,200 calls/day (over free 800 limit).
    try {
      const allHoldings = await query('SELECT DISTINCT symbol FROM holdings h JOIN portfolios p ON p.id=h.portfolio_id WHERE p.is_active=1');
      const cycleSlot = Math.floor(Date.now() / (5 * 60 * 1000));
      const watchlist = await getDynamicCycleWatchlist(cycleSlot, 50).catch(() => []);
      const allSymbols = [...new Set([
        ...allHoldings.map((h: any) => String(h.symbol)),
        ...watchlist,
      ])];
      await warmTwelveDataCache(allSymbols);
    } catch (e) {
      console.warn('[MarketCycle] Twelve Data cache warm failed (non-critical):', String(e));
    }

    // Gemini cycle focus: identify sectors most worth scanning this cycle
    // Non-blocking; market cycle continues even if Gemini is unavailable
    let geminiSectorFocus: string[] = [];
    try {
      const { getCurrentRegime } = await import('../services/adaptiveEngine.js');
      const regime = await getCurrentRegime().catch(() => null);
      const regimeLabel = regime ? `${regime.regime} (RSI buy<${regime.rsiBuy}, sell>${regime.rsiSell})` : 'UNKNOWN';
      const announcements = await fetchAnnouncements().catch(() => []);
      const headlines = announcements.slice(0, 20).map(a => `[${a.symbol}] ${a.category}: ${a.headline}`);
      geminiSectorFocus = await geminiCycleFocus(headlines, regimeLabel);
      if (geminiSectorFocus.length > 0) {
        console.log(`[Gemini] Cycle focus sectors: ${geminiSectorFocus.join(', ')}`);
      }
    } catch { /* non-critical */ }

    for (const p of portfolios) {
      const { trades, signals } = await runPortfolioTradingCycle(Number(p.id), p.risk_tolerance as string, geminiSectorFocus);
      tradesExecuted += trades;
      signalsGenerated += signals;
    }
    await snapshotAll();
    logger.cronCycle({ portfolioCount: portfolios.length, tradesExecuted, signalsGenerated, durationMs: Date.now() - cycleStart });

    // Phase 6: write cycle summary to RAG memory (non-blocking, best-effort)
    writeMarketCycleMemory(portfolios.length, tradesExecuted, signalsGenerated).catch(
      e => console.warn('[RAG] Memory write failed:', e)
    );
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
  // Weekly earnings calendar refresh — every Sunday at 08:00 IST
  cron.schedule('0 8 * * 0', async () => {
    const { getCycleWatchlist } = await import('../services/marketData.js');
    const allSyms = getCycleWatchlist(0, 200);
    await fetchEarningsCalendar(allSyms).catch(console.error);
  }, { timezone: 'Asia/Kolkata' });
  // Nightly adaptive learning: resolve signal outcomes + recalibrate weights + Gemini portfolio insights
  // Runs at 20:00 IST on weekdays — 5+ hours after market close so exit prices are settled
  cron.schedule('0 20 * * 1-5', async () => {
    await resolveSignalOutcomes().catch(console.error);
    // Update sector-level accuracy weights from resolved trade outcomes
    await computeSectorAccuracy().catch(console.error);
    // Phase 14: Retrain ML probability model on updated resolved patterns
    const { trainModel } = await import('../services/mlProbabilityModel.js');
    await trainModel().catch(console.error);
    // Phase 14: Run walk-forward validation for each active portfolio
    const { runWalkForward } = await import('../services/walkForwardEngine.js');
    const wfPortfolios = await query('SELECT id FROM portfolios WHERE is_active=1').catch(() => []);
    for (const p of wfPortfolios) {
      await runWalkForward(Number(p.id)).catch(console.error);
    }
    // Gemini portfolio health check for each active portfolio (best-effort, stored in RAG)
    try {
      const portfolios = await query('SELECT * FROM portfolios WHERE is_active = 1');
      for (const p of portfolios) {
        const summary = await getPortfolioSummary(Number(p.id)).catch(() => null);
        if (!summary) continue;
        const sectorBreakdown: Record<string, number> = {};
        const { getSymbolSector } = await import('../services/marketData.js');
        for (const h of summary.holdings) {
          const sec = getSymbolSector(h.symbol) as string;
          sectorBreakdown[sec] = (sectorBreakdown[sec] ?? 0) + (h.quantity * h.currentPrice / summary.totalValue) * 100;
        }
        const topHoldings = summary.holdings
          .sort((a, b) => (b.quantity * b.currentPrice) - (a.quantity * a.currentPrice))
          .slice(0, 5)
          .map(h => ({
            symbol: h.symbol,
            weight: summary.totalValue > 0 ? (h.quantity * h.currentPrice / summary.totalValue) * 100 : 0,
            pnlPct: h.avgBuyPrice > 0 ? ((h.currentPrice - h.avgBuyPrice) / h.avgBuyPrice) * 100 : 0,
          }));
        const navChange = Number(p.initial_capital) > 0
          ? ((summary.totalValue - Number(p.initial_capital)) / Number(p.initial_capital)) * 100 : 0;
        const winRateRow = await queryOne(
          `SELECT CAST(SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as wr
           FROM signal_outcomes WHERE portfolio_id = ? AND resolved = 1`, [Number(p.id)]
        ).catch(() => null);
        const winRate = Number(winRateRow?.wr ?? 0.5);
        const insight = await geminiPortfolioInsight(
          String(p.name), navChange, topHoldings, sectorBreakdown, winRate
        ).catch(() => null);
        if (insight) {
          const { rememberFact } = await import('../services/ragService.js');
          await rememberFact(`Portfolio insight for ${p.name}: ${insight}`, 'news_analysis', String(p.id));
          console.log(`[Gemini] Portfolio insight stored for ${p.name}`);
        }
      }
    } catch (err) { console.warn('[Gemini] Portfolio insight failed:', err); }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] All cron jobs active (IST)');
}
