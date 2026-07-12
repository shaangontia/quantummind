/**
 * portfolioHealthService.ts — Phase 21: Portfolio Health + Goal Probability
 *
 * Calculates an explainable health score (0–100) composed of 8 weighted components.
 * Health snapshots are persisted in portfolio_health_snapshots for historical trending.
 *
 * HEALTH_MODEL_VERSION = 'health-v1'
 * Weights are loaded from health_score_configs WHERE is_active=1.
 *
 * Component weights (default, health-v1):
 *   diversification  0.15
 *   drawdown         0.20
 *   goalProgress     0.15
 *   strategyBalance  0.10
 *   cashDeployment   0.10
 *   executionQuality 0.10
 *   modelConfidence  0.10
 *   riskControl      0.10
 */

import { query, queryOne, run } from '../db/turso.js';
import { getPortfolioSummary } from './tradingEngine.js';
import { evaluateKillSwitch } from './killSwitch.js';
import { getModelGovernanceState } from './modelLifecycle.js';
import { getPortfolioPolicy } from './portfolioPolicy.js';
import { classifyMarketRegime } from './regimeEngine.js';
import { getWalkForwardResults } from './walkForwardEngine.js';
import { calculateGoalProbability } from './goalProbabilityService.js';
import { generateRecommendations, deriveTopRisks } from './portfolioRecommendationService.js';
import type { PortfolioPolicy } from './portfolioPolicy.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const HEALTH_MODEL_VERSION = 'health-v1';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthGrade = 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL';

export interface HealthComponents {
  diversificationScore:  number;
  concentrationScore:    number;
  drawdownScore:         number;
  goalProgressScore:     number;
  strategyBalanceScore:  number;
  cashDeploymentScore:   number;
  executionQualityScore: number;
  modelConfidenceScore:  number;
  riskControlScore:      number;
}

export interface PortfolioHealthSnapshot {
  portfolioId:              number;
  healthScore:              number;
  healthGrade:              HealthGrade;
  goalProbabilityPct:       number | null;
  goalImpossible:           boolean;
  goalImpossibilityReason:  string | null;
  targetReturnPct:          number | null;
  horizonDays:              number | null;
  daysRemaining:            number | null;
  requiredMonthlyReturnPct: number | null;
  currentNav:               number;
  initialCapital:           number;
  currentReturnPct:         number;
  currentDrawdownPct:       number;
  cashPct:                  number;
  investedPct:              number;
  openPositionsCount:       number;
  components:               HealthComponents;
  sectorExposureJson:       string | null;
  strategyExposureJson:     string | null;
  topRisks:                 string[];
  recommendations:          Array<{ severity: string; code: string; message: string; action: string }>;
  snapshotTime:             string;
  healthModelVersion:       string;
}

interface HealthWeights {
  diversification:  number;
  drawdown:         number;
  goalProgress:     number;
  strategyBalance:  number;
  cashDeployment:   number;
  executionQuality: number;
  modelConfidence:  number;
  riskControl:      number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

async function loadActiveWeights(): Promise<HealthWeights> {
  try {
    const row = await queryOne(
      "SELECT weights_json FROM health_score_configs WHERE is_active=1 ORDER BY created_at DESC LIMIT 1",
    );
    if (row?.weights_json) return JSON.parse(String(row.weights_json)) as HealthWeights;
  } catch { /* use defaults */ }
  return {
    diversification: 0.15, drawdown: 0.20, goalProgress: 0.15, strategyBalance: 0.10,
    cashDeployment: 0.10, executionQuality: 0.10, modelConfidence: 0.10, riskControl: 0.10,
  };
}

// ── Component A: Diversification ──────────────────────────────────────────────

function computeDiversificationScore(params: {
  openPositions:    number;
  maxSingleStockPct: number;
  maxSectorPct:     number;
  coldStartMode:    boolean;
}): number {
  const { openPositions, maxSingleStockPct, maxSectorPct, coldStartMode } = params;
  let score = 100;

  // Position count penalties
  let positionPenalty = 0;
  if (openPositions < 3) positionPenalty = 25;
  else if (openPositions < 5) positionPenalty = 10;

  // Single-stock concentration
  let stockPenalty = 0;
  if (maxSingleStockPct > 15) stockPenalty = 35;
  else if (maxSingleStockPct > 10) stockPenalty = 20;

  // Sector concentration
  let sectorPenalty = 0;
  if (maxSectorPct > 35) sectorPenalty = 40;
  else if (maxSectorPct > 25) sectorPenalty = 20;

  // Cold-start adjustment: reduce penalties by 50% when positions intentionally capped
  if (coldStartMode && openPositions <= 5) {
    positionPenalty = Math.floor(positionPenalty * 0.5);
  }

  score -= positionPenalty + stockPenalty + sectorPenalty;
  return clamp(score);
}

// ── Component B: Drawdown ─────────────────────────────────────────────────────

function computeDrawdownScore(params: {
  currentDrawdownPct:     number;
  maxAllowedDrawdownPct:  number;
  drawdownProtectionActive: boolean;
}): number {
  const { currentDrawdownPct, maxAllowedDrawdownPct, drawdownProtectionActive } = params;
  if (currentDrawdownPct <= 0) return 100;
  const ratio = currentDrawdownPct / Math.max(maxAllowedDrawdownPct, 1);
  if (ratio >= 1) return 0;
  let score = clamp(100 - ratio * 100);
  if (drawdownProtectionActive) score = Math.min(score, 30);
  return score;
}

// ── Component C: Goal Progress ────────────────────────────────────────────────

function computeGoalProgressScore(params: {
  currentReturnPct: number;
  targetReturnPct:  number | null;
  elapsedDays:      number;
  horizonDays:      number | null;
}): { score: number; insufficientHistory: boolean } {
  const { currentReturnPct, targetReturnPct, elapsedDays, horizonDays } = params;
  if (!targetReturnPct || !horizonDays || horizonDays <= 0) return { score: 60, insufficientHistory: true };
  if (elapsedDays < 15) return { score: 60, insufficientHistory: true };

  const expectedProgress = targetReturnPct * elapsedDays / horizonDays;
  if (expectedProgress <= 0) return { score: 60, insufficientHistory: false };

  const ratio = currentReturnPct / expectedProgress;
  let score: number;
  if (ratio >= 1.2)      score = 100;
  else if (ratio >= 1.0) score = 90;
  else if (ratio >= 0.75) score = 70;
  else if (ratio >= 0.5) score = 50;
  else                   score = 30;

  return { score, insufficientHistory: false };
}

// ── Component D: Strategy Balance ─────────────────────────────────────────────

function computeStrategyBalanceScore(params: {
  strategyExposure: Record<string, number>;  // strategy → % of portfolio
  policy: PortfolioPolicy | null;
}): number {
  const { strategyExposure } = params;
  const values = Object.values(strategyExposure);
  if (values.length === 0) return 75; // no data — neutral

  const maxExposure = Math.max(...values);
  let score = 80; // reasonable default until richer strategy tracking data exists

  if (maxExposure > 70) score -= 30;
  // Note: disabled strategy with residual exposure penalty requires Phase 22 data
  return clamp(score);
}

// ── Component E: Cash Deployment ─────────────────────────────────────────────

function computeCashDeploymentScore(params: {
  cashPct:       number;
  policyType:    string | null;
  marketRegime:  string | null;
  coldStartMode: boolean;
}): number {
  const { cashPct, marketRegime, coldStartMode } = params;
  if (coldStartMode) return 75;
  if (marketRegime === 'BEAR' && cashPct > 40) return 90;
  if (marketRegime === 'BULL' && cashPct > 70) return 50;
  if (cashPct >= 10 && cashPct <= 40) return 85;
  if (cashPct > 60) return 60;
  if (cashPct < 5) return 65;
  return 75;
}

// ── Component F: Execution Quality ───────────────────────────────────────────

// Loaded dynamically to avoid circular imports
async function computeExecutionQualityScoreLive(portfolioId: number): Promise<number> {
  try {
    const { getPortfolioVirtualExecutionQuality } = await import('./virtualExecutionQualityService.js');
    const quality = await getPortfolioVirtualExecutionQuality(portfolioId, '30D');
    return quality.executionScore;
  } catch {
    return 70; // safe fallback if no execution events yet
  }
}

// ── Component G: Model Confidence ────────────────────────────────────────────

function computeModelConfidenceScore(params: {
  modelStage:              string | null;
  calibrationError:        number | null;
  positiveWFWindowCount:   number;
}): number {
  const { modelStage, calibrationError, positiveWFWindowCount } = params;
  const stageScores: Record<string, number> = {
    CANDIDATE:  30,
    SHADOW:     45,
    ADVISORY:   70,
    PRODUCTION: 90,
  };
  let score = stageScores[modelStage ?? 'CANDIDATE'] ?? 30;
  if (calibrationError != null && calibrationError > 15) score -= 20;
  if (positiveWFWindowCount < 3) score -= 10;
  return clamp(score);
}

// ── Component H: Risk Control ─────────────────────────────────────────────────

function computeRiskControlScore(ksState: Record<string, any>): number {
  let score = 100;
  if (ksState.dataStaleHalted)          score -= 40;
  if (ksState.circuitBreakerActive)     score -= 50;
  if (ksState.dailyLossHalted)          score -= 30;
  if (ksState.weeklyLossHalted)         score -= 40;
  if (ksState.drawdownPaused)           score -= 40;
  if (ksState.drawdownProtection)       score -= 60;
  if (ksState.consecutiveLossCooldown)  score -= 25;
  if (ksState.emergencyLiquidationTriggered) score = Math.min(score, 20);
  return clamp(score);
}

// ── Exported score aggregators ────────────────────────────────────────────────

export function calculateHealthScore(components: HealthComponents, weights: HealthWeights): number {
  const raw =
    weights.diversification  * components.diversificationScore  +
    weights.drawdown          * components.drawdownScore          +
    weights.goalProgress      * components.goalProgressScore      +
    weights.strategyBalance   * components.strategyBalanceScore   +
    weights.cashDeployment    * components.cashDeploymentScore    +
    weights.executionQuality  * components.executionQualityScore  +
    weights.modelConfidence   * components.modelConfidenceScore   +
    weights.riskControl       * components.riskControlScore;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function calculateHealthGrade(score: number): HealthGrade {
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'WARNING';
  return 'CRITICAL';
}

// ── Sector exposure helpers ───────────────────────────────────────────────────

function computeSectorExposure(holdings: any[], totalValue: number): {
  map: Record<string, number>;
  maxPct: number;
  maxSector: string | null;
} {
  const { getSymbolSector } = require('../services/marketData.js');
  const sectorMap: Record<string, number> = {};
  for (const h of holdings) {
    const sector = getSymbolSector(h.symbol) as string;
    const value  = h.quantity * (h.currentPrice ?? h.avgBuyPrice);
    sectorMap[sector] = (sectorMap[sector] ?? 0) + value;
  }
  let maxPct = 0;
  let maxSector: string | null = null;
  for (const [sector, value] of Object.entries(sectorMap)) {
    const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
    sectorMap[sector] = pct;
    if (pct > maxPct) { maxPct = pct; maxSector = sector; }
  }
  return { map: sectorMap, maxPct, maxSector };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function calculatePortfolioHealth(portfolioId: number): Promise<PortfolioHealthSnapshot> {
  const snapshotTime = new Date().toISOString();

  // Gather all inputs (errors are isolated — partial failure returns degraded snapshot)
  const [summary, ksState, govState, policy, regime, wfResults] = await Promise.allSettled([
    getPortfolioSummary(portfolioId),
    evaluateKillSwitch(portfolioId),
    getModelGovernanceState(portfolioId),
    getPortfolioPolicy(portfolioId),
    classifyMarketRegime(),
    getWalkForwardResults(portfolioId),
  ]);

  const port     = summary.status === 'fulfilled' ? summary.value : null;
  const ks       = ksState.status === 'fulfilled' ? ksState.value as any : {};
  const gov      = govState.status === 'fulfilled' ? govState.value : null;
  const pol      = policy.status === 'fulfilled' ? policy.value : null;
  const reg      = regime.status === 'fulfilled' ? regime.value : null;
  const wf       = wfResults.status === 'fulfilled' ? (wfResults.value as any[]) : [];

  // Portfolio metadata
  const portfolioRow = await queryOne(
    'SELECT initial_capital, target_return_pct, investment_horizon_months, max_drawdown_pct, created_at FROM portfolios WHERE id = ?',
    [portfolioId],
  );

  const initialCapital   = Number(portfolioRow?.initial_capital ?? port?.totalValue ?? 0);
  const targetReturnPct  = Number(portfolioRow?.target_return_pct ?? 0) || null;
  const horizonDays      = portfolioRow?.investment_horizon_months
    ? Number(portfolioRow.investment_horizon_months) * 30
    : null;
  const maxDrawdownPct   = Number(portfolioRow?.max_drawdown_pct ?? 12);
  const createdAt        = portfolioRow?.created_at ? new Date(String(portfolioRow.created_at)) : new Date();
  const elapsedDays      = Math.floor((Date.now() - createdAt.getTime()) / 86_400_000);
  const daysRemaining    = horizonDays ? Math.max(0, horizonDays - elapsedDays) : null;

  const currentNav       = port?.totalValue ?? initialCapital;
  const cashPct          = port ? (port.cashBalance / port.totalValue) * 100 : 100;
  const investedPct      = 100 - cashPct;
  const currentReturnPct = initialCapital > 0
    ? ((currentNav - initialCapital) / initialCapital) * 100 : 0;

  const holdings     = port?.holdings ?? [];
  const openPositions = holdings.length;

  // Drawdown: current drawdown from peak_nav
  const peakNavRow = await queryOne('SELECT peak_nav FROM portfolios WHERE id = ?', [portfolioId]);
  const peakNav    = Number(peakNavRow?.peak_nav ?? currentNav);
  const currentDrawdownPct = peakNav > 0 ? Math.max(0, ((peakNav - currentNav) / peakNav) * 100) : 0;

  // Sector exposure
  const sectorData = computeSectorExposure(holdings, currentNav);
  const maxSingleStockPct = holdings.reduce((max: number, h: any) => {
    const hVal = h.quantity * (h.currentPrice ?? h.avgBuyPrice);
    const pct  = currentNav > 0 ? (hVal / currentNav) * 100 : 0;
    return Math.max(max, pct);
  }, 0);

  // Strategy exposure (from holdings.strategy_type, populated by Phase 13/19)
  const strategyExposure: Record<string, number> = {};
  for (const h of holdings as any[]) {
    if (h.strategy_type) {
      const hVal = h.quantity * (h.currentPrice ?? h.avgBuyPrice);
      const pct  = currentNav > 0 ? (hVal / currentNav) * 100 : 0;
      strategyExposure[h.strategy_type] = (strategyExposure[h.strategy_type] ?? 0) + pct;
    }
  }

  // Model confidence inputs
  const positiveWFWindowCount = wf.filter((w: any) => w.expectancyPct > 0).length;
  const calibrationRow = await queryOne(
    "SELECT AVG(ABS(actual_win_rate - predicted_pwin_band_midpoint)) as cal_error FROM model_calibration ORDER BY created_at DESC LIMIT 10",
  ).catch(() => null);
  const calibrationError = calibrationRow?.cal_error != null ? Number(calibrationRow.cal_error) * 100 : null;

  const coldStartMode = gov?.isColdStart ?? true;

  // Load weights
  const weights = await loadActiveWeights();

  // Compute all 8 components
  const divScore  = computeDiversificationScore({
    openPositions, maxSingleStockPct, maxSectorPct: sectorData.maxPct, coldStartMode,
  });
  const ddScore   = computeDrawdownScore({
    currentDrawdownPct, maxAllowedDrawdownPct: maxDrawdownPct,
    drawdownProtectionActive: !!(ks as any).drawdownProtection,
  });
  const { score: gpScore } = computeGoalProgressScore({
    currentReturnPct, targetReturnPct, elapsedDays, horizonDays,
  });
  const sbScore   = computeStrategyBalanceScore({ strategyExposure, policy: pol });
  const cdScore   = computeCashDeploymentScore({
    cashPct, policyType: pol?.policyType ?? null,
    marketRegime: reg?.label ?? null, coldStartMode,
  });
  const eqScore   = await computeExecutionQualityScoreLive(portfolioId);
  const mcScore   = computeModelConfidenceScore({
    modelStage: gov?.stage ?? null, calibrationError, positiveWFWindowCount,
  });
  const rcScore   = computeRiskControlScore(ks);

  const components: HealthComponents = {
    diversificationScore:  divScore,
    concentrationScore:    divScore, // same source — concentration is the inverse
    drawdownScore:         ddScore,
    goalProgressScore:     gpScore,
    strategyBalanceScore:  sbScore,
    cashDeploymentScore:   cdScore,
    executionQualityScore: eqScore,
    modelConfidenceScore:  mcScore,
    riskControlScore:      rcScore,
  };

  const healthScore = calculateHealthScore(components, weights);
  const healthGrade = calculateHealthGrade(healthScore);

  // Goal probability
  const goalResult = calculateGoalProbability({
    currentNav, initialCapital, targetReturnPct, horizonDays, daysRemaining,
    currentReturnPct, currentDrawdownPct,
    marketRegime: reg?.label ?? 'NEUTRAL',
    modelStage: gov?.stage ?? 'CANDIDATE',
    riskLevel: pol?.policyType?.includes('LOW') ? 'low' : pol?.policyType?.includes('HIGH') ? 'high' : 'medium',
    coldStartMode,
  });

  // Phase 22: Pull virtual safety state for recommendations
  const virtualSafety = await import('./virtualSafetyService.js')
    .then(m => m.getVirtualSafetyState(portfolioId))
    .catch(() => null);

  // Recommendations + top risks
  const recommendations = generateRecommendations({
    components, policy: pol, ksState: ks, modelStage: gov?.stage ?? 'CANDIDATE',
    goalProbabilityPct: goalResult.goalProbabilityPct,
    goalImpossible: goalResult.impossible,
    currentDrawdownPct, cashPct,
    maxSectorPct: sectorData.maxPct, maxSectorName: sectorData.maxSector,
    targetReturnPct, requiredMonthlyReturnPct: goalResult.requiredMonthlyReturnPct,
    strategyExposure,
    virtualLedgerStatus:   virtualSafety?.reconciliationStatus ?? null,
    virtualNewBuysBlocked: virtualSafety?.newBuysBlocked ?? false,
    executionQualityScore: eqScore,
  });
  const topRisks = deriveTopRisks(components, ks, gov?.stage ?? 'CANDIDATE', goalResult.goalProbabilityPct);

  const snapshot: PortfolioHealthSnapshot = {
    portfolioId,
    healthScore,
    healthGrade,
    goalProbabilityPct:       goalResult.goalProbabilityPct,
    goalImpossible:           goalResult.impossible,
    goalImpossibilityReason:  goalResult.impossibilityReason,
    targetReturnPct,
    horizonDays,
    daysRemaining,
    requiredMonthlyReturnPct: goalResult.requiredMonthlyReturnPct,
    currentNav,
    initialCapital,
    currentReturnPct,
    currentDrawdownPct,
    cashPct,
    investedPct,
    openPositionsCount: openPositions,
    components,
    sectorExposureJson:    JSON.stringify(sectorData.map),
    strategyExposureJson:  Object.keys(strategyExposure).length > 0 ? JSON.stringify(strategyExposure) : null,
    topRisks,
    recommendations,
    snapshotTime,
    healthModelVersion: HEALTH_MODEL_VERSION,
  };

  // Persist
  await saveHealthSnapshot(portfolioId, snapshot);

  return snapshot;
}

export async function saveHealthSnapshot(
  portfolioId: number,
  s: PortfolioHealthSnapshot,
): Promise<number> {
  const result = await run(
    `INSERT OR IGNORE INTO portfolio_health_snapshots (
      portfolio_id, snapshot_time,
      health_score, health_grade,
      goal_probability_pct, target_return_pct, horizon_days, days_remaining, required_monthly_return_pct,
      current_nav, initial_capital, current_return_pct, current_drawdown_pct,
      cash_pct, invested_pct, open_positions_count,
      diversification_score, concentration_score, drawdown_score, goal_progress_score,
      strategy_balance_score, cash_deployment_score, execution_quality_score,
      model_confidence_score, risk_control_score,
      sector_exposure_json, strategy_exposure_json, top_risks_json, recommendations_json,
      goal_impossible, goal_impossibility_reason,
      health_model_version
    ) VALUES (
      ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?
    )`,
    [
      portfolioId, s.snapshotTime,
      s.healthScore, s.healthGrade,
      s.goalProbabilityPct, s.targetReturnPct, s.horizonDays, s.daysRemaining, s.requiredMonthlyReturnPct,
      s.currentNav, s.initialCapital, s.currentReturnPct, s.currentDrawdownPct,
      s.cashPct, s.investedPct, s.openPositionsCount,
      s.components.diversificationScore, s.components.concentrationScore, s.components.drawdownScore, s.components.goalProgressScore,
      s.components.strategyBalanceScore, s.components.cashDeploymentScore, s.components.executionQualityScore,
      s.components.modelConfidenceScore, s.components.riskControlScore,
      s.sectorExposureJson, s.strategyExposureJson, JSON.stringify(s.topRisks), JSON.stringify(s.recommendations),
      s.goalImpossible ? 1 : 0, s.goalImpossibilityReason,
      s.healthModelVersion,
    ],
  );
  return result.lastInsertRowid;
}

/**
 * Returns the latest health snapshot for a portfolio, or calculates it on the fly
 * if none exists or the existing one is stale (> 1 hour old).
 */
export async function getOrCalculateLatestHealth(portfolioId: number): Promise<PortfolioHealthSnapshot> {
  const latest = await queryOne(
    'SELECT * FROM portfolio_health_snapshots WHERE portfolio_id = ? ORDER BY snapshot_time DESC LIMIT 1',
    [portfolioId],
  );

  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const isStale    = !latest || String(latest.snapshot_time) < oneHourAgo;

  if (isStale) {
    // Calculate fresh snapshot (waits for completion)
    return calculatePortfolioHealth(portfolioId);
  }

  // Deserialize from DB row
  const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } };
  return {
    portfolioId,
    healthScore:              Number(latest.health_score),
    healthGrade:              String(latest.health_grade) as HealthGrade,
    goalProbabilityPct:       latest.goal_probability_pct != null ? Number(latest.goal_probability_pct) : null,
    goalImpossible:           Boolean(latest.goal_impossible),
    goalImpossibilityReason:  latest.goal_impossibility_reason ? String(latest.goal_impossibility_reason) : null,
    targetReturnPct:          latest.target_return_pct != null ? Number(latest.target_return_pct) : null,
    horizonDays:              latest.horizon_days != null ? Number(latest.horizon_days) : null,
    daysRemaining:            latest.days_remaining != null ? Number(latest.days_remaining) : null,
    requiredMonthlyReturnPct: latest.required_monthly_return_pct != null ? Number(latest.required_monthly_return_pct) : null,
    currentNav:               Number(latest.current_nav ?? 0),
    initialCapital:           Number(latest.initial_capital ?? 0),
    currentReturnPct:         Number(latest.current_return_pct ?? 0),
    currentDrawdownPct:       Number(latest.current_drawdown_pct ?? 0),
    cashPct:                  Number(latest.cash_pct ?? 0),
    investedPct:              Number(latest.invested_pct ?? 0),
    openPositionsCount:       Number(latest.open_positions_count ?? 0),
    components: {
      diversificationScore:  Number(latest.diversification_score ?? 0),
      concentrationScore:    Number(latest.concentration_score ?? 0),
      drawdownScore:         Number(latest.drawdown_score ?? 0),
      goalProgressScore:     Number(latest.goal_progress_score ?? 0),
      strategyBalanceScore:  Number(latest.strategy_balance_score ?? 0),
      cashDeploymentScore:   Number(latest.cash_deployment_score ?? 0),
      executionQualityScore: Number(latest.execution_quality_score ?? 0),
      modelConfidenceScore:  Number(latest.model_confidence_score ?? 0),
      riskControlScore:      Number(latest.risk_control_score ?? 0),
    },
    sectorExposureJson:    latest.sector_exposure_json ? String(latest.sector_exposure_json) : null,
    strategyExposureJson:  latest.strategy_exposure_json ? String(latest.strategy_exposure_json) : null,
    topRisks:              parseJ(latest.top_risks_json) ?? [],
    recommendations:       parseJ(latest.recommendations_json) ?? [],
    snapshotTime:          String(latest.snapshot_time),
    healthModelVersion:    String(latest.health_model_version ?? HEALTH_MODEL_VERSION),
  };
}
