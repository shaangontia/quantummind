/**
 * killSwitch.ts — Phase 13 + Phase 17: Automated trading halt engine
 *
 * Kill-switch conditions (all persisted per-portfolio in kill_switch_state):
 *
 * Phase 13:
 *   Daily loss   > 1% NAV  → halt all new BUYs for the day
 *   Weekly loss  > 3% NAV  → halve new position sizes
 *   Drawdown     > 8% NAV  → pause all new entries
 *   Drawdown     > 12% NAV → protection mode + emergency liquidation
 *
 * Phase 17:
 *   Consecutive losses >= 3 → 24-hour BUY cooldown
 *   Data staleness > 2 cycles (10 min) → halt new BUYs, no auto-SELLs
 *   API failures   >= 3 consecutive → CIRCUIT_BREAKER: halt BUYs + non-hard-stop SELLs
 *   Drawdown       > 12% → emergency liquidation (close weakest N positions)
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
const DAILY_LOSS_LIMIT_PCT      = 1.0;   // % of NAV
const WEEKLY_LOSS_LIMIT_PCT     = 3.0;
const DRAWDOWN_PAUSE_PCT        = 8.0;
const DRAWDOWN_PROTECT_PCT      = 12.0;

// Phase 17
const CONSECUTIVE_LOSS_THRESHOLD = 3;    // losses in a row before cooldown
const COOLDOWN_HOURS             = 24;   // hours to block new BUYs after threshold
const DATA_STALE_CYCLES          = 2;    // missing cycles before stale halt (5 min each)
const DATA_STALE_MINUTES         = DATA_STALE_CYCLES * 5;
const API_FAILURE_THRESHOLD      = 3;    // consecutive failures before circuit breaker

// ─── In-memory API failure counter (per-process, global across portfolios) ────
let _apiFailureCount = 0;
let _circuitBreakerActive = false;
let _circuitBreakerSince: string | null = null;
let _lastFreshPriceAt: string | null = null;

/**
 * Called by marketData layer on successful price fetch.
 * Clears the circuit breaker and resets staleness timer.
 */
export function recordApiSuccess(): void {
  const wasBreaker = _circuitBreakerActive;
  _apiFailureCount = 0;
  _circuitBreakerActive = false;
  _lastFreshPriceAt = new Date().toISOString();
  if (wasBreaker) {
    logger.warn({ job: 'kill-switch', reason: 'CIRCUIT_BREAKER cleared — API healthy again' });
  }
}

/**
 * Called by marketData layer on API error.
 * Increments failure counter; trips circuit breaker at threshold.
 */
export function recordApiFailure(): void {
  _apiFailureCount++;
  if (_apiFailureCount >= API_FAILURE_THRESHOLD && !_circuitBreakerActive) {
    _circuitBreakerActive = true;
    _circuitBreakerSince = new Date().toISOString();
    logger.warn({ job: 'kill-switch', reason: `CIRCUIT_BREAKER tripped after ${_apiFailureCount} consecutive API failures`, since: _circuitBreakerSince });
  }
}

/** Expose circuit breaker state for external callers */
export function getCircuitBreakerState(): { active: boolean; since: string | null; failureCount: number } {
  return { active: _circuitBreakerActive, since: _circuitBreakerSince, failureCount: _apiFailureCount };
}

/**
 * Record a trade outcome for consecutive-loss tracking.
 * Called from marketMonitor after every SELL trade resolves.
 * @param portfolioId
 * @param wasLoss - true if net PnL of the closed trade is negative
 */
export async function recordTradeOutcome(portfolioId: number, wasLoss: boolean): Promise<void> {
  const current = await queryOne(
    'SELECT consecutive_losses FROM kill_switch_state WHERE portfolio_id=?',
    [portfolioId],
  );

  const prevCount = current ? Number(current.consecutive_losses ?? 0) : 0;
  const newCount  = wasLoss ? prevCount + 1 : 0;  // reset on any win

  let cooldownUntil: string | null = null;
  let cooldownActive = 0;

  if (newCount >= CONSECUTIVE_LOSS_THRESHOLD) {
    const until = new Date(Date.now() + COOLDOWN_HOURS * 3_600_000);
    cooldownUntil  = until.toISOString();
    cooldownActive = 1;
    logger.warn({ job: 'kill-switch', portfolioId, consecutiveLosses: newCount,
      reason: `CONSECUTIVE_LOSS COOLDOWN — new BUYs blocked until ${cooldownUntil}` });
  }

  await run(
    `INSERT INTO kill_switch_state
       (portfolio_id, consecutive_losses, cooldown_until, cooldown_active, last_updated)
     VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       consecutive_losses=excluded.consecutive_losses,
       cooldown_until=CASE WHEN excluded.cooldown_active=1 THEN excluded.cooldown_until ELSE cooldown_until END,
       cooldown_active=excluded.cooldown_active,
       last_updated=excluded.last_updated`,
    [portfolioId, newCount, cooldownUntil, cooldownActive],
  ).catch(() => null);
}

/**
 * Evaluate and persist the full kill-switch state for a portfolio.
 * Called at the start of each market cycle before BUY scanning.
 */
export async function evaluateKillSwitch(portfolioId: number): Promise<KillSwitchState> {
  // ── NAV and drawdown ───────────────────────────────────────────────────────
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
    circuitBreakerActive: _circuitBreakerActive, circuitBreakerSince: _circuitBreakerSince,
    apiFailureCount: _apiFailureCount,
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

  // ── Phase 17: Consecutive-loss cooldown ───────────────────────────────────
  const ksRow = await queryOne(
    `SELECT consecutive_losses, cooldown_until, cooldown_active, last_fresh_price_at,
            emergency_liquidation_triggered, last_cleared_at
     FROM kill_switch_state WHERE portfolio_id=?`,
    [portfolioId],
  );

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

  // ── Phase 17: Data staleness check ────────────────────────────────────────
  let dataStalenessMinutes = 0;
  let dataStaleHalted      = false;
  const lastFreshAt = _lastFreshPriceAt ?? (ksRow?.last_fresh_price_at ? String(ksRow.last_fresh_price_at) : null);
  if (lastFreshAt) {
    const staleMs = Date.now() - new Date(lastFreshAt).getTime();
    dataStalenessMinutes = Math.floor(staleMs / 60_000);
    dataStaleHalted      = dataStalenessMinutes >= DATA_STALE_MINUTES;
  }

  if (dataStaleHalted) {
    logger.warn({ job: 'kill-switch', portfolioId, dataStalenessMinutes,
      reason: `DATA_STALE_HALT — prices are ${dataStalenessMinutes}min old, new BUYs blocked` });
  }

  // ── Phase 17: Emergency liquidation tracking ───────────────────────────────
  const emergencyLiquidationTriggered = ksRow ? Number(ksRow.emergency_liquidation_triggered ?? 0) === 1 : false;
  const lastClearedAt = ksRow?.last_cleared_at ? String(ksRow.last_cleared_at) : null;

  const state: KillSwitchState = {
    dailyLossHalted:   dailyLossPct  > DAILY_LOSS_LIMIT_PCT,
    weeklyLossHalted:  weeklyLossPct > WEEKLY_LOSS_LIMIT_PCT,
    drawdownPaused:    drawdownPct   > DRAWDOWN_PAUSE_PCT,
    drawdownProtection: drawdownPct  > DRAWDOWN_PROTECT_PCT,
    consecutiveLossCooldown,
    consecutiveLosses,
    cooldownUntil,
    dataStaleHalted,
    dataStalenessMinutes,
    circuitBreakerActive: _circuitBreakerActive,
    circuitBreakerSince: _circuitBreakerSince,
    apiFailureCount: _apiFailureCount,
    emergencyLiquidationTriggered,
    lastClearedAt,
  };

  // ── Persist full state ─────────────────────────────────────────────────────
  await run(
    `INSERT INTO kill_switch_state (
       portfolio_id,
       daily_loss_halted, weekly_loss_halted, drawdown_paused, drawdown_protection,
       data_stale_halted, api_failure_count, circuit_breaker_active, circuit_breaker_since,
       last_fresh_price_at, last_updated
     ) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(portfolio_id) DO UPDATE SET
       daily_loss_halted=excluded.daily_loss_halted,
       weekly_loss_halted=excluded.weekly_loss_halted,
       drawdown_paused=excluded.drawdown_paused,
       drawdown_protection=excluded.drawdown_protection,
       data_stale_halted=excluded.data_stale_halted,
       api_failure_count=excluded.api_failure_count,
       circuit_breaker_active=excluded.circuit_breaker_active,
       circuit_breaker_since=COALESCE(excluded.circuit_breaker_since, circuit_breaker_since),
       last_fresh_price_at=COALESCE(excluded.last_fresh_price_at, last_fresh_price_at),
       last_updated=excluded.last_updated`,
    [portfolioId,
     state.dailyLossHalted   ? 1 : 0,
     state.weeklyLossHalted  ? 1 : 0,
     state.drawdownPaused    ? 1 : 0,
     state.drawdownProtection ? 1 : 0,
     state.dataStaleHalted   ? 1 : 0,
     _apiFailureCount,
     _circuitBreakerActive   ? 1 : 0,
     _circuitBreakerSince,
     _lastFreshPriceAt,
    ],
  ).catch(() => null);

  // Log active kill-switches
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
 * Returns true if the circuit breaker blocks automated SELLs
 * (only hard stop-losses may fire when circuit breaker is active).
 */
export function circuitBreakerBlocksSell(state: KillSwitchState): boolean {
  return state.circuitBreakerActive;
}

/**
 * Emergency liquidation: close the N weakest positions when drawdown > 12%.
 * N = min(2, half of open positions rounded up).
 * Returns symbols closed.
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

  // Sort by PnL% ascending (worst first)
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
      `UPDATE kill_switch_state SET emergency_liquidation_triggered=1, last_updated=datetime('now')
       WHERE portfolio_id=?`,
      [portfolioId],
    ).catch(() => null);
  }

  return closed;
}

/**
 * Full kill-switch status for API response.
 */
export async function getKillSwitchStatus(portfolioId: number): Promise<{
  portfolioId: number;
  flags: KillSwitchState;
  anyHalted: boolean;
  reason: string;
  lastUpdated: string | null;
}> {
  const state = await evaluateKillSwitch(portfolioId);
  const anyHalted = killSwitchSizeMultiplier(state) === 0;

  const reasons: string[] = [];
  if (state.dailyLossHalted)         reasons.push('Daily loss >1% NAV');
  if (state.weeklyLossHalted)        reasons.push('Weekly loss >3% NAV (size halved)');
  if (state.drawdownPaused)          reasons.push('Drawdown >8% NAV');
  if (state.drawdownProtection)      reasons.push('Drawdown >12% NAV — protection mode');
  if (state.consecutiveLossCooldown) reasons.push(`${state.consecutiveLosses} consecutive losses — cooldown until ${state.cooldownUntil}`);
  if (state.dataStaleHalted)         reasons.push(`Data stale ${state.dataStalenessMinutes}min — prices frozen`);
  if (state.circuitBreakerActive)    reasons.push(`Circuit breaker: ${state.apiFailureCount} API failures`);

  const row = await queryOne('SELECT last_updated FROM kill_switch_state WHERE portfolio_id=?', [portfolioId]);

  return {
    portfolioId,
    flags: state,
    anyHalted,
    reason: reasons.join('; ') || 'All clear',
    lastUpdated: row?.last_updated ? String(row.last_updated) : null,
  };
}
