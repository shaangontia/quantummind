/**
 * QuantumMind ML Engine
 * Pure TypeScript ML - no external dependencies.
 * Provides: linear regression, momentum scoring,
 * volatility calculation, Kelly Criterion sizing,
 * and correlation-aware signal boosting.
 */

import https from 'https';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function covariance(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / a.length;
}

function correlation(a: number[], b: number[]): number {
  const sa = stdDev(a), sb = stdDev(b);
  if (sa === 0 || sb === 0) return 0;
  return covariance(a, b) / (sa * sb);
}

// Simple linear regression → slope (trend direction & magnitude)
function linearRegressionSlope(y: number[]): number {
  const n = y.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const mx = mean(x), my = mean(y);
  const num = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0);
  const den = x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

// ─── Historical data fetching ─────────────────────────────────────────────────

function yahooGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (x: Buffer) => { d += x; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

export async function getHistoricalReturns(symbol: string, days = 60): Promise<number[]> {
  const sym = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
  const json = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`);
  const closes: number[] = (json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
    .filter((c: any) => c !== null)
    .slice(-days);

  if (closes.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return returns;
}

// ─── ML Features ─────────────────────────────────────────────────────────────

export interface MomentumScore {
  symbol: string;
  score: number;          // -1 to +1, normalised
  trend: 'UP' | 'DOWN' | 'FLAT';
  volatility: number;     // annualised σ
  sharpeEstimate: number; // estimated Sharpe (daily returns × √252 / σ)
  lookbackDays: number;
}

export async function computeMomentumScore(symbol: string): Promise<MomentumScore | null> {
  try {
    const returns = await getHistoricalReturns(symbol, 60);
    if (returns.length < 10) return null;

    const slope = linearRegressionSlope(returns);              // trend direction
    const vol = stdDev(returns) * Math.sqrt(252);              // annualised volatility
    const avgReturn = mean(returns) * 252;                     // annualised return
    const sharpe = vol > 0 ? avgReturn / vol : 0;

    // Normalise slope to [-1, +1] using tanh
    const score = Math.tanh(slope * 5000);
    const trend = score > 0.1 ? 'UP' : score < -0.1 ? 'DOWN' : 'FLAT';

    return { symbol, score, trend, volatility: vol, sharpeEstimate: sharpe, lookbackDays: returns.length };
  } catch {
    return null;
  }
}

// ─── Kelly Criterion position sizing ─────────────────────────────────────────

export interface KellyResult {
  symbol: string;
  kellyFraction: number;   // raw Kelly fraction (0–1)
  adjustedFraction: number; // half-Kelly, capped at maxPosPct
  recommendedPct: number;  // % of portfolio to allocate
}

export function kellyPositionSize(
  winRate: number,      // probability of winning trade
  avgWin: number,       // average gain on winning trade
  avgLoss: number,      // average loss on losing trade (positive number)
  maxPosPct = 0.08      // position cap
): number {
  if (avgLoss === 0) return 0;
  const b = avgWin / avgLoss;
  const q = 1 - winRate;
  const kelly = (b * winRate - q) / b;
  // Half-Kelly for safety, capped at maxPosPct
  return Math.max(0, Math.min(maxPosPct, kelly * 0.5));
}

export async function computeKellySize(symbol: string, maxPosPct = 0.08): Promise<KellyResult> {
  const returns = await getHistoricalReturns(symbol, 90);
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0);

  const winRate = wins.length / Math.max(returns.length, 1);
  const avgWin = wins.length > 0 ? mean(wins) : 0.01;
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses)) : 0.01;

  const kelly = kellyPositionSize(winRate, avgWin, avgLoss, maxPosPct);
  return {
    symbol,
    kellyFraction: (avgWin / avgLoss * winRate - (1 - winRate)) / (avgWin / avgLoss),
    adjustedFraction: kelly,
    recommendedPct: kelly * 100,
  };
}

// ─── Correlation matrix ───────────────────────────────────────────────────────

export interface CorrelationResult {
  pairs: { symbolA: string; symbolB: string; correlation: number; warning: boolean }[];
  overCorrelated: string[][]; // groups of correlated stocks (>0.8)
}

export async function computeCorrelationMatrix(symbols: string[]): Promise<CorrelationResult> {
  const returnsMap = new Map<string, number[]>();

  await Promise.all(symbols.map(async (s) => {
    const r = await getHistoricalReturns(s, 60).catch(() => []);
    if (r.length > 10) returnsMap.set(s, r);
  }));

  const syms = Array.from(returnsMap.keys());
  const pairs: CorrelationResult['pairs'] = [];
  const overCorrelated: string[][] = [];

  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const a = returnsMap.get(syms[i])!;
      const b = returnsMap.get(syms[j])!;
      const minLen = Math.min(a.length, b.length);
      const corr = correlation(a.slice(-minLen), b.slice(-minLen));
      const warning = Math.abs(corr) > 0.80;
      pairs.push({ symbolA: syms[i], symbolB: syms[j], correlation: corr, warning });
      if (warning) overCorrelated.push([syms[i], syms[j]]);
    }
  }

  return { pairs, overCorrelated };
}

// ─── Combined ML signal boost ─────────────────────────────────────────────────

export interface MLSignalBoost {
  symbol: string;
  momentumBoost: number;    // +1, 0, or -1 added to existing signal score
  kellyMaxPos: number;      // recommended max position % from Kelly
  reason: string;
}

export async function getMLBoost(symbol: string, riskTolerance = 'Medium'): Promise<MLSignalBoost> {
  const maxPosPct = riskTolerance === 'High' ? 0.08 : riskTolerance === 'Low' ? 0.03 : 0.05;

  const [momentum, kelly] = await Promise.all([
    computeMomentumScore(symbol).catch(() => null),
    computeKellySize(symbol, maxPosPct).catch(() => ({ recommendedPct: maxPosPct * 100, adjustedFraction: maxPosPct })),
  ]);

  let boost = 0;
  const reasons: string[] = [];

  if (momentum) {
    if (momentum.trend === 'UP' && momentum.score > 0.3) {
      boost += 1;
      reasons.push(`ML momentum: ${(momentum.score * 100).toFixed(0)} (UP, Sharpe ${momentum.sharpeEstimate.toFixed(2)})`);
    } else if (momentum.trend === 'DOWN' && momentum.score < -0.3) {
      boost -= 1;
      reasons.push(`ML momentum: bearish trend (score ${(momentum.score * 100).toFixed(0)})`);
    }
  }

  return {
    symbol,
    momentumBoost: boost,
    kellyMaxPos: kelly.adjustedFraction,
    reason: reasons.join('; ') || 'ML: neutral',
  };
}

// ─── MACD + EMA Trend Indicators ─────────────────────────────────────────────

/**
 * Exponential Moving Average (EMA) over an array of prices.
 * Uses standard smoothing factor: k = 2 / (period + 1)
 */
export function computeEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  // Seed with simple average of first `period` values
  let prev = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  ema.push(prev);
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

export interface MACDResult {
  macdLine: number[];     // EMA(12) - EMA(26)
  signalLine: number[];   // EMA(9) of macdLine
  histogram: number[];    // macdLine - signalLine
  latestMACD: number;
  latestSignal: number;
  latestHistogram: number;
  /** true if histogram just flipped from negative to positive (bullish crossover) */
  bullishCrossover: boolean;
  /** true if histogram just flipped from positive to negative (bearish crossover) */
  bearishCrossover: boolean;
}

export function computeMACD(prices: number[]): MACDResult | null {
  if (prices.length < 35) return null; // need at least EMA26 + EMA9 warmup
  const ema12 = computeEMA(prices, 12);
  const ema26 = computeEMA(prices, 26);
  // Align: ema12 has more values than ema26 by 14; trim ema12 to match ema26
  const offset = ema12.length - ema26.length;
  const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
  const signalLine = computeEMA(macdLine, 9);
  // Align signal to macdLine end
  const sigOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((v, i) => macdLine[i + sigOffset] - v);

  const len = histogram.length;
  if (len < 2) return null;

  const latestHistogram  = histogram[len - 1];
  const prevHistogram    = histogram[len - 2];
  const latestMACD       = macdLine[macdLine.length - 1];
  const latestSignal     = signalLine[len - 1];

  return {
    macdLine, signalLine, histogram,
    latestMACD, latestSignal, latestHistogram,
    bullishCrossover: prevHistogram < 0 && latestHistogram >= 0,
    bearishCrossover: prevHistogram > 0 && latestHistogram <= 0,
  };
}

export interface EMACrossoverResult {
  ema20: number;
  ema50: number;
  goldenCross: boolean;  // EMA20 just crossed above EMA50 (bullish)
  deathCross: boolean;   // EMA20 just crossed below EMA50 (bearish)
  ema20AboveEma50: boolean; // current state: trend is up
}

export function computeEMACrossover(prices: number[]): EMACrossoverResult | null {
  if (prices.length < 52) return null; // need 50 + 2 warmup points
  const ema20arr = computeEMA(prices, 20);
  const ema50arr = computeEMA(prices, 50);
  if (ema20arr.length < 2 || ema50arr.length < 2) return null;

  // Align to same length (ema20 is longer — trim from front)
  const off = ema20arr.length - ema50arr.length;
  const lastIdx20 = ema20arr.length - 1;
  const lastIdx50 = ema50arr.length - 1;
  const ema20Now  = ema20arr[lastIdx20];
  const ema50Now  = ema50arr[lastIdx50];
  const ema20Prev = ema20arr[lastIdx20 - 1];
  const ema50Prev = ema50arr[lastIdx50 - 1];

  return {
    ema20: ema20Now,
    ema50: ema50Now,
    goldenCross: ema20Prev <= ema50Prev && ema20Now > ema50Now,
    deathCross:  ema20Prev >= ema50Prev && ema20Now < ema50Now,
    ema20AboveEma50: ema20Now > ema50Now,
  };
}

export interface TrendIndicators {
  macd: MACDResult | null;
  emaCrossover: EMACrossoverResult | null;
}

/** Compute MACD + EMA crossover from historical prices for a symbol */
export async function computeTrendIndicators(symbol: string): Promise<TrendIndicators> {
  try {
    // Fetch 90-day history for enough EMA warmup (need 52+ prices)
    const sym = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
    const json = await yahooGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`
    );
    const closes: number[] = (json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((c: any) => c !== null);

    if (closes.length < 35) return { macd: null, emaCrossover: null };
    return {
      macd: computeMACD(closes),
      emaCrossover: closes.length >= 52 ? computeEMACrossover(closes) : null,
    };
  } catch {
    return { macd: null, emaCrossover: null };
  }
}
