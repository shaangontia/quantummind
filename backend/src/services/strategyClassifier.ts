/**
 * strategyClassifier.ts — Phase 13: Strategy type classification
 *
 * Classifies each BUY signal into one of four strategy types so that
 * scoring logic and regime-allowed strategy gates can be applied separately.
 *
 * MEAN_REVERSION  — oversold, near 52W low, large drop, volume capitulation
 * MOMENTUM        — EMA golden cross, MACD bullish, above-trend RSI cooling
 * VALUE           — P/E undervalued, strong fundamentals, compressor valuation
 * NEWS_CATALYST   — event-driven: earnings beat, contract win, rating upgrade
 */

export type StrategyType = 'MEAN_REVERSION' | 'MOMENTUM' | 'VALUE' | 'NEWS_CATALYST' | 'MIXED';

export interface SignalClassifierInput {
  rsiVal: number | null;
  rsiBuyThreshold: number;
  near52WLow: boolean;         // price within 15% of 52W low
  dayDropPct: number;          // negative = drop
  volumeRatio: number | null;  // vs 20-day avg
  emaCrossover: boolean;       // EMA20 > EMA50 (golden cross)
  macdBullish: boolean;        // positive histogram or bullish crossover
  peUndervalued: boolean;      // P/E below sector cheap threshold
  fundamentalScore: number | null;
  groqEventType: string | null; // 'earnings' | 'contract' | 'downgrade' | 'none' | null
  groqSentiment: string | null; // 'BULLISH' | 'BEARISH' | 'NEUTRAL'
}

/**
 * Returns the dominant strategy type and a confidence (0–1).
 * Uses vote counts per strategy bucket.
 */
export function classifyStrategy(input: SignalClassifierInput): { type: StrategyType; confidence: number } {
  let mrVotes = 0; // mean reversion
  let moVotes = 0; // momentum
  let vaVotes = 0; // value
  let ncVotes = 0; // news catalyst

  // ── Mean Reversion signals ─────────────────────────────────────────────
  if (input.rsiVal !== null && input.rsiVal < input.rsiBuyThreshold - 5) mrVotes += 2;
  else if (input.rsiVal !== null && input.rsiVal < input.rsiBuyThreshold) mrVotes += 1;
  if (input.near52WLow) mrVotes += 2;
  if (input.dayDropPct < -4) mrVotes += 1;
  if (input.volumeRatio !== null && input.volumeRatio > 1.5 && input.dayDropPct < 0) mrVotes += 1; // capitulation volume

  // ── Momentum signals ──────────────────────────────────────────────────
  if (input.emaCrossover) moVotes += 2;
  if (input.macdBullish) moVotes += 2;
  // RSI cooling from overbought = momentum pullback entry
  if (input.rsiVal !== null && input.rsiVal >= 45 && input.rsiVal <= 60 && input.emaCrossover) moVotes += 1;

  // ── Value signals ─────────────────────────────────────────────────────
  if (input.peUndervalued) vaVotes += 2;
  if (input.fundamentalScore !== null && input.fundamentalScore >= 70) vaVotes += 2;
  else if (input.fundamentalScore !== null && input.fundamentalScore >= 55) vaVotes += 1;

  // ── News Catalyst signals ─────────────────────────────────────────────
  const posEvents = ['earnings_beat', 'contract_win', 'rating_upgrade', 'approval', 'policy_benefit'];
  if (input.groqEventType && posEvents.some(e => input.groqEventType!.toLowerCase().includes(e.split('_')[0]))) {
    ncVotes += 3;
  } else if (input.groqSentiment?.toUpperCase() === 'BULLISH') {
    ncVotes += 1;
  }

  const total = mrVotes + moVotes + vaVotes + ncVotes;
  if (total === 0) return { type: 'MIXED', confidence: 0 };

  const maxVotes = Math.max(mrVotes, moVotes, vaVotes, ncVotes);
  const confidence = maxVotes / total;

  if (maxVotes === mrVotes) return { type: 'MEAN_REVERSION', confidence };
  if (maxVotes === moVotes) return { type: 'MOMENTUM', confidence };
  if (maxVotes === vaVotes) return { type: 'VALUE', confidence };
  return { type: 'NEWS_CATALYST', confidence };
}

/**
 * Check if a strategy type is allowed in the current market regime.
 */
export function isStrategyAllowed(strategyType: StrategyType, allowedStrategies: string[]): boolean {
  if (strategyType === 'MIXED') return false; // never trade mixed/unclear signals
  return allowedStrategies.includes(strategyType);
}
