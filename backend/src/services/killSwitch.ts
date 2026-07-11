/**
 * killSwitch.ts — Phase 13 + Phase 17: Automated trading halt engine
 *
 * All state is persisted to DB on every mutation.
 * portfolio_id = 0 is a reserved global sentinel row for circuit breaker
 * and data-freshness state (which are not per-portfolio — they reflect
 * the health of the shared market-data API).
 *
 * Kill-switch conditions:
 *
 * Phase 13:
 *   Daily loss   > 1% NAV  → halt all new BUYs for the day
 *   Weekly loss  > 3% NAV  → halve new position sizes
 *   Drawdown     > 8% NAV  → pause all new entries
 *   Drawdown     > 12% NAV → protection mode + emergency liquidation
 *
 * Phase 17:
 *   Consecutive losses >= 3 → 24-hour BUY cooldown (per-portfolio)
 *   Data staleness > 2 cycles (10 min) → halt new BUYs (global)
 *   API failures   >= 3 consecutive → CIRCUIT_BREAKER (global, DB-persisted)
 *   Drawdown       > 12% → emergency liquidation (per-portfolio)
 *
 * Phase 17 fix (Darth Reviewer CRITICAL):
 *   Circuit breaker state fully persisted to DB — no in-memory module variables.
 *   Vercel serverless cold-start safe.
 */

import { query, queryOne, run } from '../db/turso.js';
import { logger } from '../lib/logger.js';

export type KillSwitchState = {
  // Phase 13
  dailyLossHalted: boolean;
  weeklyLossHalted: boolean;
  drawdownPaused: boolean;
  drawdownProtection: boolean;
  // Phase 17
  consecutiveLossCooldown: boolean;
  consecutiveLosses: number;
  cooldownUntil: string | null;
  dataStaleHalted: boolean;
  dataStalenessMinutes: number;
  circuitBreakerActive: boolean;
  circuitBreakerSince: string | null;
  apiFailureCount: number;
  emergencyLiquidationTriggered: boolean;
  lastClearedAt: string | null;
};

// ─── Thresholds ───────────────────────────────────────────────────────────────
const DAILY_LOSS_LIMIT_PCT      = 1.0;
const WEEKLY_LOSS_LIMIT_PCT     = 3.0;
const DRAWDOWN_PAUSE_PCT        = 8.0;
const DRAWDOWN_PROTECT_PCT      = 12.0;

const CONSECUTIVE_LOSS_THRESHOLD = 3;
const COOLDOWN_HOURS             = 24;
const DATA_STALE_MINUTES         = 10;
const API_FAILURE_THRESHOLD      = 3;

// Reserved sentinel portfolio_id for global (cross-portfolio) state
const GLOBAL_ROW_ID = 0;

// ─── DB helpers for global circuit breaker ───────────────────────────────────

/**
 * Read global circuit breaker + freshness row from DB.
 * Returns defaults if the row doesn't exist yet.
 */
async function readGlobalState(): Promise<{
  apiFailureCount: number;
  circuitBreakerActive: boolean;
  circuitBreakerSince: string | null;
  lastFreshPriceAt: string | null;
}> {
  const row = await queryOne(
    `SELECT api_failure_count, circuit_breaker_active, circuit_breaker_since, last_fresh_price_at
     FROM kill_switch_state WHERE portfolio_id=?`,
    [GLOBAL_ROW_ID],
  ).catch(() => null);

  return {
    apiFailureCount:      row ? Number(row.api_failure_count    ?? 0)    : 0,
    circuitBreakerActive: row ? Number(row.circuit_breaker_active ?? 0) === 1 : false,
    circuitBreakerSince:  row?.circuit_breaker_since ? String(row.circuit_breaker_since) : null,
    lastFreshPriceAt:     row?.last_fresh_price_at   ? String(row.last_fresh_price_at)   : null,
  };
}

async function writeGlobalState(patch: {
  apiFailureCount?: number;
  circuitBreakerActive?: boolean;
  circuitBreakerSince?: string | null;
  lastFreshPriceAt?: string | null;
}): Promise<void> {
  // Build an upsert that only touches provided columns
  const current = await readGlobalState();
  const apiFailureCount     = patch.apiFailureCount     ?? current.apiFailureCount;
  const circuitBreakerActive = patch.circuitBreakerActive ?? current.circuitBreakerActive;
  // Preserve existing since if not explicitly cleared
  const circuitBreakerSince = 'circuitBreakerSince' in patch
    ? (patch.circuitBreakerSince ?? null)
    : current.circuitBreakerSince;
  const lastFreshPriceAt    = 'lastFreshPriceAt' in patch
    ? (patch.lastFreshPriceAt ?? null)
    : current.lastFreshPriceAt;

  await run(
    `INSERT INTO kill_switch_state (
       portfolio_id, api_failure_count, circuit_breaker_active, circuit_breaker_since,
       last_fresh_price_at, last_updated
     ) VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       api_failure_count=excluded.api_failure_count,
       circuit_breaker_active=excluded.circuit_breaker_active,
       circuit_breaker_since=excluded.circuit_breaker_since,
       last_fresh_price_at=excluded.last_fresh_price_at,
       last_updated=excluded.last_updated`,
    [GLOBAL_ROW_ID, apiFailureCount, circuitBreakerActive ? 1 : 0, circuitBreakerSince, lastFreshPriceAt],
  ).catch(err => {
    logger.warn({ job: 'kill-switch', reason: 'Failed to write global state', err: String(err) });
  });
}

// ─── Public API-failure tracking (called by marketData.ts) ───────────────────

/**
 * Called by marketData layer on a successful price fetch.
 * Resets circuit breaker and records freshness timestamp.
 * DB-persisted — safe across Vercel serverless invocations.
 */
export async function recordApiSuccess(): Promise<void> {
  const current = await readGlobalState();
  const wasBreaker = current.circuitBreakerActive;

  await writeGlobalState({
    apiFailureCount: 0,
    circuitBreakerActive: false,
    circuitBreakerSince: null,
    lastFreshPriceAt: new Date().toISOString(),
  });

  if (wasBreaker) {
    logger.warn({ job: 'kill-switch', reason: 'CIRCUIT_BREAKER cleared — API healthy again' });
  }
}

/**
 * Called by marketData layer on a failed price fetch.
 * Uses atomic SQL increment to avoid read-modify-write race between concurrent invocations.
 * DB-persisted — safe across Vercel serverless invocations.
 */
export async function recordApiFailure(): Promise<void> {
  // Atomic: increment counter + conditionally set circuit_breaker_active in one statement.
  // SQLite serialises writes, so no race between concurrent lambda invocations.
  await run(
    `INSERT INTO kill_switch_state (portfolio_id, api_failure_count, circuit_breaker_active, last_updated)
     VALUES (?, 1, 0, datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       api_failure_count = kill_switch_state.api_failure_count + 1,
       circuit_breaker_active = CASE
         WHEN kill_switch_state.api_failure_count + 1 >= ? THEN 1
         ELSE kill_switch_state.circuit_breaker_active
       END,
       circuit_breaker_since = CASE
         WHEN kill_switch_state.circuit_breaker_active = 0
              AND kill_switch_state.api_failure_count + 1 >= ?
         THEN datetime('now')
         ELSE kill_switch_state.circuit_breaker_since
       END,
       last_updated = datetime('now')`,
    [GLOBAL_ROW_ID, API_FAILURE_THRESHOLD, API_FAILURE_THRESHOLD],
  ).catch(err => {
    logger.warn({ job: 'kill-switch', reason: 'Failed to record API failure', err: String(err) });
  });

  // Check if we just tripped the breaker (for logging only)
  const after = await readGlobalState();
  if (after.circuitBreakerActive && after.apiFailureCount === API_FAILURE_THRESHOLD) {
    logger.warn({ job: 'kill-switch',
      reason: `CIRCUIT_BREAKER tripped after ${after.apiFailureCount} consecutive API failures`,
      since: after.circuitBreakerSince });
  }
}

/**
 * Returns current circuit breaker state from DB.
 * Exposed for callers that need to check without running full evaluation.
 */
export async function getCircuitBreakerState(): Promise<{ active: boolean; since: string | null; failureCount: number }> {
  const g = await readGlobalState();
  return { active: g.circuitBreakerActive, since: g.circuitBreakerSince, failureCount: g.apiFailureCount };
}

// ─── Consecutive-loss tracking ───────────────────────────────────────────────

/**
 * Record a trade outcome for consecutive-loss tracking.
 * Called from marketMonitor after every resolved SELL.
 */
export async function recordTradeOutcome(portfolioId: number, wasLoss: boolean): Promise<void> {
  const current = await queryOne(
    'SELECT consecutive_losses FROM kill_switch_state WHERE portfolio_id=?',
    [portfolioId],
  ).catch(() => null);

  const prevCount = current ? Number(current.consecutive_losses ?? 0) : 0;
  const newCount  = wasLoss ? prevCount + 1 : 0;

  let cooldownUntil: string | null = null;
  let cooldownActive = 0;

  if (newCount >= CONSECUTIVE_LOSS_THRESHOLD) {
    cooldownUntil  = new Date(Date.now() + COOLDOWN_HOURS * 3_600_000).toISOString();
    cooldownActive = 1;
    logger.warn({ job: 'kill-switch', portfolioId, consecutiveLosses: newCount,
      reason: `CONSECUTIVE_LOSS COOLDOWN — new BUYs blocked until ${cooldownUntil}` });
  }

  await run(
    `INSERT INTO kill_switch_state (portfolio_id, consecutive_losses, cooldown_until, cooldown_active, last_updated)
     VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       consecutive_losses=excluded.consecutive_losses,
       cooldown_until=CASE WHEN excluded.cooldown_active=1 THEN excluded.cooldown_until ELSE cooldown_until END,
       cooldown_active=excluded.cooldown_active,
       last_updated=excluded.last_updated`,
    [portfolioId, newCount, cooldownUntil, cooldownActive],
  ).catch(() => null);
}

// ─── Full kill-switch evaluation ──────────────────────────────────────────────

/**
 * Evaluate and persist the full kill-switch state for a portfolio.
 * Called at the start of each market cycle before BUY scanning.
 * Reads global circuit-breaker / freshness state from DB — no module vars.
 */
export async function evaluateKillSwitch(portfolioId: number): Promise<KillSwitchState> {
  // ── Global state (circuit breaker + data freshness) ───────────────────────
  const global = await readGlobalState();

  // ── NAV and drawdown ──────────────────────────────────────────────────────
  const port = await queryOne('SELECT peak_nav FROM portfolios WHERE id=?', [portfolioId]);
  const snapshot = await queryOne(
    `SELECT total_portfolio_value FROM performance_snapshots
     WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 1`,
    [portfolioId],
  ).catch(() => null);

  const currentNav = snapshot ? Number(snapshot.total_portfolio_value) : 0;
  const peakNav    = port?.peak_nav ? Number(port.peak_nav) : currentNav;

  const nullState: KillSwitchState = {
    dailyLossHalted: false, weeklyLossHalted: false,
    drawdownPaused: false, drawdownProtection: false,
    consecutiveLossCooldown: false, consecutiveLosses: 0, cooldownUntil: null,
    dataStaleHalted: false, dataStalenessMinutes: 0,
    circuitBreakerActive: global.circuitBreakerActive,
    circuitBreakerSince: global.circuitBreakerSince,
    apiFailureCount: global.apiFailureCount,
    emergencyLiquidationTriggered: false, lastClearedAt: null,
  };

  if (peakNav <= 0 || currentNav <= 0) return nullState;

  const drawdownPct = ((peakNav - currentNav) / peakNav) * 100;

  // ── Daily P&L ─────────────────────────────────────────────────────────────
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailySnaps = await query(
    `SELECT total_portfolio_value FROM performance_snapshots
     WHERE portfolio_id=? AND created_at >= ? ORDER BY created_at ASC`,
    [portfolioId, todayStart.toISOString()],
  );
  let dailyLossPct = 0;
  if (dailySnaps.length >= 2) {
    const startVal = Number(dailySnaps[0].total_portfolio_value);
    const endVal   = Number(dailySnaps[dailySnaps.length - 1].total_portfolio_value);
    dailyLossPct   = startVal > 0 ? ((startVal - endVal) / startVal) * 100 : 0;
  }

  // ── Weekly P&L ────────────────────────────────────────────────────────────
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekSnaps = await query(
    `SELECT total_portfolio_value FROM performance_snapshots
     WHERE portfolio_id=? AND created_at >= ? ORDER BY created_at ASC`,
    [portfolioId, weekStart.toISOString()],
  );
  let weeklyLossPct = 0;
  if (weekSnaps.length >= 2) {
    const startVal = Number(weekSnaps[0].total_portfolio_value);
    const endVal   = Number(weekSnaps[weekSnaps.length - 1].total_portfolio_value);
    weeklyLossPct  = startVal > 0 ? ((startVal - endVal) / startVal) * 100 : 0;
  }

  // ── Per-portfolio state ────────────────────────────────────────────────────
  const ksRow = await queryOne(
    `SELECT consecutive_losses, cooldown_until, cooldown_active,
            emergency_liquidation_triggered, last_cleared_at
     FROM kill_switch_state WHERE portfolio_id=?`,
    [portfolioId],
  ).catch(() => null);

  const consecutiveLosses = ksRow ? Number(ksRow.consecutive_losses ?? 0) : 0;
  const cooldownUntil     = ksRow?.cooldown_until ? String(ksRow.cooldown_until) : null;
  const cooldownExpired   = cooldownUntil ? new Date() > new Date(cooldownUntil) : true;
  const cooldownActive    = ksRow ? Number(ksRow.cooldown_active ?? 0) === 1 : false;
  const consecutiveLossCooldown = cooldownActive && !cooldownExpired;

  // Auto-clear cooldown if expired
  if (cooldownActive && cooldownExpired) {
    await run(
      `UPDATE kill_switch_state SET cooldown_active=0, last_cleared_at=datetime('now') WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null);
  }

  // ── Data staleness (from global row) ──────────────────────────────────────
  let dataStalenessMinutes = 0;
  let dataStaleHalted      = false;
  if (global.lastFreshPriceAt) {
    const staleMs = Date.now() - new Date(global.lastFreshPriceAt).getTime();
    dataStalenessMinutes = Math.floor(staleMs / 60_000);
    dataStaleHalted      = dataStalenessMinutes >= DATA_STALE_MINUTES;
  }

  if (dataStaleHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, dataStalenessMinutes,
      reason: `DATA_STALE_HALT — prices are ${dataStalenessMinutes}min old, new BUYs blocked` });
  }

  // ── Emergency liquidation flag ─────────────────────────────────────────────
  let emergencyLiquidationTriggered = ksRow ? Number(ksRow.emergency_liquidation_triggered ?? 0) === 1 : false;
  const lastClearedAt = ksRow?.last_cleared_at ? String(ksRow.last_cleared_at) : null;

  // Phase 17 MAJOR fix (Darth Reviewer): reset flag when drawdown recovers below threshold
  const drawdownProtection = drawdownPct > DRAWDOWN_PROTECT_PCT;
  if (!drawdownProtection && emergencyLiquidationTriggered) {
    // Store timestamp of the now-cleared event for audit trail, then reset the flag
    await run(
      `UPDATE kill_switch_state
       SET emergency_liquidation_triggered=0,
           last_emergency_liquidation_at=datetime('now'),
           last_cleared_at=datetime('now'),
           last_updated=datetime('now')
       WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null);
    emergencyLiquidationTriggered = false;
    logger.warn({ job: 'kill-switch', portfolioId,
      reason: 'Emergency liquidation flag cleared — drawdown recovered below 12%' });
  }

  const state: KillSwitchState = {
    dailyLossHalted:   dailyLossPct  > DAILY_LOSS_LIMIT_PCT,
    weeklyLossHalted:  weeklyLossPct > WEEKLY_LOSS_LIMIT_PCT,
    drawdownPaused:    drawdownPct   > DRAWDOWN_PAUSE_PCT,
    drawdownProtection,
    consecutiveLossCooldown,
    consecutiveLosses,
    cooldownUntil,
    dataStaleHalted,
    dataStalenessMinutes,
    circuitBreakerActive: global.circuitBreakerActive,
    circuitBreakerSince:  global.circuitBreakerSince,
    apiFailureCount:      global.apiFailureCount,
    emergencyLiquidationTriggered,
    lastClearedAt,
  };

  // ── Persist per-portfolio state ────────────────────────────────────────────
  await run(
    `INSERT INTO kill_switch_state (
       portfolio_id,
       daily_loss_halted, weekly_loss_halted, drawdown_paused, drawdown_protection,
       data_stale_halted, last_updated
     ) VALUES (?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       daily_loss_halted=excluded.daily_loss_halted,
       weekly_loss_halted=excluded.weekly_loss_halted,
       drawdown_paused=excluded.drawdown_paused,
       drawdown_protection=excluded.drawdown_protection,
       data_stale_halted=excluded.data_stale_halted,
       last_updated=excluded.last_updated`,
    [portfolioId,
     state.dailyLossHalted   ? 1 : 0,
     state.weeklyLossHalted  ? 1 : 0,
     state.drawdownPaused    ? 1 : 0,
     state.drawdownProtection ? 1 : 0,
     state.dataStaleHalted   ? 1 : 0,
    ],
  ).catch(() => null);

  // Logging
  if (state.drawdownProtection) {
    logger.warn({ job: 'kill-switch', portfolioId, drawdownPct: drawdownPct.toFixed(1),
      reason: 'PROTECTION MODE — new entries blocked, emergency liquidation eligible' });
  } else if (state.drawdownPaused) {
    logger.warn({ job: 'kill-switch', portfolioId, drawdownPct: drawdownPct.toFixed(1),
      reason: 'DRAWDOWN PAUSE — new entries blocked' });
  } else if (state.dailyLossHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, dailyLossPct: dailyLossPct.toFixed(1),
      reason: 'DAILY LOSS LIMIT — new BUYs halted for today' });
  } else if (state.weeklyLossHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, weeklyLossPct: weeklyLossPct.toFixed(1),
      reason: 'WEEKLY LOSS LIMIT — position sizes halved' });
  }

  return state;
}

// ─── Position-size multiplier ─────────────────────────────────────────────────

/**
 * Compute position-size multiplier from kill-switch state.
 * Returns 0 if BUYs are blocked, 0.5 if halved, 1.0 if clean.
 */
export function killSwitchSizeMultiplier(state: KillSwitchState): number {
  if (
    state.drawdownProtection   ||
    state.drawdownPaused       ||
    state.dailyLossHalted      ||
    state.consecutiveLossCooldown ||
    state.dataStaleHalted      ||
    state.circuitBreakerActive
  ) return 0;
  if (state.weeklyLossHalted) return 0.5;
  return 1.0;
}

/**
 * Returns true if the circuit breaker blocks automated non-hard-stop SELLs.
 * Only hard stop-losses (STOP_LOSS, TRAILING_STOP exit types) may fire.
 */
export function circuitBreakerBlocksSell(state: KillSwitchState): boolean {
  return state.circuitBreakerActive;
}

// ─── Emergency liquidation ────────────────────────────────────────────────────

/**
 * Close the N weakest positions when drawdown > 12%.
 * N = min(2, ceil(holdings / 2)).
 * The flag is cleared automatically in evaluateKillSwitch when drawdown recovers.
 */
export async function executeEmergencyLiquidation(
  portfolioId: number,
  holdings: Array<{ symbol: string; companyName: string; quantity: number; avgBuyPrice: number; currentPrice: number }>,
  executeTradeFn: (
    portfolioId: number, symbol: string, companyName: string, action: 'SELL',
    quantity: number, price: number, reason: string
  ) => Promise<number | null>,
): Promise<string[]> {
  if (holdings.length === 0) return [];

  const sorted = [...holdings].sort((a, b) => {
    const pnlA = (a.currentPrice - a.avgBuyPrice) / a.avgBuyPrice;
    const pnlB = (b.currentPrice - b.avgBuyPrice) / b.avgBuyPrice;
    return pnlA - pnlB;
  });

  const toClose = Math.min(2, Math.ceil(sorted.length / 2));
  const targets = sorted.slice(0, toClose);
  const closed: string[] = [];

  logger.warn({ job: 'kill-switch', portfolioId,
    reason: `EMERGENCY_LIQUIDATION — closing ${toClose} weakest position(s)`,
    targets: targets.map(t => t.symbol) });

  for (const h of targets) {
    const pnlPct = ((h.currentPrice - h.avgBuyPrice) / h.avgBuyPrice * 100).toFixed(1);
    const reason = `Emergency liquidation: drawdown >12% — closing weakest position (PnL: ${pnlPct}%)`;
    try {
      await executeTradeFn(portfolioId, h.symbol, h.companyName, 'SELL', h.quantity, h.currentPrice, reason);
      closed.push(h.symbol);
      logger.warn({ job: 'kill-switch', portfolioId, symbol: h.symbol, pnlPct, reason: 'EMERGENCY_SELL executed' });
    } catch (err) {
      logger.warn({ job: 'kill-switch', portfolioId, symbol: h.symbol, err: String(err), reason: 'EMERGENCY_SELL failed' });
    }
  }

  if (closed.length > 0) {
    await run(
      `UPDATE kill_switch_state
       SET emergency_liquidation_triggered=1, last_updated=datetime('now')
       WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null);
  }

  return closed;
}

// ─── Portfolio mode derivation ───────────────────────────────────────────────

export type PortfolioMode = 'NORMAL' | 'COLD_START' | 'HALTED' | 'PROTECTION' | 'LIQUIDATION';

export type PortfolioModeResult = {
  mode: PortfolioMode;
  blockedActions: string[];
  allowedActions: string[];
  primaryReasonCode: string;
  activeSince: string | null;
  requiresManualIntervention: boolean;
};

/**
 * Derive a human-readable portfolio operating mode from kill-switch + governance state.
 * Priority order (highest first):
 *   LIQUIDATION > PROTECTION > HALTED > COLD_START > NORMAL
 */
export function derivePortfolioMode(
  ks: KillSwitchState,
  isColdStart: boolean,
): PortfolioModeResult {
  // LIQUIDATION — active emergency or drawdown > 12%
  if (ks.drawdownProtection) {
    return {
      mode: 'LIQUIDATION',
      blockedActions: ['BUY', 'NON_HARD_STOP_SELL'],
      allowedActions: ['HARD_STOP_SELL', 'EMERGENCY_LIQUIDATION_SELL'],
      primaryReasonCode: 'DRAWDOWN_PROTECTION',
      activeSince: ks.lastClearedAt,
      requiresManualIntervention: ks.emergencyLiquidationTriggered,
    };
  }

  // PROTECTION — any halting kill-switch active
  const isHalted =
    ks.drawdownPaused ||
    ks.dailyLossHalted ||
    ks.consecutiveLossCooldown ||
    ks.dataStaleHalted ||
    ks.circuitBreakerActive;

  if (isHalted) {
    let code = 'UNKNOWN';
    let activeSince: string | null = null;
    if (ks.circuitBreakerActive)    { code = 'CIRCUIT_BREAKER'; activeSince = ks.circuitBreakerSince; }
    else if (ks.dataStaleHalted)    { code = 'DATA_STALE'; }
    else if (ks.drawdownPaused)     { code = 'DRAWDOWN_PAUSE'; }
    else if (ks.dailyLossHalted)    { code = 'DAILY_LOSS'; }
    else if (ks.consecutiveLossCooldown) { code = 'CONSECUTIVE_LOSS_COOLDOWN'; activeSince = ks.cooldownUntil; }

    return {
      mode: 'HALTED',
      blockedActions: ks.circuitBreakerActive
        ? ['BUY', 'NON_HARD_STOP_SELL']
        : ['BUY'],
      allowedActions: ks.circuitBreakerActive
        ? ['HARD_STOP_SELL']
        : ['SELL', 'HARD_STOP_SELL'],
      primaryReasonCode: code,
      activeSince,
      requiresManualIntervention: ks.circuitBreakerActive && ks.apiFailureCount >= 10,
    };
  }

  // PROTECTION — weekly loss halved (trading allowed but size reduced)
  if (ks.weeklyLossHalted) {
    return {
      mode: 'PROTECTION',
      blockedActions: [],
      allowedActions: ['BUY_REDUCED_SIZE', 'SELL', 'HARD_STOP_SELL'],
      primaryReasonCode: 'WEEKLY_LOSS',
      activeSince: null,
      requiresManualIntervention: false,
    };
  }

  // COLD_START — model governance restricts sizes but system is operational
  if (isColdStart) {
    return {
      mode: 'COLD_START',
      blockedActions: ['WEAK_SIGNAL_BUY', 'LARGE_POSITION_BUY'],
      allowedActions: ['BUY_SMALL', 'SELL', 'HARD_STOP_SELL'],
      primaryReasonCode: 'INSUFFICIENT_TRAINING_DATA',
      activeSince: null,
      requiresManualIntervention: false,
    };
  }

  return {
    mode: 'NORMAL',
    blockedActions: [],
    allowedActions: ['BUY', 'SELL', 'HARD_STOP_SELL'],
    primaryReasonCode: 'NONE',
    activeSince: null,
    requiresManualIntervention: false,
  };
}

// ─── Kill-switch status API ───────────────────────────────────────────────────

/**
 * Returns the last-persisted kill-switch state for a portfolio.
 * Reads directly from DB — does NOT re-evaluate (evaluateKillSwitch handles that
 * during each cron cycle). Safe to call on every frontend poll.
 */
export async function getKillSwitchStatus(portfolioId: number): Promise<{
  portfolioId: number;
  flags: KillSwitchState;
  anyHalted: boolean;
  reason: string;
  lastUpdated: string | null;
}> {
  const [portRow, global] = await Promise.all([
    queryOne(
      `SELECT daily_loss_halted, weekly_loss_halted, drawdown_paused, drawdown_protection,
              consecutive_losses, cooldown_until, cooldown_active, data_stale_halted,
              emergency_liquidation_triggered, last_cleared_at, last_updated
       FROM kill_switch_state WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null),
    readGlobalState(),
  ]);

  const cooldownUntil  = portRow?.cooldown_until ? String(portRow.cooldown_until) : null;
  const cooldownExpired = cooldownUntil ? new Date() > new Date(cooldownUntil) : true;
  const cooldownActive  = portRow ? Number(portRow.cooldown_active ?? 0) === 1 : false;

  let dataStalenessMinutes = 0;
  if (global.lastFreshPriceAt) {
    const ms = Date.now() - new Date(global.lastFreshPriceAt).getTime();
    dataStalenessMinutes = Math.floor(ms / 60_000);
  }

  const flags: KillSwitchState = {
    dailyLossHalted:            portRow ? Number(portRow.daily_loss_halted  ?? 0) === 1 : false,
    weeklyLossHalted:           portRow ? Number(portRow.weekly_loss_halted ?? 0) === 1 : false,
    drawdownPaused:             portRow ? Number(portRow.drawdown_paused    ?? 0) === 1 : false,
    drawdownProtection:         portRow ? Number(portRow.drawdown_protection ?? 0) === 1 : false,
    consecutiveLossCooldown:    cooldownActive && !cooldownExpired,
    consecutiveLosses:          portRow ? Number(portRow.consecutive_losses ?? 0) : 0,
    cooldownUntil,
    dataStaleHalted:            portRow ? Number(portRow.data_stale_halted  ?? 0) === 1 : false,
    dataStalenessMinutes,
    circuitBreakerActive:       global.circuitBreakerActive,
    circuitBreakerSince:        global.circuitBreakerSince,
    apiFailureCount:            global.apiFailureCount,
    emergencyLiquidationTriggered: portRow ? Number(portRow.emergency_liquidation_triggered ?? 0) === 1 : false,
    lastClearedAt:              portRow?.last_cleared_at ? String(portRow.last_cleared_at) : null,
  };

  const anyHalted = killSwitchSizeMultiplier(flags) === 0;
  const reasons: string[] = [];
  if (flags.dailyLossHalted)         reasons.push('Daily loss >1% NAV');
  if (flags.weeklyLossHalted)        reasons.push('Weekly loss >3% NAV (size halved)');
  if (flags.drawdownPaused)          reasons.push('Drawdown >8% NAV');
  if (flags.drawdownProtection)      reasons.push('Drawdown >12% NAV — protection mode');
  if (flags.consecutiveLossCooldown) reasons.push(`${flags.consecutiveLosses} consecutive losses — cooldown until ${flags.cooldownUntil}`);
  if (flags.dataStaleHalted)         reasons.push(`Data stale ${flags.dataStalenessMinutes}min`);
  if (flags.circuitBreakerActive)    reasons.push(`Circuit breaker: ${flags.apiFailureCount} API failures`);

  return {
    portfolioId,
    flags,
    anyHalted,
    reason: reasons.join('; ') || 'All clear',
    lastUpdated: portRow?.last_updated ? String(portRow.last_updated) : null,
  };
}
