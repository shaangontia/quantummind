/**
 * virtualSafetyService.ts — Phase 22: Virtual Ledger Safety Gate
 *
 * Protects the trading loop when the virtual ledger is in an unsafe state.
 * Acts as a gate — checked before any BUY, and before non-risk-reducing SELLs.
 *
 * BUY rule: if newBuysBlocked → skipBuy('VIRTUAL_LEDGER_RECONCILIATION_HALT')
 *
 * SELL rule (during mismatch):
 *   ALLOWED:  STOP_LOSS | TRAILING_STOP | ATR_STOP | EMERGENCY_LIQUIDATION |
 *             DRAWDOWN_PROTECTION | THESIS_INVALIDATION | REGIME_EXIT
 *   BLOCKED:  profit booking, tactical rotation, non-risk-reducing sells
 *
 * Author: Vinidicare (Phase 22)
 */

import { query, queryOne, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type VirtualSafetyState = {
  portfolioId:          number;
  reconciliationStatus: 'HEALTHY' | 'WARNING' | 'MISMATCH' | 'FAILED';
  newBuysBlocked:       boolean;
  onlyRiskReducingSells: boolean;
  reasonCode:           string | null;
  reasonMessage:        string | null;
  lastReconciledAt:     string | null;
};

// Sell types that are ALWAYS allowed — even during a virtual ledger halt
const RISK_REDUCING_SELL_TYPES = new Set([
  'STOP_LOSS',
  'TRAILING_STOP',
  'ATR_STOP',
  'EMERGENCY_LIQUIDATION',
  'DRAWDOWN_PROTECTION',
  'THESIS_INVALIDATION',
  'THESIS_INVALIDATED',
  'REGIME_EXIT',
  'TIME_STOP',
]);

// ── Read current safety state ─────────────────────────────────────────────────

export async function getVirtualSafetyState(portfolioId: number): Promise<VirtualSafetyState> {
  const row = await queryOne(
    `SELECT reconciliation_status, new_buys_blocked, only_risk_reducing_sells,
            reason_code, reason_message, last_reconciled_at
     FROM virtual_safety_states
     WHERE portfolio_id = ?`,
    [portfolioId],
  );

  if (!row) {
    // No reconciliation run yet — default to HEALTHY (don't block on first run)
    return {
      portfolioId,
      reconciliationStatus: 'HEALTHY',
      newBuysBlocked:       false,
      onlyRiskReducingSells: false,
      reasonCode:           null,
      reasonMessage:        null,
      lastReconciledAt:     null,
    };
  }

  return {
    portfolioId,
    reconciliationStatus: String(row.reconciliation_status) as VirtualSafetyState['reconciliationStatus'],
    newBuysBlocked:       Number(row.new_buys_blocked) === 1,
    onlyRiskReducingSells: Number(row.only_risk_reducing_sells) === 1,
    reasonCode:           row.reason_code ? String(row.reason_code) : null,
    reasonMessage:        row.reason_message ? String(row.reason_message) : null,
    lastReconciledAt:     row.last_reconciled_at ? String(row.last_reconciled_at) : null,
  };
}

// ── BUY gate ─────────────────────────────────────────────────────────────────

/**
 * Returns null if BUY is allowed.
 * Returns a reason code string if BUY should be skipped.
 */
export async function assertCanBuyVirtual(portfolioId: number): Promise<string | null> {
  const safety = await getVirtualSafetyState(portfolioId);

  if (safety.newBuysBlocked) {
    const code = 'VIRTUAL_LEDGER_RECONCILIATION_HALT';
    logger.warn({ service: 'virtual-safety', portfolioId, reasonCode: safety.reasonCode,
      msg: 'Virtual ledger safety: BUY blocked' });
    return code;
  }

  return null;
}

// ── SELL gate ─────────────────────────────────────────────────────────────────

/**
 * Returns null if SELL is allowed.
 * Returns a reason code string if SELL should be blocked.
 *
 * During a virtual ledger halt, only risk-reducing sell types pass.
 */
export async function assertCanSellVirtual(
  portfolioId: number,
  sellType: string,
): Promise<string | null> {
  const safety = await getVirtualSafetyState(portfolioId);

  if (!safety.onlyRiskReducingSells) return null; // no restriction

  // Safety is in restricted mode — only risk-reducing passes
  if (RISK_REDUCING_SELL_TYPES.has(sellType.toUpperCase())) {
    logger.info({ service: 'virtual-safety', portfolioId, sellType,
      msg: 'Risk-reducing SELL allowed during reconciliation halt' });
    return null;
  }

  logger.warn({ service: 'virtual-safety', portfolioId, sellType,
    msg: 'Non-risk-reducing SELL blocked during virtual ledger halt' });
  return 'VIRTUAL_LEDGER_RECONCILIATION_HALT';
}

// ── Manual halt/clear ────────────────────────────────────────────────────────

export async function activateVirtualSafetyHalt(
  portfolioId: number,
  reasonCode: string,
  reasonMessage: string,
): Promise<void> {
  await run(
    `INSERT INTO virtual_safety_states
       (portfolio_id, reconciliation_status, new_buys_blocked, only_risk_reducing_sells,
        reason_code, reason_message, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(portfolio_id) DO UPDATE SET
       reconciliation_status    = 'MISMATCH',
       new_buys_blocked         = 1,
       only_risk_reducing_sells = 1,
       reason_code              = excluded.reason_code,
       reason_message           = excluded.reason_message,
       updated_at               = excluded.updated_at`,
    [portfolioId, 'MISMATCH', 1, 1, reasonCode, reasonMessage, new Date().toISOString()],
  );

  logger.warn({ service: 'virtual-safety', portfolioId, reasonCode, msg: 'Virtual safety halt activated' });
}

export async function clearVirtualSafetyHalt(portfolioId: number): Promise<void> {
  await run(
    `UPDATE virtual_safety_states
     SET reconciliation_status    = 'HEALTHY',
         new_buys_blocked         = 0,
         only_risk_reducing_sells = 0,
         reason_code              = NULL,
         reason_message           = NULL,
         updated_at               = ?
     WHERE portfolio_id = ?`,
    [new Date().toISOString(), portfolioId],
  );

  logger.info({ service: 'virtual-safety', portfolioId, msg: 'Virtual safety halt cleared' });
}

// ── Portfolio health integration helper ──────────────────────────────────────

/**
 * Returns health reason codes based on current virtual safety state.
 * Consumed by portfolioRecommendationService.ts (Phase 21 integration).
 */
export async function getVirtualHealthReasonCodes(portfolioId: number): Promise<string[]> {
  const safety = await getVirtualSafetyState(portfolioId);
  const codes: string[] = [];

  if (safety.reconciliationStatus === 'MISMATCH' || safety.reconciliationStatus === 'FAILED') {
    codes.push('VIRTUAL_LEDGER_MISMATCH');
  }
  if (safety.reasonCode === 'POSITION_QUANTITY_MISMATCH') {
    codes.push('POSITION_LEDGER_INCONSISTENCY');
  }
  if (safety.reasonCode === 'NAV_MISMATCH') {
    codes.push('NAV_RECONCILIATION_FAILED');
  }
  if (safety.reasonCode === 'EXIT_PLAN_QUANTITY_MISMATCH') {
    codes.push('EXIT_PLAN_QUANTITY_MISMATCH');
  }

  return codes;
}
