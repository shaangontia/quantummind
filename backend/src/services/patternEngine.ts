/**
 * patternEngine.ts — Signal Pattern Memory & Adaptive Learning
 *
 * Purpose: make the model smarter by learning WHICH signal conditions consistently
 * lead to winning trades, and feeding that institutional memory back into:
 *   1. Gemini prompts (contextual history → better LLM decisions)
 *   2. Adaptive RSI thresholds per symbol (data-driven, not fixed)
 *   3. Pattern confidence scoring (boost signals that match winning patterns)
 *
 * Architecture:
 *   recordSignalPattern()  → stores full signal context on every BUY/SELL trade
 *   resolvePatternOutcome() → marks patterns WIN/LOSS when trade closes
 *   getWinningPatterns()   → retrieves top winning contexts for a symbol+regime
 *   getAdaptiveRSI()       → returns learned RSI buy threshold for a symbol
 *   getPatternConfidence() → given current signal context, returns confidence boost
 *   buildPatternContext()  → formats pattern history for Gemini prompt injection
 */

import { query, queryOne, run } from '../db/turso.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SignalPatternContext {
  portfolioId: number;
  symbol: string;
  action: 'BUY' | 'SELL';
  rsiValue: number;
  momentumTrend: string;        // 'bullish' | 'bearish' | 'neutral'
  groqSentiment: string;        // 'BULLISH:...' | 'BEARISH:...' | 'NEUTRAL'
  fundamentalScore: number;     // 0–100 from computeFundamentalVerdict
  marketRegime: string;         // 'BULL' | 'BEAR' | 'SIDEWAYS'
  sector: string;
  voteScore: number;            // rule engine vote score
  tradeId?: number;             // linked trade after execution
}

export interface PatternInsight {
  symbol: string;
  action: 'BUY' | 'SELL';
  avgRsiBuy: number;             // average RSI at which wins occurred
  winRate: number;               // 0–1
  sampleCount: number;
  bestRegime: string;            // regime with highest win rate
  bestMomentum: string;          // momentum condition most correlated with wins
  avgFundamentalScore: number;
  summary: string;               // human-readable insight for Gemini prompt
}

// ─── DB setup (called from turso.ts initDb) ───────────────────────────────────

export async function ensurePatternTables(): Promise<void> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS signal_patterns (
      id                INTEGER  PRIMARY KEY AUTOINCREMENT,
      portfolio_id      INTEGER  NOT NULL,
      symbol            TEXT     NOT NULL,
      action            TEXT     NOT NULL CHECK(action IN ('BUY','SELL')),
      rsi_value         REAL,
      momentum_trend    TEXT,
      groq_sentiment    TEXT,
      fundamental_score REAL,
      market_regime     TEXT,
      sector            TEXT,
      vote_score        REAL,
      trade_id          INTEGER,
      outcome           TEXT,    -- 'WIN' | 'LOSS' | NULL (pending)
      realized_pnl_pct  REAL,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at       DATETIME
    ) STRICT`, []);
  } catch (_) { /* already exists */ }

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_patterns_symbol_action
      ON signal_patterns(symbol, action)`, []);
    await run(`CREATE INDEX IF NOT EXISTS idx_patterns_outcome
      ON signal_patterns(outcome, symbol)`, []);
  } catch (_) { /* already exist */ }
}

// ─── Record ────────────────────────────────────────────────────────────────────

/**
 * Record a signal pattern at trade execution time.
 * Called by marketMonitor after a BUY or SELL trade is confirmed.
 */
export async function recordSignalPattern(ctx: SignalPatternContext): Promise<number> {
  try {
    const result = await run(
      `INSERT INTO signal_patterns
        (portfolio_id, symbol, action, rsi_value, momentum_trend, groq_sentiment,
         fundamental_score, market_regime, sector, vote_score, trade_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.portfolioId, ctx.symbol, ctx.action, ctx.rsiValue,
        ctx.momentumTrend, ctx.groqSentiment, ctx.fundamentalScore,
        ctx.marketRegime, ctx.sector, ctx.voteScore, ctx.tradeId ?? null,
      ],
    );
    return result.lastInsertRowid;
  } catch (err) {
    console.warn('[PatternEngine] recordSignalPattern failed:', err);
    return -1;
  }
}

// ─── Resolve ───────────────────────────────────────────────────────────────────

/**
 * Mark pattern as WIN or LOSS when the position closes.
 * Called after every SELL trade that closes a BUY position.
 */
export async function resolvePatternOutcome(
  portfolioId: number,
  symbol: string,
  realizedPnlPct: number,
): Promise<void> {
  const outcome = realizedPnlPct > 0.5 ? 'WIN' : 'LOSS';  // >0.5% net counts as win
  try {
    await run(
      `UPDATE signal_patterns
       SET outcome = ?, realized_pnl_pct = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE portfolio_id = ? AND symbol = ? AND action = 'BUY' AND outcome IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [outcome, realizedPnlPct, portfolioId, symbol],
    );
  } catch (err) {
    console.warn('[PatternEngine] resolvePatternOutcome failed:', err);
  }
}

// ─── Analyse ───────────────────────────────────────────────────────────────────

/**
 * Get winning pattern insights for a symbol.
 * Used to build context for Gemini prompts and adaptive thresholds.
 * Returns null if fewer than 3 resolved patterns exist (not enough data).
 */
export async function getPatternInsight(symbol: string): Promise<PatternInsight | null> {
  const rows = await query(
    `SELECT action, rsi_value, momentum_trend, fundamental_score, market_regime, outcome, realized_pnl_pct
     FROM signal_patterns
     WHERE symbol = ? AND outcome IS NOT NULL
     ORDER BY resolved_at DESC LIMIT 50`,
    [symbol],
  );

  if (rows.length < 3) return null;

  const buys = rows.filter(r => r.action === 'BUY');
  const wins = buys.filter(r => r.outcome === 'WIN');
  const losses = buys.filter(r => r.outcome === 'LOSS');

  if (buys.length === 0) return null;

  const winRate = wins.length / buys.length;

  // Average RSI at winning BUY signals
  const avgRsiBuy = wins.length > 0
    ? wins.reduce((s, r) => s + Number(r.rsi_value ?? 35), 0) / wins.length
    : 35;

  // Best regime
  const regimeCounts: Record<string, { wins: number; total: number }> = {};
  for (const r of buys) {
    const reg = String(r.market_regime ?? 'SIDEWAYS');
    if (!regimeCounts[reg]) regimeCounts[reg] = { wins: 0, total: 0 };
    regimeCounts[reg].total++;
    if (r.outcome === 'WIN') regimeCounts[reg].wins++;
  }
  const bestRegime = Object.entries(regimeCounts)
    .sort(([, a], [, b]) => (b.wins / b.total) - (a.wins / a.total))[0]?.[0] ?? 'SIDEWAYS';

  // Best momentum condition at wins
  const momentumWins: Record<string, number> = {};
  for (const r of wins) {
    const m = String(r.momentum_trend ?? 'neutral');
    momentumWins[m] = (momentumWins[m] ?? 0) + 1;
  }
  const bestMomentum = Object.entries(momentumWins).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'bullish';

  const avgFundamentalScore = wins.length > 0
    ? wins.reduce((s, r) => s + Number(r.fundamental_score ?? 50), 0) / wins.length
    : 50;

  const summary = [
    `${symbol}: ${wins.length}W/${losses.length}L (${(winRate * 100).toFixed(0)}% win rate, n=${buys.length})`,
    `Best entry: RSI≈${avgRsiBuy.toFixed(0)}, ${bestMomentum} momentum, ${bestRegime} regime`,
    `Avg fundamental score at wins: ${avgFundamentalScore.toFixed(0)}/100`,
  ].join('. ');

  return { symbol, action: 'BUY', avgRsiBuy, winRate, sampleCount: buys.length, bestRegime, bestMomentum, avgFundamentalScore, summary };
}

// ─── Adaptive RSI threshold ────────────────────────────────────────────────────

/**
 * Return learned optimal RSI buy threshold for a symbol.
 * Phase 13: Conservative learning — requires 10+ resolved trades before any blending.
 * Blending weights scale with sample size to prevent overfitting:
 *   < 10 trades  → 0% learned (use regime default)
 *   10–29 trades → 25% learned, 75% default
 *   30–99 trades → 50% learned, 50% default
 *   100+ trades  → 70% learned, 30% default
 */
export async function getAdaptiveRSIBuy(
  symbol: string,
  regimeDefault: number,
): Promise<number> {
  const insight = await getPatternInsight(symbol);
  if (!insight || insight.sampleCount < 10) return regimeDefault;

  // Conservative shrinkage: weight scales with sample size
  let learnedWeight: number;
  if (insight.sampleCount < 30)  learnedWeight = 0.25;
  else if (insight.sampleCount < 100) learnedWeight = 0.50;
  else                            learnedWeight = 0.70;

  const blended = insight.avgRsiBuy * learnedWeight + regimeDefault * (1 - learnedWeight);
  return Math.max(25, Math.min(50, blended));
}

// ─── Confidence boost ──────────────────────────────────────────────────────────

/**
 * Given the current signal context, return a confidence multiplier (0.9–1.15).
 * Phase 13: Tighter range — prevents weak signals being inflated to strong.
 * Compares current conditions against historical winning patterns for this symbol.
 *
 * 1.0 = neutral (no pattern data or ambiguous)
 * 1.05–1.15 = current conditions match winning patterns → modest boost
 * 0.9–0.95  = current conditions match losing patterns → modest penalty
 */
export async function getPatternConfidence(
  symbol: string,
  rsiValue: number,
  momentumTrend: string,
  marketRegime: string,
): Promise<number> {
  const insight = await getPatternInsight(symbol);
  if (!insight || insight.sampleCount < 5) return 1.0;

  let score = 1.0;

  // RSI proximity to the learned sweet-spot (±5 RSI points)
  const rsiDiff = Math.abs(rsiValue - insight.avgRsiBuy);
  if (rsiDiff <= 5) score += 0.15;
  else if (rsiDiff > 15) score -= 0.10;

  // Momentum match
  if (momentumTrend === insight.bestMomentum) score += 0.10;

  // Regime match
  if (marketRegime === insight.bestRegime) score += 0.10;

  // General win rate adjustment
  if (insight.winRate > 0.65) score += 0.05;
  else if (insight.winRate < 0.40) score -= 0.10;

  return Math.max(0.9, Math.min(1.15, score));
}

// ─── Gemini prompt context builder ────────────────────────────────────────────

/**
 * Build a compact pattern-history block to inject into Gemini trade veto / sell review prompts.
 * Gives Gemini "institutional memory" of what has worked for this symbol.
 * Returns empty string if no data (no prompt pollution).
 */
export async function buildPatternContext(symbol: string): Promise<string> {
  const insight = await getPatternInsight(symbol);
  if (!insight || insight.sampleCount < 3) return '';

  const recentRows = await query(
    `SELECT action, rsi_value, momentum_trend, outcome, realized_pnl_pct
     FROM signal_patterns
     WHERE symbol = ? AND outcome IS NOT NULL
     ORDER BY resolved_at DESC LIMIT 5`,
    [symbol],
  );

  const recentLines = recentRows.map(r =>
    `  ${r.action} @ RSI ${Number(r.rsi_value ?? 0).toFixed(0)} (${r.momentum_trend}) → ${r.outcome} ${r.realized_pnl_pct !== null ? `(${Number(r.realized_pnl_pct).toFixed(1)}%)` : ''}`,
  ).join('\n');

  return `\nHISTORICAL PATTERN FOR ${symbol} (${insight.sampleCount} resolved trades):\n${insight.summary}\nRecent:\n${recentLines}`;
}

// ─── Top patterns for Gemini portfolio context ─────────────────────────────────

/**
 * Return pattern summaries for up to 5 symbols — injected into portfolio-level Gemini calls.
 */
export async function buildPortfolioPatternContext(symbols: string[]): Promise<string> {
  const lines: string[] = [];
  for (const sym of symbols.slice(0, 5)) {
    const insight = await getPatternInsight(sym);
    if (insight && insight.sampleCount >= 3) lines.push(insight.summary);
  }
  if (lines.length === 0) return '';
  return `\nLEARNED PATTERNS (from trade history):\n${lines.join('\n')}`;
}

// ─── Expected Value Gate ────────────────────────────────────────────────────────

const TRADE_COSTS_PCT = 0.004; // 0.4% round-trip: brokerage + STT + exchange + GST + stamp
const MIN_EV_PCT      = 1.0;   // only trade when EV > 1% after costs
const MIN_EV_SAMPLES  = 15;    // need at least 15 resolved trades to compute EV

export interface EVResult {
  ev: number;           // expected value as % of capital
  pWin: number;         // win probability 0–1
  avgWinPct: number;    // average winning return %
  avgLossPct: number;   // average losing return % (positive = loss magnitude)
  sampleCount: number;
  sufficient: boolean;  // true when sample count ≥ MIN_EV_SAMPLES
  meetsThreshold: boolean; // true when EV ≥ MIN_EV_PCT
}

/**
 * Compute expected value for a BUY in a given strategy type.
 * Uses resolved signal_patterns (outcome='WIN'/'LOSS') filtered by strategy.
 * Falls back to 'sufficient=false' when not enough data — caller should proceed without EV gate.
 */
export async function computeExpectedValue(
  symbol: string,
  strategyType: string,
): Promise<EVResult> {
  const { query } = await import('../db/turso.js');

  // Fetch resolved patterns for this symbol (strategy-specific first, fallback to symbol-level)
  const rows = await query(
    `SELECT outcome, realized_pnl_pct FROM signal_patterns
     WHERE portfolio_id IN (SELECT id FROM portfolios WHERE is_active=1)
       AND symbol=?
       AND outcome IN ('WIN','LOSS')
       AND action='BUY'
     ORDER BY created_at DESC LIMIT 100`,
    [symbol],
  ).catch(() => [] as Array<{ outcome: string; realized_pnl_pct: number }>);

  if (rows.length < MIN_EV_SAMPLES) {
    return { ev: 0, pWin: 0, avgWinPct: 0, avgLossPct: 0, sampleCount: rows.length, sufficient: false, meetsThreshold: false };
  }

  const wins  = rows.filter(r => r.outcome === 'WIN');
  const losses = rows.filter(r => r.outcome === 'LOSS');
  const pWin = wins.length / rows.length;
  const avgWinPct  = wins.length  > 0 ? wins.reduce((s, r)  => s + Number(r.realized_pnl_pct), 0)  / wins.length  : 0;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + Number(r.realized_pnl_pct), 0) / losses.length) : 0;

  const ev = pWin * avgWinPct - (1 - pWin) * avgLossPct - TRADE_COSTS_PCT * 100;

  return {
    ev,
    pWin,
    avgWinPct,
    avgLossPct,
    sampleCount: rows.length,
    sufficient: true,
    meetsThreshold: ev >= MIN_EV_PCT,
  };
}
