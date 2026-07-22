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

// ─── Holdout evaluation metrics (P1.7 fix, 2026-07-22) ────────────────────────
// trainModel() previously reported `accuracy` computed on the same rows used
// for training — in-sample accuracy systematically overstates a model's true
// predictive power, especially with L2 λ=0.01 over as few as 30 rows. These
// helpers score the trained model on a chronological holdout split it never
// saw during gradient descent. See QuantumMind_Algorithm_Analysis.md §3.1.

/** Brier score: mean squared error between predicted probability and actual
 * outcome. 0 = perfect, 0.25 = no-better-than-chance on a balanced 50/50 set. */
function brierScore(probs: number[], labels: number[]): number {
  if (probs.length === 0) return NaN;
  const sumSq = probs.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0);
  return sumSq / probs.length;
}

/** AUC-ROC via the rank-based (Mann-Whitney U) formula. Returns null when the
 * holdout has only one class present (AUC undefined). */
function computeAUC(probs: number[], labels: number[]): number | null {
  const posProbs = probs.filter((_, i) => labels[i] === 1);
  const negProbs = probs.filter((_, i) => labels[i] === 0);
  if (posProbs.length === 0 || negProbs.length === 0) return null;
  let concordant = 0;
  let tied = 0;
  for (const p of posProbs) {
    for (const n of negProbs) {
      if (p > n) concordant++;
      else if (p === n) tied++;
    }
  }
  return (concordant + 0.5 * tied) / (posProbs.length * negProbs.length);
}

// ─── In-process model cache ───────────────────────────────────────────────────

interface ModelState {
  weights: number[];
  bias: number;
  sampleCount: number;
  trainedAt: number;
  /** In-sample training accuracy — kept for backward compatibility/debugging.
   * Prefer holdoutAccuracy for any statement about real predictive power. */
  accuracy: number;
  /** P1.7 fix: out-of-sample metrics from a chronological holdout split the
   * model never trained on. Null when there wasn't enough data for a
   * meaningful holdout (falls back to in-sample-only, see trainModel()). */
  holdoutAccuracy: number | null;
  holdoutAuc: number | null;
  holdoutBrier: number | null;
  holdoutCount: number;
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
  // Phase 23: Train on EXECUTED + SHADOW candidates (LIVE_PAPER_EXECUTED + LIVE_PAPER_SHADOW).
  // Excludes POLICY_SIMULATION rows. Applies per-row learning_weight in gradient updates.
  // Validation/promotion gates still require executed-only counts (enforced in modelLifecycle).
  let rows = await query(
    `SELECT rsi_value, volume_ratio, market_regime, strategy_type, fundamental_score,
            target_hit_before_stop AS outcome_int,
            COALESCE(learning_weight, 1.0) AS sample_weight,
            data_source
     FROM trade_candidates
     WHERE learning_eligible = 1
       AND label_type = 'TARGET_BEFORE_STOP'
       AND label_status = 'FINAL'
       AND target_hit_before_stop IS NOT NULL
       AND (data_source IS NULL OR data_source != 'POLICY_SIMULATION')
     ORDER BY evaluated_at DESC LIMIT 2000`,
  ).then(r => r.map(x => ({ ...x, outcome: x.outcome_int === 1 ? 'WIN' : 'LOSS' }))).catch(() => []);

  // Fallback to signal_patterns when fewer than MIN_TRAIN_SAMPLES true labels available
  if (rows.length < MIN_TRAIN_SAMPLES) {
    rows = await query(
      `SELECT rsi_value, volume_ratio, market_regime, strategy_type, fundamental_score, outcome
       FROM signal_patterns
       WHERE action='BUY' AND outcome IN ('WIN','LOSS')
       ORDER BY created_at DESC LIMIT 2000`,
    ).catch(() => []);
  }

  if (rows.length < MIN_TRAIN_SAMPLES) {
    logger.info({ job: 'ml-model', reason: `Insufficient training data: ${rows.length} samples (need ${MIN_TRAIN_SAMPLES})` });
    return null;
  }

  // P1.7 fix (2026-07-22): chronological train/holdout split — train only on
  // the older ~80% of rows, evaluate on the most recent ~20% the model never
  // saw during gradient descent. Rows above were fetched ORDER BY ... DESC
  // (most recent first), so reverse to chronological order before splitting.
  // A minimum holdout size is required for the metrics to mean anything;
  // below that we still train on everything (same as before) but report
  // holdout metrics as null rather than a misleadingly tiny-sample number.
  const chronological = [...rows].reverse();
  const MIN_HOLDOUT = 10;
  const holdoutSize = Math.floor(chronological.length * 0.2);
  const hasHoldout = holdoutSize >= MIN_HOLDOUT && (chronological.length - holdoutSize) >= MIN_TRAIN_SAMPLES;
  const splitIdx = hasHoldout ? chronological.length - holdoutSize : chronological.length;
  const trainRows = chronological.slice(0, splitIdx);
  const holdoutRows = chronological.slice(splitIdx);

  const X: number[][] = trainRows.map(r => extractFeatures(r));
  const y: number[]   = trainRows.map(r => r.outcome === 'WIN' ? 1 : 0);
  // Phase 23: per-sample weights (1.0 executed, 0.7 skipped, 0.5 weak, 0.3 vetoed)
  const sampleWeights: number[] = trainRows.map(r => Number(r.sample_weight ?? 1.0));

  // Initialise weights to zero
  let weights = Array(N_FEATURES).fill(0) as number[];
  let bias = 0;

  // Mini-batch gradient descent
  const batchSize = Math.min(32, Math.ceil(trainRows.length / 4));
  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    // Shuffle
    const indices = X.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (let b = 0; b < indices.length; b += batchSize) {
      const batch = indices.slice(b, b + batchSize);
      const gradW = Array(N_FEATURES).fill(0) as number[];
      let gradB = 0;
      let weightSum = 0;
      for (const i of batch) {
        const z    = dotProduct(weights, X[i]) + bias;
        const pred = sigmoid(z);
        const w    = sampleWeights[i];
        const err  = (pred - y[i]) * w;  // Phase 23: scale error by sample weight
        for (let j = 0; j < N_FEATURES; j++) gradW[j] += err * X[i][j];
        gradB   += err;
        weightSum += w;
      }
      const effectiveBatch = Math.max(weightSum, 1);  // use weight-sum as effective batch size
      // Update with L2 regularisation (divided by effective batch weight sum)
      for (let j = 0; j < N_FEATURES; j++) {
        weights[j] -= LEARNING_RATE * (gradW[j] / effectiveBatch + LAMBDA * weights[j]);
      }
      bias -= LEARNING_RATE * (gradB / effectiveBatch);
    }
  }

  // In-sample accuracy — kept for backward compatibility/debugging only.
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = sigmoid(dotProduct(weights, X[i]) + bias) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  const accuracy = correct / X.length;

  // Out-of-sample holdout metrics — the numbers that should actually inform
  // whether this model is any good.
  let holdoutAccuracy: number | null = null;
  let holdoutAuc: number | null = null;
  let holdoutBrier: number | null = null;
  if (hasHoldout) {
    const Xh = holdoutRows.map(r => extractFeatures(r));
    const yh = holdoutRows.map(r => r.outcome === 'WIN' ? 1 : 0);
    const probsH = Xh.map(x => sigmoid(dotProduct(weights, x) + bias));
    let hCorrect = 0;
    for (let i = 0; i < Xh.length; i++) {
      if ((probsH[i] >= 0.5 ? 1 : 0) === yh[i]) hCorrect++;
    }
    holdoutAccuracy = hCorrect / Xh.length;
    holdoutAuc = computeAUC(probsH, yh);
    holdoutBrier = brierScore(probsH, yh);
  }

  const state: ModelState = {
    weights,
    bias,
    sampleCount: rows.length,
    trainedAt: Date.now(),
    accuracy,
    holdoutAccuracy,
    holdoutAuc,
    holdoutBrier,
    holdoutCount: holdoutRows.length,
  };

  // Persist to DB
  await run(
    `INSERT INTO ml_model_weights
       (model_name, trained_at, sample_count, feature_names, weights, bias, accuracy,
        holdout_accuracy, holdout_auc, holdout_brier, holdout_count)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [MODEL_NAME, rows.length, JSON.stringify(FEATURE_NAMES), JSON.stringify(weights), bias, accuracy,
     holdoutAccuracy, holdoutAuc, holdoutBrier, holdoutRows.length],
  ).catch(() => null);

  _model = state;
  logger.info({
    job: 'ml-model', samples: rows.length, trainRows: trainRows.length,
    inSampleAccuracy: (accuracy * 100).toFixed(1) + '%',
    holdoutAccuracy: holdoutAccuracy !== null ? (holdoutAccuracy * 100).toFixed(1) + '%' : 'n/a (insufficient data for holdout)',
    holdoutAuc: holdoutAuc !== null ? holdoutAuc.toFixed(3) : 'n/a',
    holdoutBrier: holdoutBrier !== null ? holdoutBrier.toFixed(3) : 'n/a',
    reason: 'Model trained and persisted',
  });
  return state;
}

/**
 * Load the most recent model from DB (for startup / cache miss).
 */
async function loadModelFromDB(): Promise<ModelState | null> {
  const row = await query(
    `SELECT weights, bias, sample_count, accuracy,
            holdout_accuracy, holdout_auc, holdout_brier, holdout_count,
            strftime('%s', trained_at) * 1000 as trained_ms
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
      holdoutAccuracy: row.holdout_accuracy != null ? Number(row.holdout_accuracy) : null,
      holdoutAuc: row.holdout_auc != null ? Number(row.holdout_auc) : null,
      holdoutBrier: row.holdout_brier != null ? Number(row.holdout_brier) : null,
      holdoutCount: Number(row.holdout_count ?? 0),
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
  /** P1.7: out-of-sample holdout accuracy/AUC — null when the model hasn't
   * had enough data for a chronological holdout split yet. Surfaced so
   * callers (e.g. modelLifecycle governance, admin dashboards) can tell a
   * genuinely validated model from one that's only been checked in-sample. */
  holdoutAccuracy: number | null;
  holdoutAuc: number | null;
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
    return { pWin: 0.5, meetsThreshold: true, modelAvailable: false, sampleCount: model?.sampleCount ?? 0,
      holdoutAccuracy: null, holdoutAuc: null };
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
    holdoutAccuracy: model.holdoutAccuracy,
    holdoutAuc: model.holdoutAuc,
  };
}
