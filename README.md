# QuantumMind 🧠

> AI-driven virtual Indian stock trading portal — autonomous, adaptive, and transparent.

**QuantumMind** is a fully autonomous virtual trading system for NSE-listed equities. It uses real-time market data, LLM-powered news analysis, ML momentum signals, and an adaptive feedback loop to manage multi-portfolio positions — targeting 15%+ annualized returns.

**All trading is simulated. No real money is involved.**

---

## Live Demo

```
https://quantummind-shaangontia.vercel.app
```

---

## Features

- **Multi-portfolio management** — Create portfolios with configurable risk tolerance, investment horizon, and target return
- **Autonomous trading agent** — Signal generation → Risk Engine → Execution, no human approval needed
- **Real-time NSE prices** — Yahoo Finance (primary) with Groww unofficial endpoint fallback
- **LLM news analysis** — Groq (llama-3.1-8b-instant) analyses NSE corporate announcements for sentiment and trade impact
- **ML signal stack** — RSI(14), 52-week range, linear regression momentum, Kelly Criterion position sizing, correlation matrix
- **Adaptive feedback loop** — Signal weights auto-adjust based on win/loss outcomes with confidence dampening
- **Market regime detection** — BULL / BEAR / SIDEWAYS regime gates trade thresholds
- **Comprehensive audit log** — Every BUY / SELL / HOLD with reason, price, and provider logged
- **Safety guards** — Fail-closed on stale prices, kill switch, position caps, daily trade limits, NSE holiday calendar, atomic transactions, cron idempotency

---

## External Services

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| **[Vercel](https://vercel.com)** | Hosting — frontend (static) + backend (serverless functions) | Yes — Hobby plan |
| **[Turso](https://turso.tech)** | Cloud SQLite database (Mumbai `ap-south-1` region) | Yes — 500MB, 1B row reads/month |
| **[Groq](https://groq.com)** | LLM inference — `llama-3.1-8b-instant` for news sentiment analysis | Yes — free API key |
| **[Yahoo Finance](https://finance.yahoo.com)** | Live NSE stock quotes + historical OHLCV data | Unofficial (no API key needed) |
| **[Groww](https://groww.in)** | NSE live price fallback when Yahoo Finance is unavailable | Unofficial web endpoint — no SLA |
| **[cron-job.org](https://cron-job.org)** | External cron trigger — fires `/api/cron/market-cycle` every 5 min during market hours | Yes — free |
| **[NSE India](https://nseindia.com)** | Corporate announcements RSS feed for news signal generation | Public RSS |

> ⚠️ Yahoo Finance and Groww are used via public/unofficial endpoints. They have no SLA and are suitable for simulation only.

---

## Architecture

```
Frontend (React 18 + Vite)          Backend (Node.js + Express + TypeScript)
  ┌──────────────────┐                ┌──────────────────────────────────────────┐
  │  Portfolio List  │  /api/*        │  Express Router (Vercel serverless)      │
  │  Dashboard       │◄──────────────►│                                          │
  │  Signals         │                │  ┌─────────────┐  ┌──────────────────┐  │
  │  Audit Log       │                │  │ RiskEngine  │  │ AdaptiveEngine   │  │
  │  Adaptive Panel  │                │  └─────────────┘  └──────────────────┘  │
  └──────────────────┘                │  ┌─────────────┐  ┌──────────────────┐  │
                                      │  │MarketData   │  │ TradingEngine    │  │
  Data Flow (every 5 min):            │  │ Yahoo/Groww │  │ Signal Pipeline  │  │
                                      │  └─────────────┘  └──────────────────┘  │
  cron-job.org                        │           │                              │
      │ POST /api/cron/market-cycle   │           ▼                              │
      ▼                               │  ┌───────────────────────────────────┐   │
  [Price Update]                      │  │  Turso (LibSQL cloud SQLite)      │   │
  [Signal Generation]                 │  │  portfolios / holdings / trades   │   │
  [Risk Check]                        │  │  market_signals / signal_outcomes │   │
  [Trade Execution]                   │  │  performance_snapshots / cron_lock│   │
  [Adaptive Learning]                 │  └───────────────────────────────────┘   │
  [Performance Snapshot]              └──────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, React Router v6, Recharts |
| Backend | Node.js, Express, TypeScript |
| Database | Turso (cloud SQLite via `@libsql/client`) |
| LLM | Groq API (`llama-3.1-8b-instant`) |
| Deployment | Vercel (serverless functions) |
| Cron | cron-job.org (external trigger) |

---

## Local Development

```bash
# Clone and install
git clone https://github.com/shaangontia/quantummind.git
cd quantummind
npm install
cd backend && npm install
cd ../frontend && npm install

# Environment variables
cp .env.example .env
# Edit .env with your Turso + Groq credentials

# Start (backend :3001, frontend :3000)
cd ..
npm start
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `turso_region` | Turso database URL (`libsql://...`) |
| `turso_sb_key` | Turso auth token (JWT) |
| `groq_key` | Groq API key (`gsk_...`) |
| `CRON_SECRET` | Shared secret for cron endpoint auth |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/portfolios` | List all portfolios with live NAV + return |
| `POST` | `/api/portfolios` | Create portfolio |
| `GET` | `/api/portfolios/:id/summary` | Portfolio NAV, holdings, P&L |
| `GET` | `/api/portfolios/:id/performance?days=` | Historical snapshots for chart |
| `GET` | `/api/portfolios/:id/signals` | Recent trading signals |
| `GET` | `/api/portfolios/:id/trades` | Paginated audit log |
| `GET` | `/api/market/quote/:symbol` | Live NSE quote |
| `GET` | `/api/news` | NSE corporate announcements |
| `GET` | `/api/news/intelligence` | Groq-analysed news with scoring |
| `GET` | `/api/ml/momentum/:symbol` | ML momentum score |
| `GET` | `/api/ml/kelly/:symbol` | Kelly Criterion position size |
| `GET` | `/api/adaptive/report` | Signal weights + win rates |
| `GET` | `/api/adaptive/regime` | Current market regime |
| `GET` | `/api/health` | System health |
| `GET` | `/api/health/db` | Database health |
| `GET` | `/api/health/market-data` | Market data provider health |
| `POST` | `/api/cron/market-cycle` | Trigger full trading cycle (auth required) |
| `POST` | `/api/cron/price-update` | Lightweight price refresh only (auth required) |
| `POST` | `/api/admin/trading-enabled` | Kill switch (auth required) |

---

## Cron Setup (cron-job.org)

Two jobs required:

**Job 1 — Market Cycle (every 5 min, trading hours):**
```
URL:    https://quantummind-shaangontia.vercel.app/api/cron/market-cycle
Method: POST
Header: Authorization: Bearer <CRON_SECRET>
Cron:   */5 3-10 * * 1-5   (= 09:15–15:30 IST, Mon–Fri)
```

**Job 2 — Price Update (every 5 min, all hours):**
```
URL:    https://quantummind-shaangontia.vercel.app/api/cron/price-update
Method: POST
Header: Authorization: Bearer <CRON_SECRET>
Cron:   */5 * * * 1-5
```

---

## Kill Switch

To halt all autonomous trading immediately:

```bash
curl -X POST https://quantummind-shaangontia.vercel.app/api/admin/trading-enabled \
  -H "Authorization: Bearer <CRON_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

## Known Limitations

- Yahoo Finance and Groww endpoints are unofficial — may break without notice
- Groq LLM is used for news analysis only, not fine-tuned on Indian markets
- NSE real-time data feed is a licensed product; unofficial access is for simulation only
- Backtest engine not yet implemented — adaptive weights bootstrap from 1.0
- No circuit-breaker on provider failure count yet

---

## Project Structure

```
quantummind/
  backend/
    src/
      api/routes.ts          # Express routes
      db/turso.ts            # Turso client + migrations
      lib/cache.ts           # In-memory TTL cache (Vercel KV ready)
      lib/logger.ts          # Structured JSON logging
      scheduler/
        marketMonitor.ts     # Cron orchestrator, price update, snapshot
      services/
        marketData.ts        # Yahoo + Groww price providers
        tradingEngine.ts     # Signal pipeline + portfolio summary
        riskEngine.ts        # Pre-execution risk gate (8 checks)
        adaptiveEngine.ts    # Signal weight learning
        mlEngine.ts          # Linear regression, Kelly, correlation
        newsService.ts       # NSE RSS + sentiment scoring
        groqService.ts       # Groq LLM integration
        tradingGuards.ts     # Kill switch, NSE holidays, cron lock
  frontend/
    src/
      api/                   # Typed API clients
      features/
        portfolios/          # Portfolio list, dashboard, audit log, signals
        intelligence/        # Adaptive AI panel
        news/                # NSE news feed
      shared/ui/             # SkeletonBlock, StatCard, Badge, Spinner
  vercel.json                # Build + routing + function config
  TECHNICAL_DECISIONS.md     # Full architecture + data flow writeup
  DEPLOY.md                  # Step-by-step deployment guide
```

---

## Licence

MIT — simulation use only. Not financial advice.
