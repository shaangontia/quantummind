"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cache = exports.TTL = void 0;
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
require("dotenv/config");
// ─── TTL constants (seconds) ──────────────────────────────────────────────────
exports.TTL = {
    PORTFOLIO_SUMMARY: 60, // 1 min  — prices don't tick every second
    TRADES: 30, // 30 sec
    PERFORMANCE: 300, // 5 min  — snapshots are hourly
    SIGNALS: 60, // 1 min
    NEWS: 300, // 5 min  — NSE feed updates every few minutes
    MARKET_REGIME: 3600, // 1 hr   — regime is intra-day stable
    ADAPTIVE_REPORT: 300, // 5 min
    ML_MOMENTUM: 300, // 5 min  — 60-day history, stable
    MARKET_QUOTE: 30, // 30 sec
};
// ─── Backends ─────────────────────────────────────────────────────────────────
// 1. Vercel KV
async function kvGet(key) {
    const { kv } = await Promise.resolve().then(() => __importStar(require('@vercel/kv')));
    return kv.get(key);
}
async function kvSet(key, value, ttl) {
    const { kv } = await Promise.resolve().then(() => __importStar(require('@vercel/kv')));
    await kv.set(key, value, { ex: ttl });
}
async function kvDel(key) {
    const { kv } = await Promise.resolve().then(() => __importStar(require('@vercel/kv')));
    await kv.del(key);
}
// 2. Upstash Redis (HTTP-based, serverless-safe)
async function upstashGet(key) {
    const { Redis } = await Promise.resolve().then(() => __importStar(require('@upstash/redis')));
    const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    return r.get(key);
}
async function upstashSet(key, value, ttl) {
    const { Redis } = await Promise.resolve().then(() => __importStar(require('@upstash/redis')));
    const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await r.set(key, value, { ex: ttl });
}
async function upstashDel(key) {
    const { Redis } = await Promise.resolve().then(() => __importStar(require('@upstash/redis')));
    const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await r.del(key);
}
class MemCache {
    constructor() {
        this.store = new Map();
    }
    get(key) {
        const e = this.store.get(key);
        if (!e)
            return null;
        if (Date.now() > e.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return e.value;
    }
    set(key, value, ttlSec) {
        this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    }
    del(key) { this.store.delete(key); }
    invalidatePattern(pattern) {
        for (const k of this.store.keys()) {
            if (k.includes(pattern))
                this.store.delete(k);
        }
    }
}
const mem = new MemCache();
function getMode() {
    if (process.env.KV_REST_API_URL)
        return 'vercel-kv';
    if (process.env.UPSTASH_REDIS_REST_URL)
        return 'upstash';
    return 'memory';
}
const MODE = getMode();
console.log(`[Cache] Mode: ${MODE}`);
// ─── Unified cache API ────────────────────────────────────────────────────────
exports.cache = {
    async get(key) {
        if (MODE === 'vercel-kv')
            return kvGet(key);
        if (MODE === 'upstash')
            return upstashGet(key);
        return mem.get(key);
    },
    async set(key, value, ttlSec) {
        if (MODE === 'vercel-kv') {
            await kvSet(key, value, ttlSec);
            return;
        }
        if (MODE === 'upstash') {
            await upstashSet(key, value, ttlSec);
            return;
        }
        mem.set(key, value, ttlSec);
    },
    async del(key) {
        if (MODE === 'vercel-kv') {
            await kvDel(key);
            return;
        }
        if (MODE === 'upstash') {
            await upstashDel(key);
            return;
        }
        mem.del(key);
    },
    /** Invalidate by key prefix — pattern match in memory; exact key in Redis (add specific del calls for Redis) */
    async invalidate(pattern) {
        if (MODE === 'memory') {
            mem.invalidatePattern(pattern);
            return;
        }
        // For Redis: caller must pass the exact key via del()
        // Pattern-based SCAN not used here (overkill for this scale)
    },
    async getOrSet(key, fn, ttlSec) {
        const hit = await this.get(key);
        if (hit !== null)
            return hit;
        const fresh = await fn();
        await this.set(key, fresh, ttlSec);
        return fresh;
    },
};
