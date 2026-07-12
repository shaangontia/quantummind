/**
 * explanationGenerator.ts — Phase 20: Decision Replay + Explainability
 *
 * Generates two artefacts per decision:
 *   1. UserExplanation  — sanitized natural-language summary safe for end users
 *   2. AdminTrace       — full diagnostic trace for admin replay / debugging
 *
 * VISIBILITY CONTRACT:
 *   UserExplanation fields are ONLY written to decision_explanations WHERE visibility='USER'.
 *   AdminTrace is ONLY written to decision_explanations WHERE visibility='ADMIN'
 *   and to the *_json columns of decision_replay_events.
 *   The user API must query WHERE visibility='USER' — admin blobs must never reach the user endpoint.
 *
 * explanation_version = 'v1.0' — bump when template logic changes so old rows remain replayable
 * against their own version.
 */

import type { EvaluationDecision } from './policyEvaluationStore.js';
import type { PolicyType } from './portfolioPolicy.js';
import type { StrategyType } from './strategyClassifier.js';

// ── Explanation version ───────────────────────────────────────────────────────

export const EXPLANATION_VERSION = 'v1.0';

// ── User-facing types ─────────────────────────────────────────────────────────

export interface UserExplanation {
  title: string;
  summary: string;
  reasonCodes: string[];
}

export interface PortfolioContext {
  policyType: PolicyType | null;
  riskMode: string | null;      // NORMAL | COLD_START | HALTED | PROTECTION | LIQUIDATION
  positionSizePct: number | null;
}

export interface TradeResult {
  entryPrice: number | null;
  exitPrice: number | null;
  grossReturnPct: number | null;
  costAdjustedReturnPct: number | null;
  holdingDays: number | null;
}

// ── Admin trace types ─────────────────────────────────────────────────────────

export interface FeatureSnapshot {
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
}

export interface ModelTrace {
  mlPwin: number | null;
  modelStage: string | null;
  trainingRows: number | null;
  calibrationBand: string | null;  // e.g. '55-60%'
  modelVersion: string | null;
}

export interface RuleTrace {
  eligibilityGateResults: Array<{ gate: string; passed: boolean; reason?: string }>;
  strategyClassification: { type: StrategyType | null; confidence: number | null; reasonCodes: string[] };
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
}

export interface RiskTrace {
  killSwitchFlags: Record<string, boolean>;
  portfolioMode: string | null;
  stopPrice: number | null;
  targetPrice: number | null;
  riskAmountInr: number | null;
  positionSizePct: number | null;
  drawdownPct: number | null;
}

export interface LlmTrace {
  called: boolean;
  verdict: string | null;
  reasonCodes: string[] | null;
  llmModel: string | null;
  promptVersion: string | null;
  confidence: number | null;
}

export interface ExecutionTrace {
  // User-visible subset
  exitType: string | null;
  quantity: number | null;
  averagePrice: number | null;
  brokerage: number | null;
  slippagePct: number | null;
  costAdjustedReturnPct: number | null;
  // Admin-only broker / fee breakdown (Phase 22 Broker Reconciliation)
  orderSide: 'BUY' | 'SELL' | null;
  symbol: string | null;
  quantityRequested: number | null;
  quantityFilled: number | null;
  fillStatus: 'FULL' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'FAILED' | null;
  orderType: string | null;   // MARKET | LIMIT | SL | SL-M
  signalPrice: number | null;
  intendedPrice: number | null;
  averageFillPrice: number | null;
  executionPrice: number | null;
  systemOrderId: string | null;
  brokerOrderId: string | null;
  brokerName: string | null;
  fees: {
    brokerage: number | null;
    stt: number | null;
    exchangeCharges: number | null;
    sebiCharges: number | null;
    gst: number | null;
    stampDuty: number | null;
    totalCharges: number | null;
  } | null;
  grossPnl: number | null;
  netPnl: number | null;
  grossReturnPct: number | null;
  orderPlacedAt: string | null;
  orderFilledAt: string | null;
  latencyMs: number | null;
  rejectionReason: string | null;
  brokerErrorCode: string | null;
}

export interface AdminTrace {
  featureSnapshot: FeatureSnapshot;
  modelTrace: ModelTrace;
  ruleTrace: RuleTrace;
  riskTrace: RiskTrace;
  llmTrace: LlmTrace;
  executionTrace: ExecutionTrace | null;
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface DecisionContext {
  symbol: string;
  decisionType: EvaluationDecision | 'SELL';
  policyType: PolicyType | null;
  portfolioMode: string | null;
  positionSizePct: number | null;
  // Signal features
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
  // ML
  mlPwin: number | null;
  modelStage: string | null;
  trainingRows: number | null;
  modelVersion: string | null;
  // Eligibility + utility
  eligibilityGateResults: Array<{ gate: string; passed: boolean; reason?: string }>;
  utilityComponents: RuleTrace['utilityComponents'];
  rejectionReasons: string[];
  // Risk
  killSwitchFlags: Record<string, boolean>;
  stopPrice: number | null;
  targetPrice: number | null;
  riskAmountInr: number | null;
  drawdownPct: number | null;
  // LLM (optional — only populated when Gemini was called)
  llmVerdict: string | null;
  llmReasonCodes: string[] | null;
  llmModel: string | null;
  llmPromptVersion: string | null;
  llmConfidence: number | null;
  // Execution (optional — BUY/SELL only)
  execution: Partial<Omit<ExecutionTrace, 'fees'>> & { fees?: Partial<NonNullable<ExecutionTrace['fees']>> | null } | null;
  // Trade result (SELL only)
  exitType: string | null;
  exitPrice: number | null;
  grossReturnPct: number | null;
  costAdjustedReturnPct: number | null;
  holdingDays: number | null;
  entryPrice: number | null;
}

// ── User explanation generator ────────────────────────────────────────────────

/** Map technical reason codes to human-readable short phrases */
const REASON_CODE_LABELS: Record<string, string> = {
  // Eligibility failures
  STRATEGY_MISMATCH:        'strategy type not suited to this portfolio',
  SECTOR_CAP_BREACH:        'sector exposure near portfolio cap',
  ATR_TOO_HIGH:             'volatility too high for this risk level',
  FUNDAMENTAL_SCORE_LOW:    'fundamental quality below portfolio threshold',
  BETA_TOO_HIGH:            'market sensitivity too high',
  LIQUIDITY_INSUFFICIENT:   'insufficient trading liquidity',
  NEGATIVE_EPS:             'negative earnings',
  ML_PWIN_TOO_LOW:          'ML win probability below threshold',
  EV_BELOW_THRESHOLD:       'expected value below policy minimum',
  REGIME_MISMATCH:          'market regime unfavourable for this strategy',
  // Utility / ranking
  RANKED_OUT_OF_WINDOW:     'ranked outside executable window',
  UTILITY_NEGATIVE:         'net utility score negative for this portfolio',
  // Exit
  RSI_OVERBOUGHT:           'RSI reached overbought level',
  WEAK_MACD_CONFIRMATION:   'MACD momentum not confirming further upside',
  WEAK_ML_MOMENTUM:         'ML momentum signal weakened',
  NEGATIVE_EARNINGS:        'earnings turned negative post-entry',
  STOP_LOSS_HIT:            'stop-loss price reached',
  TRAILING_STOP_HIT:        'trailing stop triggered as price pulled back',
  TIME_STOP_HIT:            'maximum holding period reached',
  PROFIT_TARGET_HIT:        'profit target achieved',
  THESIS_INVALIDATED:       'original investment thesis no longer valid',
  REGIME_EXIT:              'market regime shifted — exit triggered',
  EMERGENCY_LIQUIDATION:    'emergency portfolio protection liquidation',
  // BUY reasons
  MOMENTUM_CONFIRMED:       'EMA trend + volume confirming upward momentum',
  MEAN_REVERSION_SETUP:     'oversold RSI with support bounce setup',
  VALUE_OPPORTUNITY:        'strong fundamentals at attractive valuation',
  NEWS_CATALYST:            'positive news/event catalyst identified',
  HIGH_ML_CONFIDENCE:       'ML model high-confidence BUY signal',
  REGIME_FAVOURABLE:        'bullish market regime supporting entry',
};

function toHumanCode(code: string): string {
  return REASON_CODE_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

/** Policy type → readable label */
function policyLabel(policyType: PolicyType | null): string {
  const map: Record<string, string> = {
    LOW_RISK_24M:      'Low Risk 24M',
    MEDIUM_RISK_12M:   'Medium Risk 12M',
    HIGH_RISK_3M:      'High Risk 3M',
    VALUE_LONG:        'Value Long-Term',
    MOMENTUM_SWING:    'Momentum Swing',
    AGGRESSIVE_SHORT:  'Aggressive Short-Term',
  };
  return policyType ? (map[policyType] ?? policyType) : 'your portfolio';
}

/** Build user-facing title per decision type */
function buildTitle(ctx: DecisionContext): string {
  const { decisionType, strategyType, exitType } = ctx;

  if (decisionType === 'BUY') {
    const stratTitles: Partial<Record<StrategyType, string>> = {
      MOMENTUM:       'Momentum BUY: EMA trend + volume confirmation',
      MEAN_REVERSION: 'Mean reversion BUY: oversold bounce setup',
      VALUE:          'Value BUY: strong fundamentals at discount',
      NEWS_CATALYST:  'News catalyst BUY: event-driven opportunity',
      MIXED:          'Multi-signal BUY: combined strategy confirmation',
    };
    return (strategyType && stratTitles[strategyType]) ?? 'BUY: signal threshold met';
  }

  if (decisionType === 'SELL') {
    const exitTitles: Record<string, string> = {
      STOP_LOSS:          'Stop-loss exit: risk limit reached',
      TRAILING_STOP:      'Trailing stop exit: profit locked in',
      TIME_STOP:          'Time stop: maximum holding period reached',
      PROFIT_TARGET:      'Profit target achieved',
      THESIS_INVALIDATED: 'Investment thesis invalidated',
      REGIME_EXIT:        'Market regime shift: protective exit',
      EMERGENCY:          'Emergency liquidation: portfolio protection',
    };
    if (exitType && exitTitles[exitType]) return exitTitles[exitType];
    // Gemini / RSI-driven sell
    const rsi = ctx.rsiValue;
    if (rsi && rsi > 70) return 'Overbought profit-protection exit';
    return 'SELL: exit signal confirmed';
  }

  if (decisionType === 'VETO')
    return `Vetoed: ineligible for ${policyLabel(ctx.policyType)}`;

  if (decisionType === 'SKIP')
    return `Skipped: insufficient utility for ${policyLabel(ctx.policyType)}`;

  return `${decisionType}: decision recorded`;
}

/** Build the user-visible narrative sentence */
function buildSummary(ctx: DecisionContext, reasonCodes: string[]): string {
  const { symbol, decisionType, policyType } = ctx;
  const pLabel = policyLabel(policyType);

  if (decisionType === 'BUY') {
    const reasons = reasonCodes.slice(0, 3).map(toHumanCode).join(', ');
    return `${symbol} was bought for your ${pLabel} portfolio${reasons ? ' based on ' + reasons : ''}.`;
  }

  if (decisionType === 'SELL') {
    const qty  = ctx.execution?.quantity ?? null;
    const exit = ctx.exitPrice ?? null;
    const qtyStr = qty ? `${qty} shares ` : '';
    const priceStr = exit ? ` at ₹${exit.toLocaleString('en-IN')}` : '';
    const reasons = reasonCodes.slice(0, 3).map(toHumanCode).join(', ');
    return `${symbol} was sold${qtyStr ? ' (' + qtyStr + ')' : ''}${priceStr}${reasons ? ' because ' + reasons : ''}.`;
  }

  if (decisionType === 'VETO') {
    const reasons = reasonCodes.slice(0, 3).map(toHumanCode);
    if (reasons.length === 0) return `${symbol} was not eligible for your ${pLabel} portfolio.`;
    if (reasons.length === 1)
      return `${symbol} was not eligible for your ${pLabel} portfolio because ${reasons[0]}.`;
    const last = reasons.pop()!;
    return `${symbol} was not eligible for your ${pLabel} portfolio because ${reasons.join(', ')}, and ${last}.`;
  }

  if (decisionType === 'SKIP') {
    const reasons = reasonCodes.slice(0, 2).map(toHumanCode);
    const base = `${symbol} was passed over for your ${pLabel} portfolio`;
    return reasons.length > 0 ? `${base} because ${reasons.join(' and ')}.` : `${base}.`;
  }

  return `${symbol}: ${decisionType} decision recorded for your ${pLabel} portfolio.`;
}

/** Derive machine-readable reason codes from context */
function deriveReasonCodes(ctx: DecisionContext): string[] {
  const codes: string[] = [];

  // VETO / SKIP: use rejection reasons directly (they're already machine-readable)
  if ((ctx.decisionType === 'VETO' || ctx.decisionType === 'SKIP') && ctx.rejectionReasons.length > 0) {
    return ctx.rejectionReasons.slice(0, 6);
  }

  // SELL: derive from exit type + signal values
  if (ctx.decisionType === 'SELL') {
    if (ctx.exitType === 'STOP_LOSS')          codes.push('STOP_LOSS_HIT');
    if (ctx.exitType === 'TRAILING_STOP')      codes.push('TRAILING_STOP_HIT');
    if (ctx.exitType === 'TIME_STOP')          codes.push('TIME_STOP_HIT');
    if (ctx.exitType === 'PROFIT_TARGET')      codes.push('PROFIT_TARGET_HIT');
    if (ctx.exitType === 'THESIS_INVALIDATED') codes.push('THESIS_INVALIDATED');
    if (ctx.exitType === 'REGIME_EXIT')        codes.push('REGIME_EXIT');
    if (ctx.exitType === 'EMERGENCY')          codes.push('EMERGENCY_LIQUIDATION');
    if (ctx.rsiValue && ctx.rsiValue > 70)     codes.push('RSI_OVERBOUGHT');
    if (ctx.llmReasonCodes)                    codes.push(...ctx.llmReasonCodes.slice(0, 3));
    return codes.slice(0, 6);
  }

  // BUY: derive from strategy + signal values
  if (ctx.decisionType === 'BUY') {
    if (ctx.strategyType === 'MOMENTUM')       codes.push('MOMENTUM_CONFIRMED');
    if (ctx.strategyType === 'MEAN_REVERSION') codes.push('MEAN_REVERSION_SETUP');
    if (ctx.strategyType === 'VALUE')          codes.push('VALUE_OPPORTUNITY');
    if (ctx.strategyType === 'NEWS_CATALYST')  codes.push('NEWS_CATALYST');
    if (ctx.rsiValue && ctx.rsiValue < 35)     codes.push('MEAN_REVERSION_SETUP');
    if (ctx.mlPwin && ctx.mlPwin > 0.60)       codes.push('HIGH_ML_CONFIDENCE');
    if (ctx.marketRegime === 'BULL')           codes.push('REGIME_FAVOURABLE');
    if (ctx.fundamentalScore && ctx.fundamentalScore > 70) codes.push('VALUE_OPPORTUNITY');
    if (ctx.llmReasonCodes)                   codes.push(...ctx.llmReasonCodes.slice(0, 2));
    return [...new Set(codes)].slice(0, 6);
  }

  return codes;
}

export function generateUserExplanation(ctx: DecisionContext): UserExplanation {
  const reasonCodes = deriveReasonCodes(ctx);
  return {
    title:       buildTitle(ctx),
    summary:     buildSummary(ctx, reasonCodes),
    reasonCodes,
  };
}

// ── Admin trace builder ───────────────────────────────────────────────────────

export function buildAdminTrace(ctx: DecisionContext): AdminTrace {
  const featureSnapshot: FeatureSnapshot = {
    symbol:                 ctx.symbol,
    price:                  ctx.price,
    rsiValue:               ctx.rsiValue,
    macdHistogram:          ctx.macdHistogram,
    volumeRatio:            ctx.volumeRatio,
    atrPct:                 ctx.atrPct,
    fundamentalScore:       ctx.fundamentalScore,
    marketRegime:           ctx.marketRegime,
    strategyType:           ctx.strategyType,
    strategyConfidence:     ctx.strategyConfidence,
    strategyReasonCodes:    ctx.strategyReasonCodes,
  };

  const modelTrace: ModelTrace = {
    mlPwin:          ctx.mlPwin,
    modelStage:      ctx.modelStage,
    trainingRows:    ctx.trainingRows,
    calibrationBand: ctx.mlPwin != null
      ? `${Math.floor(ctx.mlPwin * 100 / 5) * 5}-${Math.floor(ctx.mlPwin * 100 / 5) * 5 + 5}%`
      : null,
    modelVersion:    ctx.modelVersion,
  };

  const ruleTrace: RuleTrace = {
    eligibilityGateResults: ctx.eligibilityGateResults,
    strategyClassification: {
      type:        ctx.strategyType,
      confidence:  ctx.strategyConfidence,
      reasonCodes: ctx.strategyReasonCodes ?? [],
    },
    utilityComponents: ctx.utilityComponents,
    rejectionReasons:  ctx.rejectionReasons,
  };

  const riskTrace: RiskTrace = {
    killSwitchFlags: ctx.killSwitchFlags,
    portfolioMode:   ctx.portfolioMode,
    stopPrice:       ctx.stopPrice,
    targetPrice:     ctx.targetPrice,
    riskAmountInr:   ctx.riskAmountInr,
    positionSizePct: ctx.positionSizePct,
    drawdownPct:     ctx.drawdownPct,
  };

  const llmTrace: LlmTrace = {
    called:        ctx.llmVerdict != null,
    verdict:       ctx.llmVerdict,
    reasonCodes:   ctx.llmReasonCodes,
    llmModel:      ctx.llmModel,
    promptVersion: ctx.llmPromptVersion,
    confidence:    ctx.llmConfidence,
  };

  // executionTrace — only for BUY/SELL
  let executionTrace: ExecutionTrace | null = null;
  if (ctx.decisionType === 'BUY' || ctx.decisionType === 'SELL') {
    const e = ctx.execution ?? {};
    // Build the full admin trace — captures broker/fee breakdown for Phase 22 reconciliation.
    // User-visible replay only exposes: exitType, quantity, averagePrice, brokerage, slippagePct, costAdjustedReturnPct.
    executionTrace = {
      exitType:            ctx.exitType ?? null,
      quantity:            e.quantity ?? null,
      averagePrice:        e.averagePrice ?? e.averageFillPrice ?? null,
      brokerage:           e.fees?.brokerage ?? e.brokerage ?? null,
      slippagePct:         e.slippagePct ?? null,
      costAdjustedReturnPct: ctx.costAdjustedReturnPct ?? e.costAdjustedReturnPct ?? null,
      orderSide:           ctx.decisionType === 'BUY' ? 'BUY' : 'SELL',
      symbol:              ctx.symbol,
      quantityRequested:   e.quantityRequested ?? e.quantity ?? null,
      quantityFilled:      e.quantityFilled ?? e.quantity ?? null,
      fillStatus:          e.fillStatus ?? (e.quantity ? 'FULL' : null),
      orderType:           e.orderType ?? 'MARKET',
      signalPrice:         e.signalPrice ?? ctx.price,
      intendedPrice:       e.intendedPrice ?? ctx.price,
      averageFillPrice:    e.averageFillPrice ?? e.averagePrice ?? null,
      executionPrice:      e.executionPrice ?? e.averagePrice ?? null,
      systemOrderId:       e.systemOrderId ?? null,
      brokerOrderId:       e.brokerOrderId ?? null,
      brokerName:          e.brokerName ?? 'paper',
      fees: {
        brokerage:       e.fees?.brokerage ?? e.brokerage ?? null,
        stt:             e.fees?.stt ?? null,
        exchangeCharges: e.fees?.exchangeCharges ?? null,
        sebiCharges:     e.fees?.sebiCharges ?? null,
        gst:             e.fees?.gst ?? null,
        stampDuty:       e.fees?.stampDuty ?? null,
        totalCharges:    (e.fees?.totalCharges != null ? e.fees.totalCharges : null) ?? e.brokerage ?? null,
      },
      grossPnl:            e.grossPnl ?? null,
      netPnl:              e.netPnl ?? null,
      grossReturnPct:      ctx.grossReturnPct ?? e.grossReturnPct ?? null,
      orderPlacedAt:       e.orderPlacedAt ?? null,
      orderFilledAt:       e.orderFilledAt ?? null,
      latencyMs:           e.latencyMs ?? null,
      rejectionReason:     e.rejectionReason ?? null,
      brokerErrorCode:     e.brokerErrorCode ?? null,
    };
  }

  return { featureSnapshot, modelTrace, ruleTrace, riskTrace, llmTrace, executionTrace };
}
