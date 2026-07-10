/**
 * QuantumMind Adaptive Engine
 * Implements the self-improvement feedback loop:
 * 1. Signal outcome tracking — measures if each signal led to profit
 * 2. Weight auto-adjustment — boosts accurate signal sources, penalises poor ones
 * 3. Market regime detection — calibrates thresholds to current market conditions
 */

import { query, queryOne, run } from '../db/turso.js';
import { getQuote, getRsi, toNseSymbol } from './marketData.js';

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

export async function getSignalWeights(): Promise<Map<string, SignalWeight>> {
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
  return map;
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
}

// ─── Market Regime Detection ──────────────────────────────────────────────────

export async function detectMarketRegime(): Promise<MarketRegime> {
  // Use NIFTY50 proxy (use Nifty 50 index or HDFC/Reliance as bellwether)
  const [niftyQuote, niftyRsi] = await Promise.all([
    getQuote('NSEI').catch(() => getQuote('RELIANCE.NS')), // NSEI = Nifty50 index
    getRsi('NSEI', 21).catch(() => getRsi('RELIANCE.NS', 21)),
  ]);

  const rsi = niftyRsi ?? 50;
  const changePct = niftyQuote?.changePct ?? 0;

  // Volatility proxy: absolute daily change
  const volatility = Math.abs(changePct);

  let regime: 'BULL' | 'BEAR' | 'SIDEWAYS';
  let rsiBuy: number;
  let rsiSell: number;
  let stopLoss: number;
  let notes: string;

  if (rsi > 60 && changePct > 0) {
    regime = 'BULL';
    // In bull market: be more selective on buys (higher RSI threshold), let winners run
    rsiBuy = 45;     // Buy on slight dips, not just oversold
    rsiSell = 80;    // Let momentum run before selling
    stopLoss = 0.10; // Tighter stop — protect gains
    notes = `Bull market (Nifty RSI ${rsi.toFixed(0)}, +${changePct.toFixed(1)}%): trend-following mode`;
  } else if (rsi < 40 || changePct < -1.5) {
    regime = 'BEAR';
    // In bear market: buy only deeply oversold, sell quickly
    rsiBuy = 28;     // Only buy at extreme oversold
    rsiSell = 60;    // Sell earlier
    stopLoss = 0.06; // Tight stop — capital preservation
    notes = `Bear market (Nifty RSI ${rsi.toFixed(0)}, ${changePct.toFixed(1)}%): defensive mode`;
  } else {
    regime = 'SIDEWAYS';
    // Range-bound: classic mean-reversion
    rsiBuy = 35;
    rsiSell = 68;
    stopLoss = 0.08;
    notes = `Sideways market (Nifty RSI ${rsi.toFixed(0)}): mean-reversion mode`;
  }

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
  const best = weights[0]?.source ?? 'RSI';
  const worst = weights[weights.length - 1]?.source ?? 'RSI';

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
