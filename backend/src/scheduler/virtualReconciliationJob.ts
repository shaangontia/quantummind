/**
 * virtualReconciliationJob.ts — Phase 22: Virtual Reconciliation Job
 *
 * Triggers virtual ledger reconciliation. Designed to be called:
 *   - After every virtual BUY (fire-and-forget)
 *   - After every virtual SELL (fire-and-forget)
 *   - After stop-loss execution
 *   - After emergency liquidation
 *   - Nightly cron for all active portfolios
 *   - Manual admin retry via API
 *
 * CRITICAL: Fire-and-forget calls MUST NOT throw or block the trading loop.
 * All errors are caught and logged — never propagated to the caller.
 *
 * Author: Vinidicare (Phase 22)
 */

import { query } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import { runVirtualLedgerReconciliation } from '../services/virtualLedgerReconciliationService.js';

// ── Fire-and-forget (post-trade) ─────────────────────────────────────────────

/**
 * Run reconciliation for a single portfolio after a trade.
 * Non-blocking: errors are logged, never thrown.
 */
export function fireVirtualReconciliation(portfolioId: number, trigger: string): void {
  void runVirtualLedgerReconciliation(portfolioId).catch(err =>
    logger.warn({ job: 'virtual-reconciliation', portfolioId, trigger, err: String(err),
      msg: 'Virtual reconciliation failed after trade — will retry on next cycle' }),
  );
}

// ── Single portfolio (awaitable, for admin retry) ─────────────────────────────

/**
 * Run reconciliation for a single portfolio and return the result.
 * Used by the admin retry API endpoint.
 * Throws on failure (admin can see the error).
 */
export async function runVirtualReconciliationForPortfolio(portfolioId: number) {
  logger.info({ job: 'virtual-reconciliation', portfolioId, trigger: 'MANUAL_RETRY',
    msg: 'Manual virtual reconciliation triggered' });
  return runVirtualLedgerReconciliation(portfolioId);
}

// ── Nightly job: all active portfolios ───────────────────────────────────────

/**
 * Run reconciliation for all active virtual portfolios.
 * Sequential to avoid overwhelming the DB with concurrent reads.
 * Used by the nightly cron scheduler.
 */
export async function runVirtualReconciliationJob(): Promise<{
  total: number;
  healthy: number;
  mismatch: number;
  failed: number;
}> {
  logger.info({ job: 'virtual-reconciliation-nightly', msg: 'Starting nightly virtual reconciliation run' });

  const portfolios = await query(
    'SELECT id FROM portfolios WHERE is_active = 1',
    [],
  );

  let healthy = 0, mismatch = 0, failed = 0;

  for (const portfolio of portfolios) {
    const portfolioId = Number(portfolio.id);
    try {
      const result = await runVirtualLedgerReconciliation(portfolioId);
      if (result.status === 'HEALTHY' || result.status === 'WARNING') {
        healthy++;
      } else {
        mismatch++;
      }
    } catch (err) {
      failed++;
      logger.error({ job: 'virtual-reconciliation-nightly', portfolioId, err: String(err),
        msg: 'Virtual reconciliation failed for portfolio' });
    }
  }

  logger.info({ job: 'virtual-reconciliation-nightly',
    total: portfolios.length, healthy, mismatch, failed, msg: 'Nightly virtual reconciliation complete' });

  return { total: portfolios.length, healthy, mismatch, failed };
}
