/**
 * QuantumMind Cache Layer — multi-backend with auto-detection
 *
 * Priority:
 *   1. Vercel KV  (KV_REST_API_URL set)  — production on Vercel, shared across all serverless instances
 *   2. Upstash    (UPSTASH_REDIS_REST_URL set) — self-hosted Redis alternative
 *   3. In-memory  (fallback)             — local dev, zero setup
 *
 * Usage: cache.getOrSet(key, fn, ttlSeconds)
 */
import 'dotenv/config';

// ─── TTL constants (seconds) ──────────────────────────────────────────────────
export const TTL = {
  PORTFOLIO_SUMMARY:  30,      // 30s — reduced so live prices appear quickly after cron cycle
  TRADES:             30,      // 30 sec
  PERFORMANCE:       300,      // 5 min  — snapshots are hourly
  SIGNALS:            60,      // 1 min
  NEWS:              300,      // 5 min  — NSE feed updates every few minutes
  MARKET_REGIME:    3600,      // 1 hr   — regime is intra-day stable
  ADAPTIVE_REPORT:   300,      // 5 min
  ML_MOMENTUM:       300,      // 5 min  — 60-day history, stable
  MARKET_QUOTE:       30,      // 30 sec
};

// ─── Backends ─────────────────────────────────────────────────────────────────

// 1. Vercel KV
async function kvGet<T>(key: string): Promise<T | null> {
  const { kv } = await import('@vercel/kv');
  return kv.get<T>(key);
}
async function kvSet<T>(key: string, value: T, ttl: number): Promise<void> {
  const { kv } = await import('@vercel/kv');
  await kv.set(key, value, { ex: ttl });
}
async function kvDel(key: string): Promise<void> {
  const { kv } = await import('@vercel/kv');
  await kv.del(key);
}

// 2. Upstash Redis (HTTP-based, serverless-safe)
async function upstashGet<T>(key: string): Promise<T | null> {
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  return r.get<T>(key);
}
async function upstashSet<T>(key: string, value: T, ttl: number): Promise<void> {
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  await r.set(key, value, { ex: ttl });
}
async function upstashDel(key: string): Promise<void> {
  const { Redis } = await import('@upstash/redis');
  const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  await r.del(key);
}

// 3. In-memory (local dev)
interface MemEntry<T> { value: T; expiresAt: number; }
class MemCache {
  private store = new Map<string, MemEntry<any>>();
  get<T>(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.store.delete(key); return null; }
    return e.value as T;
  }
  set<T>(key: string, value: T, ttlSec: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }
  del(key: string): void { this.store.delete(key); }
  invalidatePattern(pattern: string): void {
    for (const k of this.store.keys()) { if (k.includes(pattern)) this.store.delete(k); }
  }
}

// ─── Mode detection ───────────────────────────────────────────────────────────
type CacheMode = 'vercel-kv' | 'upstash' | 'memory';
const mem = new MemCache();

function getMode(): CacheMode {
  if (process.env.KV_REST_API_URL)         return 'vercel-kv';
  if (process.env.UPSTASH_REDIS_REST_URL)  return 'upstash';
  return 'memory';
}
const MODE = getMode();
console.log(`[Cache] Mode: ${MODE}`);

// ─── Unified cache API ────────────────────────────────────────────────────────
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    if (MODE === 'vercel-kv') return kvGet<T>(key);
    if (MODE === 'upstash')   return upstashGet<T>(key);
    return mem.get<T>(key);
  },

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (MODE === 'vercel-kv') { await kvSet(key, value, ttlSec); return; }
    if (MODE === 'upstash')   { await upstashSet(key, value, ttlSec); return; }
    mem.set(key, value, ttlSec);
  },

  async del(key: string): Promise<void> {
    if (MODE === 'vercel-kv') { await kvDel(key); return; }
    if (MODE === 'upstash')   { await upstashDel(key); return; }
    mem.del(key);
  },

  /** Invalidate by key prefix — pattern match in memory; exact key in Redis (add specific del calls for Redis) */
  async invalidate(pattern: string): Promise<void> {
    if (MODE === 'memory') { mem.invalidatePattern(pattern); return; }
    // For Redis: caller must pass the exact key via del()
    // Pattern-based SCAN not used here (overkill for this scale)
  },

  async getOrSet<T>(key: string, fn: () => Promise<T>, ttlSec: number): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const fresh = await fn();
    await this.set(key, fresh, ttlSec);
    return fresh;
  },
};
