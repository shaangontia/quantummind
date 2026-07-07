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
      'UPDATE signal_outcomes SET exit_price=?, exit_time=datetime("now"), pnl_pct=?, outcome=?, resolved=1 WHERE id=?',
      [currentQuote.price, pnlPct, outcome, s.id]
    );

    // Update signal weight for this source
    if (outcome !== 'NEUTRAL') {
      await run(
        `UPDATE signal_weights SET
          total_signals = total_signals + 1,
          winning_signals = winning_signals + ?,
          win_rate = CAST(winning_signals + ? AS REAL) / (total_signals + 1),
          last_updated = datetime('now')
        WHERE source = ?`,
        [isWin ? 1 : 0, isWin ? 1 : 0, s.signal_source]
      );
    }
  }

  // Recalibrate weights based on updated win rates
  await recalibrateWeights();
  console.log(`[Adaptive] Resolved ${unresolved.length} signal outcomes`);
}

// Recalibrate signal weights based on win rates
async function recalibrateWeights(): Promise<void> {
  const rows = await query('SELECT * FROM signal_weights WHERE total_signals >= 5');

  for (const r of rows) {
    const winRate = Number(r.win_rate);
    // Weight = 0.5 baseline, scales 0.3–2.0 based on win rate
    // win_rate 0.70 → weight 1.8, win_rate 0.40 → weight 0.4
    const newWeight = Math.max(0.3, Math.min(2.0, (winRate - 0.5) * 4 + 1.0));
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
