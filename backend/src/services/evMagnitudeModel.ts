/**
 * evMagnitudeModel.ts — learned regression for expected-return MAGNITUDE.
 *
 * computeExpectedValue() in patternEngine.ts predicts win/loss magnitude by
 * averaging the last 100 resolved trades for THIS SYMBOL ONLY — a trailing
 * average, not a learned model, and one that's data-starved for any symbol
 * without much of its own trade history (falls back to `sufficient: false`
 * below MIN_EV_SAMPLES=15 regardless of how much data exists for OTHER
 * symbols in similar conditions).
 *
 * This module fits two small linear regressions — one predicting win
 * magnitude, one predicting loss magnitude — from context features (RSI,
 * regime, fundamentals, momentum) across ALL symbols' resolved BUY trades in
 * signal_patterns, not just one symbol's. Same mini-batch GD + L2 +
 * chronological holdout shape as mlProbabilityModel.ts/jointVoteModel.ts,
 * but with a linear (not sigmoid) output and MSE loss, since the target
 * (realized_pnl_pct) is a continuous magnitude, not a 0/1 label.
 *
 * `vote_score` is deliberately excluded from the feature set: the only
 * caller that persists it into signal_patterns (marketMonitor.ts
 * recordSignalPattern) always writes 0, so it carries no information to
 * learn from — including it would just be noise.
 *
 * Dormant like the other new models here: trainMagnitudeModels() no-ops
 * below MIN_TRAIN_SAMPLES per class. computeExpectedValue() falls back to
 * its existing per-symbol trailing average whenever a prediction isn't
 * available (untrained, or the caller didn't pass feature context).
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const FEATURE_NAMES = ['rsi_norm', 'regime_bull', 'regime_bear', 'fundamental_norm', 'momentum_bullish', 'momentum_bearish'];
const N_FEATURES = FEATURE_NAMES.length;
const MIN_TRAIN_SAMPLES = 40; // per outcome class (WIN / LOSS) — smaller pool than the classifier, since it's split by outcome
const LEARNING_RATE = 0.02;
const LAMBDA = 0.01;
const MAX_EPOCHS = 200;

export interface MagnitudeContext {
  rsiValue: number | null;
  marketRegime: string | null; // 'BULL' | 'BEAR' | 'SIDEWAYS'
  fundamentalScore: number | null;
  momentumTrend: string | null; // 'bullish' | 'bearish' | 'neutral'
}

function extractFeatures(ctx: MagnitudeContext): number[] {
  const rsiNorm = Math.max(0, Math.min(1, (ctx.rsiValue ?? 50) / 100));
  const regime = (ctx.marketRegime ?? '').toUpperCase();
  const regimeBull = regime.includes('BULL') ? 1 : 0;
  const regimeBear = regime.includes('BEAR') ? 1 : 0;
  const fundNorm = Math.max(0, Math.min(1, (ctx.fundamentalScore ?? 50) / 100));
  const momentum = (ctx.momentumTrend ?? '').toLowerCase();
  const momentumBullish = momentum === 'bullish' ? 1 : 0;
  const momentumBearish = momentum === 'bearish' ? 1 : 0;
  return [rsiNorm, regimeBull, regimeBear, fundNorm, momentumBullish, momentumBearish];
}

function dotProduct(w: number[], x: number[]): number {
  return w.reduce((sum, wi, i) => sum + wi * (x[i] ?? 0), 0);
}

async function ensureTable(): Promise<void> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS ev_magnitude_weights (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name    TEXT NOT NULL,
      trained_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      sample_count  INTEGER NOT NULL,
      feature_names TEXT NOT NULL,
      weights       TEXT NOT NULL,
      bias          REAL NOT NULL,
      holdout_mae   REAL,
      holdout_rmse  REAL,
      holdout_count INTEGER
    )`, []);
  } catch (_) { /* already exists */ }
}

interface MagnitudeModelState {
  weights: number[];
  bias: number;
  sampleCount: number;
  holdoutMae: number | null;
  holdoutRmse: number | null;
}

async function trainOneModel(modelName: string, outcomeFilter: 'WIN' | 'LOSS'): Promise<MagnitudeModelState | null> {
  const rows = await query(
    `SELECT rsi_value, market_regime, fundamental_score, momentum_trend, realized_pnl_pct
     FROM signal_patterns
     WHERE action='BUY' AND outcome=? AND realized_pnl_pct IS NOT NULL
     ORDER BY created_at DESC LIMIT 2000`,
    [outcomeFilter],
  ).catch(() => []);

  if (rows.length < MIN_TRAIN_SAMPLES) {
    logger.info({ job: 'ev-magnitude-model', modelName, reason: `Insufficient ${outcomeFilter} rows: ${rows.length} (need ${MIN_TRAIN_SAMPLES})` });
    return null;
  }

  const chronological = [...rows].reverse();
  const MIN_HOLDOUT = 10;
  const holdoutSize = Math.floor(chronological.length * 0.2);
  const hasHoldout = holdoutSize >= MIN_HOLDOUT && (chronological.length - holdoutSize) >= MIN_TRAIN_SAMPLES;
  const splitIdx = hasHoldout ? chronological.length - holdoutSize : chronological.length;
  const trainRows = chronological.slice(0, splitIdx);
  const holdoutRows = chronological.slice(splitIdx);

  const X = trainRows.map(r => extractFeatures({
    rsiValue: r.rsi_value != null ? Number(r.rsi_value) : null,
    marketRegime: r.market_regime as string | null,
    fundamentalScore: r.fundamental_score != null ? Number(r.fundamental_score) : null,
    momentumTrend: r.momentum_trend as string | null,
  }));
  // Loss rows store a positive return magnitude (abs), consistent with
  // patternEngine.computeExpectedValue()'s existing avgLossPct convention.
  const y = trainRows.map(r => outcomeFilter === 'LOSS' ? Math.abs(Number(r.realized_pnl_pct)) : Number(r.realized_pnl_pct));

  let weights = Array(N_FEATURES).fill(0) as number[];
  let bias = y.reduce((a, b) => a + b, 0) / y.length; // init bias at the mean — sensible starting point for a regression
  const batchSize = Math.min(32, Math.ceil(trainRows.length / 4));

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    const indices = X.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (let b = 0; b < indices.length; b += batchSize) {
      const batch = indices.slice(b, b + batchSize);
      const gradW = Array(N_FEATURES).fill(0) as number[];
      let gradB = 0;
      for (const i of batch) {
        const pred = dotProduct(weights, X[i]) + bias; // linear output — this is a regression, not a classifier
        const err = pred - y[i];
        for (let j = 0; j < N_FEATURES; j++) gradW[j] += err * X[i][j];
        gradB += err;
      }
      for (let j = 0; j < N_FEATURES; j++) {
        weights[j] -= LEARNING_RATE * (gradW[j] / batch.length + LAMBDA * weights[j]);
      }
      bias -= LEARNING_RATE * (gradB / batch.length);
    }
  }

  let holdoutMae: number | null = null;
  let holdoutRmse: number | null = null;
  if (hasHoldout) {
    const Xh = holdoutRows.map(r => extractFeatures({
      rsiValue: r.rsi_value != null ? Number(r.rsi_value) : null,
      marketRegime: r.market_regime as string | null,
      fundamentalScore: r.fundamental_score != null ? Number(r.fundamental_score) : null,
      momentumTrend: r.momentum_trend as string | null,
    }));
    const yh = holdoutRows.map(r => outcomeFilter === 'LOSS' ? Math.abs(Number(r.realized_pnl_pct)) : Number(r.realized_pnl_pct));
    const predsH = Xh.map(x => dotProduct(weights, x) + bias);
    holdoutMae = predsH.reduce((s, p, i) => s + Math.abs(p - yh[i]), 0) / predsH.length;
    holdoutRmse = Math.sqrt(predsH.reduce((s, p, i) => s + (p - yh[i]) ** 2, 0) / predsH.length);
  }

  await ensureTable();
  await run(
    `INSERT INTO ev_magnitude_weights (model_name, sample_count, feature_names, weights, bias, holdout_mae, holdout_rmse, holdout_count)
     VALUES (?,?,?,?,?,?,?,?)`,
    [modelName, rows.length, JSON.stringify(FEATURE_NAMES), JSON.stringify(weights), bias,
     holdoutMae, holdoutRmse, holdoutRows.length],
  ).catch(() => null);

  logger.info({
    job: 'ev-magnitude-model', modelName, samples: rows.length,
    holdoutMae: holdoutMae !== null ? holdoutMae.toFixed(2) + 'pp' : 'n/a',
    holdoutRmse: holdoutRmse !== null ? holdoutRmse.toFixed(2) + 'pp' : 'n/a',
    reason: `${outcomeFilter} magnitude model trained and persisted`,
  });

  return { weights, bias, sampleCount: rows.length, holdoutMae, holdoutRmse };
}

/** Trains both the win-magnitude and loss-magnitude models. No-ops per class until enough data. */
export async function trainMagnitudeModels(): Promise<void> {
  await trainOneModel('ev_win_magnitude_v1', 'WIN');
  await trainOneModel('ev_loss_magnitude_v1', 'LOSS');
}

const _cache = new Map<string, { state: MagnitudeModelState; ts: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function loadModel(modelName: string): Promise<MagnitudeModelState | null> {
  const cached = _cache.get(modelName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.state;
  const row = await query(
    `SELECT weights, bias, sample_count, holdout_mae, holdout_rmse FROM ev_magnitude_weights
     WHERE model_name=? ORDER BY id DESC LIMIT 1`,
    [modelName],
  ).then(r => r[0]).catch(() => null);
  if (!row) return null;
  try {
    const state: MagnitudeModelState = {
      weights: JSON.parse(String(row.weights)), bias: Number(row.bias),
      sampleCount: Number(row.sample_count),
      holdoutMae: row.holdout_mae != null ? Number(row.holdout_mae) : null,
      holdoutRmse: row.holdout_rmse != null ? Number(row.holdout_rmse) : null,
    };
    _cache.set(modelName, { state, ts: Date.now() });
    return state;
  } catch { return null; }
}

/**
 * Returns { predictedWinPct, predictedLossPct } when both models are
 * trained on enough data, or null when either is unavailable — callers
 * (patternEngine.computeExpectedValue) should fall back to the existing
 * per-symbol trailing average in that case.
 */
export async function getPredictedMagnitudes(ctx: MagnitudeContext): Promise<{ predictedWinPct: number; predictedLossPct: number } | null> {
  const [winModel, lossModel] = await Promise.all([
    loadModel('ev_win_magnitude_v1'),
    loadModel('ev_loss_magnitude_v1'),
  ]);
  if (!winModel || winModel.sampleCount < MIN_TRAIN_SAMPLES) return null;
  if (!lossModel || lossModel.sampleCount < MIN_TRAIN_SAMPLES) return null;

  const features = extractFeatures(ctx);
  const predictedWinPct = dotProduct(winModel.weights, features) + winModel.bias;
  const predictedLossPct = dotProduct(lossModel.weights, features) + lossModel.bias;
  // Guard rails: a win prediction should never be negative and a loss
  // prediction (stored/returned as a positive magnitude) should never be —
  // a linear model can extrapolate outside sane bounds on edge-case inputs.
  return {
    predictedWinPct: Math.max(0.1, predictedWinPct),
    predictedLossPct: Math.max(0.1, predictedLossPct),
  };
}
