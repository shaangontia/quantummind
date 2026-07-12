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
import { evaluateKillSwitch, killSwitchSizeMultiplier, circuitBreakerBlocksSell, executeEmergencyLiquidation, recordTradeOutcome } from '../services/killSwitch.js';
import { registerExitPlan, evaluateExits, updateTrailingStop } from '../services/exitEngine.js';
import { classifyMarketRegime } from '../services/regimeEngine.js';
import { recordCandidate } from '../services/candidateRecorder.js';
import { getModelGovernanceState } from '../services/modelLifecycle.js';
// Phase 19: Portfolio-aware ranking
import { getPortfolioPolicy, snapshotPolicy } from '../services/portfolioPolicy.js';
import { checkEligibility, computeLiquidityScore, type CandidateEligibilityInput, type PortfolioExposure } from '../services/portfolioEligibilityFilter.js';
import { computePortfolioUtility, estimateHoldingDays, type CandidateUtilityInput } from '../services/portfolioUtilityScore.js';
import { storePolicyEvaluation } from '../services/policyEvaluationStore.js';
// Phase 20: Decision Replay + Explainability
import { writeDecisionReplay } from '../services/decisionReplayWriter.js';
// Phase 21: Portfolio Health Job
import { runPortfolioHealthJob, runAllPortfoliosHealthJob } from './portfolioHealthJob.js';

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

  // Phase 17: evaluate kill-switch state once before sell scan (for circuit-breaker check)
  const ksStateForSell = await evaluateKillSwitch(portfolioId).catch(() => null);

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
    let isHardStop = false;      // Phase 17 fix: explicit field, never string-derived
    let exitTypeForTrade: string | null = null;  // Phase 18: stamped on trades.exit_type

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
      isHardStop = exitDecision.isHardStop;
      exitTypeForTrade = exitDecision.exitType;
      reason = exitDecision.reason;
    }

    const isStopLoss = lossRatio < -stopLoss;

    if (isStopLoss) {
      shouldSell = true;
      isHardStop = true;
      exitTypeForTrade = 'STOP_LOSS';
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
      // Phase 17: Circuit breaker blocks non-hard-stop SELLs.
      // isHardStop set explicitly from exitDecision.isHardStop — never string-derived.
      const isCbActive = circuitBreakerBlocksSell(ksStateForSell ?? { circuitBreakerActive: false } as any);
      if (isCbActive && !isHardStop) {
        logger.warn({ job: 'market-cycle', portfolioId, symbol: h.symbol, phase: 'execution', action: 'SKIP',
          reason: 'Circuit breaker active — only hard stop-loss SELLs allowed' });
        continue;
      }

      sellSignalCount++;
      await run('INSERT INTO market_signals (portfolio_id,symbol,signal_type,strength,reason,price_at_signal,acted_upon) VALUES (?,?,?,?,?,?,1)',
        [portfolioId, h.symbol, 'SELL', signal.strength, reason, signal.price]);
      if (!marketOpen) {
        logger.info({ job: 'market-cycle', portfolioId, symbol: h.symbol, phase: 'execution', action: 'SKIP', reason: 'Market closed' });
        continue;
      }
      const sellTradeId = await executeTrade(portfolioId, h.symbol, h.companyName, 'SELL', h.quantity, signal.price, reason);
      // Phase 18 [MAJOR fix]: stamp exit_type on the trade row for reliable audit queries
      if (sellTradeId && exitTypeForTrade) {
        void run('UPDATE trades SET exit_type=? WHERE id=?', [exitTypeForTrade, sellTradeId]).catch(() => null);
      }
      // Resolve pattern outcome: mark the corresponding BUY pattern WIN/LOSS
      const sellPnlPct = ((signal.price - h.avgBuyPrice) / h.avgBuyPrice) * 100;
      void resolvePatternOutcome(portfolioId, h.symbol, sellPnlPct).catch(() => null);
      // Phase 17: Consecutive-loss tracking
      void recordTradeOutcome(portfolioId, sellPnlPct < 0).catch(() => null);
      // Phase 21: Refresh health snapshot after SELL
      void runPortfolioHealthJob(portfolioId).catch(err =>
        logger.warn({ job: 'portfolio-health', portfolioId, phase: 'health', reason: String(err) })
      );
      // Phase 20: write SELL replay event (fire-and-forget)
      if (sellTradeId) {
        const buyDate = h.createdAt ? new Date(String(h.createdAt)) : null;
        const holdingDays20 = buyDate ? Math.floor((Date.now() - buyDate.getTime()) / 86_400_000) : null;
        const grossReturnPct20 = sellPnlPct;
        const brokerage20 = 5; // flat ₹5
        const costAdjustedPct20 = sellPnlPct - (brokerage20 * 2 / (h.avgBuyPrice * h.quantity)) * 100;
        void writeDecisionReplay({
          candidateId:             0, // SELL has no candidate row; linked via trade_id
          portfolioId,
          policyEvaluationId:      null,
          tradeId:                 Number(sellTradeId),
          decisionType:            'SELL',
          decisionTime:            new Date(),
          policyType:              null, // SELL decisions have no policy eval; policy context is on original BUY
          policyVersion:           null,
          portfolioMode:           (() => {
            const ks = ksStateForSell as any;
            if (!ks) return 'NORMAL';
            if (ks.emergencyLiquidationTriggered) return 'LIQUIDATION';
            if (ks.drawdownProtection) return 'PROTECTION';
            if (ks.dailyLossHalted || ks.weeklyLossHalted) return 'HALTED';
            return 'NORMAL';
          })(),
          positionSizePct:         null,
          symbol:                  h.symbol,
          price:                   signal.price,
          rsiValue:                signal.mlBoost ?? null,
          macdHistogram:           null,
          volumeRatio:             null,
          atrPct:                  null,
          fundamentalScore:        signal.fundamentalScore ?? null,
          marketRegime:            signal.marketRegimeLabel ?? null,
          strategyType:            (signal.strategyType ?? null) as any,
          strategyConfidence:      signal.strategyConfidence ?? null,
          strategyReasonCodes:     signal.strategyReasonCodes ?? null,
          mlPwin:                  signal.mlWinProbability ?? null,
          modelStage:              null, // govState not yet loaded at sell-scan time
          trainingRows:            null,
          modelVersion:            null,
          eligibilityGateResults:  [],
          utilityComponents:       { expectedValuePct: null, strategyFitMultiplier: null, horizonFitMultiplier: null, regimeFitMultiplier: null, volatilityPenalty: null, drawdownPenalty: null, sectorConcentrationPenalty: null, liquidityPenalty: null, finalScore: null },
          rejectionReasons:        [],
          selectionReason:         null,
          killSwitchFlags:         {
            dailyLossHalted:         (ksStateForSell as any)?.dailyLossHalted ?? false,
            weeklyLossHalted:        (ksStateForSell as any)?.weeklyLossHalted ?? false,
            drawdownPaused:          (ksStateForSell as any)?.drawdownPaused ?? false,
            drawdownProtection:      (ksStateForSell as any)?.drawdownProtection ?? false,
            consecutiveLossCooldown: (ksStateForSell as any)?.consecutiveLossCooldown ?? false,
            circuitBreakerActive:    (ksStateForSell as any)?.circuitBreakerActive ?? false,
            dataStaleHalted:         (ksStateForSell as any)?.dataStaleHalted ?? false,
          },
          stopPrice:               (h as any).atrStopPrice ?? null,
          targetPrice:             null,
          riskAmountInr:           (h as any).riskAmountInr ?? null,
          drawdownPct:             null,
          llmVerdict:              null, llmReasonCodes: null, llmModel: null, llmPromptVersion: null, llmConfidence: null,
          execution: {
            quantity:             h.quantity,
            averagePrice:         signal.price,
            averageFillPrice:     signal.price,
            brokerage:            brokerage20,
            slippagePct:          0,
            costAdjustedReturnPct: costAdjustedPct20,
            orderType:            'MARKET',
            fillStatus:           'FULL',
            quantityRequested:    h.quantity,
            quantityFilled:       h.quantity,
            signalPrice:          signal.price,
            intendedPrice:        signal.price,
            executionPrice:       signal.price,
            brokerName:           'paper',
            fees: {
              brokerage:       brokerage20,
              stt:             null, exchangeCharges: null,
              sebiCharges:     null, gst: null, stampDuty: null,
              totalCharges:    brokerage20,
            },
            grossPnl:      h.quantity * (signal.price - h.avgBuyPrice),
            netPnl:        h.quantity * (signal.price - h.avgBuyPrice) - brokerage20,
            grossReturnPct: grossReturnPct20,
          },
          exitType:              exitTypeForTrade,
          exitPrice:             signal.price,
          grossReturnPct:        grossReturnPct20,
          costAdjustedReturnPct: costAdjustedPct20,
          holdingDays:           holdingDays20,
          entryPrice:            h.avgBuyPrice,
          strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        }).catch(() => null);
      }
    }
  }

  // Buy scan
  const refreshed = await getPortfolioSummary(portfolioId);
  const held = new Set(refreshed.holdings.map(h => h.symbol));
  let tradeCount = 0, signalCount = sellSignalCount;
  if (refreshed.cashBalance < 10000) return { trades: tradeCount, signals: signalCount };

  // Phase 13 + 17: Kill-switch check before any BUY activity
  // Re-use ksStateForSell if already evaluated (avoid double-evaluation)
  const ksState = ksStateForSell ?? await evaluateKillSwitch(portfolioId).catch(() => ({ dailyLossHalted: false, weeklyLossHalted: false, drawdownPaused: false, drawdownProtection: false, consecutiveLossCooldown: false, consecutiveLosses: 0, cooldownUntil: null, dataStaleHalted: false, dataStalenessMinutes: 0, circuitBreakerActive: false, circuitBreakerSince: null, apiFailureCount: 0, emergencyLiquidationTriggered: false, drawdownProtectionSince: null, lastClearedAt: null }));
  const ksMult = killSwitchSizeMultiplier(ksState);

  // Phase 17: Emergency liquidation — fire when drawdownProtection is active and market is open
  if ((ksState as any).drawdownProtection && marketOpen && !ksState.emergencyLiquidationTriggered) {
    const holdingsForLiquidation = refreshed.holdings.map(h => ({
      symbol: h.symbol,
      companyName: h.companyName ?? h.symbol,
      quantity: h.quantity,
      avgBuyPrice: h.avgBuyPrice,
      currentPrice: h.currentPrice,
    }));
    const closed = await executeEmergencyLiquidation(
      portfolioId, holdingsForLiquidation,
      (pid, sym, co, action, qty, price, rsn) => executeTrade(pid, sym, co, action, qty, price, rsn),
    ).catch(() => []);
    if (closed.length > 0) {
      logger.warn({ job: 'market-cycle', portfolioId, phase: 'execution',
        closed, reason: 'Drawdown >12% — weakest positions closed' });
    }
  }

  if (ksMult === 0) {
    logger.info({ job: 'market-cycle', portfolioId, phase: 'execution', action: 'SKIP', reason: 'Kill-switch active: no new BUYs this cycle' });
    return { trades: tradeCount, signals: signalCount };
  }

  // Phase 16: Cold-start safety mode — apply model governance constraints
  const govState = await getModelGovernanceState(portfolioId).catch(() => null);
  const coldStartMaxPos  = govState?.maxPositionPctOverride;
  const coldStartMaxPos2 = govState?.isColdStart ? (govState.maxOpenPositionsOverride ?? 5) : null;
  if (govState?.isColdStart) {
    const openPositions = refreshed.holdings.length;
    if (coldStartMaxPos2 !== null && openPositions >= coldStartMaxPos2) {
      logger.info({ job: 'market-cycle', portfolioId, phase: 'execution', action: 'SKIP',
        reason: `Cold-start: max ${coldStartMaxPos2} open positions reached (stage: ${govState.stage})` });
      return { trades: tradeCount, signals: signalCount };
    }
  }

  const baseMaxPosPct = riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05;
  const maxPosPct = ((coldStartMaxPos != null) ? coldStartMaxPos : baseMaxPosPct) * ksMult;
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

  const coldStartDailyMax = govState?.isColdStart ? (govState.maxTradesPerDayOverride ?? 2) : Infinity;

  // Phase 19: Load portfolio policy + build exposure snapshot (once per cycle, not per symbol)
  const portfolioPolicy19 = await getPortfolioPolicy(portfolioId).catch(() => null);
  const policySnapshot19   = portfolioPolicy19 ? snapshotPolicy(portfolioPolicy19) : null;
  const modelStage19       = (govState?.stage ?? 'CANDIDATE') as import('../services/modelLifecycle.js').ModelStage;
  // Build sector exposure map from current holdings
  const { getSymbolSector: getSector19 } = await import('../services/marketData.js');
  const sectorPctMap19: Record<string, number> = {};
  for (const h of refreshed.holdings) {
    const sec = getSector19(h.symbol);
    sectorPctMap19[sec] = (sectorPctMap19[sec] ?? 0) + (h.currentValue ?? 0) / refreshed.totalValue;
  }
  const portfolioExposure19: PortfolioExposure = {
    sectorPct:            sectorPctMap19,
    currentPositionCount: refreshed.holdings.length,
    cashPct:              refreshed.cashBalance / refreshed.totalValue,
    drawdownPct:          0, // TODO: wire from kill-switch drawdown state
  };

  // Phase 20: shared kill-switch flag snapshot for replay events (built once per cycle)
  const ksFlags20: Record<string, boolean> = {
    dailyLossHalted:        (ksState as any).dailyLossHalted        ?? false,
    weeklyLossHalted:       (ksState as any).weeklyLossHalted       ?? false,
    drawdownPaused:         (ksState as any).drawdownPaused         ?? false,
    drawdownProtection:     (ksState as any).drawdownProtection     ?? false,
    consecutiveLossCooldown:(ksState as any).consecutiveLossCooldown ?? false,
    circuitBreakerActive:   (ksState as any).circuitBreakerActive   ?? false,
    dataStaleHalted:        (ksState as any).dataStaleHalted        ?? false,
  };
  const portfolioMode20 = derivePortfolioMode20(ksState as any);
  /** Thin wrapper: derive mode string without importing derivePortfolioMode (avoids circular dep) */
  function derivePortfolioMode20(ks: Record<string, any>): string {
    if (ks.emergencyLiquidationTriggered) return 'LIQUIDATION';
    if (ks.drawdownProtection)             return 'PROTECTION';
    if (ks.dailyLossHalted || ks.weeklyLossHalted) return 'HALTED';
    if (govState?.isColdStart)             return 'COLD_START';
    return 'NORMAL';
  }

  for (const symbol of candidates) {
    // Phase 16: Cold-start daily trade cap
    if (tradeCount >= coldStartDailyMax) {
      logger.info({ job: 'market-cycle', portfolioId, phase: 'execution', action: 'SKIP',
        reason: `Cold-start: daily trade cap ${coldStartDailyMax} reached (stage: ${govState?.stage})` });
      break;
    }
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
    // Phase 15: Record WEAK / HOLD signals as candidates for ML training
    if (!signal || signal.action !== 'BUY') {
      if (signal) {
        void recordCandidate({
          portfolioId, symbol,
          strategyType: signal.strategyType ?? null,
          strategyConfidence: signal.strategyConfidence ?? null,
          strategyReasonCodes: signal.strategyReasonCodes ?? null,
          strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
          strategySource: 'REAL_TIME_CLASSIFIER',
          signalScore: 0,
          rsiValue: null, volumeRatio: null,
          marketRegime: signal.marketRegimeLabel ?? null,
          fundamentalScore: signal.fundamentalScore ?? null,
          filtersPassed: [], filtersBlocked: ['score_or_direction'],
          actionTaken: 'WEAK',
        }).catch(() => null);
      }
      continue;
    }
    if (signal.strength === 'WEAK') {
      void recordCandidate({
        portfolioId, symbol,
        strategyType: signal.strategyType ?? null,
        strategyConfidence: signal.strategyConfidence ?? null,
        strategyReasonCodes: signal.strategyReasonCodes ?? null,
        strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        strategySource: 'REAL_TIME_CLASSIFIER',
        signalScore: 0,
        marketRegime: signal.marketRegimeLabel ?? null,
        fundamentalScore: signal.fundamentalScore ?? null,
        filtersPassed: [], filtersBlocked: ['weak_score'],
        actionTaken: 'WEAK',
      }).catch(() => null);
      continue;
    }

    // Phase 13: Liquidity gate — avg daily traded value must be ≥ 20× intended trade size
    const allocationCapInr = refreshed.totalValue * maxPosPct;
    const avgDTV = await getAvgDailyTradedValue(symbol).catch(() => null);
    if (avgDTV !== null && avgDTV < allocationCapInr * 20) {
      logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP', reason: `Liquidity gate: avg DTV ₹${(avgDTV/1e7).toFixed(1)}Cr < 20× trade size` });
      void recordCandidate({
        portfolioId, symbol,
        strategyType: signal.strategyType ?? null,
        strategyConfidence: signal.strategyConfidence ?? null,
        strategyReasonCodes: signal.strategyReasonCodes ?? null,
        strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        strategySource: 'REAL_TIME_CLASSIFIER',
        signalScore: 0,
        marketRegime: signal.marketRegimeLabel ?? null,
        filtersPassed: ['score', 'direction'], filtersBlocked: ['liquidity_gate'],
        actionTaken: 'SKIPPED',
      }).catch(() => null);
      continue;
    }

    // Phase 19: Portfolio eligibility + utility scoring gate
    // Runs AFTER global signal gates (direction, strength, liquidity) and BEFORE execution.
    // Records evaluation for every candidate regardless of decision.
    const liquidityScore19 = avgDTV != null ? computeLiquidityScore(avgDTV, allocationCapInr) : null;
    const buySector19 = getSector19(symbol);
    let policyEvaluationCandidateId19 = 0;
    if (portfolioPolicy19 && policySnapshot19) {
      // Derive risk level from policy type (not from minFundamentalScore proxy)
      const riskLevel19 = (['LOW_RISK_24M', 'VALUE_LONG'] as string[]).includes(portfolioPolicy19.policyType) ? 'low'
        : (['HIGH_RISK_3M', 'AGGRESSIVE_SHORT'] as string[]).includes(portfolioPolicy19.policyType) ? 'high'
        : 'medium';
      const eligInput19: CandidateEligibilityInput = {
        symbol,
        strategyType:     (signal.strategyType ?? 'UNKNOWN') as any,
        fundamentalScore: signal.fundamentalScore ?? null,
        // TODO(phase20): enrich signal with ATR%, beta, EPS so Gates 3/7/8 can fire for
        // HIGH/LOW_RISK policies. Until then these gates are silently null-skipped.
        atrPct:           null,
        beta:             null,
        liquidityScore:   liquidityScore19,
        sector:           buySector19 || null,
        eps:              null,
        mlPwin:           signal.mlWinProbability ?? null,
        // EV not exposed on TradeSignal — pass null so Gate 10 is correctly skipped
        // rather than using a proxy that produces wrong-order-of-magnitude results.
        // TODO(phase20): surface computeExpectedValue() result on TradeSignal and wire here.
        evPct:            null,
        marketRegime:     signal.marketRegimeLabel ?? 'UNKNOWN',
      };
      const eligResult19 = checkEligibility(eligInput19, portfolioPolicy19, portfolioExposure19, modelStage19);

      // Record candidate first so we have an id for the evaluation row
      policyEvaluationCandidateId19 = await recordCandidate({
        portfolioId, symbol,
        strategyType: signal.strategyType ?? null,
        strategyConfidence: signal.strategyConfidence ?? null,
        strategyReasonCodes: signal.strategyReasonCodes ?? null,
        strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        strategySource: 'REAL_TIME_CLASSIFIER',
        signalScore: signal.mlWinProbability ?? 0,
        marketRegime: signal.marketRegimeLabel ?? null,
        fundamentalScore: signal.fundamentalScore ?? null,
        filtersPassed: ['score', 'direction', 'liquidity'],
        filtersBlocked: eligResult19.eligible ? [] : eligResult19.rejectionReasons,
        actionTaken: eligResult19.eligible ? 'EXECUTED' : 'VETOED',
      });

      if (!eligResult19.eligible) {
        // Portfolio-specific veto — store evaluation and skip this symbol for THIS portfolio
        void storePolicyEvaluation({
          candidateId:          policyEvaluationCandidateId19,
          portfolioId,
          policyType:           portfolioPolicy19.policyType,
          policyVersion:        portfolioPolicy19.policyVersion,
          policySnapshotJson:   policySnapshot19,
          riskLevel:            riskLevel19,
          horizonDays:          portfolioPolicy19.labelHorizonDays,
          targetReturnPct:      null,
          strategyWeightsJson:  JSON.stringify(portfolioPolicy19.strategyWeights),
          eligible:             false,
          utilityScore:         null,
          portfolioRank:        null,
          decision:             'VETO',
          selectionReason:      eligResult19.selectionReason,
          rejectionReasonsJson: JSON.stringify(eligResult19.rejectionReasons),
          expectedValuePct:     null,
          portfolioAdjustedPwin: null,
          strategyFitMultiplier: null,
          horizonFitMultiplier:  null,
          regimeFitMultiplier:   null,
          volatilityPenalty:     null,
          drawdownPenalty:       null,
          sectorConcentrationPenalty: null,
          liquidityPenalty:      null,
          positionSizePct:       null,
          maxPositionAllowedPct: null,
          labelHorizonDays:     portfolioPolicy19.labelHorizonDays,
          dataSource:           'LIVE_PAPER',
        }).catch(() => null);
        logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP',
          reason: `Phase 19 policy veto: ${eligResult19.rejectionReasons.join('; ')}` });
        // Phase 20: write VETO replay event (fire-and-forget)
        void writeDecisionReplay({
          candidateId:             policyEvaluationCandidateId19,
          portfolioId,
          policyEvaluationId:      null,
          tradeId:                 null,
          decisionType:            'VETO',
          decisionTime:            new Date(),
          policyType:              portfolioPolicy19.policyType,
          policyVersion:           portfolioPolicy19.policyVersion,
          portfolioMode:           portfolioMode20,
          positionSizePct:         maxPosPct,
          symbol,
          price:                   signal.price,
          rsiValue:                signal.mlBoost ?? null,
          macdHistogram:           null,
          volumeRatio:             null,
          atrPct:                  null,
          fundamentalScore:        signal.fundamentalScore ?? null,
          marketRegime:            signal.marketRegimeLabel ?? null,
          strategyType:            (signal.strategyType ?? null) as any,
          strategyConfidence:      signal.strategyConfidence ?? null,
          strategyReasonCodes:     signal.strategyReasonCodes ?? null,
          mlPwin:                  signal.mlWinProbability ?? null,
          modelStage:              govState?.stage ?? null,
          trainingRows:            null,
          modelVersion:            null,
          eligibilityGateResults:  [],
          utilityComponents:       { expectedValuePct: null, strategyFitMultiplier: null, horizonFitMultiplier: null, regimeFitMultiplier: null, volatilityPenalty: null, drawdownPenalty: null, sectorConcentrationPenalty: null, liquidityPenalty: null, finalScore: null },
          rejectionReasons:        eligResult19.rejectionReasons,
          selectionReason:         eligResult19.selectionReason,
          killSwitchFlags:         ksFlags20,
          stopPrice:               null,
          targetPrice:             null,
          riskAmountInr:           null,
          drawdownPct:             portfolioExposure19.drawdownPct,
          llmVerdict:              null, llmReasonCodes: null, llmModel: null, llmPromptVersion: null, llmConfidence: null,
          execution:               null,
          exitType: null, exitPrice: null, grossReturnPct: null, costAdjustedReturnPct: null, holdingDays: null, entryPrice: null,
          strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        }).catch(() => null);
        continue;
      }

      // Eligible — compute utility and store BUY evaluation
      // Note: candidates are evaluated in Gemini-sorted cycleUniverse order (not pre-ranked by utility).
      // Utility is computed + stored per candidate, but execution order is still sequential.
      // TODO(phase20): collect all signal utilities first, then execute top-N to ensure best-utility
      // candidate executes when position cap is reached.
      const utilInput19: CandidateUtilityInput = {
        symbol,
        strategyType:         (signal.strategyType ?? 'UNKNOWN') as any,
        // EV not available on TradeSignal — use P(win) directly (scaled to pct units: 0.52 → ~52%)
        // This drives strategyFit multiplier correctly; EV gate itself is disabled (evPct=null in eligibility).
        // TODO(phase20): wire computeExpectedValue() result onto TradeSignal and use here.
        evPct:                (signal.mlWinProbability ?? 0.52) * 100,
        mlPwin:               signal.mlWinProbability ?? null,
        atrPct:               2.0, // default ATR assumption; TODO(phase20): expose from tradingEngine
        liquidityScore:       liquidityScore19 ?? 0.5,
        sector:               buySector19 || null,
        expectedHoldingDays:  estimateHoldingDays((signal.strategyType ?? 'UNKNOWN') as any),
        marketRegime:         signal.marketRegimeLabel ?? 'UNKNOWN',
      };
      const utilComponents19 = computePortfolioUtility(utilInput19, portfolioPolicy19, portfolioExposure19);

      void storePolicyEvaluation({
        candidateId:          policyEvaluationCandidateId19,
        portfolioId,
        policyType:           portfolioPolicy19.policyType,
        policyVersion:        portfolioPolicy19.policyVersion,
        policySnapshotJson:   policySnapshot19,
        riskLevel:            riskLevel19,
        horizonDays:          portfolioPolicy19.labelHorizonDays,
        targetReturnPct:      null,
        strategyWeightsJson:  JSON.stringify(portfolioPolicy19.strategyWeights),
        eligible:             true,
        utilityScore:         utilComponents19.finalScore,
        portfolioRank:        null, // individual ranking not tracked in sequential loop
        decision:             'BUY',
        selectionReason:      eligResult19.selectionReason,
        rejectionReasonsJson: null,
        expectedValuePct:     utilComponents19.expectedValuePct,
        portfolioAdjustedPwin: signal.mlWinProbability ?? null,
        strategyFitMultiplier: utilComponents19.strategyFitMultiplier,
        horizonFitMultiplier:  utilComponents19.horizonFitMultiplier,
        regimeFitMultiplier:   utilComponents19.regimeFitMultiplier,
        volatilityPenalty:     utilComponents19.volatilityPenalty,
        drawdownPenalty:       utilComponents19.drawdownPenalty,
        sectorConcentrationPenalty: utilComponents19.sectorConcentrationPenalty,
        liquidityPenalty:      utilComponents19.liquidityPenalty,
        positionSizePct:       maxPosPct,
        maxPositionAllowedPct: maxPosPct,
        labelHorizonDays:     portfolioPolicy19.labelHorizonDays,
        dataSource:           'LIVE_PAPER',
      }).catch(() => null);

      // If utility score is negative (setup genuinely bad for this portfolio), watch-only
      if (utilComponents19.finalScore < 0) {
        logger.info({ job: 'market-cycle', portfolioId, symbol, phase: 'execution', action: 'SKIP',
          reason: `Phase 19 utility skip: score=${utilComponents19.finalScore.toFixed(3)}` });
        // Phase 20: write SKIP replay event
        void writeDecisionReplay({
          candidateId:             policyEvaluationCandidateId19,
          portfolioId,
          policyEvaluationId:      null,
          tradeId:                 null,
          decisionType:            'SKIP',
          decisionTime:            new Date(),
          policyType:              portfolioPolicy19?.policyType ?? null,
          policyVersion:           portfolioPolicy19?.policyVersion ?? null,
          portfolioMode:           portfolioMode20,
          positionSizePct:         maxPosPct,
          symbol,
          price:                   signal.price,
          rsiValue:                signal.mlBoost ?? null,
          macdHistogram:           null,
          volumeRatio:             null,
          atrPct:                  null,
          fundamentalScore:        signal.fundamentalScore ?? null,
          marketRegime:            signal.marketRegimeLabel ?? null,
          strategyType:            (signal.strategyType ?? null) as any,
          strategyConfidence:      signal.strategyConfidence ?? null,
          strategyReasonCodes:     signal.strategyReasonCodes ?? null,
          mlPwin:                  signal.mlWinProbability ?? null,
          modelStage:              govState?.stage ?? null,
          trainingRows:            null,
          modelVersion:            null,
          eligibilityGateResults:  [],
          utilityComponents: {
            expectedValuePct:         utilComponents19.expectedValuePct,
            strategyFitMultiplier:    utilComponents19.strategyFitMultiplier,
            horizonFitMultiplier:     utilComponents19.horizonFitMultiplier,
            regimeFitMultiplier:      utilComponents19.regimeFitMultiplier,
            volatilityPenalty:        utilComponents19.volatilityPenalty,
            drawdownPenalty:          utilComponents19.drawdownPenalty,
            sectorConcentrationPenalty: utilComponents19.sectorConcentrationPenalty,
            liquidityPenalty:         utilComponents19.liquidityPenalty,
            finalScore:               utilComponents19.finalScore,
          },
          rejectionReasons:        ['UTILITY_NEGATIVE'],
          selectionReason:         null,
          killSwitchFlags:         ksFlags20,
          stopPrice:               null,
          targetPrice:             null,
          riskAmountInr:           null,
          drawdownPct:             portfolioExposure19.drawdownPct,
          llmVerdict:              null, llmReasonCodes: null, llmModel: null, llmPromptVersion: null, llmConfidence: null,
          execution:               null,
          exitType: null, exitPrice: null, grossReturnPct: null, costAdjustedReturnPct: null, holdingDays: null, entryPrice: null,
          strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
        }).catch(() => null);
        continue;
      }
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
      // Phase 15/19: Update candidate with actual entry/stop/target prices
      const stopPrice  = signal.price * (1 - 0.015 * 1.5);
      const targetPrice = signal.price * (1 + 0.015 * 3);  // 2R target
      if (policyEvaluationCandidateId19 > 0) {
        // Update existing candidate row (already inserted in Phase 19 gate)
        void run(
          `UPDATE trade_candidates SET action_taken='EXECUTED', entry_price=?, stop_price=?, target_price=? WHERE id=?`,
          [signal.price, stopPrice, targetPrice, policyEvaluationCandidateId19],
        ).catch(() => null);
      } else {
        // Phase 19 not active (policy load failed) — insert candidate the old way
        void recordCandidate({
          portfolioId, symbol,
          strategyType: signal.strategyType ?? null,
          strategyConfidence: signal.strategyConfidence ?? null,
          strategyReasonCodes: signal.strategyReasonCodes ?? null,
          strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
          strategySource: 'REAL_TIME_CLASSIFIER',
          signalScore: signal.mlWinProbability ?? 0,
          marketRegime: signal.marketRegimeLabel ?? null,
          fundamentalScore: signal.fundamentalScore ?? null,
          filtersPassed: ['score', 'liquidity', 'fundamental', 'regime'],
          filtersBlocked: [],
          actionTaken: 'EXECUTED',
          entryPrice: signal.price,
          stopPrice,
          targetPrice,
        }).catch(() => null);
      }
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
      // Phase 20: write BUY replay event
      const stopPriceForReplay  = signal.price * (1 - 0.015 * 1.5);
      const targetPriceForReplay = signal.price * (1 + 0.015 * 3);
      void writeDecisionReplay({
        candidateId:             policyEvaluationCandidateId19 || 0,
        portfolioId,
        policyEvaluationId:      null,
        tradeId:                 Number(tradeId),
        decisionType:            'BUY',
        decisionTime:            new Date(),
        policyType:              portfolioPolicy19?.policyType ?? null,
        policyVersion:           portfolioPolicy19?.policyVersion ?? null,
        portfolioMode:           portfolioMode20,
        positionSizePct:         maxPosPct,
        symbol,
        price:                   signal.price,
        rsiValue:                signal.mlBoost ?? null,
        macdHistogram:           null,
        volumeRatio:             null,
        atrPct:                  null,
        fundamentalScore:        signal.fundamentalScore ?? null,
        marketRegime:            signal.marketRegimeLabel ?? null,
        strategyType:            (signal.strategyType ?? null) as any,
        strategyConfidence:      signal.strategyConfidence ?? null,
        strategyReasonCodes:     signal.strategyReasonCodes ?? null,
        mlPwin:                  signal.mlWinProbability ?? null,
        modelStage:              govState?.stage ?? null,
        trainingRows:            null,
        modelVersion:            null,
        eligibilityGateResults:  [],
        utilityComponents: {
          expectedValuePct:         null, strategyFitMultiplier: null,
          horizonFitMultiplier:     null, regimeFitMultiplier: null,
          volatilityPenalty:        null, drawdownPenalty: null,
          sectorConcentrationPenalty: null, liquidityPenalty: null,
          finalScore:               null,
        },
        rejectionReasons:        [],
        selectionReason:         null,
        killSwitchFlags:         ksFlags20,
        stopPrice:               stopPriceForReplay,
        targetPrice:             targetPriceForReplay,
        riskAmountInr:           refreshed.totalValue * 0.005,
        drawdownPct:             portfolioExposure19.drawdownPct,
        llmVerdict:              signal.groqSentiment ?? null,
        llmReasonCodes:          signal.fundamentalReasoning ? [signal.fundamentalReasoning] : null,
        llmModel:                null, llmPromptVersion: null, llmConfidence: null,
        execution: {
          quantity:          qty,
          averagePrice:      signal.price,
          brokerage:         5, // flat ₹5 brokerage
          orderType:         'MARKET',
          fillStatus:        'FULL',
          quantityRequested: qty,
          quantityFilled:    qty,
          signalPrice:       signal.price,
          intendedPrice:     signal.price,
          executionPrice:    signal.price,
          brokerName:        'paper',
        },
        exitType: null, exitPrice: null, grossReturnPct: null, costAdjustedReturnPct: null,
        holdingDays: null, entryPrice: signal.price,
        strategyClassifierVersion: signal.strategyClassifierVersion ?? null,
      }).catch(() => null);
      // Phase 21: Refresh health snapshot after BUY
      void runPortfolioHealthJob(portfolioId).catch(err =>
        logger.warn({ job: 'portfolio-health', portfolioId, phase: 'health', reason: String(err) })
      );
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
    // Phase 15: Generate target-before-stop labels for closed candidates
    const { generateLabels } = await import('../services/labelGenerator.js');
    await generateLabels().catch(console.error);
    // Phase 16: Evaluate model governance state for each portfolio
    const { evaluateModelGovernance, computeCalibration } = await import('../services/modelLifecycle.js');
    const govPortfolios = await query('SELECT id FROM portfolios WHERE is_active=1').catch(() => []);
    for (const p of govPortfolios) {
      await evaluateModelGovernance(Number(p.id)).catch(console.error);
    }
    await computeCalibration('buy_win_probability_v1').catch(console.error);
    // Phase 18: Exit-plan reconciliation — find + restore holdings missing a stop-loss
    const { reconcileAllExitPlans } = await import('../services/exitPlanReconciler.js');
    await reconcileAllExitPlans().catch(console.error);
    // Phase 19: Generate horizon-specific policy outcome labels for policy evaluations
    const { generatePolicyOutcomeLabels } = await import('../services/policyLabelGenerator.js');
    await generatePolicyOutcomeLabels().catch(console.error);
    // Phase 14: Retrain ML probability model on updated resolved patterns
    const { trainModel } = await import('../services/mlProbabilityModel.js');
    await trainModel().catch(console.error);
    // Phase 14: Run walk-forward validation for each active portfolio
    const { runWalkForward } = await import('../services/walkForwardEngine.js');
    const { runStrategyWalkForward } = await import('../services/strategyWalkForward.js');
    const wfPortfolios = await query('SELECT id FROM portfolios WHERE is_active=1').catch(() => []);
    for (const p of wfPortfolios) {
      await runWalkForward(Number(p.id)).catch(console.error);
      await runStrategyWalkForward(Number(p.id)).catch(console.error);
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
    // Phase 21: Nightly portfolio health refresh for all active portfolios
    await runAllPortfoliosHealthJob().catch(console.error);
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] All cron jobs active (IST)');
}
