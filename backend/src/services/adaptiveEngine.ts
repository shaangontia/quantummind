/**
 * QuantumMind Adaptive Engine
 * Implements the self-improvement feedback loop:
 * 1. Signal outcome tracking — measures if each signal led to profit
 * 2. Weight auto-adjustment — boosts accurate signal sources, penalises poor ones
 * 3. Market regime detection — calibrates thresholds to current market conditions
 */

import { query, queryOne, run } from '../db/turso.js';
import { getQuote, getRsi, toNseSymbol } from './marketData.js';
import { classifyMarketRegime as classifyDmaRegime, type MarketRegimeLabel } from './regimeEngine.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignalWeight {
  source: string;
  weight: number;
  winRate: number;
  totalSignals: number;
  winningSignals: number;
}

export interface MarketRegime {
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS';
  nifty50Trend: number;
  nifty50Rsi: number;
  volatilityPct: number;
  // Calibrated thresholds for current regime
  rsiBuy: number;
  rsiSell: number;
  stopLoss: number;
  notes: string;
}

// ─── Signal Weight Management ─────────────────────────────────────────────────

/**
 * Canonical, case-sensitive adaptive-weight source names.
 * P0.1/P0.2 fix (2026-07-22): previously tradingEngine.ts read a weight for
 * 'RSI' (uppercase) while backtestWeights.ts seeded 'rsi' (lowercase) and
 * recordSignalForTracking wrote yet a third set of names — none of them
 * matched, so 5 of 6 advertised "adaptive weights" never affected live
 * scoring. This is now the single source of truth; every scoring block in
 * generateSignal() reads exactly one of these via w(SOURCE).
 * See QuantumMind_Algorithm_Analysis.md §2.1/§2.2 for the full writeup.
 */
export const SIGNAL_SOURCES = {
  TREND_COMPOSITE: 'trend_composite', // blended RSI + MACD + EMA crossover + ML momentum
  PRICE_ACTION:    'price_action',    // 52W range position + day change + volume confirmation
  VALUATION:       'valuation',       // sector-relative P/E
  NEWS_SENTIMENT:  'news_sentiment',  // rule-based NSE announcement keyword scoring
  NEWS_LLM:        'news_llm',        // Groq/Gemini LLM sentiment
} as const;
export type SignalSource = typeof SIGNAL_SOURCES[keyof typeof SIGNAL_SOURCES];
export const ALL_SIGNAL_SOURCES: SignalSource[] = Object.values(SIGNAL_SOURCES);

/**
 * Idempotent table creation + seed, called once at startup from turso.ts
 * runMigrations() (mirrors patternEngine.ensurePatternTables()). This table
 * previously existed only via an untracked manual migration with no CREATE
 * TABLE anywhere in source control.
 */
export async function ensureSignalWeightsTable(): Promise<void> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS signal_weights (
      source          TEXT PRIMARY KEY,
      weight          REAL NOT NULL DEFAULT 1.0,
      win_rate        REAL NOT NULL DEFAULT 0.5,
      total_signals   INTEGER NOT NULL DEFAULT 0,
      winning_signals INTEGER NOT NULL DEFAULT 0,
      last_updated    DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, []);
  } catch (_) { /* already exists */ }

  for (const source of ALL_SIGNAL_SOURCES) {
    await run(
      `INSERT OR IGNORE INTO signal_weights (source, weight, win_rate, total_signals, winning_signals) VALUES (?, 1.0, 0.5, 0, 0)`,
      [source],
    ).catch(() => null);
  }
}

// In-process cache — P2.13 fix (2026-07-22): generateSignal() previously ran
// `SELECT * FROM signal_weights` once per symbol per cycle (dozens of times
// per 5-minute tick against a small, slow-changing table). Short TTL cache,
// same pattern as regimeEngine.ts's regime cache.
const WEIGHTS_CACHE_TTL_MS = 60 * 1000; // 60s — long enough to dedupe within one cycle, short enough to pick up recalibration same-day
let _weightsCache: { data: Map<string, SignalWeight>; ts: number } | null = null;

export async function getSignalWeights(): Promise<Map<string, SignalWeight>> {
  if (_weightsCache && Date.now() - _weightsCache.ts < WEIGHTS_CACHE_TTL_MS) {
    return _weightsCache.data;
  }
  const rows = await query('SELECT * FROM signal_weights');
  const map = new Map<string, SignalWeight>();
  for (const r of rows) {
    map.set(r.source as string, {
      source: r.source as string,
      weight: Number(r.weight),
      winRate: Number(r.win_rate),
      totalSignals: Number(r.total_signals),
      winningSignals: Number(r.winning_signals),
    });
  }
  _weightsCache = { data: map, ts: Date.now() };
  return map;
}

/** Invalidate the in-process weights cache (call after recalibrateWeights()). */
export function invalidateSignalWeightsCache(): void {
  _weightsCache = null;
}

// Record a new signal for outcome tracking
export async function recordSignalForTracking(
  portfolioId: number,
  symbol: string,
  signalType: 'BUY' | 'SELL',
  source: string,
  priceAtSignal: number,
  signalTime: string
): Promise<void> {
  await run(
    'INSERT INTO signal_outcomes (portfolio_id, symbol, signal_type, signal_source, signal_time, price_at_signal) VALUES (?,?,?,?,?,?)',
    [portfolioId, symbol, signalType, source, signalTime, priceAtSignal]
  );
}

// Resolve outcomes for signals that are now 5+ days old
export async function resolveSignalOutcomes(): Promise<void> {
  // Get unresolved signals older than 5 days
  const unresolved = await query(
    `SELECT * FROM signal_outcomes WHERE resolved = 0 AND signal_time <= datetime('now', '-5 days')`
  );

  for (const s of unresolved) {
    const currentQuote = await getQuote(s.symbol as string).catch(() => null);
    if (!currentQuote) continue;

    const priceAt = Number(s.price_at_signal);
    const pnlPct = ((currentQuote.price - priceAt) / priceAt) * 100;
    const signalType = s.signal_type as string;

    // WIN = price went in predicted direction
    const isWin = signalType === 'BUY' ? pnlPct > 1 : pnlPct < -1;
    const outcome = isWin ? 'WIN' : Math.abs(pnlPct) < 1 ? 'NEUTRAL' : 'LOSS';

    await run(
      'UPDATE signal_outcomes SET exit_price=?, exit_time=CURRENT_TIMESTAMP, pnl_pct=?, outcome=?, resolved=1 WHERE id=?',
      [currentQuote.price, pnlPct, outcome, s.id]
    );

    // Update signal weight for this source
    if (outcome !== 'NEUTRAL') {
      await run(
        `UPDATE signal_weights SET
          total_signals = total_signals + 1,
          winning_signals = winning_signals + ?,
          win_rate = CAST(winning_signals + ? AS REAL) / (total_signals + 1),
          last_updated = CURRENT_TIMESTAMP
        WHERE source = ?`,
        [isWin ? 1 : 0, isWin ? 1 : 0, s.signal_source]
      );
    }
  }

  // Recalibrate weights based on updated win rates
  await recalibrateWeights();
  console.log(`[Adaptive] Resolved ${unresolved.length} signal outcomes`);
}

// Recalibrate signal weights based on win rates with confidence dampening.
// Formula: effective_weight = base_weight × confidence_factor
//   base_weight      = max(0.3, min(2.0, (win_rate - 0.5) × 4 + 1.0))
//   confidence_factor = min(1.0, resolved_count / FULL_CONFIDENCE_THRESHOLD)
//
// Effect: after only 5 outcomes the model barely moves from 1.0.
// After 50+ outcomes it adapts at full speed. Prevents overfitting on small samples.
const FULL_CONFIDENCE_THRESHOLD = 50; // outcomes needed for full weight adjustment

async function recalibrateWeights(): Promise<void> {
  const rows = await query('SELECT * FROM signal_weights WHERE total_signals >= 5');

  for (const r of rows) {
    const winRate = Number(r.win_rate);
    const totalSignals = Number(r.total_signals);

    const baseWeight = Math.max(0.3, Math.min(2.0, (winRate - 0.5) * 4 + 1.0));

    // Confidence dampening: new sources stay near 1.0 until enough data accumulates
    const confidenceFactor = Math.min(1.0, totalSignals / FULL_CONFIDENCE_THRESHOLD);
    // Damped weight = 1.0 (neutral) + confidenceFactor × (baseWeight - 1.0)
    const dampedWeight = 1.0 + confidenceFactor * (baseWeight - 1.0);
    const newWeight = Math.max(0.3, Math.min(2.0, dampedWeight));

    console.log(`[Adaptive] ${r.source}: winRate=${(winRate*100).toFixed(1)}% n=${totalSignals} base=${baseWeight.toFixed(2)} confidence=${(confidenceFactor*100).toFixed(0)}% → weight=${newWeight.toFixed(3)}`);
    await run('UPDATE signal_weights SET weight = ? WHERE source = ?', [newWeight, r.source]);
  }
  invalidateSignalWeightsCache();
}

// ─── Market Regime Detection ──────────────────────────────────────────────────

/** Maps regimeEngine's DMA-based label onto this module's legacy BULL/BEAR/SIDEWAYS naming. */
const REGIME_LABEL_MAP: Record<MarketRegimeLabel, 'BULL' | 'BEAR' | 'SIDEWAYS'> = {
  BULLISH: 'BULL',
  NEUTRAL: 'SIDEWAYS',
  BEARISH: 'BEAR',
};

/**
 * P0.3 fix (2026-07-22): this function previously classified its own
 * BULL/BEAR/SIDEWAYS regime independently from Nifty RSI + day change, while
 * regimeEngine.classifyMarketRegime() separately classified
 * BULLISH/NEUTRAL/BEARISH from 50/200-day moving averages — two parallel
 * regime systems, computed from different underlying signals, that could
 * (and did) disagree in the same trading cycle. E.g. this RSI-based logic
 * could say BULL (wider stop-loss tolerance, more permissive RSI buy
 * threshold) in the same cycle regimeEngine said BEARISH (restricting
 * trading to VALUE-only strategies and cutting position size to 40%),
 * because a short-term RSI pop and a sub-200-DMA downtrend are not
 * contradictory facts about the market — but the two engines never talked to
 * each other about it. See QuantumMind_Algorithm_Analysis.md §2.3.
 *
 * regimeEngine's 50/200-DMA classification (the more standard,
 * harder-to-whipsaw signal) is now the single authoritative regime label.
 * The Nifty-RSI/day-change read below no longer produces a competing
 * classification — it only nudges the threshold numbers *within* whatever
 * regime regimeEngine has already decided we're in.
 */
export async function detectMarketRegime(): Promise<MarketRegime> {
  const [dmaRegime, niftyQuote, niftyRsi] = await Promise.all([
    classifyDmaRegime().catch(() => null),
    getQuote('NSEI').catch(() => getQuote('RELIANCE.NS')), // NSEI = Nifty50 index
    getRsi('NSEI', 21).catch(() => getRsi('RELIANCE.NS', 21)),
  ]);

  const rsi = niftyRsi ?? 50;
  const changePct = niftyQuote?.changePct ?? 0;

  // Volatility proxy: absolute daily change
  const volatility = Math.abs(changePct);

  // Authoritative label from the DMA-based classifier. Fall back to the old
  // RSI-only heuristic only when regimeEngine has no data at all yet (e.g. a
  // fresh DB with fewer than 51 days of index_prices history).
  const authoritativeLabel: MarketRegimeLabel = dmaRegime?.label
    ?? (rsi > 60 && changePct > 0 ? 'BULLISH' : (rsi < 40 || changePct < -1.5) ? 'BEARISH' : 'NEUTRAL');
  const regime = REGIME_LABEL_MAP[authoritativeLabel];

  // Base thresholds by authoritative regime — same numbers this function
  // used before the fix, just now keyed off the DMA-based label.
  let rsiBuy: number, rsiSell: number, stopLoss: number, baseDesc: string;
  if (regime === 'BULL') {
    rsiBuy = 45; rsiSell = 80; stopLoss = 0.10;
    baseDesc = `Bull market (${authoritativeLabel} — Nifty vs 50/200 DMA: ${dmaRegime?.niftyVs50Dma ?? 'n/a'}/${dmaRegime?.niftyVs200Dma ?? 'n/a'}): trend-following mode`;
  } else if (regime === 'BEAR') {
    rsiBuy = 28; rsiSell = 60; stopLoss = 0.06;
    baseDesc = `Bear market (${authoritativeLabel} — Nifty vs 50/200 DMA: ${dmaRegime?.niftyVs50Dma ?? 'n/a'}/${dmaRegime?.niftyVs200Dma ?? 'n/a'}): defensive mode`;
  } else {
    rsiBuy = 35; rsiSell = 68; stopLoss = 0.08;
    baseDesc = `Sideways market (${authoritativeLabel}): mean-reversion mode`;
  }

  // Within-regime strength modifier: nudge (not override) the thresholds
  // based on how far Nifty RSI sits from neutral (50). Capped at ±3 RSI
  // points and ±1pp stop-loss so a strong/weak RSI reading inside the
  // current regime can still matter without ever flipping the regime itself.
  const strength = Math.max(-1, Math.min(1, (rsi - 50) / 25)); // -1..+1
  rsiBuy = Math.round(rsiBuy + strength * 3);
  rsiSell = Math.round(rsiSell + strength * 3);
  stopLoss = Math.max(0.03, Math.min(0.15, stopLoss + strength * 0.01));

  const notes = `${baseDesc} (Nifty RSI ${rsi.toFixed(0)}, ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%, strength modifier ${(strength * 100).toFixed(0)}%)`;

  // Persist regime snapshot
  await run(
    `INSERT INTO market_regime (regime, nifty50_trend, nifty50_rsi, volatility_pct, recommended_rsi_buy, recommended_rsi_sell, recommended_stop_loss, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
    [regime, changePct, rsi, volatility, rsiBuy, rsiSell, stopLoss, notes]
  );

  return { regime, nifty50Trend: changePct, nifty50Rsi: rsi, volatilityPct: volatility, rsiBuy, rsiSell, stopLoss, notes };
}

// Get latest regime (or detect fresh if none today)
export async function getCurrentRegime(): Promise<MarketRegime> {
  const today = await queryOne(
    `SELECT * FROM market_regime WHERE snapshot_date = date('now') ORDER BY id DESC LIMIT 1`
  );

  if (today) {
    return {
      regime: today.regime as 'BULL' | 'BEAR' | 'SIDEWAYS',
      nifty50Trend: Number(today.nifty50_trend),
      nifty50Rsi: Number(today.nifty50_rsi),
      volatilityPct: Number(today.volatility_pct),
      rsiBuy: Number(today.recommended_rsi_buy),
      rsiSell: Number(today.recommended_rsi_sell),
      stopLoss: Number(today.recommended_stop_loss),
      notes: today.notes as string,
    };
  }

  return await detectMarketRegime();
}

// ─── Adaptive Learning Summary (for API / UI) ─────────────────────────────────

export interface AdaptiveLearningReport {
  regime: MarketRegime;
  signalWeights: SignalWeight[];
  recentOutcomes: { source: string; outcome: string; pnlPct: number; symbol: string }[];
  bestPerformingSource: string;
  worstPerformingSource: string;
}

export async function getAdaptiveLearningReport(): Promise<AdaptiveLearningReport> {
  const [regime, weightsMap, recentRows] = await Promise.all([
    getCurrentRegime(),
    getSignalWeights(),
    query(`SELECT * FROM signal_outcomes WHERE resolved = 1 ORDER BY exit_time DESC LIMIT 20`),
  ]);

  const weights = Array.from(weightsMap.values()).sort((a, b) => b.weight - a.weight);
  const best = weights[0]?.source ?? SIGNAL_SOURCES.TREND_COMPOSITE;
  const worst = weights[weights.length - 1]?.source ?? SIGNAL_SOURCES.TREND_COMPOSITE;

  const recentOutcomes = recentRows.map((r: any) => ({
    source: r.signal_source as string,
    outcome: r.outcome as string,
    pnlPct: Number(r.pnl_pct),
    symbol: r.symbol as string,
  }));

  return { regime, signalWeights: weights, recentOutcomes, bestPerformingSource: best, worstPerformingSource: worst };
}

// ─── Gemini Accuracy Tracking ─────────────────────────────────────────────────

export interface GeminiAccuracy {
  decisionType: string;
  totalDecisions: number;
  resolvedDecisions: number;
  winRate: number;         // % of Gemini-influenced trades that were profitable
  currentWeight: number;  // 0.5–2.0, adjusts Gemini's influence on signal scores
}

/**
 * Compute Gemini's accuracy per decision type from the gemini_decisions table.
 * Called during the weekly adaptive weight bootstrap.
 *
 * Weight formula:
 *   winRate > 0.70 → weight 1.5 (increase influence)
 *   winRate 0.50–0.70 → weight 1.0 (neutral)
 *   winRate < 0.40 → weight 0.6 (reduce influence)
 *   < 10 resolved decisions → weight 1.0 (not enough data)
 */
export async function computeGeminiAccuracy(): Promise<GeminiAccuracy[]> {
  const rows = await query(`
    SELECT
      decision_type,
      COUNT(*) as total,
      SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) as wins
    FROM gemini_decisions
    GROUP BY decision_type
  `);

  const results: GeminiAccuracy[] = [];

  for (const row of rows) {
    const total = Number(row.total ?? 0);
    const resolved = Number(row.resolved ?? 0);
    const wins = Number(row.wins ?? 0);
    const winRate = resolved > 0 ? wins / resolved : 0.5;

    let weight = 1.0;
    if (resolved >= 10) {
      if (winRate > 0.70) weight = 1.5;
      else if (winRate < 0.40) weight = 0.6;
    }

    results.push({
      decisionType: String(row.decision_type),
      totalDecisions: total,
      resolvedDecisions: resolved,
      winRate,
      currentWeight: weight,
    });

    // Persist weight into signal_weights so generateSignal() can read it
    const weightKey = `gemini_${row.decision_type}_weight`;
    await queryOne('INSERT OR REPLACE INTO signal_weights (source, weight) VALUES (?, ?)', [weightKey, weight])
      .catch(() => null); // silent if table schema doesn't support it yet
  }

  return results;
}

/**
 * Mark Gemini sell decisions as 'win' or 'loss' based on trade outcome.
 * Called after every SELL trade executes.
 */
export async function resolveGeminiSellDecisions(
  portfolioId: number,
  symbol: string,
  realizedPnlPct: number,
): Promise<void> {
  const outcome = realizedPnlPct > 0 ? 'win' : 'loss';
  await queryOne(
    `UPDATE gemini_decisions SET outcome = ?, realized_pnl_pct = ?
     WHERE portfolio_id = ? AND symbol = ? AND decision_type = 'sell_review' AND outcome IS NULL`,
    [outcome, realizedPnlPct, portfolioId, symbol],
  ).catch(() => null);
}

// ─── Sector-Level Accuracy Tracking ──────────────────────────────────────────

export interface SectorPerformance {
  sector: string;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  /** 0.85–1.20× — applied per-sector to bias signal scoring toward proven sectors */
  sectorWeight: number;
}

/**
 * Compute win rate and adaptive weight per sector from resolved signal_patterns.
 * Requires ≥8 resolved BUY trades per sector before activating learned weight.
 * Persists weights in signal_weights as `sector_<name>_weight`.
 *
 * Weight bands:
 *   winRate > 0.60  → 1.20× (sector outperforms historically)
 *   winRate 0.45–0.60 → 1.00× (neutral)
 *   winRate < 0.45  → 0.85× (underperforming sector — reduce exposure bias)
 */
export async function computeSectorAccuracy(): Promise<SectorPerformance[]> {
  const rows = await query(
    `SELECT sector,
            SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)  AS wins,
            SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses,
            AVG(CASE WHEN outcome='WIN'  THEN realized_pnl_pct ELSE NULL END) AS avgWinPct,
            AVG(CASE WHEN outcome='LOSS' THEN realized_pnl_pct ELSE NULL END) AS avgLossPct
     FROM signal_patterns
     WHERE action='BUY' AND outcome IS NOT NULL AND sector IS NOT NULL AND sector != ''
     GROUP BY sector
     ORDER BY wins DESC`,
    [],
  );

  const results: SectorPerformance[] = [];

  for (const row of rows) {
    const wins   = Number(row.wins   ?? 0);
    const losses = Number(row.losses ?? 0);
    const total  = wins + losses;
    if (total === 0) continue;

    const winRate    = wins / total;
    const avgWinPct  = Number(row.avgWinPct  ?? 0);
    const avgLossPct = Number(row.avgLossPct ?? 0);

    // Only activate learned weight at ≥8 resolved sector trades to prevent overfitting
    let sectorWeight = 1.0;
    if (total >= 8) {
      if (winRate > 0.60)       sectorWeight = 1.20;
      else if (winRate < 0.45)  sectorWeight = 0.85;
    }

    const sector = String(row.sector);
    results.push({ sector, wins, losses, winRate, avgWinPct, avgLossPct, sectorWeight });

    const key = `sector_${sector.toLowerCase().replace(/[^a-z0-9]/g, '_')}_weight`;
    await run(
      'INSERT OR REPLACE INTO signal_weights (source, weight) VALUES (?, ?)',
      [key, sectorWeight],
    ).catch(() => null);
  }

  return results;
}

/**
 * Retrieve the current sector weight for a given sector name.
 * Falls back to 1.0 (neutral) when no data or insufficient sample size.
 */
export async function getSectorWeight(sector: string): Promise<number> {
  if (!sector) return 1.0;
  const key = `sector_${sector.toLowerCase().replace(/[^a-z0-9]/g, '_')}_weight`;
  const row = await queryOne('SELECT weight FROM signal_weights WHERE source=?', [key]).catch(() => null);
  return row ? Math.max(0.85, Math.min(1.20, Number(row.weight))) : 1.0;
}

// ─── Multi-Signal Consensus Multiplier ───────────────────────────────────────

export interface ConsensusInput {
  rsiSignal:        'bullish' | 'bearish' | 'neutral';
  macdSignal:       'bullish' | 'bearish' | 'neutral';
  momentumSignal:   'bullish' | 'bearish' | 'neutral';
  newsSignal:       'bullish' | 'bearish' | 'neutral';
  volumeSignal:     'bullish' | 'bearish' | 'neutral';
  fundamentalScore: number;  // 0–100; ≥55 = bullish vote, <35 = bearish vote
}

/**
 * Compute a consensus multiplier (0.92–1.12×) based on real-time independent signal agreement.
 *
 * Unlike patternEngine.getPatternConfidence() which looks at HISTORICAL outcomes,
 * this function measures how many independent signals agree with the BUY direction RIGHT NOW.
 *
 * Bounded to [0.92, 1.12] to remain additive with patternConfidence [0.9, 1.15].
 * Worst-case combined ceiling: 1.12 × 1.15 = 1.288 (vs old single multiplier 1.4).
 *
 * Thresholds:
 *   ≥5 bullish votes → 1.12×  (near-unanimous)
 *   ≥4 bullish votes → 1.08×
 *   ≥3 bullish, ≤1 bearish → 1.04×
 *   majority bearish (net < −25%) → 0.92× (counter-consensus penalty)
 *   otherwise → 1.0× (neutral / mixed)
 */
export function computeConsensusMultiplier(input: ConsensusInput): number {
  const { rsiSignal, macdSignal, momentumSignal, newsSignal, fundamentalScore, volumeSignal } = input;

  let bullishCount = 0;
  let bearishCount = 0;

  const vote = (sig: string) => {
    if (sig === 'bullish') bullishCount++;
    else if (sig === 'bearish') bearishCount++;
  };
  vote(rsiSignal);
  vote(macdSignal);
  vote(momentumSignal);
  vote(newsSignal);
  vote(volumeSignal);
  // Fundamental score as directional vote
  if (fundamentalScore >= 55) bullishCount++;
  else if (fundamentalScore < 35) bearishCount++;

  const total = bullishCount + bearishCount;
  if (total === 0) return 1.0;

  const netBullishRatio = (bullishCount - bearishCount) / total;

  if (bullishCount >= 5)                          return 1.12;
  if (bullishCount >= 4)                          return 1.08;
  if (bullishCount >= 3 && bearishCount <= 1)     return 1.04;
  if (netBullishRatio < -0.25)                    return 0.92;
  return 1.0;
}
