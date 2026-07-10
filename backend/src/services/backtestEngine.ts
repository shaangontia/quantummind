/**
 * backtestEngine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Replays buy/sell signals on 2 years of historical OHLCV data using the same
 * ML stack as the live engine (RSI-14, 52-week range, linear regression momentum).
 *
 * Outputs win/loss outcomes per signal type → used by bootstrapSignalWeights()
 * to initialise signal_weights with historically-learned values.
 */

import { loadSymbolHistory, type OHLCVRow } from './backtestData.js';
import { logger } from '../lib/logger.js';
import { getFundamentalSnapshot, computeFundamentalVerdict } from './fundamentalService.js';

export type SignalType = 'rsi_oversold' | 'momentum_breakout' | 'range_low' | 'combined';

export interface BacktestSignal {
  symbol: string;
  date: string;
  signalType: SignalType;
  entryPrice: number;
  exitPrice: number | null;
  holdDays: number;
  returnPct: number | null;   // null if still open (incomplete data)
  outcome: 'win' | 'loss' | 'open';
}

export interface BacktestSummary {
  signalType: SignalType;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectedValue: number;   // winRate * avgWin - lossRate * avgLoss
}

// ─── Indicator helpers (pure, no external deps) ───────────────────────────────

function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map(d => (d > 0 ? d : 0));
  const losses = deltas.map(d => (d < 0 ? -d : 0));

  let avgGain = gains.slice(0, period).reduce((s, x) => s + x, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, x) => s + x, 0) / period;

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function linearSlope(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = arr.reduce((s, x) => s + x, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (arr[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// Flat ₹5 per trade (platform rate). Backtest uses entry price as proxy for trade value.
// Approximated as a ratio: 5/entryPrice. Applied once at exit (covers both legs).
// TODO: pass quantity when available for exact flat-fee deduction.
const BROKERAGE_FLAT_INR = 5;
const HOLD_DAYS = 10;    // simulate 10-day holding period
const MIN_PRICE = 30;    // same as live engine

// ─── Signal generation on historical data ────────────────────────────────────

function detectSignals(rows: OHLCVRow[]): BacktestSignal[] {
  const signals: BacktestSignal[] = [];
  if (rows.length < 60) return signals;

  const symbol = rows[0].symbol;

  for (let i = 60; i < rows.length - HOLD_DAYS; i++) {
    const window = rows.slice(i - 60, i);
    const closes = window.map(r => r.close);
    const current = rows[i];

    if (current.close < MIN_PRICE) continue;

    const rsi = computeRSI(closes);
    const slope = linearSlope(closes.slice(-20));
    const slopeNorm = Math.tanh(slope * 5000);

    const high52 = Math.max(...closes);
    const low52  = Math.min(...closes);
    const rangePos = high52 === low52 ? 0.5 : (current.close - low52) / (high52 - low52);

    // Signal criteria (mirrors live tradingEngine.ts logic)
    const rsiOversold     = rsi < 35;
    const momentumBreak   = slopeNorm > 0.3;
    const rangeLow        = rangePos < 0.25;

    const exitRow = rows[i + HOLD_DAYS];
    const entryPrice = current.close;
    const exitPrice  = exitRow?.close ?? null;

    const toSignal = (type: SignalType): BacktestSignal => {
      if (exitPrice === null) return { symbol, date: current.date, signalType: type, entryPrice, exitPrice: null, holdDays: HOLD_DAYS, returnPct: null, outcome: 'open' };
      const brokeragePct = (BROKERAGE_FLAT_INR * 2) / entryPrice; // round-trip: buy + sell = ₹10
      const ret = (exitPrice - entryPrice) / entryPrice - brokeragePct;
      return {
        symbol,
        date: current.date,
        signalType: type,
        entryPrice,
        exitPrice,
        holdDays: HOLD_DAYS,
        returnPct: ret,
        outcome: ret > 0 ? 'win' : 'loss',
      };
    };

    if (rsiOversold)   signals.push(toSignal('rsi_oversold'));
    if (momentumBreak) signals.push(toSignal('momentum_breakout'));
    if (rangeLow)      signals.push(toSignal('range_low'));
    if (rsiOversold && momentumBreak) signals.push(toSignal('combined'));
  }

  return signals;
}

// ─── Aggregate to summary per signal type ─────────────────────────────────────

function summarise(signals: BacktestSignal[]): BacktestSummary[] {
  const types: SignalType[] = ['rsi_oversold', 'momentum_breakout', 'range_low', 'combined'];
  return types.map(type => {
    const relevant = signals.filter(s => s.signalType === type && s.outcome !== 'open');
    const wins   = relevant.filter(s => s.outcome === 'win');
    const losses = relevant.filter(s => s.outcome === 'loss');
    const winRate = relevant.length > 0 ? wins.length / relevant.length : 0.5;
    const avgWin  = wins.length   > 0 ? wins.reduce((s, x)   => s + (x.returnPct ?? 0), 0) / wins.length   : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, x) => s + Math.abs(x.returnPct ?? 0), 0) / losses.length : 0;
    const ev = winRate * avgWin - (1 - winRate) * avgLoss;
    return { signalType: type, totalSignals: relevant.length, wins: wins.length, losses: losses.length, winRate, avgWinPct: avgWin * 100, avgLossPct: avgLoss * 100, expectedValue: ev };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run full backtest for a list of symbols.
 * Loads stored OHLCV from Turso (must call fetchAndStoreHistory first).
 * Returns aggregated BacktestSummary per signal type.
 */
export async function runBacktest(symbols: string[]): Promise<{
  summaries: BacktestSummary[];
  totalSignalsProcessed: number;
  symbolsProcessed: number;
}> {
  const allSignals: BacktestSignal[] = [];
  let symbolsProcessed = 0;

  for (const symbol of symbols) {
    try {
      // ── Fundamental filter (look-ahead caveat: uses latest available report) ──
      // Note: historical quarterly data per trade-date is not available via Twelve Data free tier.
      // We use the most recent report as a proxy. Symbols with current fundamental VETO are
      // excluded from backtest — this is conservative and avoids including structurally weak
      // companies in the signal weight calibration dataset.
      try {
        const snapshot = await getFundamentalSnapshot(symbol);
        if (snapshot) {
          const verdict = computeFundamentalVerdict(snapshot);
          if (verdict.vetoed) {
            logger.debug({ reason: `[Backtest] ${symbol}: skipped — fundamental VETO (${verdict.vetoReasons.join('; ')})` });
            continue;
          }
        }
      } catch {
        // Fundamental gate failure: non-blocking, proceed with OHLCV backtest
      }

      const rows = await loadSymbolHistory(symbol);
      if (rows.length < 60) { logger.debug({ reason: `[Backtest] ${symbol}: not enough data (${rows.length} rows)` }); continue; }
      const signals = detectSignals(rows);
      allSignals.push(...signals);
      symbolsProcessed++;
      logger.debug({ reason: `[Backtest] ${symbol}: ${signals.length} signals generated` });
    } catch (err) {
      logger.warn({ reason: `[Backtest] ${symbol}: error — ${err}` });
    }
  }

  const summaries = summarise(allSignals);
  const summaryStr = summaries.map(s => `${s.signalType}: ${(s.winRate * 100).toFixed(1)}% WR`).join(', ');
  logger.info({ reason: `[Backtest] Complete — ${symbolsProcessed} symbols, ${allSignals.length} signals: ${summaryStr}` });
  return { summaries, totalSignalsProcessed: allSignals.length, symbolsProcessed };
}
