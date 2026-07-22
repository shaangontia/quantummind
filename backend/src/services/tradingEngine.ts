import { query, queryOne, run } from '../db/turso.js';
import { getQuote, getExecutableQuote, getRsi, isNseMarketOpen, getSymbolSector, getAvgDailyTradedValue } from './marketData.js';
import {
  isTradingEnabled,
  isUnderDailyTradeLimit,
  isUnderDailyTurnoverLimit,
  isUnderPositionCap,
} from './tradingGuards.js';
import { evaluateRisk } from './riskEngine.js';
import { batchWithResults } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import { getStockSentiment } from './newsService.js';
import { getMLBoost, computeTrendIndicators, kellyPositionSize } from './mlEngine.js';
import { getGroqStockSentiment } from './groqService.js';
import { getSignalWeights, getCurrentRegime, recordSignalForTracking, resolveGeminiSellDecisions, getSectorWeight, computeConsensusMultiplier, SIGNAL_SOURCES } from './adaptiveEngine.js';
import { geminiTradeVeto, geminiFundamentalAnalysis } from './geminiService.js';
import { getFundamentalSnapshot, computeFundamentalVerdict } from './fundamentalService.js';
import { getAdaptiveRSIBuy, getPatternConfidence, computeExpectedValue } from './patternEngine.js';
import { getWinProbability } from './mlProbabilityModel.js';
import { classifyStrategy, isStrategyAllowed } from './strategyClassifier.js';
import { classifyMarketRegime } from './regimeEngine.js';
import { getDisabledStrategies } from './strategyWalkForward.js';
import { getModelGovernanceState } from './modelLifecycle.js';
import { simulateVirtualFill, calculateVirtualCharges } from './virtualFillSimulator.js';
import { recordVirtualExecutionEvent } from './virtualExecutionQualityService.js';
import { fireVirtualReconciliation } from '../scheduler/virtualReconciliationJob.js';
import { FLAT_BROKERAGE_INR } from './tradingCosts.js';

export interface TradeSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: 'STRONG' | 'MODERATE' | 'WEAK';
  reason: string;
  price: number;
  mlBoost?: number;
  groqSentiment?: string;
  fundamentalScore?: number;
  fundamentalReasoning?: string;
  strategyType?: string;
  strategyConfidence?: number;
  strategyReasonCodes?: string[];
  strategyClassifierVersion?: string;
  marketRegimeLabel?: string;
  mlWinProbability?: number;
  /** P0.1 fix: which adaptive-weight source (see adaptiveEngine.SIGNAL_SOURCES)
   * contributed the most to this decision — used to attribute the eventual
   * trade outcome back to the correct weight in recordSignalForTracking. */
  dominantSource?: string;
  /** P1.11 fix: half-Kelly position-size fraction (0..maxPosPct), derived
   * from THIS strategy+symbol's own resolved win/loss history (the same
   * evResult computeExpectedValue() already fetches for the EV gate) —
   * previously mlEngine.computeKellySize() only ever looked at unconditional
   * raw daily returns, unrelated to what the strategy actually does, and its
   * output (kellyMaxPos) was never used to size a real position. Null when
   * there isn't enough resolved history yet (< 15 trades) — callers should
   * fall back to their existing sizing rules in that case, not treat null as
   * "size zero". */
  kellyFraction?: number | null;
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
  priceStatus: 'LIVE' | 'STALE';  // LIVE = updated within last 15min, STALE = older
  priceUpdatedAt?: string;
  // Phase 13 exit engine fields
  createdAt?: string;
  strategyType?: string;
  atrStopPrice?: number | null;
  trailingStopPrice?: number | null;
  timeStopDate?: string | null;
  riskAmountInr?: number | null;
  thesisInvalidated?: number;
}

export interface PortfolioSummary {
  id: number;
  name: string;
  initialCapital: number;           // common denominator for all % calculations
  totalValue: number;
  investedValue: number;
  cashBalance: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;         // unrealizedPnl / initialCapital
  realizedPnl: number;
  realizedPnlPct: number;           // realizedPnl / initialCapital
  totalPnl: number;
  totalPnlPct: number;              // totalPnl / initialCapital (same base as returnPct)
  totalBrokerage: number;           // sum of all brokerage charges paid
  returnPct: number;                // (totalValue - initialCapital) / initialCapital
  targetReturnPct: number;
  riskTolerance: string;
  investmentHorizonMonths: number;
  policyType: string;   // Phase 19: derived portfolio policy type
  holdings: HoldingSummary[];
}

function getThresholds(risk: string, targetReturnPct?: number) {
  // Base thresholds by risk tier — takeProfit is the per-trade exit target.
  // Do NOT cap takeProfit to the portfolio's annual return target: a 100%-target
  // portfolio must trade many positions adaptively, not hold each stock until it doubles.
  // targetReturnPct drives HOW AGGRESSIVELY the engine trades (position size, RSI aggressiveness),
  // not when each individual trade exits.
  let t =
    risk === 'High'      ? { rsiBuy: 40, rsiSell: 65, stopLoss: 0.12, takeProfit: 0.30, maxPosPct: 0.08 } :
    risk === 'Low'       ? { rsiBuy: 28, rsiSell: 75, stopLoss: 0.05, takeProfit: 0.15, maxPosPct: 0.03 } :
    risk === 'Very High' ? { rsiBuy: 45, rsiSell: 60, stopLoss: 0.15, takeProfit: 0.40, maxPosPct: 0.10 } :
                           { rsiBuy: 35, rsiSell: 70, stopLoss: 0.08, takeProfit: 0.25, maxPosPct: 0.05 };

  // Use targetReturnPct to adjust aggressiveness — higher target = larger positions + tighter stops
  // to generate more frequent compounding trades toward the goal.
  if (targetReturnPct !== undefined && targetReturnPct > 0) {
    if (targetReturnPct >= 50) {
      // Very aggressive target: maximise position sizes to compound quickly
      t = { ...t, maxPosPct: Math.min(t.maxPosPct * 1.25, 0.12) };
    } else if (targetReturnPct <= 5) {
      // Very conservative target: smaller positions, preserve capital
      t = { ...t, maxPosPct: Math.min(t.maxPosPct, 0.03), stopLoss: Math.min(t.stopLoss, 0.05) };
    }
  }

  return t;
}

/**
 * Adjust thresholds based on portfolio-level volatility_preference and investment_goal.
 * Called in generateSignal() after loading the base risk thresholds.
 */
export function applyAdvancedRiskProfile(
  base: ReturnType<typeof getThresholds>,
  volatilityPref: string | null,
  investmentGoal: string | null
): ReturnType<typeof getThresholds> {
  let { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct } = base;

  // Volatility preference adjustments
  if (volatilityPref === 'low') {
    rsiBuy   = Math.min(rsiBuy, 25);    // tighter oversold threshold — only buy deeper dips
    maxPosPct = Math.min(maxPosPct, 0.03); // smaller positions
  } else if (volatilityPref === 'high') {
    rsiBuy   = Math.max(rsiBuy, 38);    // more permissive — buy before full oversold
    maxPosPct = Math.min(maxPosPct, 0.08); // allow larger positions
  }

  // Investment goal adjustments
  if (investmentGoal === 'income') {
    takeProfit = Math.min(takeProfit, 0.15); // take profits sooner for income
    stopLoss   = Math.min(stopLoss, 0.07);   // tighter stop — protect income
  } else if (investmentGoal === 'retirement') {
    rsiBuy   = Math.min(rsiBuy, 28);      // only buy strong oversold for retirement
    stopLoss = Math.min(stopLoss, 0.06);  // tight stop — preserve capital
    maxPosPct = Math.min(maxPosPct, 0.04); // conservative sizing
  } else if (investmentGoal === 'growth') {
    takeProfit = Math.max(takeProfit, 0.25); // let winners run
  }

  return { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct };
}

const MIN_STOCK_PRICE = 30; // ₹30 min — any NSE equity above this is eligible

export interface PortfolioSignalContext {
  totalNAV: number;
  cashBalance: number;
  holdings: number;
  sectorExposurePct?: number;    // % NAV in the same sector as this symbol
  proposedPositionPct?: number;  // actual position as % of NAV (computed by caller)
  targetReturnPct?: number;      // portfolio's annual return target (drives takeProfit cap)
  portfolioId?: number;          // used to record Gemini BUY veto decisions for learning
}

export async function generateSignal(
  symbol: string,
  risk = 'Medium',
  volatilityPref: string | null = null,
  investmentGoal: string | null = null,
  portfolioCtx?: PortfolioSignalContext,
): Promise<TradeSignal | null> {
  try {
    // Run all data fetches in parallel
    // getExecutableQuote: always fresh, cross-validated, never cached
    const [quote, rsi, sentiment, mlBoost, groqResult, trendResult] = await Promise.allSettled([
      getExecutableQuote(symbol),
      getRsi(symbol),
      getStockSentiment(symbol).catch(() => null),
      getMLBoost(symbol, risk).catch(() => null),
      getGroqStockSentiment(symbol).catch(() => null),
      computeTrendIndicators(symbol).catch(() => null),
    ]);

    const q = quote.status === 'fulfilled' ? quote.value : null;
    if (!q || q.price < MIN_STOCK_PRICE) {
      // Return null — callers already guard `if (!signal) continue`.
      // Returning a HOLD with price=0 was causing false stop-loss triggers.
      console.warn(`[Signal] No valid price for ${symbol} (${q?.price ?? 'null'}) — returning null`);
      return null;
    }
    // Fail-closed: do not act on stale prices during market hours
    if (!q.isFresh) {
      console.warn(`[Signal] Stale price for ${symbol} from ${q.provider} — forcing HOLD`);
      return null;
    }

    const rsiVal = rsi.status === 'fulfilled' ? rsi.value : null;
    const sent = sentiment.status === 'fulfilled' ? sentiment.value : null;
    const ml = mlBoost.status === 'fulfilled' ? mlBoost.value : null;
    const groq = groqResult.status === 'fulfilled' ? groqResult.value : null;
    const trend = trendResult.status === 'fulfilled' ? trendResult.value : null;

    // Use regime-calibrated thresholds if available, else fall back to risk tier
    let t = getThresholds(risk, portfolioCtx?.targetReturnPct);
    const [regime, weights] = await Promise.all([
      getCurrentRegime().catch(() => null),
      getSignalWeights().catch(() => new Map()),
    ]);
    if (regime) {
      t = { ...t, rsiBuy: regime.rsiBuy, rsiSell: regime.rsiSell, stopLoss: regime.stopLoss };
    }
    // Apply advanced risk profile overrides (Phase 5)
    if (volatilityPref || investmentGoal) {
      t = applyAdvancedRiskProfile(t, volatilityPref, investmentGoal);
    }

    // Phase 12: Adaptive RSI — per-symbol learned buy threshold from pattern history
    const adaptiveRsi = await getAdaptiveRSIBuy(symbol, t.rsiBuy).catch(() => t.rsiBuy);
    if (adaptiveRsi !== t.rsiBuy) t = { ...t, rsiBuy: adaptiveRsi };

    const w = (src: string) => weights.get(src)?.weight ?? 1.0;
    const notes: string[] = [];
    let buy = 0, sell = 0;

    // ── Trend composite: RSI + MACD + EMA crossover + ML momentum ───────────
    // P1.10 fix (2026-07-22): these four indicators all measure the same
    // underlying phenomenon — recent price trend — via different math.
    // Scoring them as four independent additive votes let one trending move
    // count up to 4x toward the BUY/SELL threshold (and inflated
    // computeConsensusMultiplier's "signals agree" bonus for what was really
    // the same fact counted four times). They're blended here into one
    // bounded [-1,+1] vote, then scaled by a single adaptive weight.
    // P0.1 fix: this is also now the only place RSI's contribution is
    // computed — previously RSI was the *only* one of 6 advertised adaptive
    // sources whose weight was actually read back into scoring; the other 5
    // used fixed point values regardless of historical win rate. See
    // QuantumMind_Algorithm_Analysis.md §2.1 and §3.4.
    const rsiVote: number | null = rsiVal === null ? null
      : rsiVal < t.rsiBuy  ? Math.min(1, (t.rsiBuy - rsiVal) / 10)
      : rsiVal > t.rsiSell ? -Math.min(1, (rsiVal - t.rsiSell) / 10)
      : 0;

    let macdVote: number | null = null;
    if (trend?.macd) {
      const { macd } = trend;
      macdVote = macd.bullishCrossover ? 1
        : macd.bearishCrossover ? -1
        : macd.latestHistogram > 0 ? 0.5
        : macd.latestHistogram < 0 ? -0.5
        : 0;
    }

    let emaVote: number | null = null;
    if (trend?.emaCrossover) {
      const { emaCrossover } = trend;
      emaVote = emaCrossover.goldenCross ? 1
        : emaCrossover.deathCross ? -1
        : emaCrossover.ema20AboveEma50 ? 0.3 : -0.3;
    }

    const momentumVote: number | null = ml ? ml.momentumBoost : null; // already roughly [-1,1]

    const trendVotes = [rsiVote, macdVote, emaVote, momentumVote].filter((v): v is number => v !== null);
    const trendScore = trendVotes.length > 0 ? trendVotes.reduce((a, b) => a + b, 0) / trendVotes.length : 0; // [-1,1]
    const trendLabel: 'bullish' | 'bearish' | 'neutral' =
      trendScore > 0.15 ? 'bullish' : trendScore < -0.15 ? 'bearish' : 'neutral';
    const trendWeight = w(SIGNAL_SOURCES.TREND_COMPOSITE);
    // ×4 rescales the [-1,1] blended vote back to roughly the old per-indicator
    // magnitude (was up to +2 per indicator, now one combined vote).
    const trendContribution = trendScore * 4 * trendWeight;
    const trendDetail = `RSI${rsiVote !== null ? `=${rsiVal!.toFixed(1)}` : '=n/a'}${trend?.macd ? ', MACD' : ''}${trend?.emaCrossover ? ', EMA' : ''}${ml ? ', momentum' : ''} (${trendVotes.length}/4 available)`;
    if (trendContribution > 0.05) {
      buy += trendContribution;
      notes.push(`Trend composite: ${trendLabel} +${trendContribution.toFixed(2)} (${trendDetail}) [w=${trendWeight.toFixed(2)}]`);
    } else if (trendContribution < -0.05) {
      sell += Math.abs(trendContribution);
      notes.push(`Trend composite: ${trendLabel} ${trendContribution.toFixed(2)} (${trendDetail}) [w=${trendWeight.toFixed(2)}]`);
    }

    // ── Price action: 52W range position + day change + volume confirmation ─
    // P0.1 fix: grouped under one adaptive weight (w('price_action')) instead
    // of scoring unweighted, same as every block below.
    let priceActionRaw = 0;
    if (q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh) {
      const range = q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow;
      const pos = (q.price - q.fiftyTwoWeekLow) / range;
      if (pos < 0.15) { priceActionRaw += 2; notes.push('Near 52W low'); }
      else if (pos < 0.25) { priceActionRaw += 1; notes.push('Below 52W midpoint'); }
      if (pos > 0.90) { priceActionRaw -= 1; notes.push('Near 52W high'); }
    }

    if (q.changePct < -4) { priceActionRaw += 1; notes.push(`Day drop ${q.changePct.toFixed(1)}%`); }
    if (q.changePct >  5) { priceActionRaw -= 1; notes.push(`Day surge ${q.changePct.toFixed(1)}%`); }

    // High-volume dip = panic selling — buy opportunity
    // Low-volume move = weak conviction on either side
    // High-volume surge on up day = distribution risk (smart money selling into rally)
    if (q.volumeRatio !== undefined) {
      const vr = q.volumeRatio;
      if (q.changePct < -2 && vr > 2.0) {
        priceActionRaw += 1; notes.push(`High-volume dip (${vr.toFixed(1)}x avg) — volume-confirmed entry`);
      } else if (q.changePct > 2 && vr > 2.5) {
        priceActionRaw -= 1; notes.push(`High-volume surge (${vr.toFixed(1)}x avg) — distribution risk`);
      } else if (vr < 0.4) {
        // Thin volume: dampens conviction from price action either direction
        priceActionRaw *= 0.5;
        notes.push(`Low volume (${vr.toFixed(2)}x avg) — price-action conviction dampened`);
      } else {
        notes.push(`Volume: ${vr.toFixed(2)}x avg`);
      }
    }
    const priceActionWeight = w(SIGNAL_SOURCES.PRICE_ACTION);
    if (priceActionRaw > 0) { buy += priceActionRaw * priceActionWeight; }
    else if (priceActionRaw < 0) { sell += Math.abs(priceActionRaw) * priceActionWeight; }

    // ── P/E Valuation filter (sector-relative) ─────────────────────────────────
    // P/E norms vary wildly by sector — FMCG trades at 50-70x normally;
    // Financials are better assessed by P/B (not implemented yet — skipped here);
    // IT trades at 25-35x; Pharma 30-45x. Absolute thresholds produce false signals.
    // Reference: NSE sector median P/E ranges (5-year historical averages).
    interface SectorPeNorm { cheap: number; fair: number; expensive: number; veryExpensive: number; skipPe: boolean }
    const SECTOR_PE_NORMS: Record<string, SectorPeNorm> = {
      // FMCG brands command structural premium — P/E > 60 is normal
      'FMCG':        { cheap: 35, fair: 60, expensive: 90,  veryExpensive: 120, skipPe: false },
      // Financials: P/E unreliable due to provisioning; use P/B — skip P/E scoring
      'Financials':  { cheap: 0,  fair: 0,  expensive: 0,   veryExpensive: 0,   skipPe: true  },
      // IT services: steady earnings, moderate multiples
      'IT':          { cheap: 18, fair: 35, expensive: 50,  veryExpensive: 70,  skipPe: false },
      // Pharma: R&D cycles inflate multiples temporarily
      'Healthcare':  { cheap: 20, fair: 40, expensive: 60,  veryExpensive: 90,  skipPe: false },
      // Industrials / Infra: project-based lumpy earnings
      'Industrials': { cheap: 15, fair: 35, expensive: 55,  veryExpensive: 80,  skipPe: false },
      // Energy / Utilities: regulated, lower growth = lower multiples
      'Energy':      { cheap: 8,  fair: 18, expensive: 28,  veryExpensive: 40,  skipPe: false },
      'Utilities':   { cheap: 8,  fair: 18, expensive: 28,  veryExpensive: 40,  skipPe: false },
      // Metals / Materials: cyclical, low base multiples
      'Materials':   { cheap: 5,  fair: 12, expensive: 20,  veryExpensive: 35,  skipPe: false },
      // Auto: capex-heavy, mid multiples
      'Auto':        { cheap: 12, fair: 25, expensive: 40,  veryExpensive: 60,  skipPe: false },
      // Real estate: asset-based; P/E less relevant but kept as rough guide
      'Realty':      { cheap: 15, fair: 30, expensive: 50,  veryExpensive: 75,  skipPe: false },
      // Default for unmapped / Other
      'Other':       { cheap: 12, fair: 25, expensive: 45,  veryExpensive: 70,  skipPe: false },
    };

    // P0.1 fix: accumulate into valuationRaw and apply w('valuation') once,
    // instead of scoring unweighted like every block used to.
    let valuationRaw = 0;
    if (q.peRatio !== undefined) {
      const sector = getSymbolSector(symbol);
      const norm: SectorPeNorm = SECTOR_PE_NORMS[sector] ?? SECTOR_PE_NORMS['Other'];

      if (norm.skipPe) {
        // Financials: skip P/E, note P/B would be more appropriate
        notes.push(`P/E: ${q.peRatio?.toFixed(0) ?? 'N/A'}x (${sector} — P/B more relevant, not scored)`);
      } else if (q.peRatio === null || q.peRatio < 0) {
        // Loss-making: dampen BUY regardless of sector
        valuationRaw -= 1;
        notes.push('P/E: loss-making (EPS ≤0) — BUY dampened');
      } else {
        const pe = q.peRatio;
        if (pe > norm.veryExpensive) {
          valuationRaw -= 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — severely overvalued`);
        } else if (pe > norm.expensive) {
          valuationRaw -= 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — BUY dampened`);
        } else if (pe < norm.cheap / 2 && pe > 0) {
          valuationRaw += 2;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — deeply undervalued`);
        } else if (pe < norm.cheap) {
          valuationRaw += 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — undervalued`);
        } else {
          notes.push(`P/E: ${pe.toFixed(0)}x (${sector} fair value ~${norm.fair}x)`);
        }
      }
    }
    const valuationWeight = w(SIGNAL_SOURCES.VALUATION);
    if (valuationRaw > 0) { buy += valuationRaw * valuationWeight; }
    else if (valuationRaw < 0) { sell += Math.abs(valuationRaw) * valuationWeight; }

    // ── Rule-based news sentiment (NSE announcements) ────────────────────────
    let newsRaw = 0;
    if (sent && sent.score !== 0) {
      if (sent.score >= 2)       { newsRaw += 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === 1) { newsRaw += 1; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score <= -2) { newsRaw -= 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === -1){ newsRaw -= 1; notes.push(`NSE: ${sent.label}`); }
    }
    const newsWeight = w(SIGNAL_SOURCES.NEWS_SENTIMENT);
    if (newsRaw > 0) { buy += newsRaw * newsWeight; }
    else if (newsRaw < 0) { sell += Math.abs(newsRaw) * newsWeight; }

    // Note: ML momentum (mlEngine linear-regression slope) and MACD/EMA
    // crossover state are no longer scored here as separate additive votes —
    // they're part of the trend composite above (P1.10 fix). Scoring them
    // again here would double-count the same trend signal a second time.

    // ── Groq/Gemini LLM (NSE announcement NLP — distinct information source
    // from the rule-based keyword scorer above; both can legitimately
    // disagree, so kept as separate adaptive-weight sources) ────────────────
    let groqSentiment: string | undefined;
    let llmRaw = 0;
    if (groq) {
      groqSentiment = `${groq.sentiment}: ${groq.summary}`;
      if (groq.score >= 2)       { llmRaw += 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === 1) { llmRaw += 1; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score <= -2) { llmRaw -= 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === -1){ llmRaw -= 1; notes.push(`Groq: ${groq.tradeImplication}`); }
    }
    const llmWeight = w(SIGNAL_SOURCES.NEWS_LLM);
    if (llmRaw > 0) { buy += llmRaw * llmWeight; }
    else if (llmRaw < 0) { sell += Math.abs(llmRaw) * llmWeight; }

    // P0.1 completion: which source contributed most to this decision, used
    // to attribute the eventual trade outcome back to the right adaptive
    // weight (see recordSignalForTracking call in executeTrade below).
    // Previously outcomes were bucketed into only 3 ad hoc categories
    // ('news_sentiment'/'momentum'/'technical') that didn't match any of the
    // names actually being read back into scoring.
    const sourceContributions: Record<string, number> = {
      [SIGNAL_SOURCES.TREND_COMPOSITE]: Math.abs(trendContribution),
      [SIGNAL_SOURCES.PRICE_ACTION]:    Math.abs(priceActionRaw * priceActionWeight),
      [SIGNAL_SOURCES.VALUATION]:       Math.abs(valuationRaw * valuationWeight),
      [SIGNAL_SOURCES.NEWS_SENTIMENT]:  Math.abs(newsRaw * newsWeight),
      [SIGNAL_SOURCES.NEWS_LLM]:        Math.abs(llmRaw * llmWeight),
    };
    const dominantSource = Object.entries(sourceContributions).sort((a, b) => b[1] - a[1])[0][0];

    // Phase 12: Pattern confidence boost — multiply buy/sell scores by learned historical confidence
    // P1.10 fix: derived directly from the numeric trend composite instead of
    // fragile substring-matching on the notes array (which only coincidentally
    // worked before because "MACD: bullish crossover" happened to contain the
    // word "bullish"). marketMonitor.ts still does its own substring match on
    // signal.reason for its two independent momentumTrend computations — the
    // "Trend composite: bullish/bearish ..." note text above is deliberately
    // kept so those external checks keep matching the same classification.
    const momentumForPattern = trendLabel;
    const patternConf = await getPatternConfidence(
      symbol, rsiVal ?? 50, momentumForPattern, regime?.regime ?? 'SIDEWAYS'
    ).catch(() => 1.0);
    if (patternConf !== 1.0) {
      buy  = buy  * patternConf;
      sell = sell * patternConf;
      if (patternConf > 1.1)  notes.push(`Pattern confidence boost: ${patternConf.toFixed(2)}×`);
      if (patternConf < 0.95) notes.push(`Pattern confidence penalty: ${patternConf.toFixed(2)}×`);
    }

    // Phase 12+: Sector weight — adaptive sector-level bias from historical win rates
    const symbolSector = getSymbolSector(symbol);
    const sectorWt = await getSectorWeight(symbolSector).catch(() => 1.0);
    if (sectorWt !== 1.0) {
      buy = buy * sectorWt;
      if (sectorWt > 1.05) notes.push(`Sector weight boost (${symbolSector}): ${sectorWt.toFixed(2)}×`);
      if (sectorWt < 0.95) notes.push(`Sector weight penalty (${symbolSector}): ${sectorWt.toFixed(2)}×`);
    }

    // Phase 12+: Consensus multiplier applied after fundamentals (see below, after fundamental gate)

    // Phase 13: Strategy classification (must run before regime gate)
    const near52WLow = (() => {
      if (!q.fiftyTwoWeekLow || !q.fiftyTwoWeekHigh) return false;
      const range = q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow;
      const pos = (q.price - q.fiftyTwoWeekLow) / range;
      return pos < 0.15;
    })();
    const strategyResult = classifyStrategy({
      rsiVal,
      rsiBuyThreshold: t.rsiBuy,
      near52WLow,
      dayDropPct: q.changePct ?? 0,
      volumeRatio: q.volumeRatio ?? null,
      emaCrossover: trend?.emaCrossover?.goldenCross ?? false,
      macdBullish: (trend?.macd?.bullishCrossover || (trend?.macd?.latestHistogram ?? 0) > 0) ?? false,
      peUndervalued: (q.peRatio ?? 0) > 0 && (q.eps ?? 0) > 0 && (q.peRatio ?? 999) < 20,
      fundamentalScore: null,
      groqEventType: groq?.summary?.toLowerCase().includes('contract') ? 'contract' : null,
      groqSentiment: groq?.sentiment ?? null,
    });

    // Phase 13: Market regime gate — block strategies not allowed in current regime
    // Phase 16: Also block strategies auto-disabled by walk-forward evidence
    const marketRegime = await classifyMarketRegime().catch(() => null);
    if (buy > sell && buy >= 3) {
      const regimeAllowed = marketRegime
        ? isStrategyAllowed(strategyResult.strategyType, marketRegime.allowedStrategies)
        : true;
      if (!regimeAllowed) {
        return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Strategy ${strategyResult.strategyType} blocked in ${marketRegime?.label} regime`, price: q.price };
      }

      // Walk-forward auto-disable gate
      if (portfolioCtx?.portfolioId) {
        const disabledStrategies = await getDisabledStrategies(portfolioCtx.portfolioId).catch(() => new Set<string>());
        if (disabledStrategies.has(strategyResult.strategyType)) {
          return { symbol, action: 'HOLD', strength: 'WEAK',
            reason: `Strategy ${strategyResult.strategyType} auto-disabled: negative expectancy ≥ 3 consecutive WF windows`,
            price: q.price };
        }
      }
    }

    const reason = notes.join('; ') || 'No signal';
    const topScore = Math.max(buy, sell);
    // Phase 13: Raised thresholds — consider at 3, execute at 5.5
    const topAction: 'BUY' | 'SELL' | null = buy > sell && buy >= 3 ? 'BUY' : sell > buy && sell >= 2 ? 'SELL' : null;

    // ── Fundamental Analysis Gate ────────────────────────────────────────────
    // Runs on all BUY candidates (not SELL — we never block closing a position).
    // Veto = hard block. Weak score = weight down by 0.5. Strong score = weight up by 0.5.
    let fundamentalScore: number | null = null;
    let fundamentalVetoed = false;
    let fundamentalReasoning = '';
    if (topAction === 'BUY') {
      try {
        const snapshot = await getFundamentalSnapshot(symbol);
        if (snapshot) {
          // ─ Deterministic veto + score — rules only, no LLM involvement ─
          const symbolSector = getSymbolSector(symbol);
          const verdict = computeFundamentalVerdict(snapshot, symbolSector);
          fundamentalScore = verdict.score;
          fundamentalVetoed = verdict.vetoed;

          if (verdict.vetoed) {
            // Gate fires immediately — Gemini explanation is fire-and-forget
            // Fallback: vetoReasons string used if Gemini doesn't respond in time
            fundamentalReasoning = verdict.vetoReasons.join('; ');
            notes.push(`Fundamental VETO: ${fundamentalReasoning}`);
            // Non-blocking: attempt to enrich the reasoning but never wait on it
            void geminiFundamentalAnalysis(snapshot, verdict)
              .then(r => { if (r) fundamentalReasoning = r; })
              .catch(() => { /* Gemini down — vetoReasons fallback already set */ });
          } else if (verdict.score >= 70) {
            buy += 0.5;
            notes.push(`Fundamentals strong (score:${verdict.score}) — BUY weighted up`);
            void geminiFundamentalAnalysis(snapshot, verdict)
              .then(r => { if (r) fundamentalReasoning = r; })
              .catch(() => {});
          } else if (verdict.score < 40) {
            buy = Math.max(0, buy - 0.5);
            notes.push(`Fundamentals weak (score:${verdict.score}) — BUY weighted down`);
            void geminiFundamentalAnalysis(snapshot, verdict)
              .then(r => { if (r) fundamentalReasoning = r; })
              .catch(() => {});
          }
        }
      } catch (err) {
        logger.warn({ job: 'fundamental-gate', symbol, reason: `[Fundamental] Gate failed — proceeding on technicals: ${err}` });
      }
    }

    if (fundamentalVetoed) {
      return { symbol, action: 'HOLD', strength: 'WEAK', reason: notes.join('; '), price: q.price };
    }

    // Phase 13: Expected Value gate — block BUY when EV < 1% after costs (requires 15+ resolved trades)
    // Phase 14: ML Win Probability gate — block BUY when P(win) < 52% and model is trained
    let mlWinProbability: number | undefined;
    let kellyFraction: number | null = null;
    if (topAction === 'BUY') {
      const [evResult, winProb, govState] = await Promise.all([
        computeExpectedValue(symbol, strategyResult.strategyType).catch(() => null),
        getWinProbability({
          rsiValue: rsiVal,
          volumeRatio: q.volumeRatio,
          marketRegime: marketRegime?.label ?? null,
          strategyType: strategyResult.strategyType,
          fundamentalScore: fundamentalScore,
        }).catch(() => null),
        portfolioCtx?.portfolioId
          ? getModelGovernanceState(portfolioCtx.portfolioId).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (evResult?.sufficient && !evResult.meetsThreshold) {
        return { symbol, action: 'HOLD', strength: 'WEAK',
          reason: `EV gate: expected value ${evResult.ev.toFixed(2)}% below 1% threshold (${evResult.sampleCount} trades: P(win)=${(evResult.pWin*100).toFixed(0)}%, avgWin=${evResult.avgWinPct.toFixed(1)}%, avgLoss=${evResult.avgLossPct.toFixed(1)}%)`,
          price: q.price };
      }

      // P1.11 fix (2026-07-22): half-Kelly sizing derived from this strategy+
      // symbol's own resolved trade history — reusing the exact same
      // pWin/avgWin/avgLoss computeExpectedValue() already fetched for the EV
      // gate above (no extra query). Previously mlEngine.computeKellySize()
      // sized off unconditional raw daily returns with no connection to what
      // the strategy actually trades, and its output was never used to size
      // a real position (see QuantumMind_Algorithm_Analysis.md §3.5).
      if (evResult?.sufficient) {
        kellyFraction = kellyPositionSize(evResult.pWin, evResult.avgWinPct, evResult.avgLossPct, t.maxPosPct);
        notes.push(`Kelly (strategy-conditioned, n=${evResult.sampleCount}): ${(kellyFraction * 100).toFixed(1)}% of NAV`);
      }

      mlWinProbability = winProb?.pWin;

      // P0.4 fix (2026-07-22): getWinProbability() previously blocked live BUYs
      // at its own independent threshold (pWin>=0.52 once it had 50 training
      // samples) — completely bypassing modelLifecycle.ts's much more careful
      // staged-promotion gate (200/500/1000 labels + positive walk-forward
      // windows + strategy/sector diversity + calibration checks), which is
      // the gatekeeper the rest of the codebase clearly intends to use for ML
      // influence over real trades. modelLifecycle's own doc comment says ML
      // "can block/approve" only at PRODUCTION stage; CANDIDATE/SHADOW/ADVISORY
      // should be no-op-to-advisory only. Below PRODUCTION we still compute and
      // surface the prediction (mlWinProbability on the returned signal, and a
      // note) but never let it turn a signal into a HOLD.
      // See QuantumMind_Algorithm_Analysis.md §3.1.
      const mlGateActive = govState?.stage === 'PRODUCTION';
      if (winProb?.modelAvailable && !winProb.meetsThreshold) {
        if (mlGateActive) {
          return { symbol, action: 'HOLD', strength: 'WEAK',
            reason: `ML gate: P(win)=${(winProb.pWin*100).toFixed(1)}% < 52% threshold (${winProb.sampleCount} training samples, model stage=PRODUCTION)`,
            price: q.price };
        }
        notes.push(`ML advisory only (model stage=${govState?.stage ?? 'CANDIDATE'}, not yet PRODUCTION — not blocking): P(win)=${(winProb.pWin*100).toFixed(1)}% below 52% threshold`);
      }
    }

    // Phase 12+: Consensus multiplier — real-time independent signal agreement (runs post-fundamentals)
    const groqDir = groqSentiment?.startsWith('BULLISH') ? 'bullish' : groqSentiment?.startsWith('BEARISH') ? 'bearish' : 'neutral';
    const consensusMult = computeConsensusMultiplier({
      rsiSignal:        rsiVal !== null && rsiVal < (t.rsiBuy ?? 35) ? 'bullish' : rsiVal !== null && rsiVal > 70 ? 'bearish' : 'neutral',
      macdSignal:       (trend?.macd?.bullishCrossover ?? false) ? 'bullish' : (trend?.macd?.bearishCrossover ?? false) ? 'bearish' : 'neutral',
      momentumSignal:   momentumForPattern,
      newsSignal:       groqDir,
      volumeSignal:     (q.volumeRatio ?? 1) > 1.5 ? 'bullish' : (q.volumeRatio ?? 1) < 0.5 ? 'bearish' : 'neutral',
      fundamentalScore: fundamentalScore ?? 50,
    });
    if (consensusMult !== 1.0) {
      buy = buy * consensusMult;
      if (consensusMult > 1.05) notes.push(`Consensus boost: ${consensusMult.toFixed(2)}×`);
      if (consensusMult < 0.97) notes.push(`Consensus penalty: ${consensusMult.toFixed(2)}×`);
    }

    if (topAction && portfolioCtx && topScore >= 5.5) {
      // Gemini pre-trade reasoning gate — only fires on STRONG signals (score ≥ 5.5)
      // MODERATE signals (score 3–5.4) proceed without veto to conserve Gemini quota
      const veto = await geminiTradeVeto({
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
      }).catch(() => ({ verdict: 'EXECUTE' as const, reason: '' }));

      // Record BUY veto decision for Gemini accuracy learning
      if (portfolioCtx?.portfolioId) {
        const { run: dbRun } = await import('../db/turso.js');
        await dbRun(
          'INSERT INTO gemini_decisions (portfolio_id,symbol,decision_type,verdict,score) VALUES (?,?,?,?,?)',
          [portfolioCtx.portfolioId, symbol, 'buy_veto', veto.verdict,
           veto.verdict === 'EXECUTE' ? 1 : veto.verdict === 'REDUCE' ? 0 : -1]
        ).catch(() => null);
      }

      if (veto.verdict === 'SKIP') {
        return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Gemini veto: ${veto.reason}`, price: q.price };
      }
      const strength = veto.verdict === 'REDUCE'
        ? 'MODERATE'  // cap to MODERATE so position sizing stays smaller
        : topScore >= 5.5 ? 'STRONG' : 'MODERATE';
      const finalReason = veto.reason ? `${reason} | Gemini: ${veto.reason}` : reason;
      return { symbol, action: topAction, strength, reason: finalReason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment,
        fundamentalScore: fundamentalScore ?? undefined, fundamentalReasoning: fundamentalReasoning || undefined,
        strategyType: strategyResult.strategyType, strategyConfidence: strategyResult.confidence,
        strategyReasonCodes: strategyResult.reasonCodes, strategyClassifierVersion: strategyResult.classifierVersion,
        marketRegimeLabel: marketRegime?.label, mlWinProbability, dominantSource, kellyFraction };
    }

    if (topAction) {
      return { symbol, action: topAction, strength: topScore >= 5.5 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment,
        fundamentalScore: fundamentalScore ?? undefined, fundamentalReasoning: fundamentalReasoning || undefined,
        mlWinProbability, dominantSource, kellyFraction,
        strategyType: strategyResult.strategyType, strategyConfidence: strategyResult.confidence,
        strategyReasonCodes: strategyResult.reasonCodes, strategyClassifierVersion: strategyResult.classifierVersion,
        marketRegimeLabel: marketRegime?.label };
    }
    return { symbol, action: 'HOLD', strength: 'WEAK', reason, price: q.price };
  } catch (err) {
    console.error(`[Signal] Error for ${symbol}:`, err);
    return null;
  }
}

/**
 * Execute a simulated trade.
 * Flow: pre-checks → RiskEngine → atomic DB batch (all-or-nothing).
 * Returns tradeId on success, null if blocked.
 */
export interface TradeContext {
  rsi?: number;
  momentumScore?: number;
  newsScore?: number;
  groqSentiment?: string;
  kellyFraction?: number;
  regime?: string;
  buyScore?: number;
  sellScore?: number;
  riskGates?: string[];
  fundamentalScore?: number;
  fundamentalReasoning?: string;
  /** P0.1 fix: the dominant adaptive-weight source from generateSignal()'s
   * TradeSignal.dominantSource, used to attribute this trade's eventual
   * outcome to the correct signal_weights row. */
  dominantSource?: string;
}

export async function executeTrade(
  portfolioId: number,
  symbol: string,
  companyName: string,
  action: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  reason: string,
  quote?: import('./marketData.js').StockQuote,  // pass executable quote for risk engine
  ctx?: TradeContext                              // structured context for explainability
): Promise<number | null> {
  // Hard guard: never execute a trade at zero or sub-penny price.
  // Zero price = market data unavailable (Yahoo Finance blocked on cloud IPs).
  if (!price || price < MIN_STOCK_PRICE) {
    logger.warn({ job: 'trade-execution', portfolioId, symbol, phase: 'execution',
      reason: `Aborted: invalid price ${price} — trade would corrupt realized P&L` });
    return null;
  }

  // Phase 18: Idempotency guard — block duplicate order within 60s window.
  // Prevents double-BUY or double-SELL from retry/concurrent invocations.
  const DEDUP_WINDOW_S = 60;
  const dedupWindowIso = new Date(Date.now() - DEDUP_WINDOW_S * 1000).toISOString();
  const recentDuplicate = await queryOne(
    `SELECT id FROM trades
     WHERE portfolio_id=? AND symbol=? AND action=? AND created_at >= ?
     LIMIT 1`,
    [portfolioId, symbol, action, dedupWindowIso],
  ).catch(() => null);
  if (recentDuplicate) {
    const detail = `Duplicate ${action} within ${DEDUP_WINDOW_S}s (existing trade id=${recentDuplicate.id})`;
    logger.warn({ job: 'trade-execution', portfolioId, symbol, action, phase: 'execution',
      reason: `DEDUP_BLOCKED: ${detail}` });
    // Phase 18 [MAJOR fix]: persist to trade_events so audit report can count it
    void run(
      `INSERT INTO trade_events (portfolio_id, symbol, event_type, action, detail) VALUES (?,?,?,?,?)`,
      [portfolioId, symbol, 'DEDUP_BLOCKED', action, detail],
    ).catch(() => null);
    return null;
  }

  const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [portfolioId]);
  if (!portfolio || !portfolio.is_active) return null;

  // Cash/holding sufficiency checks below are sanity-checked against the
  // REQUESTED order (quantity/price) — the fill simulator (further down)
  // then determines how much of that request actually executes.
  const requestedAmount = quantity * price;
  const requestedNetAmount = action === 'BUY' ? requestedAmount + FLAT_BROKERAGE_INR : requestedAmount - FLAT_BROKERAGE_INR;

  // Compute NAV
  const holdingsForNAV = await query('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]);
  const portfolioNAV = holdingsForNAV.reduce(
    (s: number, h: any) => s + Number(h.quantity) * Number(h.current_price || h.avg_buy_price), 0
  ) + Number(portfolio.current_cash);

  // ── Risk Engine gate ──────────────────────────────────────────────────
  if (quote) {
    const riskDecision = await evaluateRisk({
      portfolioId, symbol, action,
      quantity, price, portfolioNAV, quote,
    });
    const effectiveQty = riskDecision.maxAllowedQty ?? quantity;
    if (!riskDecision.approved) {
      logger.riskBlock(portfolioId, symbol, riskDecision.reason);
      return null;
    }
    if (effectiveQty !== quantity) {
      // Risk engine reduced the quantity to fit under position cap
      return executeTrade(portfolioId, symbol, companyName, action, effectiveQty, price, `${reason} [qty-capped]`, quote);
    }
  }

  // Cash / holding pre-check (fast fail before touching DB)
  if (action === 'BUY' && portfolio.current_cash < requestedNetAmount) {
    logger.warn({ job: 'trade-execution', portfolioId, symbol, phase: 'execution', reason: 'Insufficient cash' });
    return null;
  }
  if (action === 'SELL') {
    const h = await queryOne('SELECT * FROM holdings WHERE portfolio_id=? AND symbol=?', [portfolioId, symbol]);
    if (!h || Number(h.quantity) < quantity) {
      logger.warn({ job: 'trade-execution', portfolioId, symbol, phase: 'execution', reason: 'Insufficient holding for SELL' });
      return null;
    }
  }

  // ── P0.5 fix (2026-07-22): realistic fill simulation now actually feeds
  // the ledger, instead of being computed only after the fact purely for an
  // audit log (see QuantumMind_Algorithm_Analysis.md §2.5). simulateVirtualFill
  // determines the executed price (with ATR/volume/order-size slippage) and
  // quantity (partial fills below 30% of average volume; rejection below
  // 10% or when the order exceeds 10% of average daily traded value).
  // calculateVirtualCharges (tradingCosts.ts / virtualFillSimulator.ts) is
  // the single source of truth for transaction cost — replacing the
  // previously-hardcoded flat ₹5 that ignored STT/exchange/SEBI/GST/stamp
  // duty entirely.
  const avgDailyValue = await getAvgDailyTradedValue(symbol).catch(() => undefined);
  const fillResult = simulateVirtualFill({
    symbol, side: action,
    signalPrice: price, intendedPrice: price, currentPrice: price,
    quantity, orderValue: requestedAmount,
    volumeRatio: quote?.volumeRatio ?? 1.0,
    averageDailyValue: avgDailyValue ?? undefined,
  });

  if (fillResult.fillStatus === 'REJECTED') {
    logger.warn({ job: 'trade-execution', portfolioId, symbol, action, phase: 'execution',
      reason: `Virtual fill REJECTED: ${fillResult.rejectionReason}` });
    void run(
      `INSERT INTO trade_events (portfolio_id, symbol, event_type, action, detail) VALUES (?,?,?,?,?)`,
      [portfolioId, symbol, 'FILL_REJECTED', action, fillResult.rejectionReason ?? 'unknown'],
    ).catch(() => null);
    return null;
  }

  const execQty = fillResult.quantityFilled;
  const execPrice = fillResult.simulatedFillPrice;
  const amount = execQty * execPrice;
  const charges = calculateVirtualCharges(action, amount);
  const brokerage = charges.totalCharges; // itemized total (brokerage + STT + exchange + SEBI + GST + stamp duty)
  const netAmount = action === 'BUY' ? amount + brokerage : amount - brokerage;

  const valueBefore = portfolioNAV;

  // ── Atomic execution batch ───────────────────────────────────────────────
  // All statements execute in one LibSQL transaction — partial failures roll back entirely.
  const statements: { sql: string; args: any[] }[] = [];

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
    fundamentalScore: ctx.fundamentalScore,
    fundamentalReasoning: ctx.fundamentalReasoning,
    price: execPrice,
    quantityRequested: quantity,
    quantityFilled: execQty,
    slippagePct: fillResult.slippagePct,
    fillStatus: fillResult.fillStatus,
    action,
    timestamp: new Date().toISOString(),
  }) : null;
  // For SELL: compute realized PnL before building statements so it can be
  // included in the INSERT itself — keeping the entire operation atomic.
  // Cost basis (avg_buy_price, set on BUY below) already includes buy-side
  // charges blended in, so this only needs to net the sell-side charges —
  // previously this only ever netted a flat ₹5 SELL fee and never accounted
  // for the BUY-side fee against cost basis at all, silently understating
  // true round-trip cost in every realized_pnl figure (which feeds ML
  // training labels and the EV gate).
  let realizedPnlOnTrade: number | null = null;
  if (action === 'SELL') {
    const h = holdingsForNAV.find((h: any) => h.symbol === symbol);
    if (!h) {
      logger.warn({ job: 'trading-engine', portfolioId, symbol, reason: 'SELL skipped — holding not found in NAV snapshot' });
      return null;
    }
    realizedPnlOnTrade = (execPrice - Number(h.avg_buy_price)) * execQty - brokerage;
    const newQty = Number(h.quantity) - execQty;
    if (newQty <= 0.001) {
      statements.push({ sql: 'DELETE FROM holdings WHERE portfolio_id=? AND symbol=?', args: [portfolioId, symbol] });
    } else {
      statements.push({ sql: 'UPDATE holdings SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, portfolioId, symbol] });
    }
    statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash+?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
  } else {
    const existing = holdingsForNAV.find((h: any) => h.symbol === symbol);
    // Cost basis includes this BUY's charges (brokerage + STT + exchange +
    // SEBI + GST + stamp duty), blended per-share — P0.5 fix: previously
    // buy-side brokerage reduced cash but was never reflected in avg_buy_price,
    // so realized P&L on the eventual SELL silently ignored the BUY-side fee.
    const costBasisAmount = amount + brokerage;
    if (existing) {
      const newQty = Number(existing.quantity) + execQty;
      const newAvg = Math.round(((Number(existing.quantity) * Number(existing.avg_buy_price) + costBasisAmount) / newQty) * 100) / 100;
      statements.push({ sql: 'UPDATE holdings SET quantity=?, avg_buy_price=?, current_price=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, newAvg, execPrice, portfolioId, symbol] });
    } else {
      const newAvg = Math.round((costBasisAmount / execQty) * 100) / 100;
      statements.push({ sql: 'INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price) VALUES (?,?,?,?,?,?)', args: [portfolioId, symbol, companyName, execQty, newAvg, execPrice] });
    }
    statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash-?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
  }

  // INSERT trade with realized_pnl included — fully atomic, no follow-up UPDATE needed
  statements.unshift({
    sql: 'INSERT INTO trades (portfolio_id, symbol, company_name, action, quantity, price, amount, brokerage, net_amount, signal_reason, portfolio_value_before, trade_reason, realized_pnl, volume_ratio) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    args: [portfolioId, symbol, companyName, action, execQty, execPrice, amount, brokerage, netAmount, reason, valueBefore, tradeReasonJson, realizedPnlOnTrade, quote?.volumeRatio ?? null],
  });

  // Fire-and-forget: persist the fill-quality/charges audit event and kick
  // off virtual ledger reconciliation. Uses the SAME fillResult/charges that
  // were just applied to the ledger above (single source of truth) — this
  // used to be recomputed independently in marketMonitor.ts *after*
  // executeTrade had already committed different (unrealistic) numbers,
  // which meant the audit log could drift from what was actually charged.
  const recordExecutionEvent = (tradeId: number) => {
    void (async () => {
      try {
        const orderType = action === 'SELL'
          ? (/trailing/i.test(reason) ? 'VIRTUAL_TRAILING_STOP' : /stop/i.test(reason) ? 'VIRTUAL_STOP' : 'VIRTUAL_MARKET')
          : 'VIRTUAL_MARKET';
        await recordVirtualExecutionEvent({
          portfolioId, tradeId,
          virtualOrderId: `${action.toLowerCase()}-${portfolioId}-${symbol}-${Date.now()}`,
          symbol, side: action, quantityRequested: quantity, quantityFilled: execQty,
          orderType,
          signalPrice: price, intendedPrice: price, simulatedFillPrice: execPrice,
          slippageAbs: fillResult.slippageAbs, slippagePct: fillResult.slippagePct,
          fillStatus: fillResult.fillStatus, rejectionReason: fillResult.rejectionReason,
          simulatedLatencyMs: fillResult.simulatedLatencyMs,
          brokerage: charges.brokerage, stt: charges.stt, exchangeCharges: charges.exchangeCharges,
          sebiCharges: charges.sebiCharges, gst: charges.gst, stampDuty: charges.stampDuty,
          totalCharges: charges.totalCharges,
        });
        fireVirtualReconciliation(portfolioId, action === 'BUY' ? 'POST_BUY' : 'POST_SELL');
      } catch (e) {
        logger.warn({ job: 'virtual-execution', portfolioId, symbol, err: String(e), reason: 'Virtual execution recording failed' });
      }
    })();
  };

  if (action === 'SELL') {
    // statements already built above — execute and return
    const results = await batchWithResults(statements);
    const tradeId = results[0].lastInsertRowid;
    logger.trade(portfolioId, symbol, 'SELL', execPrice, quote?.provider ?? 'unknown', true, reason, { qty: execQty, netAmount, realizedPnl: realizedPnlOnTrade });
    recordExecutionEvent(Number(tradeId));
    // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
    // P0.1 fix (2026-07-22): previously bucketed into 3 ad hoc categories
    // ('news_sentiment'/'momentum'/'technical') that didn't match any of the
    // 5 canonical SIGNAL_SOURCES names actually read back into scoring — so
    // outcome tracking silently fed the wrong (or no) weight. Now uses the
    // dominant source computed in generateSignal(), falling back to the old
    // heuristic only for callers that don't run through generateSignal (e.g.
    // the manual-trade API route, which has no TradeSignal to draw from).
    const signalSourceSell = ctx?.dominantSource
      ?? (ctx?.groqSentiment != null ? SIGNAL_SOURCES.NEWS_SENTIMENT
        : ctx?.momentumScore != null ? SIGNAL_SOURCES.TREND_COMPOSITE
        : SIGNAL_SOURCES.PRICE_ACTION);
    recordSignalForTracking(portfolioId, symbol, 'SELL', signalSourceSell, execPrice, new Date().toISOString()).catch(
      e => console.warn('[Adaptive] recordSignalForTracking failed:', e)
    );
    // Resolve Gemini sell decisions for this symbol — mark win/loss for learning (fire-and-forget)
    if (realizedPnlOnTrade !== null) {
      const avgBuyPrice = holdingsForNAV.find((h: any) => h.symbol === symbol)?.avg_buy_price;
      const realizedPnlPct = avgBuyPrice ? (realizedPnlOnTrade / (Number(avgBuyPrice) * execQty)) * 100 : 0;
      resolveGeminiSellDecisions(portfolioId, symbol, realizedPnlPct).catch(() => null);
    }
    return tradeId;
  }

  const results = await batchWithResults(statements);
  const tradeId = results[0].lastInsertRowid;
  logger.trade(portfolioId, symbol, 'BUY', execPrice, quote?.provider ?? 'unknown', true, reason, { qty: execQty, netAmount });
  recordExecutionEvent(Number(tradeId));
  // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
  // P0.1 fix: see comment on signalSourceSell above.
  const signalSourceBuy = ctx?.dominantSource
    ?? (ctx?.groqSentiment != null ? SIGNAL_SOURCES.NEWS_SENTIMENT
      : ctx?.momentumScore != null ? SIGNAL_SOURCES.TREND_COMPOSITE
      : SIGNAL_SOURCES.PRICE_ACTION);
  recordSignalForTracking(portfolioId, symbol, 'BUY', signalSourceBuy, execPrice, new Date().toISOString()).catch(
    e => console.warn('[Adaptive] recordSignalForTracking failed:', e)
  );
  return tradeId;
}

export async function getPortfolioSummary(portfolioId: number): Promise<PortfolioSummary> {
  const [portfolio, holdings] = await Promise.all([
    queryOne('SELECT * FROM portfolios WHERE id = ?', [portfolioId]),
    query('SELECT * FROM holdings WHERE portfolio_id = ?', [portfolioId]),
  ]);

  // Realized PnL: only from closed positions (SELL trades minus their cost basis)
  // Approximated as: sum(sell_proceeds) - sum(buy_cost for matching lots)
  // For now: track via explicit pnl column when available, else 0 until sells occur
  const [realizedRows, brokerageRows] = await Promise.all([
    query(`SELECT COALESCE(SUM(realized_pnl), 0) as pnl FROM trades WHERE portfolio_id = ? AND action = 'SELL' AND realized_pnl IS NOT NULL`, [portfolioId]),
    query(`SELECT COALESCE(SUM(brokerage), 0) as total FROM trades WHERE portfolio_id = ? AND price > 0`, [portfolioId]),
  ]);
  const realizedPnl    = Number(realizedRows[0]?.pnl ?? 0);
  const totalBrokerage = Number(brokerageRows[0]?.total ?? 0);

  let invested = 0, current = 0;
  const hSummaries: HoldingSummary[] = [];
  for (const h of holdings) {
    const cp = Number(h.current_price ?? h.avg_buy_price);
    const cv = Number(h.quantity) * cp;
    const cost = Number(h.quantity) * Number(h.avg_buy_price);
    invested += cost; current += cv;
    const updatedAt = (h.last_price_updated ?? h.updated_at) as string | undefined;
    const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;
    const priceStatus: 'LIVE' | 'STALE' = ageMs < 15 * 60 * 1000 ? 'LIVE' : 'STALE';
    hSummaries.push({
      symbol: h.symbol as string, companyName: h.company_name as string, sector: h.sector as string | undefined,
      quantity: Number(h.quantity), avgBuyPrice: Number(h.avg_buy_price), currentPrice: cp,
      currentValue: cv, pnl: cv - cost, pnlPct: ((cv - cost) / cost) * 100,
      priceStatus, priceUpdatedAt: updatedAt,
      createdAt: h.created_at as string | undefined,
      strategyType: h.strategy_type as string | undefined,
      atrStopPrice: h.atr_stop_price != null ? Number(h.atr_stop_price) : null,
      trailingStopPrice: h.trailing_stop_price != null ? Number(h.trailing_stop_price) : null,
      timeStopDate: h.time_stop_date as string | null,
      riskAmountInr: h.risk_amount_inr != null ? Number(h.risk_amount_inr) : null,
      thesisInvalidated: Number(h.thesis_invalidated ?? 0),
    });
  }

  const totalValue = current + Number(portfolio.current_cash);
  const initCap      = Number(portfolio.initial_capital);
  const unrealPnl    = current - invested;
  const totalPnl     = unrealPnl + realizedPnl;
  const returnPct    = initCap > 0 ? ((totalValue - initCap) / initCap) * 100 : 0;
  // All % use initialCapital as denominator — consistent with returnPct
  const unrealPnlPct = initCap > 0 ? (unrealPnl  / initCap) * 100 : 0;
  const realPnlPct   = initCap > 0 ? (realizedPnl / initCap) * 100 : 0;
  const totalPnlPct  = initCap > 0 ? (totalPnl    / initCap) * 100 : 0;

  return {
    id: Number(portfolio.id), name: portfolio.name as string,
    initialCapital: initCap,
    totalValue, investedValue: invested, cashBalance: Number(portfolio.current_cash),
    unrealizedPnl: unrealPnl, unrealizedPnlPct: unrealPnlPct,
    realizedPnl,               realizedPnlPct: realPnlPct,
    totalPnl,                  totalPnlPct,
    totalBrokerage,
    returnPct, targetReturnPct: Number(portfolio.target_return_pct),
    riskTolerance: portfolio.risk_tolerance as string, investmentHorizonMonths: Number(portfolio.investment_horizon_months),
    policyType: (() => { try { const { derivePolicy } = require('./portfolioPolicy.js'); return derivePolicy({ risk_tolerance: portfolio.risk_tolerance, investment_horizon_months: portfolio.investment_horizon_months, target_return_pct: portfolio.target_return_pct, investment_goal: portfolio.investment_goal ?? 'growth', volatility_preference: portfolio.volatility_preference ?? 'medium' }).policyType; } catch { return 'MEDIUM_RISK_12M'; } })(),
    holdings: hSummaries,
  };
}
