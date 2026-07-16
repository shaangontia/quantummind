/**
 * buildCandidateLabelPlan.ts — Phase 23: Centralised label-plan factory
 *
 * Produces a consistent CandidateLabelPlan for every candidate action type.
 * Prevents scattered logic across recordCandidate call sites and makes
 * learning weights and price-source semantics explicit and auditable.
 *
 * Usage:
 *   const plan = buildCandidateLabelPlan('SKIPPED', signal.price);
 *   await recordCandidate({ ...otherFields, ...plan });
 *
 * Price formulas (mirror the executed-trade path in marketMonitor.ts):
 *   stop   = price × (1 − 0.015 × 1.5)  = price × 0.9775   (~2.25% below)
 *   target = price × (1 + 0.015 × 3.0)  = price × 1.045    (~4.5% above, 2R)
 *
 * Learning weights:
 *   EXECUTED          → 1.0  (actual portfolio trade)
 *   SKIPPED           → 0.7  (ranked below daily limit / gated by hard safety rule)
 *   WEAK              → 0.5  (signal too weak to qualify)
 *   VETOED (soft)     → 0.3  (policy / ML / EV gate)
 *   VETOED (hard)     → 0.0  (Gemini risk=high, fundamental fraud block — analytics only)
 *
 * Validation occurs on executed-only rows to prevent shadow data from masking
 * real model performance. Promotion gates enforce a minimum executed-label count.
 */

export type PriceSource  = 'EXECUTED_FILL' | 'THEORETICAL_EVALUATION';
export type DataSource   = 'LIVE_PAPER_EXECUTED' | 'LIVE_PAPER_SHADOW' | 'POLICY_SIMULATION';
export type LabelQuality = 'ACTUAL_EXECUTED' | 'SHADOW_THEORETICAL' | 'SIMULATED_POLICY' | 'INVALID';
export type VetoType     = 'soft' | 'hard';

/** Label horizon: 15 trading days ≈ 21 calendar days */
const LABEL_HORIZON_DAYS = 15;
const CALENDAR_BUFFER    = 21; // calendar days used for label_ready_at date
const ATR_PCT            = 0.015;
const ATR_MULTIPLIER     = 1.5;
const TARGET_R_MULTIPLE  = 2.0;
const STOP_R_MULTIPLE    = 1.5;

export interface CandidateLabelPlan {
  entryPrice:       number;
  stopPrice:        number;
  targetPrice:      number;
  riskPerShare:     number;
  stopRMultiple:    number;
  targetRMultiple:  number;
  labelHorizonDays: number;
  labelReadyAt:     string;   // ISO date string
  priceSource:      PriceSource;
  dataSource:       DataSource;
  labelQuality:     LabelQuality;
  learningEligible: boolean;
  learningWeight:   number;
}

/**
 * Build a CandidateLabelPlan for any candidate action type.
 *
 * @param action     - The action taken (EXECUTED / SKIPPED / WEAK / VETOED)
 * @param signalPrice - Market price at time of evaluation
 * @param vetoType   - For VETOED only: 'hard' = learning_weight=0.0 (excluded from training)
 */
export function buildCandidateLabelPlan(
  action: 'EXECUTED' | 'SKIPPED' | 'WEAK' | 'VETOED',
  signalPrice: number,
  vetoType: VetoType = 'soft',
): CandidateLabelPlan {
  const stopPrice    = Math.round(signalPrice * (1 - ATR_PCT * ATR_MULTIPLIER) * 100) / 100;
  const riskPerShare = Math.round((signalPrice - stopPrice) * 100) / 100;
  const targetPrice  = Math.round(signalPrice * (1 + ATR_PCT * TARGET_R_MULTIPLE * ATR_MULTIPLIER) * 100) / 100;

  const labelReadyAt = new Date(Date.now() + CALENDAR_BUFFER * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);

  switch (action) {
    case 'EXECUTED':
      return {
        entryPrice: signalPrice, stopPrice, targetPrice, riskPerShare,
        stopRMultiple: STOP_R_MULTIPLE, targetRMultiple: TARGET_R_MULTIPLE,
        labelHorizonDays: LABEL_HORIZON_DAYS, labelReadyAt,
        priceSource:      'EXECUTED_FILL',
        dataSource:       'LIVE_PAPER_EXECUTED',
        labelQuality:     'ACTUAL_EXECUTED',
        learningEligible: true,
        learningWeight:   1.0,
      };

    case 'SKIPPED':
      return {
        entryPrice: signalPrice, stopPrice, targetPrice, riskPerShare,
        stopRMultiple: STOP_R_MULTIPLE, targetRMultiple: TARGET_R_MULTIPLE,
        labelHorizonDays: LABEL_HORIZON_DAYS, labelReadyAt,
        priceSource:      'THEORETICAL_EVALUATION',
        dataSource:       'LIVE_PAPER_SHADOW',
        labelQuality:     'SHADOW_THEORETICAL',
        learningEligible: true,
        learningWeight:   0.7,
      };

    case 'WEAK':
      return {
        entryPrice: signalPrice, stopPrice, targetPrice, riskPerShare,
        stopRMultiple: STOP_R_MULTIPLE, targetRMultiple: TARGET_R_MULTIPLE,
        labelHorizonDays: LABEL_HORIZON_DAYS, labelReadyAt,
        priceSource:      'THEORETICAL_EVALUATION',
        dataSource:       'LIVE_PAPER_SHADOW',
        labelQuality:     'SHADOW_THEORETICAL',
        learningEligible: true,
        learningWeight:   0.5,
      };

    case 'VETOED': {
      const isHard = vetoType === 'hard';
      return {
        entryPrice: signalPrice, stopPrice, targetPrice, riskPerShare,
        stopRMultiple: STOP_R_MULTIPLE, targetRMultiple: TARGET_R_MULTIPLE,
        labelHorizonDays: LABEL_HORIZON_DAYS, labelReadyAt,
        priceSource:      'THEORETICAL_EVALUATION',
        dataSource:       'LIVE_PAPER_SHADOW',
        labelQuality:     'SHADOW_THEORETICAL',
        learningEligible: !isHard,  // hard veto → analytics only, never trained on
        learningWeight:   isHard ? 0.0 : 0.3,
      };
    }
  }
}
