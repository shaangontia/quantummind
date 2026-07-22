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
   - **Authentication**: add header `Authorization: Bearer <CRON_SECRET>` (same value as the `CRON_SECRET` env var set in Vercel) — the route rejects requests without it.

## Step 4 — Nightly Learning Job Cron (added 2026-07-22)

The nightly pipeline (label generation → model-governance promotion →
ML retrain → walk-forward validation) is registered via in-process
`node-cron` too, but that never fires on Vercel's serverless deployment —
there's no persistent process for the timer, and the one Vercel Hobby cron
slot is already spent on Step 3. Without a second, externally-triggered job
hitting this route, the model never generates labels, never promotes past
CANDIDATE/SHADOW, and never retrains — independent of trade volume.

Add a **second** cron-job.org job pointed at the new endpoint:

1. In the same cron-job.org account used for Step 3, create another job:
   - **URL**: `https://<your-vercel-url>/api/cron/nightly-training`
   - **Method**: POST
   - **Schedule**: Once daily
   - **Execution days**: Mon–Fri only
   - **Execution time**: 20:00 IST (14:30 UTC) — well after market close so exit prices have settled
   - **Authentication**: same header as Step 3 — `Authorization: Bearer <CRON_SECRET>`
2. The route responds immediately (fire-and-forget) and runs the full pipeline in the background; check Vercel function logs for `[Admin] Nightly training job complete` to confirm it finished, or `FAILED` with the error if not.

## Cache hierarchy (auto-detected, no config needed)
```
KV_REST_API_URL set     → Vercel KV  (production, recommended)
UPSTASH_REDIS_REST_URL  → Upstash    (alternative)
Neither set             → In-memory  (local dev)
```
