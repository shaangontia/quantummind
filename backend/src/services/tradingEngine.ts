import { query, queryOne, run } from '../db/turso.js';
import { getQuote, getExecutableQuote, getRsi, isNseMarketOpen, getSymbolSector } from './marketData.js';
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
import { getMLBoost, computeTrendIndicators } from './mlEngine.js';
import { getGroqStockSentiment } from './groqService.js';
import { getSignalWeights, getCurrentRegime, recordSignalForTracking, resolveGeminiSellDecisions } from './adaptiveEngine.js';
import { geminiTradeVeto, geminiFundamentalAnalysis } from './geminiService.js';
import { getFundamentalSnapshot, computeFundamentalVerdict } from './fundamentalService.js';
import { getAdaptiveRSIBuy, getPatternConfidence } from './patternEngine.js';
import { classifyStrategy, isStrategyAllowed } from './strategyClassifier.js';
import { classifyMarketRegime } from './regimeEngine.js';

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
  marketRegimeLabel?: string;
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

    // ── Volume confirmation ─────────────────────────────────────────────────
    // High-volume dip = panic selling — buy opportunity
    // Low-volume move = weak conviction on either side
    // High-volume surge on up day = distribution risk (smart money selling into rally)
    if (q.volumeRatio !== undefined) {
      const vr = q.volumeRatio;
      if (q.changePct < -2 && vr > 2.0) {
        buy  += 1; notes.push(`High-volume dip (${vr.toFixed(1)}x avg) — volume-confirmed entry`);
      } else if (q.changePct > 2 && vr > 2.5) {
        sell += 1; notes.push(`High-volume surge (${vr.toFixed(1)}x avg) — distribution risk`);
      } else if (vr < 0.4) {
        // Thin volume: dampens both buy and sell signals from price action
        if (buy > sell) { buy  -= 0.5; notes.push(`Low volume (${vr.toFixed(2)}x avg) — weak BUY conviction`); }
        else if (sell > buy) { sell -= 0.5; notes.push(`Low volume (${vr.toFixed(2)}x avg) — weak SELL conviction`); }
      } else {
        notes.push(`Volume: ${vr.toFixed(2)}x avg`);
      }
    }

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

    if (q.peRatio !== undefined) {
      const sector = getSymbolSector(symbol);
      const norm: SectorPeNorm = SECTOR_PE_NORMS[sector] ?? SECTOR_PE_NORMS['Other'];

      if (norm.skipPe) {
        // Financials: skip P/E, note P/B would be more appropriate
        notes.push(`P/E: ${q.peRatio?.toFixed(0) ?? 'N/A'}x (${sector} — P/B more relevant, not scored)`);
      } else if (q.peRatio === null || q.peRatio < 0) {
        // Loss-making: dampen BUY regardless of sector
        buy  -= 1;
        notes.push('P/E: loss-making (EPS ≤0) — BUY dampened');
      } else {
        const pe = q.peRatio;
        if (pe > norm.veryExpensive) {
          sell += 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — severely overvalued`);
        } else if (pe > norm.expensive) {
          buy  -= 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — BUY dampened`);
        } else if (pe < norm.cheap / 2 && pe > 0) {
          buy  += 2;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — deeply undervalued`);
        } else if (pe < norm.cheap) {
          buy  += 1;
          notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — undervalued`);
        } else {
          notes.push(`P/E: ${pe.toFixed(0)}x (${sector} fair value ~${norm.fair}x)`);
        }
      }
    }

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

    // ── MACD + EMA trend filter ───────────────────────────────────────────────
    // Crossover events score directly. EMA state used as RSI filter.
    if (trend) {
      const { macd, emaCrossover } = trend;
      if (macd) {
        if (macd.bullishCrossover)       { buy  += 2; notes.push('MACD: bullish crossover (histogram flipped +)'); }
        else if (macd.bearishCrossover)  { sell += 2; notes.push('MACD: bearish crossover (histogram flipped -)'); }
        else if (macd.latestHistogram > 0){ buy  += 1; notes.push(`MACD: positive histogram (${macd.latestHistogram.toFixed(3)})`); }
        else if (macd.latestHistogram < 0){ sell += 1; notes.push(`MACD: negative histogram (${macd.latestHistogram.toFixed(3)})`); }
      }
      if (emaCrossover) {
        if (emaCrossover.goldenCross)     { buy  += 2; notes.push('EMA: golden cross (EMA20 above EMA50)'); }
        else if (emaCrossover.deathCross) { sell += 2; notes.push('EMA: death cross (EMA20 below EMA50)'); }
        else if (!emaCrossover.ema20AboveEma50 && rsiVal !== null && rsiVal < t.rsiBuy) {
          // Bearish trend state — suppress RSI-generated BUY votes
          buy = Math.max(0, buy - 1);
          notes.push('EMA trend: bearish (EMA20 < EMA50) — RSI BUY dampened');
        }
      }
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

    // Phase 12: Pattern confidence boost — multiply buy/sell scores by learned confidence
    const momentumForPattern = notes.some(n => n.includes('bullish') || n.includes('Momentum UP')) ? 'bullish'
      : notes.some(n => n.includes('bearish') || n.includes('Momentum DOWN')) ? 'bearish' : 'neutral';
    const patternConf = await getPatternConfidence(
      symbol, rsiVal ?? 50, momentumForPattern, regime?.regime ?? 'SIDEWAYS'
    ).catch(() => 1.0);
    if (patternConf !== 1.0) {
      buy  = buy  * patternConf;
      sell = sell * patternConf;
      if (patternConf > 1.1)  notes.push(`Pattern confidence boost: ${patternConf.toFixed(2)}×`);
      if (patternConf < 0.95) notes.push(`Pattern confidence penalty: ${patternConf.toFixed(2)}×`);
    }

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
    const marketRegime = await classifyMarketRegime().catch(() => null);
    if (buy > sell && buy >= 3) {
      const regimeAllowed = marketRegime
        ? isStrategyAllowed(strategyResult.type, marketRegime.allowedStrategies)
        : true;
      if (!regimeAllowed) {
        return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Strategy ${strategyResult.type} blocked in ${marketRegime?.label} regime`, price: q.price };
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
          const verdict = computeFundamentalVerdict(snapshot);
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

    if (topAction && portfolioCtx && topScore >= 5.5) {
      // Gemini pre-trade reasoning gate — only fires on STRONG signals (score ≥ 4)
      // MODERATE signals (score 2-3) proceed without veto to conserve Gemini quota
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
        strategyType: strategyResult.type, marketRegimeLabel: marketRegime?.label };
    }

    if (topAction) {
      return { symbol, action: topAction, strength: topScore >= 5.5 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment,
        fundamentalScore: fundamentalScore ?? undefined, fundamentalReasoning: fundamentalReasoning || undefined,
        strategyType: strategyResult.type, marketRegimeLabel: marketRegime?.label };
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

  const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [portfolioId]);
  if (!portfolio || !portfolio.is_active) return null;

  const amount = quantity * price;
  const brokerage = 5; // flat ₹5 per trade (platform rate) — TODO: integrate into signal scoring via CostAdjustedSignalValidator
  const netAmount = action === 'BUY' ? amount + brokerage : amount - brokerage;

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
  if (action === 'BUY' && portfolio.current_cash < netAmount) {
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
    price,
    action,
    timestamp: new Date().toISOString(),
  }) : null;
  // For SELL: compute realized PnL before building statements so it can be
  // included in the INSERT itself — keeping the entire operation atomic.
  let realizedPnlOnTrade: number | null = null;
  if (action === 'SELL') {
    const h = holdingsForNAV.find((h: any) => h.symbol === symbol);
    if (!h) {
      logger.warn({ job: 'trading-engine', portfolioId, symbol, reason: 'SELL skipped — holding not found in NAV snapshot' });
      return null;
    }
    realizedPnlOnTrade = (price - Number(h.avg_buy_price)) * quantity - brokerage;
    const newQty = Number(h.quantity) - quantity;
    if (newQty <= 0.001) {
      statements.push({ sql: 'DELETE FROM holdings WHERE portfolio_id=? AND symbol=?', args: [portfolioId, symbol] });
    } else {
      statements.push({ sql: 'UPDATE holdings SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, portfolioId, symbol] });
    }
    statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash+?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
  } else {
    const existing = holdingsForNAV.find((h: any) => h.symbol === symbol);
    if (existing) {
      const newQty = Number(existing.quantity) + quantity;
      const newAvg = (Number(existing.quantity) * Number(existing.avg_buy_price) + amount) / newQty;
      statements.push({ sql: 'UPDATE holdings SET quantity=?, avg_buy_price=?, current_price=?, updated_at=CURRENT_TIMESTAMP WHERE portfolio_id=? AND symbol=?', args: [newQty, newAvg, price, portfolioId, symbol] });
    } else {
      statements.push({ sql: 'INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price) VALUES (?,?,?,?,?,?)', args: [portfolioId, symbol, companyName, quantity, price, price] });
    }
    statements.push({ sql: 'UPDATE portfolios SET current_cash=current_cash-?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [netAmount, portfolioId] });
  }

  // INSERT trade with realized_pnl included — fully atomic, no follow-up UPDATE needed
  statements.unshift({
    sql: 'INSERT INTO trades (portfolio_id, symbol, company_name, action, quantity, price, amount, brokerage, net_amount, signal_reason, portfolio_value_before, trade_reason, realized_pnl, volume_ratio) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    args: [portfolioId, symbol, companyName, action, quantity, price, amount, brokerage, netAmount, reason, valueBefore, tradeReasonJson, realizedPnlOnTrade, quote?.volumeRatio ?? null],
  });

  if (action === 'SELL') {
    // statements already built above — execute and return
    const results = await batchWithResults(statements);
    const tradeId = results[0].lastInsertRowid;
    logger.trade(portfolioId, symbol, 'SELL', price, quote?.provider ?? 'unknown', true, reason, { qty: quantity, netAmount, realizedPnl: realizedPnlOnTrade });
    // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
    const signalSourceSell = ctx?.groqSentiment != null ? 'news_sentiment'
      : ctx?.momentumScore != null ? 'momentum'
      : 'technical';
    recordSignalForTracking(portfolioId, symbol, 'SELL', signalSourceSell, price, new Date().toISOString()).catch(
      e => console.warn('[Adaptive] recordSignalForTracking failed:', e)
    );
    // Resolve Gemini sell decisions for this symbol — mark win/loss for learning (fire-and-forget)
    if (realizedPnlOnTrade !== null) {
      const avgBuyPrice = holdingsForNAV.find((h: any) => h.symbol === symbol)?.avg_buy_price;
      const realizedPnlPct = avgBuyPrice ? (realizedPnlOnTrade / (Number(avgBuyPrice) * quantity)) * 100 : 0;
      resolveGeminiSellDecisions(portfolioId, symbol, realizedPnlPct).catch(() => null);
    }
    return tradeId;
  }

  const results = await batchWithResults(statements);
  const tradeId = results[0].lastInsertRowid;
  logger.trade(portfolioId, symbol, 'BUY', price, quote?.provider ?? 'unknown', true, reason, { qty: quantity, netAmount });
  // Record signal for adaptive weight learning (fire-and-forget; non-blocking)
  const signalSourceBuy = ctx?.groqSentiment != null ? 'news_sentiment'
    : ctx?.momentumScore != null ? 'momentum'
    : 'technical';
  recordSignalForTracking(portfolioId, symbol, 'BUY', signalSourceBuy, price, new Date().toISOString()).catch(
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
    holdings: hSummaries,
  };
}
