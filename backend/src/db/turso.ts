import { createClient, type Client } from '@libsql/client';
import 'dotenv/config';

let _client: Client | null = null;

export function getClient(): Client {
  if (_client) return _client;
  const url = process.env.turso_region;
  const authToken = process.env.turso_sb_key;
  if (!url || !authToken) throw new Error('Turso credentials missing. Set turso_region and turso_sb_key env vars.');
  _client = createClient({ url, authToken });
  return _client;
}

/** Run once at startup — idempotent column additions */
export async function runMigrations(): Promise<void> {
  const db = getClient();
  // Add realized_pnl to trades if missing (SQLite ALTER TABLE ADD COLUMN is safe)
  try {
    await db.execute('ALTER TABLE trades ADD COLUMN realized_pnl REAL');
    console.log('[DB] Migration: trades.realized_pnl column added');
  } catch (_) { /* already exists — ignore */ }
  try {
    await db.execute("ALTER TABLE portfolios ADD COLUMN preferred_caps TEXT DEFAULT NULL");
    console.log('[DB] Migration: portfolios.preferred_caps column added');
  } catch (_) { /* already exists — ignore */ }
  try {
    await db.execute("ALTER TABLE portfolios ADD COLUMN preferred_cap TEXT DEFAULT NULL");
    console.log('[DB] Migration: portfolios.preferred_cap column added');
  } catch (_) { /* already exists — ignore */ }
  try {
    await db.execute('ALTER TABLE trades ADD COLUMN trade_reason TEXT');
    console.log('[DB] Migration: trades.trade_reason column added');
  } catch (_) { /* already exists — ignore */ }
  // index_prices table (created lazily by indexData.ts, but also ensure here)
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS index_prices (
      index_symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
      PRIMARY KEY (index_symbol, date)
    )`);
  } catch (_) { /* ignore */ }
  // Phase 5: advanced risk profiling columns on portfolios
  try {
    await db.execute('ALTER TABLE portfolios ADD COLUMN max_drawdown_pct REAL DEFAULT 20');
    console.log('[DB] Migration: portfolios.max_drawdown_pct added');
  } catch (_) { /* already exists */ }
  try {
    await db.execute("ALTER TABLE portfolios ADD COLUMN volatility_preference TEXT DEFAULT 'medium'");
    console.log('[DB] Migration: portfolios.volatility_preference added');
  } catch (_) { /* already exists */ }
  try {
    await db.execute("ALTER TABLE portfolios ADD COLUMN investment_goal TEXT DEFAULT 'growth'");
    console.log('[DB] Migration: portfolios.investment_goal added');
  } catch (_) { /* already exists */ }

  try {
    await db.execute('ALTER TABLE portfolios ADD COLUMN strategy_updated_at DATETIME DEFAULT NULL');
    console.log('[DB] Migration: portfolios.strategy_updated_at added');
  } catch (_) { /* already exists */ }

  try {
    // peak_nav: highest total portfolio value ever recorded; used for true drawdown calculation
    await db.execute('ALTER TABLE portfolios ADD COLUMN peak_nav REAL DEFAULT NULL');
    console.log('[DB] Migration: portfolios.peak_nav added');
  } catch (_) { /* already exists */ }

  // Phase 6: RAG-based TARS memory — FTS5 full-text search (no API key required)
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS tars_memory (
      id          INTEGER  PRIMARY KEY AUTOINCREMENT,
      content     TEXT     NOT NULL,
      source_type TEXT     NOT NULL,
      source_id   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('[DB] Migration: tars_memory table ensured');
  } catch (err) { console.warn('[DB] tars_memory table creation skipped:', err); }

  try {
    // FTS5 virtual table mirrors tars_memory.content for BM25 full-text search
    await db.execute(
      `CREATE VIRTUAL TABLE IF NOT EXISTS tars_memory_fts
       USING fts5(content, content='tars_memory', content_rowid='id')`
    );
    console.log('[DB] Migration: tars_memory_fts FTS5 index ensured');
  } catch (err) { console.warn('[DB] FTS5 index skipped:', err); }

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
  } catch (err) { console.warn('[DB] FTS5 triggers skipped:', err); }
}

export async function query(sql: string, args: any[] = []): Promise<any[]> {
  const db = getClient();
  const result = await db.execute({ sql, args });
  return result.rows as any[];
}

export async function queryOne(sql: string, args: any[] = []): Promise<any | null> {
  const rows = await query(sql, args);
  return rows[0] ?? null;
}

export async function run(sql: string, args: any[] = []): Promise<{ lastInsertRowid: number }> {
  const db = getClient();
  const result = await db.execute({ sql, args });
  return { lastInsertRowid: Number(result.lastInsertRowid) };
}

export async function batch(statements: { sql: string; args?: any[] }[]): Promise<void> {
  const db = getClient();
  await db.batch(statements.map(s => ({ sql: s.sql, args: s.args ?? [] })));
}

/** Atomic batch that returns all ResultSets (useful when you need lastInsertRowid from a batch) */
export async function batchWithResults(
  statements: { sql: string; args?: any[] }[]
): Promise<{ lastInsertRowid: number }[]> {
  const db = getClient();
  const results = await db.batch(
    statements.map(s => ({ sql: s.sql, args: s.args ?? [] }))
  );
  return results.map(r => ({ lastInsertRowid: Number(r.lastInsertRowid ?? 0) }));
}
