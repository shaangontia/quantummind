"use strict";
/**
 * indexData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches and stores Nifty 50 (^NSEI) and Nifty 500 (^CRSLDX) daily closing
 * prices from Yahoo Finance for benchmark comparison.
 *
 * Schema: index_prices (index_symbol TEXT, date TEXT, close REAL, PRIMARY KEY)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.INDEX_SYMBOLS = void 0;
exports.fetchAndStoreIndexHistory = fetchAndStoreIndexHistory;
exports.getIndexClose = getIndexClose;
exports.getIndexHistory = getIndexHistory;
const turso_js_1 = require("../db/turso.js");
const logger_js_1 = require("../lib/logger.js");
exports.INDEX_SYMBOLS = {
    NIFTY50: '^NSEI',
    NIFTY500: '^CRSLDX',
};
/** Ensure index_prices table exists */
async function ensureTable() {
    await (0, turso_js_1.getClient)().execute(`
    CREATE TABLE IF NOT EXISTS index_prices (
      index_symbol TEXT NOT NULL,
      date         TEXT NOT NULL,
      close        REAL NOT NULL,
      PRIMARY KEY (index_symbol, date)
    )
  `);
}
/** Fetch latest 2-year daily closes for an index from Yahoo Finance */
async function fetchIndexHistory(symbol) {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - 2 * 365 * 24 * 3600;
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
        throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result)
        throw new Error(`No data for ${symbol}`);
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const rows = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] == null || isNaN(closes[i]))
            continue;
        rows.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
    }
    return rows;
}
/** Store index history in Turso (upsert) */
async function persistIndexRows(symbol, rows) {
    if (!rows.length)
        return;
    const db = (0, turso_js_1.getClient)();
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
        await db.batch(rows.slice(i, i + CHUNK).map(r => ({
            sql: 'INSERT OR REPLACE INTO index_prices (index_symbol, date, close) VALUES (?,?,?)',
            args: [symbol, r.date, r.close],
        })));
    }
}
/** Download and store both Nifty 50 and Nifty 500 history */
async function fetchAndStoreIndexHistory() {
    await ensureTable();
    for (const [name, sym] of Object.entries(exports.INDEX_SYMBOLS)) {
        try {
            const rows = await fetchIndexHistory(sym);
            await persistIndexRows(sym, rows);
            logger_js_1.logger.info({ reason: `[IndexData] ${name} (${sym}): ${rows.length} rows stored` });
        }
        catch (err) {
            logger_js_1.logger.warn({ reason: `[IndexData] ${name} (${sym}): fetch failed — ${err}` });
        }
    }
}
/** Fetch single day's close for an index from DB */
async function getIndexClose(symbol, date) {
    await ensureTable();
    const row = await (0, turso_js_1.query)('SELECT close FROM index_prices WHERE index_symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1', [symbol, date]);
    return row[0]?.close != null ? Number(row[0].close) : null;
}
/** Get index closes for a date range — returns [{date, close}] sorted ascending */
async function getIndexHistory(symbol, fromDate, toDate) {
    await ensureTable();
    const rows = await (0, turso_js_1.query)('SELECT date, close FROM index_prices WHERE index_symbol = ? AND date >= ? AND date <= ? ORDER BY date ASC', [symbol, fromDate, toDate]);
    return rows.map(r => ({ date: r.date, close: Number(r.close) }));
}
