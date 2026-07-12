/**
 * virtualExecutionQualityService.ts — Phase 22: Virtual Execution Quality
 *
 * Records and aggregates simulated virtual fill quality events.
 * Provides:
 *   - recordVirtualExecutionEvent    — persist a fill event after BUY/SELL
 *   - calculateVirtualExecutionScore — score 0-100 based on fill, slippage, latency
 *   - getPortfolioVirtualExecutionQuality — user-facing quality summary (range: 7D/30D/90D)
 *   - getAdminVirtualExecutionQuality     — system-wide quality summary for admin
 *
 * Author: Vinidicare (Phase 22)
 */

import { query, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type VirtualExecutionEventInput = {
  portfolioId:         number;
  tradeId?:            number;
  candidateId?:        number;
  virtualOrderId:      string;
  symbol:              string;
  side:                'BUY' | 'SELL';
  quantityRequested:   number;
  quantityFilled:      number;
  orderType:           'VIRTUAL_MARKET' | 'VIRTUAL_LIMIT' | 'VIRTUAL_STOP' | 'VIRTUAL_TRAILING_STOP';
  signalPrice?:        number;
  intendedPrice?:      number;
  simulatedFillPrice?: number;
  slippageAbs?:        number;
  slippagePct?:        number;
  spreadPct?:          number;
  liquidityScore?:     number;
  fillStatus:          'FULL' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'FAILED' | 'EXPIRED';
  rejectionReason?:    string;
  orderCreatedAt?:     string;
  orderFilledAt?:      string;
  simulatedLatencyMs?: number;
  brokerage?:          number;
  stt?:                number;
  exchangeCharges?:    number;
  sebiCharges?:        number;
  gst?:                number;
  stampDuty?:          number;
  totalCharges?:       number;
  grossPnl?:           number;
  netPnl?:             number;
  grossReturnPct?:     number;
  costAdjustedReturnPct?: number;
};

export type VirtualExecutionQualitySummary = {
  portfolioId?:          number;
  range:                 string;
  executionScore:        number;
  averageSlippagePct:    number;
  rejectedOrders:        number;
  failedOrders:          number;
  partialFills:          number;
  averageSimulatedLatencyMs: number;
  totalOrders:           number;
  summary:               string;
};

export type AdminVirtualExecutionQuality = {
  range:                string;
  systemExecutionScore: number;
  averageSlippagePct:   number;
  rejectedOrders:       number;
  failedOrders:         number;
  partialFills:         number;
  totalOrders:          number;
  worstSymbolsBySlippage: Array<{ symbol: string; averageSlippagePct: number }>;
};

// ── Execution score formula ───────────────────────────────────────────────────

/**
 * Score 0-100. Penalties applied for:
 *   - Fill status (REJECTED: -50, FAILED: -60, PARTIAL: -15)
 *   - Slippage (>0.10%: -5, >0.25%: -15, >0.50%: -30)
 *   - Latency  (>2000ms: -5, >5000ms: -15)
 */
export function calculateVirtualExecutionScore(params: {
  fillStatus:          string;
  slippagePct?:        number;
  simulatedLatencyMs?: number;
}): number {
  let score = 100;

  if (params.fillStatus === 'REJECTED')  score -= 50;
  else if (params.fillStatus === 'FAILED')    score -= 60;
  else if (params.fillStatus === 'PARTIAL')   score -= 15;
  else if (params.fillStatus === 'CANCELLED') score -= 10;
  else if (params.fillStatus === 'EXPIRED')   score -= 20;

  const slip = params.slippagePct ?? 0;
  if (slip > 0.50) score -= 30;
  else if (slip > 0.25) score -= 15;
  else if (slip > 0.10) score -= 5;

  const latency = params.simulatedLatencyMs ?? 0;
  if (latency > 5000) score -= 15;
  else if (latency > 2000) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ── Record an execution event ────────────────────────────────────────────────

export async function recordVirtualExecutionEvent(
  input: VirtualExecutionEventInput,
): Promise<number> {
  const executionScore = calculateVirtualExecutionScore({
    fillStatus:          input.fillStatus,
    slippagePct:         input.slippagePct,
    simulatedLatencyMs:  input.simulatedLatencyMs,
  });

  const now = new Date().toISOString();

  const result = await run(
    `INSERT INTO virtual_execution_quality_events (
      portfolio_id, trade_id, candidate_id, virtual_order_id,
      symbol, side, quantity_requested, quantity_filled, order_type,
      signal_price, intended_price, simulated_fill_price,
      slippage_abs, slippage_pct, spread_pct, liquidity_score,
      fill_status, rejection_reason,
      order_created_at, order_filled_at, simulated_latency_ms,
      brokerage, stt, exchange_charges, sebi_charges, gst, stamp_duty, total_charges,
      gross_pnl, net_pnl, gross_return_pct, cost_adjusted_return_pct,
      execution_score, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.portfolioId,
      input.tradeId ?? null,
      input.candidateId ?? null,
      input.virtualOrderId,
      input.symbol,
      input.side,
      input.quantityRequested,
      input.quantityFilled,
      input.orderType,
      input.signalPrice ?? null,
      input.intendedPrice ?? null,
      input.simulatedFillPrice ?? null,
      input.slippageAbs ?? null,
      input.slippagePct ?? null,
      input.spreadPct ?? null,
      input.liquidityScore ?? null,
      input.fillStatus,
      input.rejectionReason ?? null,
      input.orderCreatedAt ?? now,
      input.orderFilledAt ?? (input.fillStatus === 'FULL' || input.fillStatus === 'PARTIAL' ? now : null),
      input.simulatedLatencyMs ?? null,
      input.brokerage ?? null,
      input.stt ?? null,
      input.exchangeCharges ?? null,
      input.sebiCharges ?? null,
      input.gst ?? null,
      input.stampDuty ?? null,
      input.totalCharges ?? null,
      input.grossPnl ?? null,
      input.netPnl ?? null,
      input.grossReturnPct ?? null,
      input.costAdjustedReturnPct ?? null,
      executionScore,
      now,
    ],
  );

  logger.info({ service: 'virtual-execution-quality', portfolioId: input.portfolioId,
    symbol: input.symbol, side: input.side, fillStatus: input.fillStatus,
    slippagePct: input.slippagePct, executionScore, msg: 'Virtual execution event recorded' });

  return result.lastInsertRowid;
}

// ── Range helper ──────────────────────────────────────────────────────────────

function rangeToSql(range: string): string {
  if (range === '7D')  return `datetime('now', '-7 days')`;
  if (range === '90D') return `datetime('now', '-90 days')`;
  return `datetime('now', '-30 days')`; // default 30D
}

// ── Portfolio execution quality ───────────────────────────────────────────────

export async function getPortfolioVirtualExecutionQuality(
  portfolioId: number,
  range: string = '30D',
): Promise<VirtualExecutionQualitySummary> {
  const since = rangeToSql(range);

  const rows = await query(
    `SELECT fill_status, slippage_pct, simulated_latency_ms, execution_score
     FROM virtual_execution_quality_events
     WHERE portfolio_id = ? AND created_at >= ${since}`,
    [portfolioId],
  );

  return buildQualitySummary(rows, range, portfolioId);
}

// ── Admin execution quality ───────────────────────────────────────────────────

export async function getAdminVirtualExecutionQuality(
  range: string = '30D',
): Promise<AdminVirtualExecutionQuality> {
  const since = rangeToSql(range);

  const rows = await query(
    `SELECT fill_status, slippage_pct, simulated_latency_ms, execution_score, symbol
     FROM virtual_execution_quality_events
     WHERE created_at >= ${since}`,
    [],
  );

  const summary = buildQualitySummary(rows, range);

  // Worst symbols by average slippage (min 2 events)
  const symbolMap = new Map<string, number[]>();
  for (const r of rows) {
    if (r.slippage_pct == null) continue;
    const sym = String(r.symbol);
    if (!symbolMap.has(sym)) symbolMap.set(sym, []);
    symbolMap.get(sym)!.push(Number(r.slippage_pct));
  }

  const worstSymbolsBySlippage = [...symbolMap.entries()]
    .filter(([, vals]) => vals.length >= 2)
    .map(([symbol, vals]) => ({
      symbol,
      averageSlippagePct: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10000) / 10000,
    }))
    .sort((a, b) => b.averageSlippagePct - a.averageSlippagePct)
    .slice(0, 10);

  return {
    range,
    systemExecutionScore: summary.executionScore,
    averageSlippagePct:   summary.averageSlippagePct,
    rejectedOrders:       summary.rejectedOrders,
    failedOrders:         summary.failedOrders,
    partialFills:         summary.partialFills,
    totalOrders:          summary.totalOrders,
    worstSymbolsBySlippage,
  };
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildQualitySummary(
  rows: any[],
  range: string,
  portfolioId?: number,
): VirtualExecutionQualitySummary {
  const total          = rows.length;
  const rejected       = rows.filter(r => r.fill_status === 'REJECTED').length;
  const failed         = rows.filter(r => r.fill_status === 'FAILED').length;
  const partial        = rows.filter(r => r.fill_status === 'PARTIAL').length;
  const slippageVals   = rows.map(r => Number(r.slippage_pct ?? 0));
  const latencyVals    = rows.filter(r => r.simulated_latency_ms != null).map(r => Number(r.simulated_latency_ms));
  const scoreVals      = rows.map(r => Number(r.execution_score ?? 0));

  const avgSlippage    = total > 0 ? slippageVals.reduce((a, b) => a + b, 0) / total : 0;
  const avgLatency     = latencyVals.length > 0 ? latencyVals.reduce((a, b) => a + b, 0) / latencyVals.length : 0;
  const avgScore       = total > 0 ? Math.round(scoreVals.reduce((a, b) => a + b, 0) / total) : 100;

  let summaryText: string;
  if (total === 0) {
    summaryText = 'No virtual execution events in this period.';
  } else if (avgScore >= 85 && rejected === 0) {
    summaryText = `Virtual execution quality is healthy. Simulated slippage and rejected orders are within acceptable limits.`;
  } else if (rejected > 0 || failed > 0) {
    summaryText = `${rejected + failed} virtual order(s) were rejected or failed. Review liquidity and order sizing.`;
  } else {
    summaryText = `Execution quality at ${avgScore}/100. Average slippage: ${(avgSlippage * 100).toFixed(3)}%.`;
  }

  return {
    portfolioId,
    range,
    executionScore:            avgScore,
    averageSlippagePct:        Math.round(avgSlippage * 10000) / 10000,
    rejectedOrders:            rejected,
    failedOrders:              failed,
    partialFills:              partial,
    averageSimulatedLatencyMs: Math.round(avgLatency),
    totalOrders:               total,
    summary:                   summaryText,
  };
}
