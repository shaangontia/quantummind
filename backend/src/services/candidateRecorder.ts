/**
 * candidateRecorder.ts — Phase 15: Candidate-level training data collection
 *
 * Records EVERY BUY candidate evaluated per cycle, regardless of outcome:
 *   EXECUTED   — trade was placed
 *   VETOED     — Gemini risk=high, fundamental veto, EV gate, ML gate
 *   WEAK       — score < threshold, regime blocked, strategy mismatch
 *   SKIPPED    — liquidity gate, kill-switch, earnings blackout, ASM/GSM
 *
 * This gives candidate-level training data, eliminating the selection bias
 * of training only on executed trades.
 *
 * Nightly, the label generator fills in:
 *   target_hit_before_stop
 *   max_adverse_excursion_pct
 *   max_favorable_excursion_pct
 *   cost_adjusted_return_pct
 */

import { run } from '../db/turso.js';
import type { PriceSource, DataSource, LabelQuality } from './buildCandidateLabelPlan.js';

export type CandidateAction = 'EXECUTED' | 'VETOED' | 'WEAK' | 'SKIPPED';

export interface CandidateRecord {
  portfolioId: number;
  symbol: string;
  strategyType?: string | null;
  signalScore: number;
  rsiValue?: number | null;
  volumeRatio?: number | null;
  marketRegime?: string | null;
  fundamentalScore?: number | null;
  atrPct?: number | null;
  dma20Pct?: number | null;
  dma50Pct?: number | null;
  dist52wLowPct?: number | null;
  llmRiskLevel?: string | null;
  llmNewsEventType?: string | null;
  filtersPassed: string[];
  filtersBlocked: string[];
  actionTaken: CandidateAction;
  entryPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  predictionPwin?: number | null;       // Phase 16: ML win probability at evaluation time
  modelVersion?: string | null;
  // Phase 19: strategy classifier enrichment
  strategyConfidence?: number | null;
  strategyReasonCodes?: string[] | null;
  strategyClassifierVersion?: string | null;
  strategySource?: string | null;        // 'REAL_TIME_CLASSIFIER' | 'INFERRED_BACKFILL'
  // Phase 23: Shadow label learning
  priceSource?:      PriceSource | null;
  dataSource?:       DataSource | null;
  labelQuality?:     LabelQuality | null;
  learningEligible?: boolean;
  learningWeight?:   number | null;
  labelHorizonDays?: number | null;
  labelReadyAt?:     string | null;
  riskPerShare?:     number | null;
  stopRMultiple?:    number | null;
  targetRMultiple?:  number | null;
}

/**
 * Record a candidate evaluation result.
 * Returns the inserted row id (0 on failure).
 * The caller may use the id to link portfolio_policy_evaluations.
 */
export async function recordCandidate(c: CandidateRecord): Promise<number> {
  const result = await run(
    `INSERT INTO trade_candidates
       (portfolio_id, symbol, strategy_type, signal_score, rsi_value, volume_ratio,
        market_regime, fundamental_score, atr_pct, dma20_pct, dma50_pct, dist_52w_low_pct,
        llm_risk_level, llm_news_event_type, filters_passed, filters_blocked, action_taken,
        entry_price, stop_price, target_price, prediction_pwin, model_version,
        strategy_confidence, strategy_reason_codes_json, strategy_classifier_version, strategy_source,
        price_source, data_source, label_quality, learning_eligible, learning_weight,
        label_horizon_days, label_ready_at, risk_per_share, stop_r_multiple, target_r_multiple)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c.portfolioId, c.symbol,
      c.strategyType ?? null, c.signalScore,
      c.rsiValue ?? null, c.volumeRatio ?? null,
      c.marketRegime ?? null, c.fundamentalScore ?? null,
      c.atrPct ?? null, c.dma20Pct ?? null, c.dma50Pct ?? null, c.dist52wLowPct ?? null,
      c.llmRiskLevel ?? null, c.llmNewsEventType ?? null,
      JSON.stringify(c.filtersPassed), JSON.stringify(c.filtersBlocked),
      c.actionTaken,
      c.entryPrice ?? null,
      c.stopPrice ?? null,
      c.targetPrice ?? null,
      c.predictionPwin ?? null,
      c.modelVersion ?? 'buy_win_probability_v1',
      c.strategyConfidence ?? null,
      c.strategyReasonCodes ? JSON.stringify(c.strategyReasonCodes) : null,
      c.strategyClassifierVersion ?? null,
      c.strategySource ?? 'REAL_TIME_CLASSIFIER',
      // Phase 23: shadow label fields
      c.priceSource ?? null,
      c.dataSource ?? null,
      c.labelQuality ?? null,
      c.learningEligible ? 1 : 0,
      c.learningWeight ?? 0.0,
      c.labelHorizonDays ?? 15,
      c.labelReadyAt ?? null,
      c.riskPerShare ?? null,
      c.stopRMultiple ?? null,
      c.targetRMultiple ?? null,
    ],
  ).catch(() => ({ lastInsertRowid: 0 }));
  return result.lastInsertRowid;
}
