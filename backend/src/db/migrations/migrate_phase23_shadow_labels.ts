/**
 * migrate_phase23_shadow_labels.ts
 *
 * Phase 23: Shadow Label Learning Acceleration
 *
 * Adds learning metadata columns to trade_candidates so non-executed (shadow)
 * candidates can be labelled and used in ML training with sample weights.
 *
 * New columns:
 *   price_source         — EXECUTED_FILL | THEORETICAL_EVALUATION
 *   data_source          — LIVE_PAPER_EXECUTED | LIVE_PAPER_SHADOW | POLICY_SIMULATION
 *   label_quality        — ACTUAL_EXECUTED | SHADOW_THEORETICAL | SIMULATED_POLICY | INVALID
 *   learning_eligible    — 1 = include in ML training pipeline
 *   learning_weight      — sample weight: EXECUTED=1.0, SKIPPED=0.7, WEAK=0.5, VETOED=0.3, hard-veto=0.0
 *   label_horizon_days   — how many trading days after entry to attempt label (default 15)
 *   label_ready_at       — ISO date when label generation is first attempted
 *   risk_per_share       — entry_price - stop_price (INR per share)
 *   stop_r_multiple      — stop distance expressed in R units (always 1.5 for ATR-based stops)
 *   target_r_multiple    — target distance in R units (always 2.0 for existing formula)
 *
 * Backfill:
 *   All existing EXECUTED rows → LIVE_PAPER_EXECUTED, ACTUAL_EXECUTED, weight=1.0
 *   All others with entry_price → LIVE_PAPER_SHADOW, SHADOW_THEORETICAL, weight per action_taken
 */

import { run, query } from '../turso.js';
import { logger } from '../../lib/logger.js';

export async function runMigration(): Promise<void> {
  logger.info({ job: 'migration', name: 'phase23_shadow_labels', reason: 'Starting' });

  const alterStatements = [
    `ALTER TABLE trade_candidates ADD COLUMN price_source TEXT DEFAULT 'THEORETICAL_EVALUATION'`,
    `ALTER TABLE trade_candidates ADD COLUMN data_source TEXT DEFAULT 'LIVE_PAPER_SHADOW'`,
    `ALTER TABLE trade_candidates ADD COLUMN label_quality TEXT`,
    `ALTER TABLE trade_candidates ADD COLUMN learning_eligible INTEGER DEFAULT 0`,
    `ALTER TABLE trade_candidates ADD COLUMN learning_weight REAL DEFAULT 0.0`,
    `ALTER TABLE trade_candidates ADD COLUMN label_horizon_days INTEGER DEFAULT 15`,
    `ALTER TABLE trade_candidates ADD COLUMN label_ready_at TEXT`,
    `ALTER TABLE trade_candidates ADD COLUMN risk_per_share REAL`,
    `ALTER TABLE trade_candidates ADD COLUMN stop_r_multiple REAL DEFAULT 1.5`,
    `ALTER TABLE trade_candidates ADD COLUMN target_r_multiple REAL DEFAULT 2.0`,
  ];

  for (const sql of alterStatements) {
    await run(sql).catch(e => {
      // Column already exists — safe to ignore
      if (!String(e).includes('duplicate column')) {
        logger.warn({ job: 'migration', name: 'phase23_shadow_labels', err: String(e), reason: 'ALTER failed' });
      }
    });
  }

  // Backfill: EXECUTED rows
  await run(`
    UPDATE trade_candidates
    SET price_source     = 'EXECUTED_FILL',
        data_source      = 'LIVE_PAPER_EXECUTED',
        label_quality    = 'ACTUAL_EXECUTED',
        learning_eligible = 1,
        learning_weight  = 1.0,
        risk_per_share   = CASE WHEN entry_price IS NOT NULL AND stop_price IS NOT NULL
                               THEN entry_price - stop_price ELSE NULL END,
        stop_r_multiple  = 1.5,
        target_r_multiple = 2.0,
        label_ready_at   = date(evaluated_at, '+21 days')
    WHERE action_taken = 'EXECUTED'
  `).catch(e => logger.warn({ job: 'migration', name: 'phase23_shadow_labels', err: String(e), reason: 'EXECUTED backfill failed' }));

  // Backfill: SKIPPED (ranked-out or gated) — high-quality shadow labels
  await run(`
    UPDATE trade_candidates
    SET price_source     = 'THEORETICAL_EVALUATION',
        data_source      = 'LIVE_PAPER_SHADOW',
        label_quality    = 'SHADOW_THEORETICAL',
        learning_eligible = CASE WHEN entry_price IS NOT NULL THEN 1 ELSE 0 END,
        learning_weight  = 0.7,
        risk_per_share   = CASE WHEN entry_price IS NOT NULL AND stop_price IS NOT NULL
                               THEN entry_price - stop_price ELSE NULL END,
        stop_r_multiple  = 1.5,
        target_r_multiple = 2.0,
        label_ready_at   = date(evaluated_at, '+21 days')
    WHERE action_taken = 'SKIPPED'
  `).catch(e => logger.warn({ job: 'migration', name: 'phase23_shadow_labels', err: String(e), reason: 'SKIPPED backfill failed' }));

  // Backfill: WEAK — lower weight
  await run(`
    UPDATE trade_candidates
    SET price_source     = 'THEORETICAL_EVALUATION',
        data_source      = 'LIVE_PAPER_SHADOW',
        label_quality    = 'SHADOW_THEORETICAL',
        learning_eligible = CASE WHEN entry_price IS NOT NULL THEN 1 ELSE 0 END,
        learning_weight  = 0.5,
        risk_per_share   = CASE WHEN entry_price IS NOT NULL AND stop_price IS NOT NULL
                               THEN entry_price - stop_price ELSE NULL END,
        stop_r_multiple  = 1.5,
        target_r_multiple = 2.0,
        label_ready_at   = date(evaluated_at, '+21 days')
    WHERE action_taken = 'WEAK'
  `).catch(e => logger.warn({ job: 'migration', name: 'phase23_shadow_labels', err: String(e), reason: 'WEAK backfill failed' }));

  // Backfill: VETOED — lowest weight (analytics but risk-gated)
  await run(`
    UPDATE trade_candidates
    SET price_source     = 'THEORETICAL_EVALUATION',
        data_source      = 'LIVE_PAPER_SHADOW',
        label_quality    = 'SHADOW_THEORETICAL',
        learning_eligible = CASE WHEN entry_price IS NOT NULL THEN 1 ELSE 0 END,
        learning_weight  = 0.3,
        risk_per_share   = CASE WHEN entry_price IS NOT NULL AND stop_price IS NOT NULL
                               THEN entry_price - stop_price ELSE NULL END,
        stop_r_multiple  = 1.5,
        target_r_multiple = 2.0,
        label_ready_at   = date(evaluated_at, '+21 days')
    WHERE action_taken = 'VETOED'
  `).catch(e => logger.warn({ job: 'migration', name: 'phase23_shadow_labels', err: String(e), reason: 'VETOED backfill failed' }));

  const total = await query('SELECT COUNT(*) as c FROM trade_candidates').then(r => Number(r[0]?.c ?? 0)).catch(() => 0);
  logger.info({ job: 'migration', name: 'phase23_shadow_labels', total, reason: 'Complete' });
}
