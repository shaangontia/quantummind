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
    // CRITICAL-3: Auth — users table and portfolios.owner_id
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id           INTEGER  PRIMARY KEY AUTOINCREMENT,
      email        TEXT     NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
        console.log('[DB] Migration: users table ensured');
    }
    catch (err) {
        console.warn('[DB] users table skipped:', err);
    }
    try {
        await db.execute('ALTER TABLE portfolios ADD COLUMN owner_id INTEGER REFERENCES users(id)');
        console.log('[DB] Migration: portfolios.owner_id added');
    }
    catch (_) { /* already exists */ }
    // Phase 6: RAG-based TARS memory — FTS5 full-text search (no API key required)
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS tars_memory (
      id          INTEGER  PRIMARY KEY AUTOINCREMENT,
      content     TEXT     NOT NULL,
      embedding   F32_BLOB(768),  -- Gemini text-embedding-004 (768-dim); NULL when Gemini unavailable
      source_type TEXT     NOT NULL,
      source_id   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
        console.log('[DB] Migration: tars_memory table ensured');
    }
    catch (err) {
        console.warn('[DB] tars_memory table creation skipped:', err);
    }
    // Add embedding column to existing tars_memory tables created before Gemini integration
    try {
        await db.execute('ALTER TABLE tars_memory ADD COLUMN embedding F32_BLOB(768)');
        console.log('[DB] Migration: tars_memory.embedding column added');
    }
    catch (_) { /* already exists */ }
    try {
        await db.execute(`CREATE INDEX IF NOT EXISTS tars_memory_vec_idx ON tars_memory (libsql_vector_idx(embedding))`);
        console.log('[DB] Migration: tars_memory vector index ensured');
    }
    catch (err) {
        console.warn('[DB] Vector index skipped:', err);
    }
    try {
        // FTS5 virtual table mirrors tars_memory.content for BM25 full-text search
        await db.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS tars_memory_fts
       USING fts5(content, content='tars_memory', content_rowid='id')`);
        console.log('[DB] Migration: tars_memory_fts FTS5 index ensured');
    }
    catch (err) {
        console.warn('[DB] FTS5 index skipped:', err);
    }
    // Keep FTS5 shadow table in sync via triggers
    try {
        await db.execute(`CREATE TRIGGER IF NOT EXISTS tars_memory_fts_insert
      AFTER INSERT ON tars_memory BEGIN
        INSERT INTO tars_memory_fts(rowid, content) VALUES (new.id, new.content);
      END`);
        await db.execute(`CREATE TRIGGER IF NOT EXISTS tars_memory_fts_delete
      AFTER DELETE ON tars_memory BEGIN
        INSERT INTO tars_memory_fts(tars_memory_fts, rowid, content)
          VALUES('delete', old.id, old.content);
      END`);
        console.log('[DB] Migration: tars_memory FTS5 triggers ensured');
    }
    catch (err) {
        console.warn('[DB] FTS5 triggers skipped:', err);
    }
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
