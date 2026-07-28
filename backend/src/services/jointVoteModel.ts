/**
 * jointVoteModel.ts — joint cross-source logistic regression over
 * signal_vote_log (see adaptiveEngine.ts recordSignalVotes/resolveSignalVoteOutcomes
 * for how that table is populated).
 *
 * recalibrateWeights() in adaptiveEngine.ts can only ever learn each signal
 * source's own UNIVARIATE win rate — it has no way to learn that e.g.
 * news_llm matters less when trend_composite already agrees, because it
 * only ever sees one source's outcome at a time. This module fits a small
 * logistic regression jointly over all 5 votes + fundamental score,
 * mirroring mlProbabilityModel.ts's training loop exactly (same mini-batch
 * gradient descent + L2 + chronological holdout shape, just a different
 * table/feature set) — same reasoning: a tree ensemble or anything heavier
 * isn't needed here, and keeping the same shape keeps this serverless-
 * friendly with zero new dependencies.
 *
 * Each vote (bullish/bearish/neutral) is encoded as a signed feature
 * (+1/-1/0) rather than one-hot, so the model learns a single directional
 * coefficient per source — directly comparable to "how much should this
 * source's agreement move the odds of a win", which is exactly what
 * recalibrateWeights() needs to turn into a per-source weight.
 *
 * Persisted into the existing ml_model_weights table under a distinct
 * model_name (no new table needed — same schema already has everything:
 * weights, bias, holdout_accuracy/auc/brier, sample_count).
 *
 * IMPORTANT: this requires real resolved data to do anything useful. Until
 * MIN_TRAIN_SAMPLES resolved rows exist in signal_vote_log, trainJointVoteModel()
 * and getJointSourceWeights() are no-ops — recalibrateWeights() keeps using
 * the univariate Bayesian-shrinkage estimate. Check current row count with:
 *   SELECT COUNT(*) FROM signal_vote_log WHERE resolved = 1
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import { SIGNAL_SOURCES, type SignalSource } from './adaptiveEngine.js';

const MODEL_NAME = 'signal_vote_joint_v1';
// Order matters — matches the weights vector index-for-index.
const FEATURE_NAMES = ['rsi_vote', 'macd_vote', 'momentum_vote', 'news_vote', 'volume_vote', 'fundamental_norm'];
const N_FEATURES = FEATURE_NAMES.length;
// Per ROADMAP.md: wait for ≥200-300 resolved rows before fitting anything,
// same order of magnitude as mlProbabilityModel.ts's MIN_TRAIN_SAMPLES(30)
// scaled up — this table has far more categories (5 sources × 3 states) to
// disambiguate than that model's 7 mostly-continuous features.
const MIN_TRAIN_SAMPLES = 250;
const LEARNING_RATE = 0.05;
const LAMBDA = 0.01;
const MAX_EPOCHS = 200;

// Maps each of the 5 canonical adaptive-weight sources onto the vote column
// that best represents it, so the learned per-source coefficient can be
// turned back into a signal_weights row. news_llm and news_sentiment both
// map to the same news_vote column — they're not separately represented in
// ConsensusInput (see adaptiveEngine.ts computeConsensusMultiplier).
const SOURCE_TO_FEATURE_INDEX: Record<SignalSource, number> = {
  [SIGNAL_SOURCES.TREND_COMPOSITE]: 2, // momentum_vote
  [SIGNAL_SOURCES.PRICE_ACTION]:    0, // rsi_vote (closest proxy — no dedicated price-action vote column)
  [SIGNAL_SOURCES.VALUATION]:       5, // fundamental_norm
  [SIGNAL_SOURCES.NEWS_SENTIMENT]:  3, // news_vote
  [SIGNAL_SOURCES.NEWS_LLM]:        3, // news_vote
};

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}
function dotProduct(w: number[], x: number[]): number {
  return w.reduce((sum, wi, i) => sum + wi * (x[i] ?? 0), 0);
}
function voteToSigned(vote: string | null | undefined): number {
  return vote === 'bullish' ? 1 : vote === 'bearish' ? -1 : 0;
}

function extractFeatures(row: {
  rsi_vote?: string | null; macd_vote?: string | null; momentum_vote?: string | null;
  news_vote?: string | null; volume_vote?: string | null; fundamental_score?: number | null;
}): number[] {
  return [
    voteToSigned(row.rsi_vote), voteToSigned(row.macd_vote), voteToSigned(row.momentum_vote),
    voteToSigned(row.news_vote), voteToSigned(row.volume_vote),
    Math.max(0, Math.min(1, (row.fundamental_score ?? 50) / 100)),
  ];
}

interface JointModelState {
  weights: number[];
  bias: number;
  sampleCount: number;
  holdoutAccuracy: number | null;
  holdoutAuc: number | null;
  holdoutCount: number;
}

function brierScore(probs: number[], labels: number[]): number {
  if (probs.length === 0) return NaN;
  return probs.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0) / probs.length;
}
function computeAUC(probs: number[], labels: number[]): number | null {
  const pos = probs.filter((_, i) => labels[i] === 1);
  const neg = probs.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let concordant = 0, tied = 0;
  for (const p of pos) for (const n of neg) { if (p > n) concordant++; else if (p === n) tied++; }
  return (concordant + 0.5 * tied) / (pos.length * neg.length);
}

/**
 * Train the joint model. No-op (returns null) until MIN_TRAIN_SAMPLES
 * resolved rows exist — this is expected to be a no-op for a long time
 * after signal_vote_log's first deployment; that's fine, it's dormant
 * infrastructure waiting on real data, exactly like mlProbabilityModel.ts's
 * own MIN_TRAIN_SAMPLES gate.
 */
export async function trainJointVoteModel(): Promise<JointModelState | null> {
  const rows = await query(
    `SELECT rsi_vote, macd_vote, momentum_vote, news_vote, volume_vote, fundamental_score, outcome
     FROM signal_vote_log
     WHERE resolved = 1 AND outcome IN ('WIN','LOSS')
     ORDER BY signal_time DESC LIMIT 3000`,
  ).catch(() => []);

  if (rows.length < MIN_TRAIN_SAMPLES) {
    logger.info({ job: 'joint-vote-model', reason: `Insufficient resolved signal_vote_log rows: ${rows.length} (need ${MIN_TRAIN_SAMPLES})` });
    return null;
  }

  // Chronological holdout — same rationale as mlProbabilityModel.ts's P1.7 fix.
  const chronological = [...rows].reverse();
  const MIN_HOLDOUT = 20;
  const holdoutSize = Math.floor(chronological.length * 0.2);
  const hasHoldout = holdoutSize >= MIN_HOLDOUT && (chronological.length - holdoutSize) >= MIN_TRAIN_SAMPLES;
  const splitIdx = hasHoldout ? chronological.length - holdoutSize : chronological.length;
  const trainRows = chronological.slice(0, splitIdx);
  const holdoutRows = chronological.slice(splitIdx);

  const X = trainRows.map(r => extractFeatures(r));
  const y = trainRows.map(r => r.outcome === 'WIN' ? 1 : 0);

  let weights = Array(N_FEATURES).fill(0) as number[];
  let bias = 0;
  const batchSize = Math.min(32, Math.ceil(trainRows.length / 4));

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    const indices = X.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (let b = 0; b < indices.length; b += batchSize) {
      const batch = indices.slice(b, b + batchSize);
      const gradW = Array(N_FEATURES).fill(0) as number[];
      let gradB = 0;
      for (const i of batch) {
        const pred = sigmoid(dotProduct(weights, X[i]) + bias);
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

  let holdoutAccuracy: number | null = null;
  let holdoutAuc: number | null = null;
  let holdoutBrier: number | null = null;
  if (hasHoldout) {
    const Xh = holdoutRows.map(r => extractFeatures(r));
    const yh = holdoutRows.map(r => r.outcome === 'WIN' ? 1 : 0);
    const probsH = Xh.map(x => sigmoid(dotProduct(weights, x) + bias));
    holdoutAccuracy = probsH.filter((p, i) => (p >= 0.5 ? 1 : 0) === yh[i]).length / Xh.length;
    holdoutAuc = computeAUC(probsH, yh);
    holdoutBrier = brierScore(probsH, yh);
  }

  const state: JointModelState = {
    weights, bias, sampleCount: rows.length,
    holdoutAccuracy, holdoutAuc, holdoutCount: holdoutRows.length,
  };

  await run(
    `INSERT INTO ml_model_weights
       (model_name, trained_at, sample_count, feature_names, weights, bias, accuracy,
        holdout_accuracy, holdout_auc, holdout_brier, holdout_count)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [MODEL_NAME, rows.length, JSON.stringify(FEATURE_NAMES), JSON.stringify(weights), bias,
     hasHoldout ? (holdoutAccuracy ?? 0) : 0,
     holdoutAccuracy, holdoutAuc, holdoutBrier, holdoutRows.length],
  ).catch(() => null);

  logger.info({
    job: 'joint-vote-model', samples: rows.length, trainRows: trainRows.length,
    holdoutAccuracy: holdoutAccuracy !== null ? (holdoutAccuracy * 100).toFixed(1) + '%' : 'n/a',
    holdoutAuc: holdoutAuc !== null ? holdoutAuc.toFixed(3) : 'n/a',
    reason: 'Joint cross-source model trained and persisted',
  });
  return state;
}

let _cachedState: { state: JointModelState; ts: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function loadLatest(): Promise<JointModelState | null> {
  if (_cachedState && Date.now() - _cachedState.ts < CACHE_TTL_MS) return _cachedState.state;
  const row = await query(
    `SELECT weights, bias, sample_count, holdout_accuracy, holdout_auc, holdout_count
     FROM ml_model_weights WHERE model_name=? ORDER BY id DESC LIMIT 1`,
    [MODEL_NAME],
  ).then(r => r[0]).catch(() => null);
  if (!row) return null;
  try {
    const state: JointModelState = {
      weights: JSON.parse(String(row.weights)),
      bias: Number(row.bias),
      sampleCount: Number(row.sample_count),
      holdoutAccuracy: row.holdout_accuracy != null ? Number(row.holdout_accuracy) : null,
      holdoutAuc: row.holdout_auc != null ? Number(row.holdout_auc) : null,
      holdoutCount: Number(row.holdout_count ?? 0),
    };
    _cachedState = { state, ts: Date.now() };
    return state;
  } catch { return null; }
}

/**
 * Returns a per-source weight override map (same [0.3, 2.0] scale
 * recalibrateWeights() already uses) derived from the joint model's learned
 * coefficients, or null when there isn't yet a trained joint model (either
 * never trained, or trained on fewer than MIN_TRAIN_SAMPLES rows).
 *
 * Mapping: newWeight = clamp(0.3, 2.0, 1.0 + coefficient × 0.5). A source
 * with a learned coefficient of 0 (no independent signal once the others
 * are accounted for) stays neutral at 1.0, matching the univariate
 * estimator's same neutral-at-1.0 baseline. The 0.5 scale is a starting
 * point, not derived from anything — revisit once real coefficients exist
 * to see what range they actually land in.
 */
export async function getJointSourceWeights(): Promise<Map<SignalSource, number> | null> {
  const state = await loadLatest();
  if (!state || state.sampleCount < MIN_TRAIN_SAMPLES) return null;

  const result = new Map<SignalSource, number>();
  for (const source of Object.values(SIGNAL_SOURCES)) {
    const idx = SOURCE_TO_FEATURE_INDEX[source];
    const coef = state.weights[idx] ?? 0;
    result.set(source, Math.max(0.3, Math.min(2.0, 1.0 + coef * 0.5)));
  }
  return result;
}
