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
