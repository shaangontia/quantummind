/**
 * ⚠️ DEPRECATED / UNUSED — DO NOT IMPORT.
 *
 * This is an earlier fork of the signal engine. The live scheduler
 * (backend/src/scheduler/marketMonitor.ts) imports generateSignal() from
 * ../tradingEngine.ts, NOT from this file. Nothing in the codebase imports
 * this module (verified via repo-wide grep, 2026-07-22).
 *
 * The two have already drifted apart — e.g. this file triggers a BUY at
 * score ≥2 / STRONG at ≥4, while tradingEngine.ts (the real, live logic)
 * requires ≥3 / ≥5.5, and tradingEngine.ts additionally runs the
 * fundamental gate, EV gate, ML win-probability gate, strategy classifier,
 * and regime gate that this file lacks entirely. Reading this file to
 * understand "how the bot trades" will give you a wrong answer.
 *
 * Left in place (not deleted) per explicit request — kept only as
 * historical reference. See backend/src/services/tradingEngine.ts for the
 * logic that actually runs.
 *
 * ── Original header ──
 * signal.ts — generateSignal(): produces a BUY/SELL/HOLD TradeSignal for a given symbol.
 * Runs all data sources in parallel, scores them, and optionally passes through Gemini veto.
 */
import { getExecutableQuote, getRsi, getSymbolSector } from '../marketData.js';
import { getStockSentiment } from '../newsService.js';
import { getMLBoost, computeTrendIndicators } from '../mlEngine.js';
import { getGroqStockSentiment } from '../groqService.js';
import { getSignalWeights, getCurrentRegime } from '../adaptiveEngine.js';
import { geminiTradeVeto } from '../geminiService.js';
import { getThresholds, applyAdvancedRiskProfile, SECTOR_PE_NORMS, MIN_STOCK_PRICE } from './thresholds.js';
import type { TradeSignal, PortfolioSignalContext } from './types.js';

export { MIN_STOCK_PRICE };

export async function generateSignal(
  symbol: string,
  risk = 'Medium',
  volatilityPref: string | null = null,
  investmentGoal: string | null = null,
  portfolioCtx?: PortfolioSignalContext,
): Promise<TradeSignal | null> {
  try {
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
      console.warn(`[Signal] No valid price for ${symbol} (${q?.price ?? 'null'}) — returning null`);
      return null;
    }
    if (!q.isFresh) {
      console.warn(`[Signal] Stale price for ${symbol} from ${q.provider} — forcing HOLD`);
      return null;
    }

    const rsiVal = rsi.status === 'fulfilled' ? rsi.value : null;
    const sent   = sentiment.status === 'fulfilled' ? sentiment.value : null;
    const ml     = mlBoost.status === 'fulfilled' ? mlBoost.value : null;
    const groq   = groqResult.status === 'fulfilled' ? groqResult.value : null;
    const trend  = trendResult.status === 'fulfilled' ? trendResult.value : null;

    let t = getThresholds(risk);
    const [regime, weights] = await Promise.all([getCurrentRegime().catch(() => null), getSignalWeights().catch(() => new Map())]);
    if (regime) t = { ...t, rsiBuy: regime.rsiBuy, rsiSell: regime.rsiSell, stopLoss: regime.stopLoss };
    if (volatilityPref || investmentGoal) t = applyAdvancedRiskProfile(t, volatilityPref, investmentGoal);

    const w = (src: string) => weights.get(src)?.weight ?? 1.0;
    const notes: string[] = [];
    let buy = 0, sell = 0;

    // ── RSI ────────────────────────────────────────────────────────────────────
    const rsiWeight = w('RSI');
    if (rsiVal !== null) {
      if (rsiVal < t.rsiBuy - 5)   { buy  += 2 * rsiWeight; notes.push(`RSI oversold (${rsiVal.toFixed(1)}) [w=${rsiWeight.toFixed(1)}]`); }
      else if (rsiVal < t.rsiBuy)  { buy  += 1 * rsiWeight; notes.push(`RSI low (${rsiVal.toFixed(1)})`); }
      if (rsiVal > t.rsiSell + 5)  { sell += 2 * rsiWeight; notes.push(`RSI overbought (${rsiVal.toFixed(1)})`); }
      else if (rsiVal > t.rsiSell) { sell += 1 * rsiWeight; notes.push(`RSI high (${rsiVal.toFixed(1)})`); }
    }

    // ── 52-week range ──────────────────────────────────────────────────────────
    if (q.fiftyTwoWeekLow && q.fiftyTwoWeekHigh) {
      const pos = (q.price - q.fiftyTwoWeekLow) / (q.fiftyTwoWeekHigh - q.fiftyTwoWeekLow);
      if (pos < 0.15) { buy += 2; notes.push('Near 52W low'); }
      else if (pos < 0.25) { buy += 1; notes.push('Below 52W midpoint'); }
      if (pos > 0.90) { sell += 1; notes.push('Near 52W high'); }
    }

    // ── Day change ─────────────────────────────────────────────────────────────
    if (q.changePct < -4) { buy  += 1; notes.push(`Day drop ${q.changePct.toFixed(1)}%`); }
    if (q.changePct >  5) { sell += 1; notes.push(`Day surge ${q.changePct.toFixed(1)}%`); }

    // ── Volume confirmation ────────────────────────────────────────────────────
    if (q.volumeRatio !== undefined) {
      const vr = q.volumeRatio;
      if (q.changePct < -2 && vr > 2.0)      { buy  += 1; notes.push(`High-volume dip (${vr.toFixed(1)}x avg) — volume-confirmed entry`); }
      else if (q.changePct > 2 && vr > 2.5)  { sell += 1; notes.push(`High-volume surge (${vr.toFixed(1)}x avg) — distribution risk`); }
      else if (vr < 0.4) {
        if (buy > sell)       { buy  -= 0.5; notes.push(`Low volume (${vr.toFixed(2)}x avg) — weak BUY conviction`); }
        else if (sell > buy)  { sell -= 0.5; notes.push(`Low volume (${vr.toFixed(2)}x avg) — weak SELL conviction`); }
      } else { notes.push(`Volume: ${vr.toFixed(2)}x avg`); }
    }

    // ── Sector-relative P/E ────────────────────────────────────────────────────
    if (q.peRatio !== undefined) {
      const sector = getSymbolSector(symbol);
      const norm = SECTOR_PE_NORMS[sector] ?? SECTOR_PE_NORMS['Other'];
      if (norm.skipPe) {
        notes.push(`P/E: ${q.peRatio?.toFixed(0) ?? 'N/A'}x (${sector} — P/B more relevant, not scored)`);
      } else if (q.peRatio === null || q.peRatio < 0) {
        buy -= 1; notes.push('P/E: loss-making (EPS ≤0) — BUY dampened');
      } else {
        const pe = q.peRatio;
        if (pe > norm.veryExpensive)      { sell += 1; notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — severely overvalued`); }
        else if (pe > norm.expensive)     { buy  -= 1; notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — BUY dampened`); }
        else if (pe < norm.cheap / 2 && pe > 0) { buy += 2; notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — deeply undervalued`); }
        else if (pe < norm.cheap)         { buy  += 1; notes.push(`P/E: ${pe.toFixed(0)}x vs ${sector} norm ~${norm.fair}x — undervalued`); }
        else { notes.push(`P/E: ${pe.toFixed(0)}x (${sector} fair value ~${norm.fair}x)`); }
      }
    }

    // ── Rule-based news sentiment ──────────────────────────────────────────────
    if (sent && sent.score !== 0) {
      if (sent.score >= 2)       { buy  += 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === 1) { buy  += 1; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score <= -2) { sell += 2; notes.push(`NSE: ${sent.label}`); }
      else if (sent.score === -1){ sell += 1; notes.push(`NSE: ${sent.label}`); }
    }

    // ── ML momentum boost ──────────────────────────────────────────────────────
    if (ml && ml.momentumBoost !== 0) {
      if (ml.momentumBoost > 0) { buy  += ml.momentumBoost; notes.push(ml.reason); }
      else                       { sell += Math.abs(ml.momentumBoost); notes.push(ml.reason); }
    }

    // ── MACD + EMA trend filter ────────────────────────────────────────────────
    if (trend) {
      const { macd, emaCrossover } = trend;
      if (macd) {
        if (macd.bullishCrossover)        { buy  += 2; notes.push('MACD: bullish crossover (histogram flipped +)'); }
        else if (macd.bearishCrossover)   { sell += 2; notes.push('MACD: bearish crossover (histogram flipped -)'); }
        else if (macd.latestHistogram > 0){ buy  += 1; notes.push(`MACD: positive histogram (${macd.latestHistogram.toFixed(3)})`); }
        else if (macd.latestHistogram < 0){ sell += 1; notes.push(`MACD: negative histogram (${macd.latestHistogram.toFixed(3)})`); }
      }
      if (emaCrossover) {
        if (emaCrossover.goldenCross)      { buy  += 2; notes.push('EMA: golden cross (EMA20 above EMA50)'); }
        else if (emaCrossover.deathCross)  { sell += 2; notes.push('EMA: death cross (EMA20 below EMA50)'); }
        else if (!emaCrossover.ema20AboveEma50 && rsiVal !== null && rsiVal < t.rsiBuy) {
          buy = Math.max(0, buy - 1); notes.push('EMA trend: bearish (EMA20 < EMA50) — RSI BUY dampened');
        }
      }
    }

    // ── Groq LLM ──────────────────────────────────────────────────────────────
    let groqSentiment: string | undefined;
    if (groq) {
      groqSentiment = `${groq.sentiment}: ${groq.summary}`;
      if (groq.score >= 2)       { buy  += 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === 1) { buy  += 1; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score <= -2) { sell += 2; notes.push(`Groq: ${groq.tradeImplication}`); }
      else if (groq.score === -1){ sell += 1; notes.push(`Groq: ${groq.tradeImplication}`); }
    }

    const reason   = notes.join('; ') || 'No signal';
    const topScore = Math.max(buy, sell);
    const topAction: 'BUY' | 'SELL' | null = buy > sell && buy >= 2 ? 'BUY' : sell > buy && sell >= 2 ? 'SELL' : null;

    // ── Gemini veto gate (STRONG signals only) ────────────────────────────────
    if (topAction && portfolioCtx && topScore >= 4) {
      const veto = await geminiTradeVeto({
        symbol, action: topAction, price: q.price, rsiValue: rsiVal, momentumTrend: ml?.reason, groqSentiment, voteScore: topScore,
        portfolioContext: {
          sectorExposurePct: portfolioCtx.sectorExposurePct,
          positionSizePct: portfolioCtx.proposedPositionPct ?? (portfolioCtx.totalNAV > 0 ? (portfolioCtx.cashBalance * 0.05 / portfolioCtx.totalNAV) * 100 : 5),
          totalHoldings: portfolioCtx.holdings,
          cashBalancePct: portfolioCtx.totalNAV > 0 ? (portfolioCtx.cashBalance / portfolioCtx.totalNAV) * 100 : 100,
        },
      }).catch(() => ({ verdict: 'EXECUTE' as const, reason: '' }));
      if (veto.verdict === 'SKIP') return { symbol, action: 'HOLD', strength: 'WEAK', reason: `Gemini veto: ${veto.reason}`, price: q.price };
      const strength    = veto.verdict === 'REDUCE' ? 'MODERATE' : topScore >= 4 ? 'STRONG' : 'MODERATE';
      const finalReason = veto.reason ? `${reason} | Gemini: ${veto.reason}` : reason;
      return { symbol, action: topAction, strength, reason: finalReason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
    }
    if (topAction) return { symbol, action: topAction, strength: topScore >= 4 ? 'STRONG' : 'MODERATE', reason, price: q.price, mlBoost: ml?.momentumBoost, groqSentiment };
    return { symbol, action: 'HOLD', strength: 'WEAK', reason, price: q.price };
  } catch (err) {
    console.error(`[Signal] Error for ${symbol}:`, err);
    return null;
  }
}
