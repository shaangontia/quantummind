/**
 * mlProbabilityModel.ts — Phase 14: Logistic Regression Win Probability
 *
 * A lightweight logistic regression trained on resolved signal_patterns.
 * Each resolved BUY trade (outcome='WIN' or 'LOSS') provides a training sample.
 *
 * Feature vector (7 features):
 *   0. rsi_norm        — RSI normalised to [0,1] (rsiValue / 100)
 *   1. volume_ratio    — volume / 20-day avg, capped at 3.0, normalised by /3
 *   2. regime_bull     — 1 if marketRegime='BULL' else 0
 *   3. regime_bear     — 1 if marketRegime='BEAR' else 0 (SIDEWAYS = both 0)
 *   4. strategy_mr     — 1 if MEAN_REVERSION else 0
 *   5. strategy_mo     — 1 if MOMENTUM else 0
 *   6. fundamental_norm — fundamentalScore / 100
 *
 * Training uses mini-batch gradient descent with L2 regularisation.
 * Retrained nightly (called from adaptiveEngine.ts evening batch) when ≥30 new samples.
 * Model weights persisted in ml_model_weights table.
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const MODEL_NAME = 'buy_win_probability_v1';
const FEATURE_NAMES = ['rsi_norm', 'volume_ratio_norm', 'regime_bull', 'regime_bear', 'strategy_mr', 'strategy_mo', 'fundamental_norm'];
const N_FEATURES = FEATURE_NAMES.length;
const MIN_TRAIN_SAMPLES = 30;
const MIN_PREDICT_SAMPLES = 50;
const LEARNING_RATE = 0.05;
const LAMBDA = 0.01;           // L2 regularisation
const MAX_EPOCHS = 200;
const WIN_PROB_THRESHOLD = 0.52;

// ─── Sigmoid ──────────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}

function dotProduct(w: number[], x: number[]): number {
  return w.reduce((sum, wi, i) => sum + wi * (x[i] ?? 0), 0);
}

// ─── In-process model cache ───────────────────────────────────────────────────

interface ModelState {
  weights: number[];
  bias: number;
  sampleCount: number;
  trainedAt: number;
  accuracy: number;
}

let _model: ModelState | null = null;
const MODEL_CACHE_MS = 60 * 60 * 1000; // 1h — reload from DB at most hourly

// ─── Feature extraction ───────────────────────────────────────────────────────

function extractFeatures(row: {
  rsi_value?: number | null;
  volume_ratio?: number | null;
  market_regime?: string | null;
  strategy_type?: string | null;
  fundamental_score?: number | null;
}): number[] {
  const rsiNorm        = Math.max(0, Math.min(1, (row.rsi_value ?? 50) / 100));
  const volNorm        = Math.max(0, Math.min(1, (row.volume_ratio ?? 1.0) / 3));
  const regime         = (row.market_regime ?? '').toUpperCase();
  const regimeBull     = regime.includes('BULL') ? 1 : 0;
  const regimeBear     = regime.includes('BEAR') ? 1 : 0;
  const strategy       = (row.strategy_type ?? '').toUpperCase();
  const strategyMR     = strategy === 'MEAN_REVERSION' ? 1 : 0;
  const strategyMO     = strategy === 'MOMENTUM'       ? 1 : 0;
  const fundNorm       = Math.max(0, Math.min(1, (row.fundamental_score ?? 50) / 100));

  return [rsiNorm, volNorm, regimeBull, regimeBear, strategyMR, strategyMO, fundNorm];
}

// ─── Training ─────────────────────────────────────────────────────────────────

/**
 * Train logistic regression on resolved signal_patterns.
 * Returns trained weights + bias, or null when insufficient data.
 */
export async function trainModel(): Promise<ModelState | null> {
  const rows = await query(
    `SELECT rsi_value, volume_ratio, market_regime, strategy_type, fundamental_score, outcome
     FROM signal_patterns
     WHERE action='BUY' AND outcome IN ('WIN','LOSS')
     ORDER BY created_at DESC LIMIT 2000`,
  ).catch(() => []);

  if (rows.length < MIN_TRAIN_SAMPLES) {
    logger.info({ job: 'ml-model', reason: `Insufficient training data: ${rows.length} samples (need ${MIN_TRAIN_SAMPLES})` });
    return null;
  }

  const X: number[][] = rows.map(r => extractFeatures(r));
  const y: number[]   = rows.map(r => r.outcome === 'WIN' ? 1 : 0);

  // Initialise weights to zero
  let weights = Array(N_FEATURES).fill(0) as number[];
  let bias = 0;

  // Mini-batch gradient descent
  const batchSize = Math.min(32, Math.ceil(rows.length / 4));
  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    // Shuffle
    const indices = X.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (let b = 0; b < indices.length; b += batchSize) {
      const batch = indices.slice(b, b + batchSize);
      const gradW = Array(N_FEATURES).fill(0) as number[];
      let gradB = 0;
      for (const i of batch) {
        const z = dotProduct(weights, X[i]) + bias;
        const pred = sigmoid(z);
        const err = pred - y[i];
        for (let j = 0; j < N_FEATURES; j++) gradW[j] += err * X[i][j];
        gradB += err;
      }
      // Update with L2 regularisation
      for (let j = 0; j < N_FEATURES; j++) {
        weights[j] -= LEARNING_RATE * (gradW[j] / batch.length + LAMBDA * weights[j]);
      }
      bias -= LEARNING_RATE * (gradB / batch.length);
    }
  }

  // Evaluate accuracy on training set
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = sigmoid(dotProduct(weights, X[i]) + bias) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const accuracy = correct / X.length;

  const state: ModelState = {
    weights,
    bias,
    sampleCount: rows.length,
    trainedAt: Date.now(),
    accuracy,
  };

  // Persist to DB
  await run(
    `INSERT INTO ml_model_weights
       (model_name, trained_at, sample_count, feature_names, weights, bias, accuracy)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
    [MODEL_NAME, rows.length, JSON.stringify(FEATURE_NAMES), JSON.stringify(weights), bias, accuracy],
  ).catch(() => null);

  _model = state;
  logger.info({ job: 'ml-model', samples: rows.length, accuracy: (accuracy * 100).toFixed(1) + '%', reason: 'Model trained and persisted' });
  return state;
}

/**
 * Load the most recent model from DB (for startup / cache miss).
 */
async function loadModelFromDB(): Promise<ModelState | null> {
  const row = await query(
    `SELECT weights, bias, sample_count, accuracy, strftime('%s', trained_at) * 1000 as trained_ms
     FROM ml_model_weights WHERE model_name=?
     ORDER BY id DESC LIMIT 1`,
    [MODEL_NAME],
  ).then(r => r[0]).catch(() => null);

  if (!row) return null;
  try {
    return {
      weights: JSON.parse(String(row.weights)),
      bias: Number(row.bias),
      sampleCount: Number(row.sample_count),
      trainedAt: Number(row.trained_ms ?? 0),
      accuracy: Number(row.accuracy ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Get cached model (loads from DB if cache is stale).
 */
async function getModel(): Promise<ModelState | null> {
  if (_model && Date.now() - _model.trainedAt < MODEL_CACHE_MS) return _model;
  _model = await loadModelFromDB();
  return _model;
}

// ─── Prediction ───────────────────────────────────────────────────────────────

export interface WinProbabilityResult {
  pWin: number;           // 0–1 win probability
  meetsThreshold: boolean; // pWin ≥ WIN_PROB_THRESHOLD
  modelAvailable: boolean; // false when insufficient training data
  sampleCount: number;
}

/**
 * Compute win probability for a given signal context.
 * Returns {modelAvailable: false} when model hasn't enough training data.
 */
export async function getWinProbability(ctx: {
  rsiValue: number | null;
  volumeRatio?: number | null;
  marketRegime?: string | null;
  strategyType?: string | null;
  fundamentalScore?: number | null;
}): Promise<WinProbabilityResult> {
  const model = await getModel().catch(() => null);

  if (!model || model.sampleCount < MIN_PREDICT_SAMPLES) {
    return { pWin: 0.5, meetsThreshold: true, modelAvailable: false, sampleCount: model?.sampleCount ?? 0 };
  }

  const features = extractFeatures({
    rsi_value: ctx.rsiValue,
    volume_ratio: ctx.volumeRatio,
    market_regime: ctx.marketRegime,
    strategy_type: ctx.strategyType,
    fundamental_score: ctx.fundamentalScore,
  });

  const z = dotProduct(model.weights, features) + model.bias;
  const pWin = sigmoid(z);

  return {
    pWin,
    meetsThreshold: pWin >= WIN_PROB_THRESHOLD,
    modelAvailable: true,
    sampleCount: model.sampleCount,
  };
}
