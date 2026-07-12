/**
 * portfolioRecommendationService.ts — Phase 21: Recommendations + Top Risks
 *
 * Generates user-facing plain-English recommendations and machine-readable
 * top-risk codes from health component scores, kill-switch state, model
 * stage, and goal probability.
 *
 * User messages must be simple and actionable. Admin calculation_trace_json
 * contains the full diagnostic context if needed.
 *
 * Alert creation: CRITICAL-severity findings create portfolio_health_alerts
 * rows (INSERT OR IGNORE on OPEN alert of same type — one alert per type per portfolio).
 */

import { queryOne, run } from '../db/turso.js';
import type { HealthComponents } from './portfolioHealthService.js';
import type { PortfolioPolicy } from './portfolioPolicy.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Recommendation {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  code:     string;
  message:  string;
  action:   string;
}

export interface RecommendationInput {
  components:            HealthComponents;
  policy:                PortfolioPolicy | null;
  ksState:               Record<string, any>;
  modelStage:            string;
  goalProbabilityPct:    number | null;
  goalImpossible:        boolean;
  currentDrawdownPct:    number;
  cashPct:               number;
  maxSectorPct:          number;
  maxSectorName:         string | null;
  targetReturnPct:       number | null;
  requiredMonthlyReturnPct: number | null;
  strategyExposure:      Record<string, number>;
  // Phase 22: Virtual safety state (optional — degraded gracefully if absent)
  virtualLedgerStatus?:  'HEALTHY' | 'WARNING' | 'MISMATCH' | 'FAILED' | null;
  virtualNewBuysBlocked?: boolean;
  executionQualityScore?: number;
}

// ── Risk code ordering for severity sorting ────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  WARNING:  1,
  INFO:     2,
};

// ── Recommendation generators ─────────────────────────────────────────────────

export function generateRecommendations(input: RecommendationInput): Recommendation[] {
  const {
    components, ksState, modelStage, goalProbabilityPct, goalImpossible,
    currentDrawdownPct, cashPct, maxSectorPct, maxSectorName,
    targetReturnPct, requiredMonthlyReturnPct, strategyExposure,
  } = input;

  const recs: Recommendation[] = [];

  // ── Kill-switch active ───────────────────────────────────────────────────
  const activeFlags: string[] = [];
  if (ksState.dailyLossHalted)          activeFlags.push('daily loss halt');
  if (ksState.weeklyLossHalted)         activeFlags.push('weekly loss halt');
  if (ksState.drawdownPaused)           activeFlags.push('drawdown pause');
  if (ksState.drawdownProtection)       activeFlags.push('drawdown protection');
  if (ksState.consecutiveLossCooldown)  activeFlags.push('consecutive-loss cooldown');
  if (ksState.circuitBreakerActive)     activeFlags.push('circuit breaker');
  if (ksState.dataStaleHalted)          activeFlags.push('stale data halt');

  if (activeFlags.length > 0) {
    const sev: 'CRITICAL' | 'WARNING' = ksState.circuitBreakerActive || ksState.drawdownProtection
      ? 'CRITICAL' : 'WARNING';
    recs.push({
      severity: sev,
      code:     'KILL_SWITCH_ACTIVE',
      message:  `Trading is partially paused: ${activeFlags.join(', ')}. Risk controls are protecting the portfolio.`,
      action:   'MONITOR_KILL_SWITCH',
    });
  }

  if (ksState.emergencyLiquidationTriggered) {
    recs.push({
      severity: 'CRITICAL',
      code:     'EMERGENCY_LIQUIDATION_ACTIVE',
      message:  'Emergency liquidation is active. Positions are being closed to protect against further drawdown.',
      action:   'REVIEW_PORTFOLIO_IMMEDIATELY',
    });
  }

  // ── Drawdown ─────────────────────────────────────────────────────────────
  if (currentDrawdownPct > 5) {
    const sev: 'CRITICAL' | 'WARNING' = currentDrawdownPct > 10 ? 'CRITICAL' : 'WARNING';
    recs.push({
      severity: sev,
      code:     'DRAWDOWN_RISK_HIGH',
      message:  `Portfolio is ${currentDrawdownPct.toFixed(1)}% below peak. Risk controls are monitoring closely.`,
      action:   'REDUCE_RISK_EXPOSURE',
    });
  }

  // ── Sector concentration ─────────────────────────────────────────────────
  if (maxSectorPct > 25 && maxSectorName) {
    const sev: 'CRITICAL' | 'WARNING' = maxSectorPct > 35 ? 'CRITICAL' : 'WARNING';
    const threshold = maxSectorPct > 35 ? 30 : 25;
    recs.push({
      severity: sev,
      code:     'SECTOR_CONCENTRATION_HIGH',
      message:  `${maxSectorName} exposure is ${maxSectorPct.toFixed(0)}%, above the ${threshold}% target for this portfolio. New ${maxSectorName} buys should be limited.`,
      action:   'REDUCE_NEW_SECTOR_EXPOSURE',
    });
  }

  // ── Goal probability ─────────────────────────────────────────────────────
  if (goalImpossible && targetReturnPct) {
    recs.push({
      severity: 'CRITICAL',
      code:     'GOAL_IMPOSSIBLE',
      message:  `Goal probability is very low because a ${targetReturnPct}% target return is not compatible with the configured risk limits and time horizon.`,
      action:   'ADJUST_TARGET_OR_HORIZON',
    });
  } else if (goalProbabilityPct != null && goalProbabilityPct < 20) {
    recs.push({
      severity: 'CRITICAL',
      code:     'GOAL_PROBABILITY_LOW',
      message:  `Goal probability is ${goalProbabilityPct}%. Required monthly return of ${requiredMonthlyReturnPct?.toFixed(2) ?? '?'}% is very high — consider adjusting the target return or investment horizon.`,
      action:   'ADJUST_TARGET_OR_HORIZON',
    });
  } else if (goalProbabilityPct != null && goalProbabilityPct < 40) {
    recs.push({
      severity: 'WARNING',
      code:     'GOAL_PROBABILITY_LOW',
      message:  `Goal probability is ${goalProbabilityPct}%. Required monthly return of ${requiredMonthlyReturnPct?.toFixed(2) ?? '?'}% is elevated.`,
      action:   'MONITOR_PROGRESS',
    });
  }

  // ── Model confidence ─────────────────────────────────────────────────────
  if (modelStage === 'CANDIDATE' || modelStage === 'SHADOW') {
    recs.push({
      severity: 'INFO',
      code:     'MODEL_CONFIDENCE_LOW',
      message:  `Model is still in ${modelStage.toLowerCase()} mode. Position sizes are capped until sufficient trade history accumulates.`,
      action:   'CONTINUE_PAPER_TRADING',
    });
  }

  // ── Cash deployment ──────────────────────────────────────────────────────
  if (cashPct > 70) {
    recs.push({
      severity: 'INFO',
      code:     'CASH_TOO_HIGH',
      message:  `Cash is ${cashPct.toFixed(0)}% of the portfolio. Capital will be deployed as eligible candidates appear.`,
      action:   'AWAIT_SIGNALS',
    });
  } else if (cashPct < 5) {
    recs.push({
      severity: 'WARNING',
      code:     'CASH_TOO_LOW',
      message:  'Cash reserve is below 5%. Portfolio has limited capacity to respond to new opportunities or cover emergency exits.',
      action:   'REVIEW_POSITION_SIZES',
    });
  }

  // ── Strategy imbalance ────────────────────────────────────────────────────
  const stratValues = Object.values(strategyExposure);
  if (stratValues.length > 0) {
    const maxStratPct = Math.max(...stratValues);
    if (maxStratPct > 70) {
      const dominantStrategy = Object.entries(strategyExposure).find(([, v]) => v === maxStratPct)?.[0];
      recs.push({
        severity: 'WARNING',
        code:     'STRATEGY_IMBALANCE',
        message:  `${dominantStrategy ?? 'One strategy'} accounts for ${maxStratPct.toFixed(0)}% of current exposure. Portfolio is concentrated in a single signal type.`,
        action:   'DIVERSIFY_STRATEGY_MIX',
      });
    }
  }

  // ── Execution quality (Phase 22 placeholder) ─────────────────────────────
  if (components.executionQualityScore < 60) {
    recs.push({
      severity: 'WARNING',
      code:     'EXECUTION_QUALITY_LOW',
      message:  'Execution quality score is low. Review recent order fills and slippage data.',
      action:   'REVIEW_EXECUTION_DATA',
    });
  }

  // Sort: CRITICAL → WARNING → INFO
  recs.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2));

  // Create CRITICAL alerts (async, fire-and-forget — health calc must not fail on alert errors)
  for (const rec of recs.filter(r => r.severity === 'CRITICAL')) {
    // Called inline — portfolioId is not in scope here; caller must handle alert creation separately
    // This function returns the recommendations; alert creation is done in the caller (portfolioHealthService)
    void 0;
  }

  // ── Phase 22: Virtual ledger + execution quality ──────────────────────
  const { virtualLedgerStatus, virtualNewBuysBlocked, executionQualityScore } = input;

  if (virtualLedgerStatus === 'MISMATCH' || virtualLedgerStatus === 'FAILED') {
    recs.push({
      severity: 'CRITICAL',
      code:     'VIRTUAL_LEDGER_MISMATCH',
      message:  `Virtual ledger mismatch detected. New BUY orders are paused until cash, positions, NAV, and exit plans are reconciled.`,
      action:   'REVIEW_VIRTUAL_LEDGER',
    });
  } else if (virtualLedgerStatus === 'WARNING') {
    recs.push({
      severity: 'WARNING',
      code:     'VIRTUAL_LEDGER_MISMATCH',
      message:  `Minor virtual ledger discrepancy detected. Trading continues but reconciliation is recommended.`,
      action:   'REVIEW_VIRTUAL_LEDGER',
    });
  }

  if (executionQualityScore != null && executionQualityScore < 70) {
    const sev: 'CRITICAL' | 'WARNING' = executionQualityScore < 50 ? 'CRITICAL' : 'WARNING';
    recs.push({
      severity: sev,
      code:     'HIGH_SIMULATED_SLIPPAGE',
      message:  `Virtual execution quality is ${executionQualityScore}/100. High simulated slippage or rejected orders are reducing realistic returns.`,
      action:   'REVIEW_EXECUTION_QUALITY',
    });
  }

  return recs.slice(0, 8); // cap at 8 recommendations
}

/** Returns top risk codes sorted by severity (CRITICAL first) — max 4 */
export function deriveTopRisks(
  components: HealthComponents,
  ksState:    Record<string, any>,
  modelStage: string,
  goalProbabilityPct: number | null,
): string[] {
  const risks: Array<{ code: string; severity: number; score: number }> = [];

  const add = (code: string, severity: 'CRITICAL' | 'WARNING' | 'INFO', score: number) =>
    risks.push({ code, severity: SEVERITY_ORDER[severity], score });

  // Critical-level risks first
  if (ksState.emergencyLiquidationTriggered) add('EMERGENCY_LIQUIDATION_ACTIVE', 'CRITICAL', 0);
  if (ksState.circuitBreakerActive)          add('CIRCUIT_BREAKER_ACTIVE', 'CRITICAL', 0);
  if (ksState.drawdownProtection)            add('DRAWDOWN_PROTECTION_ACTIVE', 'CRITICAL', 0);
  if (goalProbabilityPct != null && goalProbabilityPct < 20) add('GOAL_PROBABILITY_LOW', 'CRITICAL', goalProbabilityPct);

  // Component-based risks
  if (components.modelConfidenceScore < 40)    add('MODEL_CONFIDENCE_LOW', 'WARNING', components.modelConfidenceScore);
  if (components.drawdownScore < 50)           add('DRAWDOWN_RISK_HIGH', 'WARNING', components.drawdownScore);
  if (components.diversificationScore < 50)   add('DIVERSIFICATION_LOW', 'WARNING', components.diversificationScore);
  if (components.cashDeploymentScore < 60)     add('CASH_DEPLOYMENT_MODERATE', 'INFO', components.cashDeploymentScore);
  if (components.goalProgressScore < 50)       add('GOAL_PROGRESS_BEHIND', 'WARNING', components.goalProgressScore);
  if (components.strategyBalanceScore < 50)    add('STRATEGY_IMBALANCE', 'WARNING', components.strategyBalanceScore);
  if (components.riskControlScore < 50)        add('RISK_CONTROL_DEGRADED', 'WARNING', components.riskControlScore);
  if (goalProbabilityPct != null && goalProbabilityPct < 40 && goalProbabilityPct >= 20)
    add('GOAL_PROBABILITY_LOW', 'WARNING', goalProbabilityPct);

  // Kill-switch warnings
  if (ksState.dailyLossHalted || ksState.weeklyLossHalted) add('KILL_SWITCH_ACTIVE', 'WARNING', 0);
  if (ksState.dataStaleHalted) add('DATA_STALE_HALTED', 'WARNING', 0);

  // Model stage info
  if (modelStage === 'CANDIDATE' || modelStage === 'SHADOW') add('MODEL_CONFIDENCE_LOW', 'INFO', 0);

  // Deduplicate + sort by severity then score
  const seen = new Set<string>();
  const unique = risks.filter(r => { if (seen.has(r.code)) return false; seen.add(r.code); return true; });
  unique.sort((a, b) => a.severity !== b.severity ? a.severity - b.severity : a.score - b.score);

  return unique.slice(0, 4).map(r => r.code);
}

/**
 * Creates a CRITICAL health alert if one of the same type is not already OPEN.
 * Safe to call from portfolioHealthService after calculating recommendations.
 */
export async function createHealthAlertIfNeeded(params: {
  portfolioId: number;
  alertType:   string;
  severity:    'INFO' | 'WARNING' | 'CRITICAL';
  message:     string;
  reasonCodes: string[];
}): Promise<void> {
  const { portfolioId, alertType, severity, message, reasonCodes } = params;
  try {
    const existing = await queryOne(
      "SELECT id FROM portfolio_health_alerts WHERE portfolio_id=? AND alert_type=? AND status='OPEN' LIMIT 1",
      [portfolioId, alertType],
    );
    if (existing) return; // already an open alert of this type
    await run(
      `INSERT INTO portfolio_health_alerts (portfolio_id, alert_type, severity, message, reason_codes_json)
       VALUES (?, ?, ?, ?, ?)`,
      [portfolioId, alertType, severity, message, JSON.stringify(reasonCodes)],
    );
  } catch { /* alert creation must never fail health job */ }
}
