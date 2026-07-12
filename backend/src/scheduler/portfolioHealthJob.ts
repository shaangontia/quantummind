/**
 * portfolioHealthJob.ts — Phase 21: Portfolio Health Refresh Job
 *
 * Fire-and-forget health calculation triggered after:
 *   - BUY trade executed (marketMonitor.ts)
 *   - SELL trade executed (marketMonitor.ts)
 *   - Kill-switch state change (evaluated in evaluateKillSwitch)
 *   - Nightly cron (via runAllPortfoliosHealthJob)
 *   - Manual admin recalculation (API)
 *
 * CRITICAL: This job must NEVER throw or block the calling path.
 * All errors are caught and logged silently.
 */

import { query } from '../db/turso.js';
import { calculatePortfolioHealth } from '../services/portfolioHealthService.js';
import { createHealthAlertIfNeeded } from '../services/portfolioRecommendationService.js';

/**
 * Run health calculation for a single portfolio.
 * Returns the new health score, or null on failure.
 * Never throws.
 */
export async function runPortfolioHealthJob(portfolioId: number): Promise<number | null> {
  try {
    const snapshot = await calculatePortfolioHealth(portfolioId);

    // Create CRITICAL alerts for any critical findings
    const criticalRecs = snapshot.recommendations.filter(r => r.severity === 'CRITICAL');
    for (const rec of criticalRecs) {
      await createHealthAlertIfNeeded({
        portfolioId,
        alertType:   rec.code,
        severity:    'CRITICAL',
        message:     rec.message,
        reasonCodes: snapshot.topRisks,
      });
    }

    return snapshot.healthScore;
  } catch (err) {
    console.error(`[portfolioHealthJob] Failed for portfolio ${portfolioId}:`, String(err));
    return null;
  }
}

/**
 * Run health calculation for all active portfolios.
 * Sequential to avoid overwhelming the DB with concurrent reads.
 * Never throws.
 */
export async function runAllPortfoliosHealthJob(): Promise<{ portfoliosProcessed: number; failures: number }> {
  let portfoliosProcessed = 0;
  let failures = 0;

  try {
    const portfolios = await query('SELECT id FROM portfolios WHERE is_active = 1 ORDER BY id');
    for (const p of portfolios) {
      const result = await runPortfolioHealthJob(Number(p.id));
      if (result !== null) portfoliosProcessed++;
      else failures++;
    }
  } catch (err) {
    console.error('[portfolioHealthJob] runAllPortfoliosHealthJob failed:', String(err));
  }

  return { portfoliosProcessed, failures };
}
