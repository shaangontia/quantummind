/**
 * strategyClassifier.ts — Phase 13 (updated Phase 19)
 *
 * Classifies each BUY signal into one of five strategy types so that
 * scoring logic and regime-allowed strategy gates can be applied separately.
 *
 * MEAN_REVERSION  — oversold, near 52W low, large drop, volume capitulation
 * MOMENTUM        — EMA golden cross, MACD bullish, above-trend RSI cooling
 * VALUE           — P/E undervalued, strong fundamentals, compressor valuation
 * NEWS_CATALYST   — event-driven: earnings beat, contract win, rating upgrade
 * MIXED           — multiple strategies score equally; primary is ambiguous
 * UNKNOWN         — insufficient features to classify; allowed for logging only
 *
 * Phase 19 additions:
 *   - UNKNOWN type for insufficient-data cases
 *   - reasonCodes[] for audit and policy evaluation
 *   - classifierVersion for backfill tracking
 *   - strategy_source: REAL_TIME_CLASSIFIER | INFERRED_BACKFILL
 */

export type StrategyType = 'MEAN_REVERSION' | 'MOMENTUM' | 'VALUE' | 'NEWS_CATALYST' | 'MIXED' | 'UNKNOWN';

/** Current classifier version — bump when rules change (used for audit/backfill tracking) */
export const CLASSIFIER_VERSION = 'v1.1.0';

export type StrategySource = 'REAL_TIME_CLASSIFIER' | 'INFERRED_BACKFILL';

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

export interface StrategyClassification {
  strategyType: StrategyType;
  confidence: number;       // 0..1
  reasonCodes: string[];    // machine-readable signals that drove the classification
  classifierVersion: string;
  source: StrategySource;
}

/**
 * Returns the dominant strategy type, confidence (0–1), and reason codes.
 * Uses vote counts per strategy bucket.
 *
 * reason codes follow the pattern: SIGNAL_NAME (e.g. RSI_OVERSOLD, MACD_BULLISH)
 * stored as strategy_reason_codes_json in trade_candidates.
 */
export function classifyStrategy(
  input: SignalClassifierInput,
  source: StrategySource = 'REAL_TIME_CLASSIFIER',
): StrategyClassification {
  let mrVotes = 0; // mean reversion
  let moVotes = 0; // momentum
  let vaVotes = 0; // value
  let ncVotes = 0; // news catalyst
  const reasons: string[] = [];

  // ── Mean Reversion signals ─────────────────────────────────────────────
  if (input.rsiVal !== null && input.rsiVal < input.rsiBuyThreshold - 5) {
    mrVotes += 2; reasons.push('RSI_DEEPLY_OVERSOLD');
  } else if (input.rsiVal !== null && input.rsiVal < input.rsiBuyThreshold) {
    mrVotes += 1; reasons.push('RSI_OVERSOLD');
  }
  if (input.near52WLow) { mrVotes += 2; reasons.push('NEAR_52W_LOW'); }
  if (input.dayDropPct < -4) { mrVotes += 1; reasons.push('DAY_DROP_HIGH'); }
  if (input.volumeRatio !== null && input.volumeRatio > 1.5 && input.dayDropPct < 0) {
    mrVotes += 1; reasons.push('VOLUME_SPIKE_ON_DIP'); // capitulation volume
  }

  // ── Momentum signals ──────────────────────────────────────────────────
  if (input.emaCrossover) { moVotes += 2; reasons.push('EMA_GOLDEN_CROSS'); }
  if (input.macdBullish)  { moVotes += 2; reasons.push('MACD_BULLISH'); }
  // RSI cooling from overbought = momentum pullback entry
  if (input.rsiVal !== null && input.rsiVal >= 45 && input.rsiVal <= 60 && input.emaCrossover) {
    moVotes += 1; reasons.push('MOMENTUM_PULLBACK_ENTRY');
  }

  // ── Value signals ─────────────────────────────────────────────────────
  if (input.peUndervalued) { vaVotes += 2; reasons.push('PE_UNDERVALUED'); }
  if (input.fundamentalScore !== null && input.fundamentalScore >= 70) {
    vaVotes += 2; reasons.push('FUNDAMENTAL_STRONG');
  } else if (input.fundamentalScore !== null && input.fundamentalScore >= 55) {
    vaVotes += 1; reasons.push('FUNDAMENTAL_ACCEPTABLE');
  }

  // ── News Catalyst signals ─────────────────────────────────────────────
  const posEvents = ['earnings_beat', 'contract_win', 'rating_upgrade', 'approval', 'policy_benefit'];
  if (input.groqEventType && posEvents.some(e => input.groqEventType!.toLowerCase().includes(e.split('_')[0]))) {
    ncVotes += 3; reasons.push('POSITIVE_NEWS_EVENT');
  } else if (input.groqSentiment?.toUpperCase() === 'BULLISH') {
    ncVotes += 1; reasons.push('BULLISH_SENTIMENT');
  }
  if (input.volumeRatio !== null && input.volumeRatio > 2.0) {
    ncVotes += 1; reasons.push('VOLUME_EXPANSION');
  }

  const total = mrVotes + moVotes + vaVotes + ncVotes;

  // Insufficient features — return UNKNOWN
  if (total === 0) {
    return {
      strategyType: 'UNKNOWN',
      confidence: 0,
      reasonCodes: [],
      classifierVersion: CLASSIFIER_VERSION,
      source,
    };
  }

  const maxVotes = Math.max(mrVotes, moVotes, vaVotes, ncVotes);
  const confidence = maxVotes / total;

  // MIXED: two strategies within 1 vote of each other and both ≥ 2 votes
  const sortedVotes = [mrVotes, moVotes, vaVotes, ncVotes].sort((a, b) => b - a);
  if (sortedVotes[0] >= 2 && sortedVotes[1] >= 2 && sortedVotes[0] - sortedVotes[1] <= 1) {
    return {
      strategyType: 'MIXED',
      confidence,
      reasonCodes: reasons,
      classifierVersion: CLASSIFIER_VERSION,
      source,
    };
  }

  let strategyType: StrategyType;
  if (maxVotes === mrVotes) strategyType = 'MEAN_REVERSION';
  else if (maxVotes === moVotes) strategyType = 'MOMENTUM';
  else if (maxVotes === vaVotes) strategyType = 'VALUE';
  else strategyType = 'NEWS_CATALYST';

  return { strategyType, confidence, reasonCodes: reasons, classifierVersion: CLASSIFIER_VERSION, source };
}

/**
 * Check if a strategy type is allowed in the current market regime.
 * MIXED and UNKNOWN signals are never traded directly.
 */
export function isStrategyAllowed(strategyType: StrategyType, allowedStrategies: string[]): boolean {
  if (strategyType === 'MIXED' || strategyType === 'UNKNOWN') return false;
  return allowedStrategies.includes(strategyType);
}
