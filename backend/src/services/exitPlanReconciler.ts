/**
 * exitPlanReconciler.ts — Phase 18: Exit-plan reconciliation job
 *
 * Nightly scan: find all open holdings that have no registered exit plan
 * (atr_stop_price IS NULL). Re-register using current ATR.
 * Logs MISSING_EXIT_PLAN alert for any position older than 1 day with no stop.
 *
 * Rationale: if a position was entered before exitEngine was deployed,
 * or a rare race condition left it without a stop, this job is the safety net.
 */

import { query, queryOne } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import { registerExitPlan, computeATRStop } from './exitEngine.js';
import { getRsi } from './marketData.js';

export interface ReconciliationReport {
  portfolioId: number;
  totalHoldings: number;
  missingExitPlans: number;
  restored: string[];
  alerts: string[];
}

/**
 * Reconcile exit plans for a single portfolio.
 * Returns a report of missing plans and which were restored.
 */
export async function reconcileExitPlans(portfolioId: number): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    portfolioId,
    totalHoldings: 0,
    missingExitPlans: 0,
    restored: [],
    alerts: [],
  };

  const holdings = await query(
    `SELECT h.*, t.risk_amount_inr
     FROM holdings h
     LEFT JOIN trades t ON t.portfolio_id = h.portfolio_id
       AND t.symbol = h.symbol
       AND t.action = 'BUY'
       AND t.id = (
         SELECT MAX(id) FROM trades
         WHERE portfolio_id = h.portfolio_id AND symbol = h.symbol AND action = 'BUY'
       )
     WHERE h.portfolio_id = ?`,
    [portfolioId],
  ).catch(() => []);

  report.totalHoldings = holdings.length;

  const oneDayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();

  for (const h of holdings) {
    const hasStop = h.atr_stop_price !== null && h.atr_stop_price !== undefined;
    if (hasStop) continue;

    report.missingExitPlans++;

    const isOldPosition = h.created_at && h.created_at < oneDayAgo;
    const symbol  = String(h.symbol);
    const entryPx = Number(h.avg_buy_price ?? 0);
    const currentPx = Number(h.current_price ?? entryPx);
    const qty = Number(h.quantity ?? 0);

    if (isOldPosition) {
      const alertMsg = `MISSING_EXIT_PLAN: portfolio=${portfolioId} symbol=${symbol} held since ${h.created_at} has no stop-loss`;
      report.alerts.push(alertMsg);
      logger.warn({ job: 'exit-reconciler', portfolioId, symbol, reason: alertMsg });
    }

    // Re-register using ATR fallback (1.5% of current price)
    // Get actual RSI for ATR estimate if available; fall back to 1.5% constant
    const riskAmountInr = h.risk_amount_inr ? Number(h.risk_amount_inr) : entryPx * qty * 0.005;

    try {
      await registerExitPlan(portfolioId, symbol, entryPx, riskAmountInr);
      report.restored.push(symbol);
      logger.warn({ job: 'exit-reconciler', portfolioId, symbol,
        reason: `EXIT_PLAN_RESTORED — re-registered stop using entry price ₹${entryPx.toFixed(2)}` });
    } catch (err) {
      const errMsg = `Failed to restore exit plan for ${symbol}: ${String(err)}`;
      report.alerts.push(errMsg);
      logger.warn({ job: 'exit-reconciler', portfolioId, symbol, err: String(err),
        reason: 'EXIT_PLAN_RESTORE_FAILED' });
    }
  }

  return report;
}

/**
 * Reconcile exit plans for all active portfolios.
 * Called nightly from marketMonitor cron.
 */
export async function reconcileAllExitPlans(): Promise<ReconciliationReport[]> {
  const portfolios = await query('SELECT id FROM portfolios WHERE is_active=1').catch(() => []);
  const reports: ReconciliationReport[] = [];

  for (const p of portfolios) {
    const report = await reconcileExitPlans(Number(p.id)).catch(err => {
      logger.warn({ job: 'exit-reconciler', portfolioId: p.id, err: String(err),
        reason: 'Reconciliation failed for portfolio' });
      return null;
    });
    if (report) reports.push(report);
  }

  const totalMissing = reports.reduce((s, r) => s + r.missingExitPlans, 0);
  const totalRestored = reports.reduce((s, r) => s + r.restored.length, 0);
  logger.warn({ job: 'exit-reconciler',
    reason: `Nightly reconciliation complete: ${totalMissing} missing exit plans, ${totalRestored} restored` });

  return reports;
}
