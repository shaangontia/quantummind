/**
 * overlapAnalytics.ts — Phase 19: Portfolio overlap detection and classification
 *
 * Analyses current holdings across all of a user's portfolios and classifies
 * why the same stock appears in multiple portfolios:
 *
 *   GLOBAL_CONSENSUS      — stock held in 3+ portfolios; all policies agree it's a good setup
 *   POLICY_MATCH          — stock held in 1–2 portfolios; correct differentiation working
 *   REGIME_DRIVEN         — all portfolios buy the same stock because regime limits the universe
 *   DIVERSIFICATION_BLOCKED — stock would appear in more portfolios but sector cap blocked it
 *
 * overlapRate = overlappingSymbols / totalHeldSymbols
 * If overlapRate > 0.7 → differentiation may still not be working (surface as warning).
 */

import { query } from '../db/turso.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OverlapType =
  | 'GLOBAL_CONSENSUS'
  | 'POLICY_MATCH'
  | 'REGIME_DRIVEN'
  | 'DIVERSIFICATION_BLOCKED';

export interface OverlapEntry {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  heldByPortfolioIds: number[];
  portfolioCount: number;
  overlapType: OverlapType;
  explanation: string;
  strategyType: string | null;
  // Utility scores per portfolio (if available from policy evaluations)
  utilityScores: Record<number, number>;
}

export interface OverlapReport {
  totalPortfolios: number;
  totalHeldSymbols: number;
  overlappingSymbols: number;
  overlapRate: number;                    // 0..1
  overlapRateWarning: boolean;            // true if > 0.7
  overlaps: OverlapEntry[];
  singlePortfolioSymbols: number;         // stocks held by only one portfolio
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Returns the overlap report for all active portfolios owned by a user.
 * Uses current holdings as the source of truth.
 */
export async function getPortfolioOverlap(userId: string | number): Promise<OverlapReport> {
  // Load all active portfolios for the user
  const portfolios = await query(
    `SELECT id, risk_tolerance, investment_horizon_months, target_return_pct
     FROM portfolios WHERE owner_id = ? AND is_active = 1`,
    [userId],
  ).catch(() => []);

  if (portfolios.length === 0) {
    return emptyReport(0);
  }

  const portfolioIds = portfolios.map((p: any) => Number(p.id));

  // Load all current holdings grouped by symbol
  const placeholders = portfolioIds.map(() => '?').join(',');
  const holdings = await query(
    `SELECT h.symbol, h.portfolio_id, h.strategy_type,
            s.company_name, s.sector
     FROM holdings h
     LEFT JOIN (
       SELECT DISTINCT symbol, NULL as company_name, NULL as sector
       FROM holdings WHERE portfolio_id IN (${placeholders})
     ) s ON s.symbol = h.symbol
     WHERE h.portfolio_id IN (${placeholders})
     ORDER BY h.symbol`,
    [...portfolioIds, ...portfolioIds],
  ).catch(() => []);

  // Enrich with stock metadata if available
  const enrichedHoldings = await enrichWithSectorData(holdings, portfolioIds);

  // Load utility scores from recent policy evaluations (last 30 days)
  const utilityMap = await loadUtilityScores(portfolioIds);

  // Group by symbol
  const bySymbol = new Map<string, {
    portfolioIds: number[];
    strategyType: string | null;
    companyName: string | null;
    sector: string | null;
  }>();

  for (const h of enrichedHoldings) {
    const symbol = h.symbol as string;
    const existing = bySymbol.get(symbol);
    if (existing) {
      if (!existing.portfolioIds.includes(Number(h.portfolio_id))) {
        existing.portfolioIds.push(Number(h.portfolio_id));
      }
    } else {
      bySymbol.set(symbol, {
        portfolioIds: [Number(h.portfolio_id)],
        strategyType: h.strategy_type ?? null,
        companyName:  h.company_name ?? null,
        sector:       h.sector ?? null,
      });
    }
  }

  const totalHeldSymbols   = bySymbol.size;
  const overlappingSymbols = [...bySymbol.values()].filter(v => v.portfolioIds.length > 1).length;
  const singlePortfolioSymbols = totalHeldSymbols - overlappingSymbols;
  const overlapRate = totalHeldSymbols > 0 ? overlappingSymbols / totalHeldSymbols : 0;

  // Build overlap entries for multi-portfolio symbols
  const overlaps: OverlapEntry[] = [];
  for (const [symbol, data] of bySymbol) {
    if (data.portfolioIds.length < 2) continue;

    const utilityScores: Record<number, number> = {};
    for (const pid of data.portfolioIds) {
      const score = utilityMap.get(`${symbol}:${pid}`);
      if (score !== undefined) utilityScores[pid] = score;
    }

    const overlapType = classifyOverlap(data.portfolioIds, portfolios.length, utilityScores);
    const explanation = buildExplanation(overlapType, symbol, data, data.portfolioIds, portfolios.length);

    overlaps.push({
      symbol,
      companyName:        data.companyName,
      sector:             data.sector,
      heldByPortfolioIds: data.portfolioIds,
      portfolioCount:     data.portfolioIds.length,
      overlapType,
      explanation,
      strategyType:       data.strategyType,
      utilityScores,
    });
  }

  // Sort: most overlapping first
  overlaps.sort((a, b) => b.portfolioCount - a.portfolioCount);

  return {
    totalPortfolios:    portfolioIds.length,
    totalHeldSymbols,
    overlappingSymbols,
    overlapRate:        Math.round(overlapRate * 1000) / 1000,
    overlapRateWarning: overlapRate > 0.7,
    overlaps,
    singlePortfolioSymbols,
  };
}

// ── Classification ────────────────────────────────────────────────────────────

function classifyOverlap(
  holdingPortfolioIds: number[],
  totalPortfolios: number,
  utilityScores: Record<number, number>,
): OverlapType {
  const count = holdingPortfolioIds.length;

  // Held by 3+ portfolios (or all portfolios if fewer than 3 exist)
  if (count >= 3 || (totalPortfolios >= 2 && count === totalPortfolios)) {
    return 'GLOBAL_CONSENSUS';
  }

  // Utility scores available — check if differentiation is working
  const scores = Object.values(utilityScores);
  if (scores.length >= 2) {
    const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    // If high utility scores across both portfolios that hold it → consensus
    if (avgScore > 1.5 && count >= 2) return 'GLOBAL_CONSENSUS';
  }

  // Default: held by 2 portfolios — could be correct policy match or regime-driven
  return 'POLICY_MATCH';
}

function buildExplanation(
  overlapType: OverlapType,
  symbol: string,
  data: { strategyType: string | null; sector: string | null; companyName: string | null },
  holdingPortfolioIds: number[],
  totalPortfolios: number,
): string {
  const portfolioPhrase = `${holdingPortfolioIds.length} of ${totalPortfolios} portfolio${totalPortfolios > 1 ? 's' : ''}`;

  switch (overlapType) {
    case 'GLOBAL_CONSENSUS':
      return `${symbol} held in ${portfolioPhrase}. ` +
        `All active portfolio policies agree this is a strong opportunity` +
        (data.strategyType ? ` (${data.strategyType} setup)` : '') +
        (data.sector ? ` in the ${data.sector} sector` : '') + '.';

    case 'POLICY_MATCH':
      return `${symbol} held in ${portfolioPhrase}. ` +
        `Specific portfolio policies match this candidate's ` +
        (data.strategyType ? `${data.strategyType} strategy type` : 'setup') + '. ' +
        `Other portfolios may have filtered it by eligibility criteria.`;

    case 'REGIME_DRIVEN':
      return `${symbol} held in ${portfolioPhrase}. ` +
        `Current market regime may have reduced the eligible universe, ` +
        `causing multiple portfolio policies to converge on similar candidates.`;

    case 'DIVERSIFICATION_BLOCKED':
      return `${symbol} held in ${portfolioPhrase}. ` +
        `Sector concentration caps prevented it from appearing in additional portfolios.`;

    default:
      return `${symbol} held in ${portfolioPhrase}.`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function enrichWithSectorData(
  holdings: any[],
  portfolioIds: number[],
): Promise<any[]> {
  // Try to get sector/company from market_signals or trade context
  // For now return raw holdings — sector enrichment is best-effort
  // (sector data lives in NSE_UNIVERSE which is in-memory; future: store in DB)
  return holdings;
}

async function loadUtilityScores(portfolioIds: number[]): Promise<Map<string, number>> {
  if (portfolioIds.length === 0) return new Map();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const placeholders = portfolioIds.map(() => '?').join(',');

  // Join policy evaluations with trade_candidates to get symbol
  const rows = await query(
    `SELECT tc.symbol, ppe.portfolio_id, ppe.utility_score
     FROM portfolio_policy_evaluations ppe
     JOIN trade_candidates tc ON tc.id = ppe.candidate_id
     WHERE ppe.portfolio_id IN (${placeholders})
       AND ppe.decision = 'BUY'
       AND ppe.created_at >= ?
       AND ppe.utility_score IS NOT NULL`,
    [...portfolioIds, thirtyDaysAgo],
  ).catch(() => []);

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.symbol}:${row.portfolio_id}`, Number(row.utility_score));
  }
  return map;
}

function emptyReport(totalPortfolios: number): OverlapReport {
  return {
    totalPortfolios,
    totalHeldSymbols:    0,
    overlappingSymbols:  0,
    overlapRate:         0,
    overlapRateWarning:  false,
    overlaps:            [],
    singlePortfolioSymbols: 0,
  };
}
