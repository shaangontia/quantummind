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
