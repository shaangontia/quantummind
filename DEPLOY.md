# QuantumMind — Vercel Deployment Guide

## Pre-requisites (already done)
- [x] `vercel login` — authenticated as shaangontia
- [x] `vercel link` — linked to `shaangontias-projects/quantummind`
- [x] Env vars set: `groq_key`, `turso_region`, `turso_sb_key`

## Step 1 — Deploy to Vercel

```bash
cd ~/battlefield/QuantumMind
npm run build          # compile backend + frontend
vercel --prod --yes    # deploy to production
```

## Step 2 — Vercel KV (distributed cache)

1. Go to [vercel.com/dashboard](https://vercel.com/dashboard) → **Storage** → **Create Database** → **KV**
2. Name it `quantummind-kv` → Create
3. Connect to project `quantummind` → this auto-injects:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
4. Redeploy: `vercel --prod --yes`

The cache layer auto-detects these env vars — no code change needed.

## Step 3 — Market Cycle Cron (free plan workaround)

Vercel free plan = max 1 cron/day. Use **cron-job.org** (free) for 5-min cycles:

1. Sign up at [cron-job.org](https://cron-job.org)
2. Create job:
   - **URL**: `https://<your-vercel-url>/api/cron/market-cycle`
   - **Method**: POST
   - **Schedule**: Every 5 minutes
   - **Execution days**: Mon–Fri only
   - **Execution times**: 09:15–15:45 IST (03:45–10:15 UTC)

## Cache hierarchy (auto-detected, no config needed)
```
KV_REST_API_URL set     → Vercel KV  (production, recommended)
UPSTASH_REDIS_REST_URL  → Upstash    (alternative)
Neither set             → In-memory  (local dev)
```
