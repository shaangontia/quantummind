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

  // CRITICAL-3: Auth — users table and portfolios.owner_id
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id            INTEGER  PRIMARY KEY AUTOINCREMENT,
      email         TEXT     NOT NULL UNIQUE,
      password_hash TEXT,           -- nullable for OAuth-only users
      google_id     TEXT UNIQUE,
      name          TEXT,
      avatar_url    TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('[DB] Migration: users table ensured');
  } catch (err) { console.warn('[DB] users table skipped:', err); }
  // Add OAuth columns to existing users tables
  for (const col of [
    'ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE',
    'ALTER TABLE users ADD COLUMN name TEXT',
    'ALTER TABLE users ADD COLUMN avatar_url TEXT',
  ]) {
    try { await db.execute(col); } catch (_) { /* already exists */ }
  }
  try {
    await db.execute('ALTER TABLE portfolios ADD COLUMN owner_id INTEGER REFERENCES users(id)');
    console.log('[DB] Migration: portfolios.owner_id added');
  } catch (_) { /* already exists */ }

  // Phase 6: RAG-based TARS memory — FTS5 full-text search (no API key required)
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS tars_memory (
      id          INTEGER  PRIMARY KEY AUTOINCREMENT,
      content     TEXT     NOT NULL,
      embedding   F32_BLOB(768),  -- legacy 768-dim column (text-embedding-004); superseded by embedding_3k
      source_type TEXT     NOT NULL,
      source_id   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('[DB] Migration: tars_memory table ensured');
  } catch (err) { console.warn('[DB] tars_memory table creation skipped:', err); }

  // Add legacy embedding column for existing tables that predate Gemini integration
  try {
    await db.execute('ALTER TABLE tars_memory ADD COLUMN embedding F32_BLOB(768)');
    console.log('[DB] Migration: tars_memory.embedding (legacy 768) column added');
  } catch (_) { /* already exists — expected */ }

  // Phase 12: gemini-embedding-001 migration (3072-dim, replaces text-embedding-004 768-dim)
  // SQLite cannot change column types, so we add a new column embedding_3k F32_BLOB(3072).
  // ragService.ts writes to embedding_3k exclusively. Old 768-dim column is left for audit.
  try {
    await db.execute('ALTER TABLE tars_memory ADD COLUMN embedding_3k F32_BLOB(3072)');
    console.log('[DB] Migration: tars_memory.embedding_3k (3072-dim) column added');
  } catch (_) { /* already exists */ }

  // Drop old 768-dim vector index (incompatible with 3072-dim vectors); FTS5 fallback active
  try {
    await db.execute('DROP INDEX IF EXISTS tars_memory_vec_idx');
    console.log('[DB] Migration: old 768-dim vector index dropped');
  } catch (_) { /* ignore */ }

  // Nullify old 768-dim embeddings so they don’t confuse any residual index reads
  try {
    await db.execute('UPDATE tars_memory SET embedding = NULL WHERE embedding IS NOT NULL');
    console.log('[DB] Migration: old 768-dim embeddings cleared');
  } catch (_) { /* ignore */ }

  // Create new vector index on the 3072-dim column
  try {
    await db.execute(
      `CREATE INDEX IF NOT EXISTS tars_memory_vec3k_idx ON tars_memory (libsql_vector_idx(embedding_3k))`
    );
    console.log('[DB] Migration: tars_memory 3072-dim vector index ensured');
  } catch (err) { console.warn('[DB] 3072-dim vector index skipped (FTS5 fallback active):', err); }

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

  // Admin flag on users — first registered user (id=1) is admin by default
  try {
    await db.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    console.log('[DB] Migration: users.is_admin column added');
  } catch (_) { /* already exists */ }
  // Promote admin by ADMIN_EMAIL env var — survives DB resets, not tied to row ID
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    try { await db.execute({ sql: 'UPDATE users SET is_admin=1 WHERE email=?', args: [adminEmail] }); } catch (_) { /* ignore */ }
  }

  // Phase 7: Volume integration — volume_ratio per trade
  try {
    await db.execute('ALTER TABLE trades ADD COLUMN volume_ratio REAL DEFAULT NULL');
    console.log('[DB] Migration: trades.volume_ratio column added');
  } catch (_) { /* already exists */ }

  // Phase 9: Earnings calendar blackout
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS earnings_calendar (
      id           INTEGER  PRIMARY KEY AUTOINCREMENT,
      symbol       TEXT     NOT NULL,
      earnings_date TEXT    NOT NULL,
      is_confirmed INTEGER  DEFAULT 0,
      fetched_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, earnings_date)
    )`);
    console.log('[DB] Migration: earnings_calendar table ensured');
  } catch (err) { console.warn('[DB] earnings_calendar table skipped:', err); }

  // Phase 11: Gemini decision tracking + adaptive learning
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS gemini_decisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id     INTEGER NOT NULL,
      symbol           TEXT    NOT NULL,
      decision_type    TEXT    NOT NULL,  -- 'buy_veto' | 'buy_score' | 'sell_review'
      verdict          TEXT    NOT NULL,  -- Gemini's verdict string
      score            REAL    DEFAULT 0, -- Gemini's numeric score
      trade_id         INTEGER,           -- linked trade (if executed)
      outcome          TEXT,              -- 'win' | 'loss' | NULL (pending)
      realized_pnl_pct REAL,             -- filled when position closes
      created_at       TEXT    DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
    )`);
    console.log('[DB] Migration: gemini_decisions table ensured');
  } catch (err) { console.warn('[DB] gemini_decisions table skipped:', err); }

  try {
    // gemini_hold_count on holdings: tracks consecutive HOLD verdicts so we enforce the 2-cycle max
    await db.execute('ALTER TABLE holdings ADD COLUMN gemini_hold_count INTEGER DEFAULT 0');
    console.log('[DB] Migration: holdings.gemini_hold_count column added');
  } catch (_) { /* already exists */ }

  // Phase 12: Signal pattern memory for adaptive learning
  const { ensurePatternTables } = await import('../services/patternEngine.js');
  await ensurePatternTables();
  console.log('[DB] Migration: signal_patterns tables ensured');

  // Phase 13: Exit engine + strategy classification columns on holdings
  const holdingsCols = [
    "ALTER TABLE holdings ADD COLUMN strategy_type TEXT",
    "ALTER TABLE holdings ADD COLUMN atr_stop_price REAL",
    "ALTER TABLE holdings ADD COLUMN trailing_stop_price REAL",
    "ALTER TABLE holdings ADD COLUMN time_stop_date TEXT",
    "ALTER TABLE holdings ADD COLUMN risk_amount_inr REAL",
    "ALTER TABLE holdings ADD COLUMN thesis_invalidated INTEGER DEFAULT 0",
  ];
  for (const col of holdingsCols) {
    try { await db.execute(col); } catch (_) { /* already exists */ }
  }
  // Phase 13: Kill-switch state table
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS kill_switch_state (
      portfolio_id INTEGER PRIMARY KEY,
      daily_loss_halted INTEGER DEFAULT 0,
      weekly_loss_halted INTEGER DEFAULT 0,
      drawdown_paused INTEGER DEFAULT 0,
      drawdown_protection INTEGER DEFAULT 0,
      last_updated TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) { /* already exists */ }
  // Phase 13: strategy_type on market_signals
  try { await db.execute('ALTER TABLE market_signals ADD COLUMN strategy_type TEXT'); } catch (_) { /* already exists */ }
  // Phase 13: EV tracking on signal_patterns
  try { await db.execute('ALTER TABLE signal_patterns ADD COLUMN expected_value REAL'); } catch (_) { /* already exists */ }
  console.log('[DB] Migration: Phase 13 exit engine + kill-switch schema done');

  // Phase 14: ML probability model schema
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS ml_model_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      trained_at TEXT NOT NULL DEFAULT (datetime('now')),
      sample_count INTEGER NOT NULL,
      feature_names TEXT NOT NULL,
      weights TEXT NOT NULL,
      bias REAL NOT NULL DEFAULT 0,
      accuracy REAL,
      precision_score REAL,
      recall_score REAL
    )`);
  } catch (_) { /* already exists */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS walk_forward_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER,
      train_start TEXT NOT NULL,
      train_end TEXT NOT NULL,
      test_start TEXT NOT NULL,
      test_end TEXT NOT NULL,
      total_trades INTEGER DEFAULT 0,
      win_rate REAL,
      sharpe_ratio REAL,
      max_drawdown_pct REAL,
      avg_hold_days REAL,
      strategy_breakdown TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) { /* already exists */ }
  // features_json column on signal_patterns
  try { await db.execute('ALTER TABLE signal_patterns ADD COLUMN features_json TEXT'); } catch (_) { /* already exists */ }
  console.log('[DB] Migration: Phase 14 ML model schema done');

  // Phase 15: Candidate recorder schema
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS trade_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_type TEXT,
      signal_score REAL,
      rsi_value REAL,
      volume_ratio REAL,
      market_regime TEXT,
      fundamental_score REAL,
      atr_pct REAL,
      dma20_pct REAL,
      dma50_pct REAL,
      dist_52w_low_pct REAL,
      llm_risk_level TEXT,
      llm_news_event_type TEXT,
      filters_passed TEXT,
      filters_blocked TEXT,
      action_taken TEXT NOT NULL DEFAULT 'EVALUATED',
      entry_price REAL,
      stop_price REAL,
      target_price REAL,
      target_hit_before_stop INTEGER,
      max_adverse_excursion_pct REAL,
      max_favorable_excursion_pct REAL,
      actual_hold_days INTEGER,
      cost_adjusted_return_pct REAL,
      label_generated_at TEXT
    )`);
    await db.execute('CREATE INDEX IF NOT EXISTS idx_trade_candidates_symbol ON trade_candidates(symbol, evaluated_at)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_trade_candidates_action ON trade_candidates(action_taken, evaluated_at)');
  } catch (_) { /* already exists */ }
  console.log('[DB] Migration: Phase 15 candidate recorder schema done');

  // Phase 16: Label type + model lifecycle schema
  try { await db.execute("ALTER TABLE trade_candidates ADD COLUMN label_type TEXT DEFAULT 'UNKNOWN'"); } catch (_) { /* exists */ }
  try { await db.execute("ALTER TABLE ml_model_weights ADD COLUMN lifecycle_stage TEXT DEFAULT 'CANDIDATE'"); } catch (_) { /* exists */ }
  try { await db.execute("ALTER TABLE ml_model_weights ADD COLUMN true_label_count INTEGER DEFAULT 0"); } catch (_) { /* exists */ }
  try { await db.execute("ALTER TABLE ml_model_weights ADD COLUMN positive_wf_windows INTEGER DEFAULT 0"); } catch (_) { /* exists */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS model_calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      pwin_band_low REAL NOT NULL,
      pwin_band_high REAL NOT NULL,
      predicted_count INTEGER NOT NULL,
      actual_win_count INTEGER NOT NULL,
      actual_win_rate REAL NOT NULL,
      calibration_error REAL NOT NULL,
      evaluated_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) { /* exists */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS cold_start_state (
      portfolio_id INTEGER PRIMARY KEY,
      is_cold_start INTEGER DEFAULT 1,
      lifecycle_stage TEXT DEFAULT 'CANDIDATE',
      true_label_count INTEGER DEFAULT 0,
      positive_wf_windows INTEGER DEFAULT 0,
      last_evaluated TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) { /* exists */ }
  console.log('[DB] Migration: Phase 16 model governance schema done');
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
