/**
 * fundamentalService.ts — Quarterly fundamental data for NSE stocks
 *
 * Fetches income statement, balance sheet, and cash flow from Twelve Data API.
 * Returns a FundamentalSnapshot with pre-computed financial health ratios.
 *
 * Caching: 7 days per symbol (fundamentals update quarterly, not intraday).
 * Graceful degradation: returns null if API key unset or symbol unsupported on NSE.
 */
import 'dotenv/config';
import { memCache } from '../lib/cache.js';

const FUNDAMENTAL_CACHE_TTL = 7 * 24 * 3600; // 7 days in seconds
const FUNDAMENTAL_CACHE_PREFIX = 'fundamental:';
const TD_BASE = 'https://api.twelvedata.com';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FundamentalSnapshot {
  symbol: string;
  fiscalDate: string;          // most recent quarter (YYYY-MM-DD)
  currency: string;

  // Growth
  revenueGrowthQoQ: number;   // % change revenue vs prior quarter
  revenueGrowthYoY: number;   // % change revenue vs same quarter last year
  patGrowthQoQ: number;       // % change net income vs prior quarter
  patGrowthYoY: number;       // % change net income vs same quarter last year

  // Margins
  grossMarginPct: number;     // gross profit / revenue × 100
  patMarginPct: number;       // net income / revenue × 100
  ebitdaMarginPct: number;

  // Quality of earnings
  cfoToNetIncome: number;     // operating cash flow / net income (>1 = good quality)

  // Balance sheet
  debtToEquity: number;       // total liabilities / shareholders equity
  currentRatio: number;       // current assets / current liabilities (>1 = solvent)

  // Returns
  roe: number;                // net income / shareholders equity × 100

  fetchedAt: string;          // ISO timestamp of data fetch
}

// ─── Twelve Data fetcher ──────────────────────────────────────────────────────

async function fetchTD<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null;

  const qs = new URLSearchParams({ ...params, apikey: apiKey, exchange: 'NSE', period: 'quarterly', outputsize: '4' });
  const url = `${TD_BASE}/${endpoint}?${qs.toString()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    if (data.code && Number(data.code) >= 400) return null;
    return data as T;
  } catch {
    return null;
  }
}

// ─── Helper: safe number from nested value ─────────────────────────────────

function n(v: unknown): number {
  const num = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(num) ? num : 0;
}

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

function growthPct(current: number, prior: number): number {
  if (!prior) return 0;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── Deterministic fundamental verdict ───────────────────────────────────────

export interface FundamentalVerdict {
  score: number;           // 0–100 rule-based score
  vetoed: boolean;         // hard block on BUY
  vetoReasons: string[];   // which rules triggered
  // Gemini populates this separately — rules do not set it
  reasoning?: string;
}

/**
 * Apply deterministic veto rules and compute a 0–100 fundamental score.
 * No LLM involvement — fully auditable and unit-testable.
 *
 * Veto rules (any one triggers hard BUY block):
 *   1. CFO/NetIncome < 0.5  — earnings quality / possible manipulation
 *   2. Debt-to-Equity > 3.0 — excessive leverage
 *   3. PAT YoY decline > 50% — severe earnings deterioration
 */
export function computeFundamentalVerdict(snap: FundamentalSnapshot): FundamentalVerdict {
  const vetoReasons: string[] = [];

  if (snap.cfoToNetIncome < 0.5) vetoReasons.push(`CFO/NI=${snap.cfoToNetIncome.toFixed(2)} (<0.5 — poor earnings quality)`);
  if (snap.debtToEquity   > 3.0) vetoReasons.push(`D/E=${snap.debtToEquity.toFixed(2)} (>3.0 — excessive leverage)`);
  if (snap.patGrowthYoY  < -50) vetoReasons.push(`PAT YoY=${snap.patGrowthYoY.toFixed(1)}% (<-50% — earnings collapse)`);

  const vetoed = vetoReasons.length > 0;

  // Scoring (0–100) — each dimension contributes up to 25 pts
  let score = 0;

  // Revenue growth (max 20): YoY growth > 20% = full, 10–20% = half, <0% = penalty
  if (snap.revenueGrowthYoY >= 20)      score += 20;
  else if (snap.revenueGrowthYoY >= 10) score += 12;
  else if (snap.revenueGrowthYoY >= 0)  score += 6;
  else                                   score += 0; // shrinking revenue

  // PAT margin (max 20): >15% = excellent, 5–15% = ok, <0% = loss-making
  if (snap.patMarginPct >= 15)      score += 20;
  else if (snap.patMarginPct >= 5)  score += 12;
  else if (snap.patMarginPct >= 0)  score += 4;
  else                               score += 0;

  // CFO quality (max 20): ratio >= 1.2 = very healthy, 0.8–1.2 = ok
  if (snap.cfoToNetIncome >= 1.2)      score += 20;
  else if (snap.cfoToNetIncome >= 0.8) score += 14;
  else if (snap.cfoToNetIncome >= 0.5) score += 8;
  else                                  score += 0; // already veto territory

  // Leverage (max 20): D/E < 0.5 = pristine, 0.5–1.5 = healthy, 1.5–3.0 = watch
  if (snap.debtToEquity < 0.5)      score += 20;
  else if (snap.debtToEquity < 1.5) score += 14;
  else if (snap.debtToEquity < 3.0) score += 6;
  else                               score += 0; // already veto territory

  // ROE (max 20): >20% = excellent, 12–20% = good, 5–12% = ok
  if (snap.roe >= 20)      score += 20;
  else if (snap.roe >= 12) score += 14;
  else if (snap.roe >= 5)  score += 8;
  else                      score += 2;

  return { score: Math.min(100, score), vetoed, vetoReasons };
}

/**
 * Fetch and compute fundamental snapshot for an NSE symbol.
 * Returns cached value if available. Returns null on any failure.
 */
export async function getFundamentalSnapshot(nseSymbol: string): Promise<FundamentalSnapshot | null> {
  const cacheKey = `${FUNDAMENTAL_CACHE_PREFIX}${nseSymbol}`;
  const cached = memCache.get<FundamentalSnapshot>(cacheKey);
  if (cached) return cached;

  // Fetch all three statements in parallel
  const [incomeRes, balanceRes, cfRes] = await Promise.all([
    fetchTD<{ income_statement: Record<string, unknown>[] }>('income_statement', { symbol: nseSymbol }),
    fetchTD<{ balance_sheet: Record<string, unknown>[] }>('balance_sheet', { symbol: nseSymbol }),
    fetchTD<{ cash_flow_statement: Record<string, unknown>[] }>('cash_flow_statement', { symbol: nseSymbol }),
  ]);

  const income = incomeRes?.income_statement;
  const balance = balanceRes?.balance_sheet;
  const cf = cfRes?.cash_flow_statement;

  // Need at least income statement with 2 periods for QoQ
  if (!income || income.length < 2) return null;

  const q0 = income[0]; // most recent quarter
  const q1 = income[1]; // prior quarter
  // q4 = same quarter last year (index 4 if available, else null)
  const qLY = income[3] ?? null;

  const revenue0   = n(q0.sales);
  const revenue1   = n(q1.sales);
  const revenueLY  = qLY ? n(qLY.sales) : 0;
  const pat0       = n(q0.net_income);
  const pat1       = n(q1.net_income);
  const patLY      = qLY ? n(qLY.net_income) : 0;
  const grossProfit0 = n(q0.gross_profit);
  const ebitda0    = n(q0.ebitda);

  // Balance sheet (latest period)
  const bs = balance?.[0];
  const assets = bs ? n((bs.assets as Record<string, unknown>)?.total_assets ?? 0) : 0;
  const liabilities = bs ? n((bs.liabilities as Record<string, unknown>)?.total_liabilities ?? 0) : 0;
  const equity = bs ? n((bs.shareholders_equity as Record<string, unknown>)?.total_equity ?? 0) : 0;
  const currentAssets = bs ? n((bs.assets as Record<string, unknown>)?.current_assets ?? 0) : 0;
  const currentLiabilities = bs ? n((bs.liabilities as Record<string, unknown>)?.current_liabilities ?? 0) : 0;

  // Cash flow (latest period)
  const cfq0 = cf?.[0];
  const cfoRaw = cfq0 ? (cfq0.cash_flow_from_operations ?? cfq0.operating_activities) : null;
  const cfo = cfoRaw ? n(typeof cfoRaw === 'object' ? (cfoRaw as Record<string, unknown>).total ?? 0 : cfoRaw) : 0;

  const snapshot: FundamentalSnapshot = {
    symbol: nseSymbol,
    fiscalDate: String(q0.fiscal_date ?? ''),
    currency: 'INR',

    revenueGrowthQoQ: growthPct(revenue0, revenue1),
    revenueGrowthYoY: qLY ? growthPct(revenue0, revenueLY) : 0,
    patGrowthQoQ: growthPct(pat0, pat1),
    patGrowthYoY: qLY ? growthPct(pat0, patLY) : 0,

    grossMarginPct: pct(grossProfit0, revenue0),
    patMarginPct:   pct(pat0, revenue0),
    ebitdaMarginPct: pct(ebitda0, revenue0),

    cfoToNetIncome: pat0 !== 0 ? cfo / pat0 : 0,

    debtToEquity:  equity !== 0 ? liabilities / equity : 99,
    currentRatio:  currentLiabilities !== 0 ? currentAssets / currentLiabilities : 0,

    roe: equity !== 0 ? pct(pat0, equity) : 0,

    fetchedAt: new Date().toISOString(),
  };

  memCache.set(cacheKey, snapshot, FUNDAMENTAL_CACHE_TTL);
  return snapshot;
}

/**
 * Fetch snapshot for a specific fiscal quarter (for backtest look-ahead prevention).
 * Finds the most recent report BEFORE the given tradeDate.
 * Returns null if unavailable.
 */
export async function getFundamentalSnapshotBeforeDate(
  nseSymbol: string,
  tradeDate: string,
): Promise<FundamentalSnapshot | null> {
  // For backtest: fetch last 4 quarters and pick the one whose fiscal_date < tradeDate
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${FUNDAMENTAL_CACHE_PREFIX}${nseSymbol}:before:${tradeDate}`;
  const cached = memCache.get<FundamentalSnapshot | null>(cacheKey);
  if (cached !== undefined) return cached;

  const incomeRes = await fetchTD<{ income_statement: Record<string, unknown>[] }>('income_statement', {
    symbol: nseSymbol,
    outputsize: '8', // 2 years of quarters
  });

  const statements = incomeRes?.income_statement ?? [];
  // Find the most recent fiscal_date strictly before tradeDate
  const valid = statements.filter(s => String(s.fiscal_date) < tradeDate);
  if (!valid.length) {
    memCache.set(cacheKey, null, 3600);
    return null;
  }

  // Use the most recent valid quarter as the "latest" for ratio computation
  // Re-use getFundamentalSnapshot which fetches all three statements (with full cache)
  const snapshot = await getFundamentalSnapshot(nseSymbol);
  // If the live snapshot's fiscal_date is after tradeDate, we don't have historical balance/CF data
  // — degrade gracefully: return null so backtest skips fundamental gate rather than using future data
  if (snapshot && snapshot.fiscalDate >= tradeDate) {
    memCache.set(cacheKey, null, 3600);
    return null;
  }

  memCache.set(cacheKey, snapshot, FUNDAMENTAL_CACHE_TTL);
  return snapshot;
}
