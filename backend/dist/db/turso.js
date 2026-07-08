"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClient = getClient;
exports.runMigrations = runMigrations;
exports.query = query;
exports.queryOne = queryOne;
exports.run = run;
exports.batch = batch;
exports.batchWithResults = batchWithResults;
const client_1 = require("@libsql/client");
require("dotenv/config");
let _client = null;
function getClient() {
    if (_client)
        return _client;
    const url = process.env.turso_region;
    const authToken = process.env.turso_sb_key;
    if (!url || !authToken)
        throw new Error('Turso credentials missing. Set turso_region and turso_sb_key env vars.');
    _client = (0, client_1.createClient)({ url, authToken });
    return _client;
}
/** Run once at startup — idempotent column additions */
async function runMigrations() {
    const db = getClient();
    // Add realized_pnl to trades if missing (SQLite ALTER TABLE ADD COLUMN is safe)
    try {
        await db.execute('ALTER TABLE trades ADD COLUMN realized_pnl REAL');
        console.log('[DB] Migration: trades.realized_pnl column added');
    }
    catch (_) { /* already exists — ignore */ }
    try {
        await db.execute("ALTER TABLE portfolios ADD COLUMN preferred_caps TEXT DEFAULT NULL");
        console.log('[DB] Migration: portfolios.preferred_caps column added');
    }
    catch (_) { /* already exists — ignore */ }
    try {
        await db.execute("ALTER TABLE portfolios ADD COLUMN preferred_cap TEXT DEFAULT NULL");
        console.log('[DB] Migration: portfolios.preferred_cap column added');
    }
    catch (_) { /* already exists — ignore */ }
    try {
        await db.execute('ALTER TABLE trades ADD COLUMN trade_reason TEXT');
        console.log('[DB] Migration: trades.trade_reason column added');
    }
    catch (_) { /* already exists — ignore */ }
    // index_prices table (created lazily by indexData.ts, but also ensure here)
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS index_prices (
      index_symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
      PRIMARY KEY (index_symbol, date)
    )`);
    }
    catch (_) { /* ignore */ }
    // Phase 5: advanced risk profiling columns on portfolios
    try {
        await db.execute('ALTER TABLE portfolios ADD COLUMN max_drawdown_pct REAL DEFAULT 20');
        console.log('[DB] Migration: portfolios.max_drawdown_pct added');
    }
    catch (_) { /* already exists */ }
    try {
        await db.execute("ALTER TABLE portfolios ADD COLUMN volatility_preference TEXT DEFAULT 'medium'");
        console.log('[DB] Migration: portfolios.volatility_preference added');
    }
    catch (_) { /* already exists */ }
    try {
        await db.execute("ALTER TABLE portfolios ADD COLUMN investment_goal TEXT DEFAULT 'growth'");
        console.log('[DB] Migration: portfolios.investment_goal added');
    }
    catch (_) { /* already exists */ }
    try {
        await db.execute('ALTER TABLE portfolios ADD COLUMN strategy_updated_at DATETIME DEFAULT NULL');
        console.log('[DB] Migration: portfolios.strategy_updated_at added');
    }
    catch (_) { /* already exists */ }
    try {
        // peak_nav: highest total portfolio value ever recorded; used for true drawdown calculation
        await db.execute('ALTER TABLE portfolios ADD COLUMN peak_nav REAL DEFAULT NULL');
        console.log('[DB] Migration: portfolios.peak_nav added');
    }
    catch (_) { /* already exists */ }
}
async function query(sql, args = []) {
    const db = getClient();
    const result = await db.execute({ sql, args });
    return result.rows;
}
async function queryOne(sql, args = []) {
    const rows = await query(sql, args);
    return rows[0] ?? null;
}
async function run(sql, args = []) {
    const db = getClient();
    const result = await db.execute({ sql, args });
    return { lastInsertRowid: Number(result.lastInsertRowid) };
}
async function batch(statements) {
    const db = getClient();
    await db.batch(statements.map(s => ({ sql: s.sql, args: s.args ?? [] })));
}
/** Atomic batch that returns all ResultSets (useful when you need lastInsertRowid from a batch) */
async function batchWithResults(statements) {
    const db = getClient();
    const results = await db.batch(statements.map(s => ({ sql: s.sql, args: s.args ?? [] })));
    return results.map(r => ({ lastInsertRowid: Number(r.lastInsertRowid ?? 0) }));
}
