/**
 * backtestData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Downloads 2-year daily OHLCV data for NSE symbols via Yahoo Finance chart API
 * and persists it to the backtesting_prices Turso table.
 *
 * Table is created lazily on first use (migration-safe).
 */

import { query, run, getClient } from '../db/turso.js';
import { logger } from '../lib/logger.js';

const YAHOO_CHART = 'https://query2.finance.yahoo.com/v8/finance/chart';
const TWO_YEARS_S = 2 * 365 * 24 * 3600; // seconds

export interface OHLCVRow {
  symbol: string;
  date: string;   // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Ensure backtesting_prices table exists */
async function ensureTable(): Promise<void> {
  const db = getClient();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS backtesting_prices (
      symbol  TEXT NOT NULL,
      date    TEXT NOT NULL,
      open    REAL,
      high    REAL,
      low     REAL,
      close   REAL NOT NULL,
      volume  INTEGER,
      PRIMARY KEY (symbol, date)
    )
  `);
}

/** Fetch 2-year daily OHLCV from Yahoo Finance for a single .NS symbol */
export async function fetchSymbolHistory(symbol: string): Promise<OHLCVRow[]> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - TWO_YEARS_S;
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=div`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status} for ${symbol}`);

  const json = await res.json() as any;
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const opens: number[] = q.open ?? [];
  const highs: number[] = q.high ?? [];
  const lows: number[]  = q.low ?? [];
  const closes: number[] = q.close ?? [];
  const volumes: number[] = q.volume ?? [];

  const rows: OHLCVRow[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || isNaN(close)) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    rows.push({
      symbol,
      date,
      open:   opens[i]   ?? close,
      high:   highs[i]   ?? close,
      low:    lows[i]    ?? close,
      close,
      volume: volumes[i] ?? 0,
    });
  }
  return rows;
}

/** Persist OHLCV rows to Turso (upsert — safe to re-run) */
async function persistRows(rows: OHLCVRow[]): Promise<void> {
  if (!rows.length) return;
  const db = getClient();
  // Batch in chunks of 100 to avoid statement size limits
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.batch(chunk.map(r => ({
      sql: `INSERT OR REPLACE INTO backtesting_prices (symbol,date,open,high,low,close,volume)
            VALUES (?,?,?,?,?,?,?)`,
      args: [r.symbol, r.date, r.open, r.high, r.low, r.close, r.volume],
    })));
  }
}

/**
 * Download and store 2-year history for a list of symbols.
 * Skips symbols already fully loaded (>400 rows in DB = ~2 years of trading days).
 * Returns count of symbols successfully fetched.
 */
export async function fetchAndStoreHistory(
  symbols: string[],
  opts: { skipExisting?: boolean; delayMs?: number } = {}
): Promise<{ fetched: number; skipped: number; failed: string[] }> {
  await ensureTable();
  const { skipExisting = true, delayMs = 300 } = opts;

  let fetched = 0; let skipped = 0; const failed: string[] = [];

  for (const symbol of symbols) {
    if (skipExisting) {
      const rows = await query(
        'SELECT COUNT(*) as cnt FROM backtesting_prices WHERE symbol = ?',
        [symbol]
      );
      if ((rows[0]?.cnt ?? 0) > 400) { skipped++; continue; }
    }

    try {
      const rows = await fetchSymbolHistory(symbol);
      await persistRows(rows);
      logger.info({ reason: `[Backtest] ${symbol}: ${rows.length} rows stored` });
      fetched++;
    } catch (err) {
      logger.warn({ reason: `[Backtest] ${symbol}: fetch failed — ${err}` });
      failed.push(symbol);
    }

    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }

  return { fetched, skipped, failed };
}

/** Load stored history for a symbol from Turso */
export async function loadSymbolHistory(symbol: string): Promise<OHLCVRow[]> {
  await ensureTable();
  const rows = await query(
    'SELECT * FROM backtesting_prices WHERE symbol = ? ORDER BY date ASC',
    [symbol]
  );
  return rows as OHLCVRow[];
}
