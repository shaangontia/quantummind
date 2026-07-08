# QuantumMind 🤖📈

> AI-driven autonomous virtual Indian stock trading portal with self-improving adaptive ML engine.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed-Vercel-black)](https://quantummind-shaangontia.vercel.app)

---

## Overview

QuantumMind manages virtual equity portfolios on NSE-listed Indian stocks. An autonomous agent runs every 5 minutes during market hours, generates buy/sell signals using a multi-source ML engine, applies a risk-gated execution pipeline, and adapts its signal weights based on historical outcomes.

**Key characteristics:**
- 100% virtual / paper trading — no real money, no broker API
- NSE-only (Yahoo Finance `.NS` symbols)
- Deterministic, auditable, fail-closed execution
- Self-improving signal weights via confidence-dampened adaptive engine

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  cron-job.org  →  POST /api/cron/market-cycle  (every 5 min, IST)  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
              ┌────────────────────▼────────────────────┐
              │         Market Monitor (scheduler)       │
              │   NSE holiday check · DB cron lock       │
              └────────────────────┬────────────────────┘
                                   │
         ┌─────────────────────────▼─────────────────────────┐
         │              Signal Engine (mlEngine.ts)           │
         │  Technical Analysis · News Sentiment (Groq LLM)   │
         │  ML Pattern Recognition · Adaptive Weight Engine   │
         └─────────────────────────┬─────────────────────────┘
                                   │
         ┌─────────────────────────▼─────────────────────────┐
         │              Risk Engine (riskEngine.ts)           │
         │  8-gate check: kill switch · market hours ·        │
         │  price freshness · provider confidence ·           │
         │  daily limits · position cap · drawdown halt        │
         └─────────────────────────┬─────────────────────────┘
                                   │
         ┌─────────────────────────▼─────────────────────────┐
         │           Execution Simulator (tradingEngine.ts)   │
         │      Atomic LibSQL batch · batchWithResults()      │
         └────────────────────────────────────────────────────┘
```

---

## External Services

| Service | Role | Tier |
|---------|------|------|
| **[Turso](https://turso.tech)** | Primary database (LibSQL/SQLite, Mumbai region) | Free |
| **[Groq](https://console.groq.com)** | LLM inference for news sentiment analysis (`llama-3.1-8b-instant`) | Free |
| **[Yahoo Finance](https://finance.yahoo.com)** | Primary market data source (`query2` → `query1` fallback) | Public API |
| **[Groww](https://groww.in)** ⚠️ | Unofficial fallback for NSE price data — **no SLA, web endpoint, schema may change** | Unofficial |
| **[Vercel](https://vercel.com)** | Hosting, serverless functions, CI/CD from GitHub | Free Hobby |
| **[cron-job.org](https://cron-job.org)** | External cron scheduler — triggers market cycle every 5 min on market days | Free |
| **[GitHub](https://github.com/shaangontia/quantummind)** | Source control, triggers Vercel auto-deploys on push | Free |

> ⚠️ The Groww endpoint is an unofficial web scraping fallback. It has no published API, no SLA, and its schema may change without notice. It is used as a last resort when both Yahoo Finance CDNs fail. Large BUY orders (>₹1L) are blocked when Groww is the sole price source.

---

## Market Data Flow

```
getExecutableQuote() [trade execution — always fresh]
  → Yahoo Finance query2 (primary CDN)
  → Yahoo Finance query1 (secondary CDN, parallel)
  → Cross-validate: if price diff > 2% → THROW (no trade)
  → Groww fallback if both Yahoo CDNs fail

getDisplayQuote() [UI only — may use cache]
  → Same fallback chain, allows 30-min stale cache
```

---

## Tech Stack

### Backend
- **Runtime**: Node.js 18 + TypeScript
- **Framework**: Express.js
- **Database**: Turso (LibSQL) via `@libsql/client`
- **LLM**: Groq SDK (`groq-sdk`)
- **Deployment**: Vercel Serverless Functions (`api/index.ts`)

### Frontend
- **Framework**: Next.js 14 (App Router)
- **UI**: Tailwind CSS
- **Charts**: Recharts

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `turso_region` | Turso database URL (`libsql://...`) |
| `turso_sb_key` | Turso auth token (JWT) |
| `groq_key` | Groq API key |
| `CRON_SECRET` | Bearer token for cron endpoint auth |
| `TRADING_ENABLED` | Optional kill switch (`false` disables all trades) |

---

## API Endpoints

### Health
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service liveness |
| `GET` | `/api/health/db` | Database connectivity |
| `GET` | `/api/health/market-data` | Yahoo Finance reachability + price freshness |
| `GET` | `/api/health/cron` | Last cron cycle timestamp |

### Portfolios
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/portfolios` | List all portfolios with live NAV + return |
| `POST` | `/api/portfolios` | Create portfolio |
| `GET` | `/api/portfolios/:id/summary` | Holdings, cash, live prices, PnL |
| `GET` | `/api/portfolios/:id/trades` | Trade history |
| `GET` | `/api/portfolios/:id/performance` | Performance snapshots |
| `GET` | `/api/portfolios/:id/signals` | Signal history |

### Cron (requires `Authorization: Bearer <CRON_SECRET>`)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cron/market-cycle` | Full AI trading cycle (signals + risk + execution) |
| `POST` | `/api/cron/price-update` | Lightweight price-only refresh (no signal generation) |

### Admin (requires auth)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/trading-enabled` | Toggle kill switch `{"enabled": true/false}` |

---

## Database Schema

```
portfolios          — portfolio config, cash balance
holdings            — current positions (qty, avg_buy_price, current_price)
trades              — immutable trade ledger
market_signals      — generated signals with source weights
signal_outcomes     — resolved win/loss for adaptive learning
signal_weights      — per-signal-type weight (auto-adjusted)
market_regime       — detected market regime (bull/bear/sideways)
performance_snapshots — daily NAV snapshots
trading_config      — kill switch persistent override
cron_lock           — idempotency lock (survives cold starts)
```

---

## Safety & Risk Controls

1. **Kill switch** — env var `TRADING_ENABLED=false` OR DB row in `trading_config`
2. **NSE holiday calendar** — 2025–2026 holidays hardcoded; no trades on holidays
3. **Market hours gate** — trades only 9:15–15:30 IST, Mon–Fri
4. **Price freshness** — `getExecutableQuote()` always fetches fresh; rejects if >30 min stale
5. **Provider cross-validation** — two Yahoo CDNs queried in parallel; >2% diff = abort
6. **Daily trade limit** — max 10 trades per portfolio per day
7. **Daily turnover limit** — max 25% NAV per day
8. **Position cap** — max 10% NAV per symbol
9. **Portfolio drawdown halt** — trading suspended if portfolio drops >20% from peak
10. **Atomic execution** — all-or-nothing LibSQL batch; `CURRENT_TIMESTAMP` (not `datetime("now")`)

---

## Cron Setup (cron-job.org)

| Job | URL | Method | Schedule |
|-----|-----|--------|----------|
| Market cycle | `https://quantummind-shaangontia.vercel.app/api/cron/market-cycle` | POST | `*/5 3-10 * * 1-5` UTC |
| Price refresh | `https://quantummind-shaangontia.vercel.app/api/cron/price-update` | POST | `*/5 3-10 * * 1-5` UTC |

Header for both: `Authorization: Bearer <CRON_SECRET>`

---

## Development

```bash
# Install dependencies
cd backend && npm install

# Build
npm run build

# Run locally
npm run dev   # starts Express on :3001

# Frontend
cd .. && npm install && npm run dev  # Next.js on :3000
```

---

## Key Design Decisions

See [`TECHNICAL_DECISIONS.md`](./TECHNICAL_DECISIONS.md) for full architectural rationale including:
- Why Turso over Vercel Postgres
- Why Groq over OpenAI
- Groww fallback documentation and risks
- LibSQL batch `CURRENT_TIMESTAMP` constraint
- Confidence dampening formula for adaptive weights

---

*QuantumMind is a paper trading simulator. All trades are virtual. No real capital is at risk.*
