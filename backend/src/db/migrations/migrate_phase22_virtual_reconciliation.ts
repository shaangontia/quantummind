/**
 * Migration: Phase 22 — Virtual Ledger Reconciliation + Simulated Execution Quality
 *
 * Creates:
 *   - virtual_reconciliation_runs        — one row per reconciliation attempt per portfolio
 *   - virtual_reconciliation_mismatches  — individual mismatch records
 *   - virtual_execution_quality_events   — simulated fill quality per order
 *   - virtual_safety_states              — current virtual ledger safety state per portfolio
 *
 * Author: Vinidicare (Phase 22)
 */

import { getClient } from '../turso.js';
import 'dotenv/config';

async function migrate() {
  const db = getClient();
  console.log('[p22-migration] Starting Phase 22 virtual reconciliation tables...');

  // ── 1. virtual_reconciliation_runs ─────────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS virtual_reconciliation_runs (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id             INTEGER NOT NULL,
      run_started_at           DATETIME NOT NULL,
      run_completed_at         DATETIME,
      status                   TEXT NOT NULL,
      mismatch_count           INTEGER DEFAULT 0,
      critical_mismatch_count  INTEGER DEFAULT 0,
      expected_cash            REAL,
      actual_cash              REAL,
      cash_difference          REAL,
      expected_nav             REAL,
      actual_nav               REAL,
      nav_difference           REAL,
      expected_positions_json  TEXT,
      actual_positions_json    TEXT,
      mismatches_json          TEXT,
      error_message            TEXT,
      resolution_status        TEXT DEFAULT 'OPEN',
      created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[p22-migration] virtual_reconciliation_runs ✓');

  // ── 2. virtual_reconciliation_mismatches ────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS virtual_reconciliation_mismatches (
      id                             INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_run_id          INTEGER NOT NULL,
      portfolio_id                   INTEGER NOT NULL,
      mismatch_type                  TEXT NOT NULL,
      severity                       TEXT NOT NULL,
      symbol                         TEXT,
      expected_value                 TEXT,
      actual_value                   TEXT,
      difference_value               TEXT,
      blocks_new_buys                INTEGER DEFAULT 0,
      allows_only_risk_reducing_sells INTEGER DEFAULT 0,
      status                         TEXT DEFAULT 'OPEN',
      reason                         TEXT,
      created_at                     DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at                    DATETIME
    )
  `);
  console.log('[p22-migration] virtual_reconciliation_mismatches ✓');

  // ── 3. virtual_execution_quality_events ─────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS virtual_execution_quality_events (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id            INTEGER NOT NULL,
      trade_id                INTEGER,
      candidate_id            INTEGER,
      virtual_order_id        TEXT NOT NULL,
      symbol                  TEXT NOT NULL,
      side                    TEXT NOT NULL,
      quantity_requested      INTEGER NOT NULL,
      quantity_filled         INTEGER DEFAULT 0,
      order_type              TEXT NOT NULL,
      signal_price            REAL,
      intended_price          REAL,
      simulated_fill_price    REAL,
      slippage_abs            REAL,
      slippage_pct            REAL,
      spread_pct              REAL,
      liquidity_score         REAL,
      fill_status             TEXT NOT NULL,
      rejection_reason        TEXT,
      order_created_at        DATETIME,
      order_filled_at         DATETIME,
      simulated_latency_ms    INTEGER,
      brokerage               REAL,
      stt                     REAL,
      exchange_charges        REAL,
      sebi_charges            REAL,
      gst                     REAL,
      stamp_duty              REAL,
      total_charges           REAL,
      gross_pnl               REAL,
      net_pnl                 REAL,
      gross_return_pct        REAL,
      cost_adjusted_return_pct REAL,
      execution_score         INTEGER,
      created_at              DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[p22-migration] virtual_execution_quality_events ✓');

  // ── 4. virtual_safety_states ────────────────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS virtual_safety_states (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id                 INTEGER NOT NULL UNIQUE,
      reconciliation_status        TEXT NOT NULL DEFAULT 'HEALTHY',
      new_buys_blocked             INTEGER DEFAULT 0,
      only_risk_reducing_sells     INTEGER DEFAULT 0,
      reason_code                  TEXT,
      reason_message               TEXT,
      last_reconciliation_run_id   INTEGER,
      last_reconciled_at           DATETIME,
      updated_at                   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[p22-migration] virtual_safety_states ✓');

  // ── Indexes ──────────────────────────────────────────────────────────────────
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_virtual_reconciliation_portfolio_time
    ON virtual_reconciliation_runs(portfolio_id, run_started_at)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_virtual_mismatches_portfolio_status
    ON virtual_reconciliation_mismatches(portfolio_id, status, severity)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_virtual_execution_portfolio_time
    ON virtual_execution_quality_events(portfolio_id, created_at)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_virtual_execution_symbol_time
    ON virtual_execution_quality_events(symbol, created_at)
  `);
  console.log('[p22-migration] Indexes ✓');

  console.log('[p22-migration] Phase 22 migration complete.');
}

migrate().catch(err => {
  console.error('[p22-migration] FAILED:', err);
  process.exit(1);
});
