/**
 * indexData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches and stores Nifty 50 (^NSEI) and Nifty 500 (^CRSLDX) daily closing
 * prices from Yahoo Finance for benchmark comparison.
 *
 * Schema: index_prices (index_symbol TEXT, date TEXT, close REAL, PRIMARY KEY)
 */

import { query, run, getClient } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export const INDEX_SYMBOLS = {
  NIFTY50:  '^NSEI',
  NIFTY500: '^CRSLDX',
} as const;

/** Ensure index_prices table exists */
async function ensureTable(): Promise<void> {
  await getClient().execute(`
    CREATE TABLE IF NOT EXISTS index_prices (
      index_symbol TEXT NOT NULL,
      date         TEXT NOT NULL,
      close        REAL NOT NULL,
      PRIMARY KEY (index_symbol, date)
    )
  `);
}

/** Fetch latest 2-year daily closes for an index from Yahoo Finance */
async function fetchIndexHistory(symbol: string): Promise<{ date: string; close: number }[]> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 2 * 365 * 24 * 3600;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);

  const json = await res.json() as any;
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const rows: { date: string; close: number }[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null || isNaN(closes[i])) continue;
    rows.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
  }
  return rows;
}

/** Store index history in Turso (upsert) */
async function persistIndexRows(symbol: string, rows: { date: string; close: number }[]): Promise<void> {
  if (!rows.length) return;
  const db = getClient();
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(rows.slice(i, i + CHUNK).map(r => ({
      sql: 'INSERT OR REPLACE INTO index_prices (index_symbol, date, close) VALUES (?,?,?)',
      args: [symbol, r.date, r.close],
    })));
  }
}

/** Download and store both Nifty 50 and Nifty 500 history */
export async function fetchAndStoreIndexHistory(): Promise<void> {
  await ensureTable();
  for (const [name, sym] of Object.entries(INDEX_SYMBOLS)) {
    try {
      const rows = await fetchIndexHistory(sym);
      await persistIndexRows(sym, rows);
      logger.info({ reason: `[IndexData] ${name} (${sym}): ${rows.length} rows stored` });
    } catch (err) {
      logger.warn({ reason: `[IndexData] ${name} (${sym}): fetch failed — ${err}` });
    }
  }
}

/** Fetch single day's close for an index from DB */
export async function getIndexClose(symbol: string, date: string): Promise<number | null> {
  await ensureTable();
  const row = await query(
    'SELECT close FROM index_prices WHERE index_symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1',
    [symbol, date]
  );
  return row[0]?.close != null ? Number(row[0].close) : null;
}

/** Get index closes for a date range — returns [{date, close}] sorted ascending */
export async function getIndexHistory(
  symbol: string,
  fromDate: string,
  toDate: string
): Promise<{ date: string; close: number }[]> {
  await ensureTable();
  const rows = await query(
    'SELECT date, close FROM index_prices WHERE index_symbol = ? AND date >= ? AND date <= ? ORDER BY date ASC',
    [symbol, fromDate, toDate]
  );
  return rows.map(r => ({ date: r.date as string, close: Number(r.close) }));
}
