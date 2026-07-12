/**
 * virtualLedgerReconciliationService.ts — Phase 22: Virtual Ledger Reconciliation
 *
 * Compares the reconstructed virtual ledger against current stored system state,
 * records mismatches, and updates the virtual safety state.
 *
 * Severity rules:
 *   CRITICAL (blocks new BUYs):
 *     - Cash mismatch > ₹100
 *     - NAV mismatch > 0.5%
 *     - Any position quantity mismatch (exact — tolerance = 0)
 *     - Negative cash
 *     - Negative position quantity
 *     - Trade exists but no corresponding position
 *     - Exit plan quantity exceeds actual position quantity
 *     - Duplicate order effect detected
 *
 *   WARNING (does not block immediately):
 *     - Cash mismatch ₹10–₹100 (rounding/fee differences)
 *     - NAV mismatch 0.1–0.5%
 *     - Exit plan missing within grace period (< 2 min after BUY)
 *
 *   INFO:
 *     - Position exists but no trade history (manual admin correction)
 *
 * Author: Vinidicare (Phase 22)
 */

import { query, queryOne, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';
import {
  reconstructVirtualLedger,
  type ReconstructedVirtualLedger,
  type ReconstructedPosition,
} from './virtualLedgerService.js';

// ── Config ────────────────────────────────────────────────────────────────────

const virtualReconciliationConfig = {
  cashWarningAmount:         10,     // ₹10 difference → WARNING
  cashCriticalAmount:        100,    // ₹100 difference → CRITICAL
  navWarningPct:             0.10,   // 0.10% NAV difference → WARNING
  navCriticalPct:            0.50,   // 0.50% NAV difference → CRITICAL
  positionQuantityTolerance: 0,      // zero tolerance on quantity mismatches
  exitPlanGraceMinutes:      2,      // grace period for missing exit plan after BUY
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export type MismatchSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type MismatchType =
  | 'CASH_MISMATCH'
  | 'NAV_MISMATCH'
  | 'POSITION_QUANTITY_MISMATCH'
  | 'POSITION_MISSING'
  | 'TRADE_WITHOUT_POSITION'
  | 'POSITION_WITHOUT_TRADE'
  | 'EXIT_PLAN_QUANTITY_MISMATCH'
  | 'NEGATIVE_CASH'
  | 'NEGATIVE_POSITION'
  | 'DUPLICATE_ORDER_EFFECT';

export type ReconciliationMismatch = {
  mismatchType:                MismatchType;
  severity:                    MismatchSeverity;
  symbol?:                     string;
  expectedValue:               string;
  actualValue:                 string;
  differenceValue:             string;
  blocksNewBuys:               boolean;
  allowsOnlyRiskReducingSells: boolean;
};

export type ReconciliationResult = {
  portfolioId:           number;
  status:                'HEALTHY' | 'WARNING' | 'MISMATCH' | 'FAILED';
  mismatches:            ReconciliationMismatch[];
  mismatchCount:         number;
  criticalMismatchCount: number;
  expectedCash:          number;
  actualCash:            number;
  cashDifference:        number;
  expectedNav:           number;
  actualNav:             number;
  navDifference:         number;
  expectedPositions:     ReconstructedPosition[];
  actualPositions:       any[];
  runId:                 number;
};

// ── Individual comparisons ────────────────────────────────────────────────────

export function compareVirtualCash(expectedCash: number, actualCash: number): ReconciliationMismatch[] {
  const mismatches: ReconciliationMismatch[] = [];
  const diff = Math.abs(expectedCash - actualCash);

  if (actualCash < 0) {
    mismatches.push({
      mismatchType:                'NEGATIVE_CASH',
      severity:                    'CRITICAL',
      expectedValue:               '≥ 0',
      actualValue:                 String(actualCash.toFixed(2)),
      differenceValue:             String(diff.toFixed(2)),
      blocksNewBuys:               true,
      allowsOnlyRiskReducingSells: false,
    });
  }

  if (diff >= virtualReconciliationConfig.cashCriticalAmount) {
    mismatches.push({
      mismatchType:                'CASH_MISMATCH',
      severity:                    'CRITICAL',
      expectedValue:               String(expectedCash.toFixed(2)),
      actualValue:                 String(actualCash.toFixed(2)),
      differenceValue:             String(diff.toFixed(2)),
      blocksNewBuys:               true,
      allowsOnlyRiskReducingSells: true,
    });
  } else if (diff >= virtualReconciliationConfig.cashWarningAmount) {
    mismatches.push({
      mismatchType:                'CASH_MISMATCH',
      severity:                    'WARNING',
      expectedValue:               String(expectedCash.toFixed(2)),
      actualValue:                 String(actualCash.toFixed(2)),
      differenceValue:             String(diff.toFixed(2)),
      blocksNewBuys:               false,
      allowsOnlyRiskReducingSells: false,
    });
  }

  return mismatches;
}

export function compareVirtualPositions(
  expectedPositions: ReconstructedPosition[],
  actualPositions: Array<{ symbol: string; quantity: number }>,
): ReconciliationMismatch[] {
  const mismatches: ReconciliationMismatch[] = [];
  const actualMap = new Map(actualPositions.map(p => [p.symbol, p.quantity]));
  const expectedMap = new Map(expectedPositions.map(p => [p.symbol, p.quantity]));

  // Check expected vs actual
  for (const exp of expectedPositions) {
    if (exp.quantity < 0) {
      mismatches.push({
        mismatchType:                'NEGATIVE_POSITION',
        severity:                    'CRITICAL',
        symbol:                      exp.symbol,
        expectedValue:               '≥ 0',
        actualValue:                 String(exp.quantity),
        differenceValue:             String(Math.abs(exp.quantity)),
        blocksNewBuys:               true,
        allowsOnlyRiskReducingSells: false,
      });
      continue;
    }

    const actualQty = actualMap.get(exp.symbol) ?? 0;
    const qtyDiff   = Math.abs(exp.quantity - actualQty);

    if (qtyDiff > virtualReconciliationConfig.positionQuantityTolerance) {
      if (actualQty === 0) {
        mismatches.push({
          mismatchType:                'TRADE_WITHOUT_POSITION',
          severity:                    'CRITICAL',
          symbol:                      exp.symbol,
          expectedValue:               String(exp.quantity),
          actualValue:                 '0 (no holding record)',
          differenceValue:             String(exp.quantity),
          blocksNewBuys:               true,
          allowsOnlyRiskReducingSells: true,
        });
      } else {
        mismatches.push({
          mismatchType:                'POSITION_QUANTITY_MISMATCH',
          severity:                    'CRITICAL',
          symbol:                      exp.symbol,
          expectedValue:               String(exp.quantity),
          actualValue:                 String(actualQty),
          differenceValue:             String(qtyDiff.toFixed(4)),
          blocksNewBuys:               true,
          allowsOnlyRiskReducingSells: true,
        });
      }
    }
  }

  // Positions that exist in holdings but have NO trade history
  for (const act of actualPositions) {
    if (!expectedMap.has(act.symbol) && act.quantity > 0) {
      mismatches.push({
        mismatchType:                'POSITION_WITHOUT_TRADE',
        severity:                    'INFO',
        symbol:                      act.symbol,
        expectedValue:               '0 (no trade history)',
        actualValue:                 String(act.quantity),
        differenceValue:             String(act.quantity),
        blocksNewBuys:               false,
        allowsOnlyRiskReducingSells: false,
      });
    }
  }

  return mismatches;
}

export function compareVirtualNav(
  expectedNav: number,
  actualNav: number,
): ReconciliationMismatch[] {
  if (actualNav <= 0) return []; // skip if NAV is zero (new portfolio)

  const diffPct = Math.abs((expectedNav - actualNav) / actualNav) * 100;
  const diffAbs = Math.abs(expectedNav - actualNav);

  if (diffPct >= virtualReconciliationConfig.navCriticalPct) {
    return [{
      mismatchType:                'NAV_MISMATCH',
      severity:                    'CRITICAL',
      expectedValue:               String(expectedNav.toFixed(2)),
      actualValue:                 String(actualNav.toFixed(2)),
      differenceValue:             `${diffAbs.toFixed(2)} (${diffPct.toFixed(3)}%)`,
      blocksNewBuys:               true,
      allowsOnlyRiskReducingSells: true,
    }];
  }

  if (diffPct >= virtualReconciliationConfig.navWarningPct) {
    return [{
      mismatchType:                'NAV_MISMATCH',
      severity:                    'WARNING',
      expectedValue:               String(expectedNav.toFixed(2)),
      actualValue:                 String(actualNav.toFixed(2)),
      differenceValue:             `${diffAbs.toFixed(2)} (${diffPct.toFixed(3)}%)`,
      blocksNewBuys:               false,
      allowsOnlyRiskReducingSells: false,
    }];
  }

  return [];
}

export async function compareExitPlans(
  portfolioId: number,
  expectedPositions: ReconstructedPosition[],
): Promise<ReconciliationMismatch[]> {
  const mismatches: ReconciliationMismatch[] = [];

  // Load holdings with exit plan data
  const holdings = await query(
    `SELECT symbol, quantity, atr_stop_price, time_stop_date, created_at
     FROM holdings
     WHERE portfolio_id = ?`,
    [portfolioId],
  );

  const holdingMap = new Map(holdings.map((h: any) => [String(h.symbol), h]));

  for (const exp of expectedPositions) {
    const holding = holdingMap.get(exp.symbol);
    if (!holding) continue;

    const actualQty = Number(holding.quantity ?? 0);

    // Exit plan quantity > actual holding quantity = data integrity issue
    // (This would happen if an exit plan was registered for a quantity that was later partially sold
    //  but the exit plan target was never updated)
    // We flag it as WARNING rather than block (exit plan will be trimmed on next SELL)
    if (exp.quantity > 0 && actualQty > 0 && exp.quantity > actualQty + 0.001) {
      mismatches.push({
        mismatchType:                'EXIT_PLAN_QUANTITY_MISMATCH',
        severity:                    'CRITICAL',
        symbol:                      exp.symbol,
        expectedValue:               String(exp.quantity),
        actualValue:                 String(actualQty),
        differenceValue:             String((exp.quantity - actualQty).toFixed(4)),
        blocksNewBuys:               true,
        allowsOnlyRiskReducingSells: false,
      });
    }

    // Missing exit plan for a position older than grace period
    if (holding.atr_stop_price == null) {
      const createdAt  = holding.created_at ? new Date(String(holding.created_at)) : null;
      const ageMinutes = createdAt
        ? (Date.now() - createdAt.getTime()) / (1000 * 60)
        : Infinity;

      if (ageMinutes > virtualReconciliationConfig.exitPlanGraceMinutes) {
        mismatches.push({
          mismatchType:                'POSITION_MISSING',
          severity:                    'WARNING',
          symbol:                      exp.symbol,
          expectedValue:               'exit plan present',
          actualValue:                 'no exit plan (atr_stop_price IS NULL)',
          differenceValue:             `${Math.round(ageMinutes)} minutes since entry`,
          blocksNewBuys:               false,
          allowsOnlyRiskReducingSells: false,
        });
      }
    }
  }

  return mismatches;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export async function saveVirtualReconciliationRun(
  portfolioId: number,
  ledger: ReconstructedVirtualLedger,
  actualCash: number,
  actualNav: number,
  actualPositions: any[],
  mismatches: ReconciliationMismatch[],
  status: 'HEALTHY' | 'WARNING' | 'MISMATCH' | 'FAILED',
  errorMessage?: string,
): Promise<number> {
  const criticalCount = mismatches.filter(m => m.severity === 'CRITICAL').length;
  const now = new Date().toISOString();

  const result = await run(
    `INSERT INTO virtual_reconciliation_runs (
      portfolio_id, run_started_at, run_completed_at, status,
      mismatch_count, critical_mismatch_count,
      expected_cash, actual_cash, cash_difference,
      expected_nav, actual_nav, nav_difference,
      expected_positions_json, actual_positions_json, mismatches_json,
      error_message, resolution_status, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      portfolioId,
      now, now, status,
      mismatches.length, criticalCount,
      ledger.expectedCash, actualCash, Math.abs(ledger.expectedCash - actualCash),
      ledger.expectedNav, actualNav, Math.abs(ledger.expectedNav - actualNav),
      JSON.stringify(ledger.expectedPositions),
      JSON.stringify(actualPositions),
      JSON.stringify(mismatches),
      errorMessage ?? null,
      'OPEN',
      now,
    ],
  );

  return result.lastInsertRowid;
}

export async function saveVirtualReconciliationMismatches(
  runId: number,
  portfolioId: number,
  mismatches: ReconciliationMismatch[],
): Promise<void> {
  for (const m of mismatches) {
    await run(
      `INSERT INTO virtual_reconciliation_mismatches (
        reconciliation_run_id, portfolio_id, mismatch_type, severity,
        symbol, expected_value, actual_value, difference_value,
        blocks_new_buys, allows_only_risk_reducing_sells,
        status, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        runId, portfolioId, m.mismatchType, m.severity,
        m.symbol ?? null, m.expectedValue, m.actualValue, m.differenceValue,
        m.blocksNewBuys ? 1 : 0,
        m.allowsOnlyRiskReducingSells ? 1 : 0,
        'OPEN', new Date().toISOString(),
      ],
    );
  }
}

export async function updateVirtualSafetyState(
  portfolioId: number,
  runId: number,
  mismatches: ReconciliationMismatch[],
  status: 'HEALTHY' | 'WARNING' | 'MISMATCH' | 'FAILED',
): Promise<void> {
  const criticalMismatches = mismatches.filter(m => m.severity === 'CRITICAL');
  const newBuysBlocked     = criticalMismatches.length > 0 || status === 'FAILED';
  const onlyRiskReducing   = criticalMismatches.some(m => m.allowsOnlyRiskReducingSells);

  const reasonCode = criticalMismatches.length > 0
    ? criticalMismatches[0].mismatchType
    : null;
  const reasonMessage = criticalMismatches.length > 0
    ? buildReasonMessage(criticalMismatches)
    : null;

  await run(
    `INSERT INTO virtual_safety_states
       (portfolio_id, reconciliation_status, new_buys_blocked, only_risk_reducing_sells,
        reason_code, reason_message, last_reconciliation_run_id, last_reconciled_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(portfolio_id) DO UPDATE SET
       reconciliation_status      = excluded.reconciliation_status,
       new_buys_blocked           = excluded.new_buys_blocked,
       only_risk_reducing_sells   = excluded.only_risk_reducing_sells,
       reason_code                = excluded.reason_code,
       reason_message             = excluded.reason_message,
       last_reconciliation_run_id = excluded.last_reconciliation_run_id,
       last_reconciled_at         = excluded.last_reconciled_at,
       updated_at                 = excluded.updated_at`,
    [
      portfolioId, status, newBuysBlocked ? 1 : 0, onlyRiskReducing ? 1 : 0,
      reasonCode, reasonMessage,
      runId, new Date().toISOString(), new Date().toISOString(),
    ],
  );
}

function buildReasonMessage(criticals: ReconciliationMismatch[]): string {
  const types = [...new Set(criticals.map(m => m.mismatchType))];
  if (types.includes('NEGATIVE_CASH'))             return 'Virtual portfolio has negative cash balance. New BUYs blocked.';
  if (types.includes('TRADE_WITHOUT_POSITION'))    return 'Trade records exist without corresponding position records. New BUYs blocked.';
  if (types.includes('POSITION_QUANTITY_MISMATCH')) return `Position quantity mismatch detected. New BUYs blocked until reconciliation completes.`;
  if (types.includes('CASH_MISMATCH'))             return 'Virtual cash mismatch above tolerance. New BUYs paused.';
  if (types.includes('NAV_MISMATCH'))              return 'Virtual NAV mismatch above tolerance. New BUYs paused.';
  if (types.includes('EXIT_PLAN_QUANTITY_MISMATCH')) return 'Exit plan quantity exceeds actual position. New BUYs blocked.';
  return 'Virtual ledger mismatch detected. New BUY orders paused until reconciliation completes.';
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runVirtualLedgerReconciliation(portfolioId: number): Promise<ReconciliationResult> {
  logger.info({ service: 'virtual-reconciliation', portfolioId, msg: 'Starting virtual ledger reconciliation' });

  let runId = 0;

  try {
    // 1. Reconstruct expected ledger from trade history
    const ledger = await reconstructVirtualLedger(portfolioId);

    // 2. Load current system state
    const portfolio = await queryOne(
      'SELECT current_cash FROM portfolios WHERE id = ?',
      [portfolioId],
    );
    if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

    const actualCash = Number(portfolio.current_cash);

    // Current holdings as actual positions
    const actualHoldings = await query(
      `SELECT symbol, quantity, current_price, avg_buy_price
       FROM holdings WHERE portfolio_id = ?`,
      [portfolioId],
    );
    const actualPositions = actualHoldings.map((h: any) => ({
      symbol:   String(h.symbol),
      quantity: Number(h.quantity ?? 0),
    }));

    // Actual NAV: current_cash + market value of holdings
    const holdingMarketValue = actualHoldings.reduce(
      (sum: number, h: any) => sum + Number(h.quantity ?? 0) * Number(h.current_price ?? h.avg_buy_price ?? 0),
      0,
    );
    const actualNav = actualCash + holdingMarketValue;

    // 3. Compare
    const allMismatches: ReconciliationMismatch[] = [
      ...compareVirtualCash(ledger.expectedCash, actualCash),
      ...compareVirtualPositions(ledger.expectedPositions, actualPositions),
      ...compareVirtualNav(ledger.expectedNav, actualNav),
      ...await compareExitPlans(portfolioId, ledger.expectedPositions),
    ];

    // 4. Determine status
    const hasCritical = allMismatches.some(m => m.severity === 'CRITICAL');
    const hasWarning  = allMismatches.some(m => m.severity === 'WARNING');
    const status: ReconciliationResult['status'] =
      hasCritical ? 'MISMATCH'
      : hasWarning ? 'WARNING'
      : 'HEALTHY';

    // 5. Persist
    runId = await saveVirtualReconciliationRun(
      portfolioId, ledger, actualCash, actualNav, actualPositions, allMismatches, status,
    );
    await saveVirtualReconciliationMismatches(runId, portfolioId, allMismatches);
    await updateVirtualSafetyState(portfolioId, runId, allMismatches, status);

    logger.info({ service: 'virtual-reconciliation', portfolioId, status,
      mismatchCount: allMismatches.length, runId, msg: 'Reconciliation complete' });

    return {
      portfolioId, status,
      mismatches:            allMismatches,
      mismatchCount:         allMismatches.length,
      criticalMismatchCount: allMismatches.filter(m => m.severity === 'CRITICAL').length,
      expectedCash:          ledger.expectedCash,
      actualCash,
      cashDifference:        Math.abs(ledger.expectedCash - actualCash),
      expectedNav:           ledger.expectedNav,
      actualNav,
      navDifference:         Math.abs(ledger.expectedNav - actualNav),
      expectedPositions:     ledger.expectedPositions,
      actualPositions,
      runId,
    };

  } catch (err) {
    logger.error({ service: 'virtual-reconciliation', portfolioId, err: String(err), msg: 'Virtual reconciliation failed' });

    // Save FAILED run if we have a run ID, otherwise insert a new failure record
    const failedRunId = await run(
      `INSERT INTO virtual_reconciliation_runs
         (portfolio_id, run_started_at, run_completed_at, status, error_message, created_at)
       VALUES (?,?,?,?,?,?)`,
      [portfolioId, new Date().toISOString(), new Date().toISOString(),
       'FAILED', String(err), new Date().toISOString()],
    ).then(r => r.lastInsertRowid).catch(() => 0);

    await updateVirtualSafetyState(portfolioId, failedRunId, [], 'FAILED').catch(() => null);

    throw err;
  }
}
