/**
 * decisionReplayWriter.ts — Phase 20: Decision Replay persistence
 *
 * Writes one decision_replay_events row + two decision_explanations rows
 * (visibility=USER and visibility=ADMIN) for every BUY, SELL, SKIP, and VETO.
 *
 * Idempotency key strategy (user spec):
 *   BUY/SKIP/VETO: candidate:{candidateId}:portfolio:{portfolioId}:{DECISION_TYPE}
 *   SELL:          trade:{tradeId}:order:{systemOrderId}:SELL
 *
 * INSERT OR IGNORE on idempotency_key — safe to call multiple times; the first
 * write wins. If policy evaluation store is called again for the same candidate,
 * the replay writer will silently skip the duplicate.
 *
 * Note on SELL policyEvaluationId:
 *   SELL decisions have no portfolio_policy_evaluations row (those exist only
 *   for BUY candidates). Pass null — the replay event links via trade_id instead.
 */

import { run, queryOne } from '../db/turso.js';
import type { EvaluationDecision } from './policyEvaluationStore.js';
import type { PolicyType } from './portfolioPolicy.js';
import type { StrategyType } from './strategyClassifier.js';
import {
  EXPLANATION_VERSION,
  generateUserExplanation,
  buildAdminTrace,
  type DecisionContext,
} from './explanationGenerator.js';

// ── Input type ────────────────────────────────────────────────────────────────

export interface WriteReplayParams {
  // Identifiers
  candidateId: number;
  portfolioId: number;
  policyEvaluationId: number | null; // null for SELL
  tradeId: number | null;            // non-null for BUY execution + SELL

  // Decision
  decisionType: EvaluationDecision | 'SELL';
  decisionTime: Date;

  // Policy context
  policyType: PolicyType | null;
  policyVersion: string | null;
  portfolioMode: string | null;
  positionSizePct: number | null;

  // Signal / feature inputs (passed through to DecisionContext)
  symbol: string;
  price: number | null;
  rsiValue: number | null;
  macdHistogram: number | null;
  volumeRatio: number | null;
  atrPct: number | null;
  fundamentalScore: number | null;
  marketRegime: string | null;
  strategyType: StrategyType | null;
  strategyConfidence: number | null;
  strategyReasonCodes: string[] | null;

  // ML state
  mlPwin: number | null;
  modelStage: string | null;
  trainingRows: number | null;
  modelVersion: string | null;

  // Eligibility + utility
  eligibilityGateResults: Array<{ gate: string; passed: boolean; reason?: string }>;
  utilityComponents: {
    expectedValuePct: number | null;
    strategyFitMultiplier: number | null;
    horizonFitMultiplier: number | null;
    regimeFitMultiplier: number | null;
    volatilityPenalty: number | null;
    drawdownPenalty: number | null;
    sectorConcentrationPenalty: number | null;
    liquidityPenalty: number | null;
    finalScore: number | null;
  };
  rejectionReasons: string[];
  selectionReason: string | null;

  // Risk snapshot
  killSwitchFlags: Record<string, boolean>;
  stopPrice: number | null;
  targetPrice: number | null;
  riskAmountInr: number | null;
  drawdownPct: number | null;

  // LLM (optional)
  llmVerdict: string | null;
  llmReasonCodes: string[] | null;
  llmModel: string | null;
  llmPromptVersion: string | null;
  llmConfidence: number | null;

  // Execution (BUY/SELL only)
  execution: {
    quantity?: number | null;
    averagePrice?: number | null;
    averageFillPrice?: number | null;
    brokerage?: number | null;
    slippagePct?: number | null;
    costAdjustedReturnPct?: number | null;
    orderType?: string | null;
    signalPrice?: number | null;
    intendedPrice?: number | null;
    executionPrice?: number | null;
    systemOrderId?: string | null;
    brokerOrderId?: string | null;
    brokerName?: string | null;
    fillStatus?: 'FULL' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'FAILED' | null;
    quantityRequested?: number | null;
    quantityFilled?: number | null;
    fees?: {
      brokerage?: number | null | undefined;
      stt?: number | null | undefined;
      exchangeCharges?: number | null | undefined;
      sebiCharges?: number | null | undefined;
      gst?: number | null | undefined;
      stampDuty?: number | null | undefined;
      totalCharges?: number | null | undefined;
    } | null;
    grossPnl?: number | null;
    netPnl?: number | null;
    grossReturnPct?: number | null;
    orderPlacedAt?: string | null;
    orderFilledAt?: string | null;
    latencyMs?: number | null;
    rejectionReason?: string | null;
    brokerErrorCode?: string | null;
  } | null;

  // SELL result
  exitType: string | null;
  exitPrice: number | null;
  grossReturnPct: number | null;
  costAdjustedReturnPct: number | null;
  holdingDays: number | null;
  entryPrice: number | null;

  // Strategy classifier version
  strategyClassifierVersion: string | null;
}

// ── Idempotency key builders ──────────────────────────────────────────────────

function buildIdempotencyKey(params: WriteReplayParams): string {
  if (params.decisionType === 'SELL') {
    const orderId = params.execution?.systemOrderId ?? 'nosys';
    const tradeId = params.tradeId ?? 'notrade';
    return `trade:${tradeId}:order:${orderId}:SELL`;
  }
  return `candidate:${params.candidateId}:portfolio:${params.portfolioId}:${params.decisionType}`;
}

// ── Source type mapping ───────────────────────────────────────────────────────

function resolveSource(params: WriteReplayParams): { sourceType: string; sourceId: string } {
  if (params.decisionType === 'SELL') {
    return { sourceType: 'TRADE', sourceId: String(params.tradeId ?? params.candidateId) };
  }
  if (params.decisionType === 'BUY' && params.tradeId) {
    return { sourceType: 'TRADE', sourceId: String(params.tradeId) };
  }
  return { sourceType: 'CANDIDATE', sourceId: String(params.candidateId) };
}

// ── Main writer ───────────────────────────────────────────────────────────────

/**
 * Persists a decision replay event and its USER + ADMIN explanation rows.
 * Returns the decision_replay_events.id, or null if skipped (duplicate).
 * Never throws — all errors are caught and logged; missing replay data must
 * not affect the trading loop.
 */
export async function writeDecisionReplay(params: WriteReplayParams): Promise<number | null> {
  try {
    const idempotencyKey = buildIdempotencyKey(params);
    const { sourceType, sourceId } = resolveSource(params);

    // Build the full DecisionContext for both generator functions
    const ctx: DecisionContext = {
      symbol:                   params.symbol,
      decisionType:             params.decisionType,
      policyType:               params.policyType,
      portfolioMode:            params.portfolioMode,
      positionSizePct:          params.positionSizePct,
      price:                    params.price,
      rsiValue:                 params.rsiValue,
      macdHistogram:            params.macdHistogram,
      volumeRatio:              params.volumeRatio,
      atrPct:                   params.atrPct,
      fundamentalScore:         params.fundamentalScore,
      marketRegime:             params.marketRegime,
      strategyType:             params.strategyType,
      strategyConfidence:       params.strategyConfidence,
      strategyReasonCodes:      params.strategyReasonCodes,
      mlPwin:                   params.mlPwin,
      modelStage:               params.modelStage,
      trainingRows:             params.trainingRows,
      modelVersion:             params.modelVersion,
      eligibilityGateResults:   params.eligibilityGateResults,
      utilityComponents:        params.utilityComponents,
      rejectionReasons:         params.rejectionReasons,
      killSwitchFlags:          params.killSwitchFlags,
      stopPrice:                params.stopPrice,
      targetPrice:              params.targetPrice,
      riskAmountInr:            params.riskAmountInr,
      drawdownPct:              params.drawdownPct,
      llmVerdict:               params.llmVerdict,
      llmReasonCodes:           params.llmReasonCodes,
      llmModel:                 params.llmModel,
      llmPromptVersion:         params.llmPromptVersion,
      llmConfidence:            params.llmConfidence,
      execution:                params.execution,
      exitType:                 params.exitType,
      exitPrice:                params.exitPrice,
      grossReturnPct:           params.grossReturnPct,
      costAdjustedReturnPct:    params.costAdjustedReturnPct,
      holdingDays:              params.holdingDays,
      entryPrice:               params.entryPrice,
    };

    // Generate user + admin artefacts
    const userExp   = generateUserExplanation(ctx);
    const adminTrace = buildAdminTrace(ctx);

    // Serialize admin blobs
    const adminTraceJson          = JSON.stringify(adminTrace);
    const rawFeatureSnapshotJson  = JSON.stringify(adminTrace.featureSnapshot);
    const modelTraceJson          = JSON.stringify(adminTrace.modelTrace);
    const ruleTraceJson           = JSON.stringify(adminTrace.ruleTrace);
    const llmTraceJson            = JSON.stringify(adminTrace.llmTrace);
    const riskTraceJson           = JSON.stringify(adminTrace.riskTrace);
    const executionTraceJson      = adminTrace.executionTrace
      ? JSON.stringify(adminTrace.executionTrace) : null;

    // Insert main event row (INSERT OR IGNORE — idempotency_key is UNIQUE)
    const eventResult = await run(
      `INSERT OR IGNORE INTO decision_replay_events (
        candidate_id, portfolio_id, policy_evaluation_id,
        decision_type, decision_time,
        source_type, source_id, trade_id, order_id,
        user_summary, user_reason_codes_json,
        admin_trace_json, raw_feature_snapshot_json, model_trace_json,
        rule_trace_json, llm_trace_json, risk_trace_json, execution_trace_json,
        explanation_version, model_version, policy_version, strategy_classifier_version,
        idempotency_key
      ) VALUES (
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )`,
      [
        params.candidateId, params.portfolioId, params.policyEvaluationId ?? null,
        params.decisionType, params.decisionTime.toISOString(),
        sourceType, sourceId, params.tradeId ?? null, params.execution?.systemOrderId ?? null,
        userExp.summary, JSON.stringify(userExp.reasonCodes),
        adminTraceJson, rawFeatureSnapshotJson, modelTraceJson,
        ruleTraceJson, llmTraceJson, riskTraceJson, executionTraceJson,
        EXPLANATION_VERSION, params.modelVersion, params.policyVersion, params.strategyClassifierVersion,
        idempotencyKey,
      ],
    );

    const eventId = eventResult.lastInsertRowid;
    if (!eventId) {
      // Row already existed (INSERT OR IGNORE suppressed) — retrieve existing id
      const existing = await queryOne(
        'SELECT id FROM decision_replay_events WHERE idempotency_key = ?',
        [idempotencyKey],
      );
      return existing ? Number(existing.id) : null;
    }

    // Insert USER explanation row
    await run(
      `INSERT OR IGNORE INTO decision_explanations
        (decision_replay_event_id, visibility, title, summary, reason_codes_json, metrics_json)
       VALUES (?, 'USER', ?, ?, ?, ?)`,
      [
        eventId,
        userExp.title,
        userExp.summary,
        JSON.stringify(userExp.reasonCodes),
        JSON.stringify({
          policyType:             params.policyType,
          portfolioMode:          params.portfolioMode,
          positionSizePct:        params.positionSizePct,
          entryPrice:             params.entryPrice,
          exitPrice:              params.exitPrice,
          grossReturnPct:         params.grossReturnPct,
          costAdjustedReturnPct:  params.costAdjustedReturnPct,
          holdingDays:            params.holdingDays,
        }),
      ],
    );

    // Insert ADMIN explanation row (full trace + versions)
    await run(
      `INSERT OR IGNORE INTO decision_explanations
        (decision_replay_event_id, visibility, title, summary, reason_codes_json, metrics_json)
       VALUES (?, 'ADMIN', ?, ?, ?, ?)`,
      [
        eventId,
        `[ADMIN] ${userExp.title}`,
        userExp.summary,
        JSON.stringify(userExp.reasonCodes),
        JSON.stringify({
          // Admin metrics — includes all technical details
          selectionReason:           params.selectionReason,
          utilityComponents:         params.utilityComponents,
          eligibilityGateResults:    params.eligibilityGateResults,
          mlPwin:                    params.mlPwin,
          modelStage:                params.modelStage,
          trainingRows:              params.trainingRows,
          modelVersion:              params.modelVersion,
          policyVersion:             params.policyVersion,
          strategyClassifierVersion: params.strategyClassifierVersion,
          strategyType:              params.strategyType,
          strategyConfidence:        params.strategyConfidence,
          rejectionReasons:          params.rejectionReasons,
          killSwitchFlags:           params.killSwitchFlags,
          stopPrice:                 params.stopPrice,
          targetPrice:               params.targetPrice,
        }),
      ],
    );

    return eventId;
  } catch (err) {
    // Never throw — replay writer must not break the trading loop
    console.error('[decisionReplayWriter] Error writing replay event:', String(err));
    return null;
  }
}
