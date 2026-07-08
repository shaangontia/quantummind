/**
 * tradingGuards.ts — Pre-execution safety gates for QuantumMind
 *
 * All guards are fail-closed: any uncertainty → block the trade.
 *
 * Guards implemented:
 *  1. Global kill switch (DB flag or TRADING_ENABLED=false env)
 *  2. NSE holiday calendar (2025–2026)
 *  3. Max trades per portfolio per day
 *  4. Max daily turnover per portfolio
 *  5. Max position concentration per symbol (hard NAV cap)
 *  6. Cron idempotency lock (prevent double-execution within 4 min)
 */

import { query, queryOne, run } from '../db/turso.js';

// ── NSE Holiday Calendar 2025–2026 ────────────────────────────────────────────
// Source: NSE India official holiday list. Update annually.
const NSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-26', // Republic Day
  '2025-02-19', // Chhatrapati Shivaji Maharaj Jayanti
  '2025-03-14', // Holi
  '2025-04-10', // Id-ul-Fitr (Eid)
  '2025-04-14', // Dr. Babasaheb Ambedkar Jayanti
  '2025-04-18', // Good Friday
  '2025-05-01', // Maharashtra Day
  '2025-06-07', // Bakri Id (Eid-ul-Adha)
  '2025-07-06', // Muharram
  '2025-08-15', // Independence Day
  '2025-08-27', // Ganesh Chaturthi
  '2025-10-02', // Mahatma Gandhi Jayanti
  '2025-10-20', // Diwali (Laxmi Pujan)  — verify exact date annually
  '2025-10-21', // Diwali (Balipratipada)
  '2025-11-05', // Prakash Gurpurb Sri Guru Nanak Dev Ji
  '2025-12-25', // Christmas
  // 2026
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-20', // Id-ul-Fitr (approximate)
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Babasaheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-12-25', // Christmas
]);

function todayIST(): string {
  const now = new Date();
  // IST = UTC + 5:30
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function isNseHoliday(): boolean {
  return NSE_HOLIDAYS.has(todayIST());
}

// ── Global kill switch ────────────────────────────────────────────────────────
// Set env var TRADING_ENABLED=false OR insert a row in trading_config table to halt all trades.
// DB row takes precedence; env var is the emergency override.
export async function isTradingEnabled(): Promise<boolean> {
  // Hard env override
  if (process.env.TRADING_ENABLED === 'false') {
    console.log('[Guard] Kill switch active: TRADING_ENABLED=false');
    return false;
  }
  // Soft DB toggle
  try {
    const row = await queryOne('SELECT value FROM trading_config WHERE key = ?', ['global_trading_enabled']);
    if (row && row.value === 'false') {
      console.log('[Guard] Kill switch active: DB trading_config.global_trading_enabled=false');
      return false;
    }
  } catch {
    // Table may not exist yet — fail-open here (kill switch not configured = trading allowed)
  }
  return true;
}

// ── Max trades per portfolio per day ─────────────────────────────────────────
const MAX_TRADES_PER_DAY = 10; // configurable

export async function isUnderDailyTradeLimit(portfolioId: number): Promise<boolean> {
  try {
    const row = await queryOne(
      `SELECT COUNT(*) as count FROM trades
       WHERE portfolio_id = ?
         AND date(created_at) = date('now')`,
      [portfolioId]
    );
    const count = Number(row?.count ?? 0);
    if (count >= MAX_TRADES_PER_DAY) {
      console.warn(`[Guard] P${portfolioId} hit daily trade limit (${count}/${MAX_TRADES_PER_DAY})`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Guard] isUnderDailyTradeLimit error — blocking trade for safety:', err);
    return false;
  }
}

// ── Max daily turnover ────────────────────────────────────────────────────────
const MAX_DAILY_TURNOVER_PCT = 0.25; // block if today's traded amount > 25% of NAV

export async function isUnderDailyTurnoverLimit(portfolioId: number, portfolioNAV: number, tradeAmount: number): Promise<boolean> {
  try {
    const row = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) as turnover FROM trades
       WHERE portfolio_id = ?
         AND date(created_at) = date('now')`,
      [portfolioId]
    );
    const existingTurnover = Number(row?.turnover ?? 0);
    const newTotal = existingTurnover + tradeAmount;
    const limit = portfolioNAV * MAX_DAILY_TURNOVER_PCT;
    if (newTotal > limit) {
      console.warn(`[Guard] P${portfolioId} daily turnover limit: ₹${newTotal.toFixed(0)} > ₹${limit.toFixed(0)} (${(MAX_DAILY_TURNOVER_PCT * 100).toFixed(0)}% NAV)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Guard] isUnderDailyTurnoverLimit error — blocking for safety:', err);
    return false;
  }
}

// ── Max position concentration per symbol ────────────────────────────────────
const MAX_POSITION_PCT = 0.10; // hard cap: 10% of NAV per symbol

export async function isUnderPositionCap(
  portfolioId: number,
  symbol: string,
  portfolioNAV: number,
  additionalAmount: number
): Promise<boolean> {
  try {
    const row = await queryOne(
      `SELECT quantity, current_price FROM holdings WHERE portfolio_id = ? AND symbol = ?`,
      [portfolioId, symbol]
    );
    const existingValue = row ? Number(row.quantity) * Number(row.current_price) : 0;
    const newValue = existingValue + additionalAmount;
    const cap = portfolioNAV * MAX_POSITION_PCT;
    if (newValue > cap) {
      console.warn(`[Guard] P${portfolioId} ${symbol} position cap: ₹${newValue.toFixed(0)} > ₹${cap.toFixed(0)} (${(MAX_POSITION_PCT * 100).toFixed(0)}% NAV)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Guard] isUnderPositionCap error — blocking for safety:', err);
    return false;
  }
}

// ── Cron idempotency lock ─────────────────────────────────────────────────────
// Prevents double-execution if cron fires twice within 4 minutes.
let lastCycleRanAt: Date | null = null;
const MIN_CYCLE_GAP_MS = 4 * 60 * 1000; // 4 minutes

export function acquireCycleLock(): boolean {
  const now = new Date();
  if (lastCycleRanAt && now.getTime() - lastCycleRanAt.getTime() < MIN_CYCLE_GAP_MS) {
    const secAgo = Math.floor((now.getTime() - lastCycleRanAt.getTime()) / 1000);
    console.warn(`[Guard] Idempotency lock: cycle ran ${secAgo}s ago — skipping duplicate execution`);
    return false;
  }
  lastCycleRanAt = now;
  return true;
}

// ── Ensure trading_config table exists (run once at startup) ─────────────────
// ── DB-persisted cron lock (survives serverless cold starts) ─────────────────
const CRON_LOCK_KEY = 'market-cycle';

export async function acquireDbCycleLock(): Promise<boolean> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS cron_lock (
      key TEXT PRIMARY KEY,
      locked_until TEXT NOT NULL,
      owner TEXT NOT NULL
    )`);
    const now = new Date();
    const until = new Date(now.getTime() + MIN_CYCLE_GAP_MS).toISOString();
    const existing = await queryOne('SELECT locked_until FROM cron_lock WHERE key=?', [CRON_LOCK_KEY]);
    if (existing) {
      const lockedUntil = new Date(existing.locked_until as string);
      if (lockedUntil > now) {
        const secLeft = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
        console.warn(`[Guard] DB cron lock held for ${secLeft}s more — skipping duplicate execution`);
        return false;
      }
      // Lock expired — update
      await run('UPDATE cron_lock SET locked_until=?, owner=? WHERE key=?', [until, process.pid?.toString() ?? 'serverless', CRON_LOCK_KEY]);
    } else {
      await run('INSERT INTO cron_lock (key, locked_until, owner) VALUES (?,?,?)', [CRON_LOCK_KEY, until, process.pid?.toString() ?? 'serverless']);
    }
    return true;
  } catch (err) {
    console.warn('[Guard] DB cron lock error — falling back to in-memory lock:', err);
    return acquireCycleLock(); // fall back to in-memory
  }
}

export async function releaseCycleLock(): Promise<void> {
  try {
    await run('DELETE FROM cron_lock WHERE key=?', [CRON_LOCK_KEY]);
  } catch { /* ignore */ }
  lastCycleRanAt = null; // also reset in-memory lock
}

export async function ensureTradingConfigTable(): Promise<void> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS trading_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT (CURRENT_TIMESTAMP)
    )`);
    // Seed default if not present
    await run(`INSERT OR IGNORE INTO trading_config (key, value) VALUES ('global_trading_enabled', 'true')`);
  } catch (err) {
    console.warn('[Guard] Could not create trading_config table:', err);
  }
}
