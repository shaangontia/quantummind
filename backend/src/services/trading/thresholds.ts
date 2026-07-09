/**
 * thresholds.ts — Risk-tier thresholds and advanced risk profile overrides.
 * Sector-relative P/E norms live here to keep generateSignal() readable.
 */

export interface RiskThresholds {
  rsiBuy: number;
  rsiSell: number;
  stopLoss: number;
  takeProfit: number;
  maxPosPct: number;
}

export const MIN_STOCK_PRICE = 30; // ₹30 — NSE equities below this are ineligible

// ─── Base thresholds by risk tier ─────────────────────────────────────────────
export function getThresholds(risk: string): RiskThresholds {
  if (risk === 'High') return { rsiBuy: 40, rsiSell: 65, stopLoss: 0.12, takeProfit: 0.30, maxPosPct: 0.08 };
  if (risk === 'Low')  return { rsiBuy: 28, rsiSell: 75, stopLoss: 0.05, takeProfit: 0.15, maxPosPct: 0.03 };
  return                      { rsiBuy: 35, rsiSell: 70, stopLoss: 0.08, takeProfit: 0.25, maxPosPct: 0.05 };
}

// ─── Advanced risk profile overrides ──────────────────────────────────────────
export function applyAdvancedRiskProfile(
  base: RiskThresholds,
  volatilityPref: string | null,
  investmentGoal: string | null
): RiskThresholds {
  let { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct } = base;
  if (volatilityPref === 'low')  { rsiBuy = Math.min(rsiBuy, 25); maxPosPct = Math.min(maxPosPct, 0.03); }
  if (volatilityPref === 'high') { rsiBuy = Math.max(rsiBuy, 38); maxPosPct = Math.min(maxPosPct, 0.08); }
  if (investmentGoal === 'income')     { takeProfit = Math.min(takeProfit, 0.15); stopLoss = Math.min(stopLoss, 0.07); }
  if (investmentGoal === 'retirement') { rsiBuy = Math.min(rsiBuy, 28); stopLoss = Math.min(stopLoss, 0.06); maxPosPct = Math.min(maxPosPct, 0.04); }
  if (investmentGoal === 'growth')     { takeProfit = Math.max(takeProfit, 0.25); }
  return { rsiBuy, rsiSell, stopLoss, takeProfit, maxPosPct };
}

// ─── Sector P/E norms (median historical, NSE) ────────────────────────────────
export interface SectorPeNorm {
  cheap: number;
  fair: number;
  expensive: number;
  veryExpensive: number;
  /** Skip P/E scoring — use P/B instead (e.g. Financials) */
  skipPe: boolean;
}

export const SECTOR_PE_NORMS: Record<string, SectorPeNorm> = {
  // FMCG: structural brand premium — PE 50-70 is normal
  FMCG:        { cheap: 35, fair: 60, expensive: 90,  veryExpensive: 120, skipPe: false },
  // Financials: provisioning distorts P/E; P/B is the standard metric
  Financials:  { cheap: 0,  fair: 0,  expensive: 0,   veryExpensive: 0,   skipPe: true  },
  // IT services: stable earnings, moderate multiples
  IT:          { cheap: 18, fair: 35, expensive: 50,  veryExpensive: 70,  skipPe: false },
  // Pharma/healthcare: R&D cycles temporarily inflate multiples
  Healthcare:  { cheap: 20, fair: 40, expensive: 60,  veryExpensive: 90,  skipPe: false },
  // Industrials / infra: lumpy project earnings
  Industrials: { cheap: 15, fair: 35, expensive: 55,  veryExpensive: 80,  skipPe: false },
  // Energy / utilities: regulated, lower growth = lower multiples
  Energy:      { cheap: 8,  fair: 18, expensive: 28,  veryExpensive: 40,  skipPe: false },
  Utilities:   { cheap: 8,  fair: 18, expensive: 28,  veryExpensive: 40,  skipPe: false },
  // Metals / materials: cyclical, thin margins
  Materials:   { cheap: 5,  fair: 12, expensive: 20,  veryExpensive: 35,  skipPe: false },
  // Auto: capex-heavy, mid multiples
  Auto:        { cheap: 12, fair: 25, expensive: 40,  veryExpensive: 60,  skipPe: false },
  // Real estate: asset-based; P/E rough guide only
  Realty:      { cheap: 15, fair: 30, expensive: 50,  veryExpensive: 75,  skipPe: false },
  // Default
  Other:       { cheap: 12, fair: 25, expensive: 45,  veryExpensive: 70,  skipPe: false },
};
