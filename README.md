# QuantumMind

> AI-driven autonomous virtual Indian stock trading platform with self-improving adaptive ML engine, multi-source signal fusion, and a 10-gate risk framework.

## Overview

QuantumMind manages virtual equity portfolios on NSE-listed Indian stocks. An autonomous agent runs every 5 minutes during market hours, generates BUY/SELL signals from 6 weighted sources (RSI, ML momentum, news sentiment, Groq/Gemini LLM, MACD/EMA, price action), applies a 10-gate risk-gated execution pipeline, and adapts its signal weights based on historical outcomes via confidence-dampened feedback.

**Key characteristics:**
- 100% virtual paper trading — no real money, no broker API
- NSE-only (Yahoo Finance `.NS` symbols)
- Deterministic, auditable, fail-closed execution
- Self-improving signal weights via adaptive engine + pattern memory
- Multi-LLM architecture (Gemini primary, Groq fallback)
- RAG-augmented AI chatbot (TARS)
- JWT + Google OAuth authentication

## Architecture

```
cron-job.org (5 min, IST)
  │
  ▼
Market Monitor (scheduler)
  │  ├── Acquire idempotency locks
  │  ├── Update all holding prices
  │  ├── Warm Twelve Data cache
  │  ├── Gemini cycle focus (sector identification)
  │  └── For each active portfolio:
  │       ├── Sell scan (stop-loss, take-profit, Gemini sell review)
  │       ├── Buy scan (candidates from rotating NSE watchlist)
  │       ├── Execute trades via atomic LibSQL batch
  │       └── Record patterns for learning
  │
  ▼
Signal Engine (6 parallel sources, weighted voting)
  ├── RSI (14-period, regime-calibrated)
  ├── ML Momentum (linear regression on 60-day returns)
  ├── News Sentiment (NSE announcements, keyword-scored)
  ├── Groq/Gemini LLM (corporate announcement NLP)
  ├── MACD + EMA crossovers
  ├── Price Action (52-week range, volume confirmation)
  ├── Fundamental Analysis (Twelve Data quarterly ratios)
  └── Pattern Confidence (historical pattern matching)
  │
  ▼
Adaptive Engine
  ├── Signal weight recalibration (win/loss → weight update)
  ├── Market regime detection (BULL/BEAR/SIDEWAYS)
  ├── Pattern memory (what conditions lead to winning trades)
  └── Confidence dampening (full confidence after 50 outcomes)
  │
  ▼
10-Gate Risk Engine
  ├── Kill switch (global_trading_enabled)
  ├── Market hours (09:15–15:30 IST Mon–Fri)
  ├── NSE holiday calendar (2025–2026 hardcoded)
  ├── Price freshness (< 30 min)
  ├── Provider confidence (Groww blocks >₹1L BUYs)
  ├── Daily trade limit (max 10/day)
  ├── Daily turnover limit (max 25% NAV)
  ├── Position cap (max 10% NAV per symbol)
  ├── Portfolio drawdown halt (>20% from peak)
  ├── Sector concentration cap (max 35% per sector)
  └── Earnings blackout (±48h)
  │
  ▼
Execution Simulator
  ├── Atomic LibSQL batch (all-or-nothing)
  ├── Costs: flat ₹5 brokerage + itemized STT/exchange/SEBI/GST/stamp duty
  │          (single source of truth: virtualFillSimulator.calculateVirtualCharges,
  │           applied directly to the ledger — see tradingCosts.ts)
  └── Gemini trade veto (STRONG signals only)
```

## Tech Stack

### Backend
- **Runtime**: Node.js + TypeScript (target ES2020, CommonJS)
- **Framework**: Express.js
- **Database**: Turso (LibSQL/SQLite, Mumbai region)
- **LLMs**: Groq (`llama-3.1-8b-instant`, fallback) + Gemini (`gemini-1.5-flash`, primary + `text-embedding-004`)
- **Auth**: JWT (HttpOnly cookie, 30-day expiry) + Google OAuth 2.0
- **Cache**: Vercel KV → Upstash Redis → In-memory (auto-detected)
- **Deployment**: Vercel Serverless Functions (`api/index.ts`)
- **External Scheduler**: cron-job.org (5-min cycles, free plan workaround)

### Frontend
- **Framework**: React 18 + TypeScript + Vite 5
- **State**: Redux Toolkit (RTK Query) + TanStack React Query
- **Routing**: React Router v6 (createBrowserRouter)
- **Charts**: Recharts
- **API**: Zod-validated base query layer

## External Services

| Service | Role | Free Tier |
|---------|------|-----------|
| **Turso** | Primary database (LibSQL/SQLite) | Free |
| **Groq** | LLM sentiment analysis (fallback) | 30K tokens/day |
| **Gemini** | Primary LLM: trade veto, cycle focus, portfolio insights, embeddings | 1500 req/day |
| **Yahoo Finance** | Primary market data (query2 → query1 CDN fallback) | Public API |
| **Twelve Data** | Primary price provider + fundamental data | 800 calls/day |
| **Groww** ⚠️ | Unofficial fallback for NSE price data — no SLA | Unofficial |
| **Vercel** | Hosting, serverless functions | Hobby |
| **Vercel KV** | Distributed cache (production) | Hobby |
| **cron-job.org** | External 5-min cron scheduler | Free |

> ⚠️ The Groww endpoint is an unofficial fallback with no SLA. Large BUY orders (>₹1L) are blocked when Groww is the sole price source.

## Project Structure

```
├── api/index.ts                 # Vercel serverless entry point
├── vercel.json                  # Vercel deployment config
├── package.json                 # Root monorepo scripts
├── backend/
│   ├── src/
│   │   ├── index.ts             # Express app bootstrap
│   │   ├── api/routes/          # Route handlers
│   │   │   ├── auth.routes.ts       # Email + Google OAuth
│   │   │   ├── portfolio.routes.ts  # Portfolio CRUD + strategy locking
│   │   │   ├── analytics.routes.ts  # Trades, performance, ML, adaptive
│   │   │   ├── market.routes.ts     # News, quotes, watchlist
│   │   │   ├── tars.routes.ts       # TARS AI chatbot
│   │   │   ├── admin.routes.ts      # Health, cron, kill switch, backtest
│   │   │   └── helpers.ts           # Zod schemas, admin auth
│   │   ├── middleware/auth.ts   # JWT verify + portfolio ownership
│   │   ├── db/
│   │   │   ├── turso.ts         # Turso client + migrations
│   │   │   └── schema.sql       # Core DDL
│   │   ├── lib/
│   │   │   ├── cache.ts         # Multi-backend cache
│   │   │   └── logger.ts        # Structured JSON logger
│   │   ├── scheduler/
│   │   │   └── marketMonitor.ts # Market cycle orchestrator
│   │   └── services/
│   │       ├── marketData.ts       # Price providers (Twelve Data, Yahoo, Groww)
│   │       ├── tradingEngine.ts    # Signal generation + trade execution
│   │       ├── tradingGuards.ts    # Safety gates + idempotency locks
│   │       ├── riskEngine.ts       # 10 pre-execution risk gates
│   │       ├── mlEngine.ts         # Pure-TS ML (RSI, MACD, EMA, regression, Kelly)
│   │       ├── adaptiveEngine.ts   # Self-improving signal weights + regime
│   │       ├── patternEngine.ts    # Signal pattern memory + adaptive RSI
│   │       ├── fundamentalService.ts # Twelve Data quarterly analysis
│   │       ├── riskClassifier.ts   # Auto-derives risk level from goals
│   │       ├── newsService.ts      # NSE corporate announcements
│   │       ├── groqService.ts      # Groq LLM sentiment
│   │       ├── geminiService.ts    # Gemini AI (chat, embeddings, trade veto)
│   │       ├── ragService.ts       # RAG memory for TARS (FTS5 + vector)
│   │       ├── indexData.ts        # Nifty 50/500 benchmark history
│   │       ├── backtestEngine.ts   # Historical signal replay
│   │       ├── backtestWeights.ts  # Bootstrap signal weights
│   │       └── backtestData.ts     # Historical OHLCV downloader
│   └── data/quantummind.db      # Local SQLite dev database
├── frontend/
│   ├── src/
│   │   ├── main.tsx             # React entry (Redux + React Query + Router)
│   │   ├── router.tsx           # Protected routes
│   │   ├── store/               # Redux Toolkit + RTK Query
│   │   │   ├── api/             # Base API, Zod base query
│   │   │   ├── auth/            # Auth API + types
│   │   │   └── portfolios/      # Portfolios API + slice + selectors
│   │   ├── api/                 # Vanilla fetch wrappers
│   │   ├── features/
│   │   │   ├── auth/ui/             # LoginPage, RegisterPage
│   │   │   ├── portfolios/         # Dashboard, audit log, signals, charts
│   │   │   ├── news/               # NewsFeed
│   │   │   └── intelligence/       # Adaptive report panel
│   │   └── shared/ui/
│   │       ├── AppLayout/          # Shell with header + nav + TARS
│   │       ├── TarsChat/           # Floating AI chatbot
│   │       ├── RequireAuth/        # Auth guard
│   │       ├── OnboardingModal/    # First-time user onboarding
│   │       └── ...                 # Badge, StatCard, Spinner, etc.
│   └── vite.config.ts           # Vite config + proxy
└── scripts/
    └── repair-zero-price-trades.ts
```

## Database Schema

Core tables (Turso/LibSQL):

| Table | Purpose |
|-------|---------|
| `portfolios` | Portfolio config, cash balance, risk profile, strategy fields |
| `holdings` | Current positions (quantity, avg buy price, sector) |
| `trades` | Immutable trade ledger with PnL per SELL |
| `market_signals` | Generated signals with source metadata |
| `performance_snapshots` | Hourly NAV, PnL, return % |
| `users` | Auth (email + bcrypt hash + Google OAuth) |
| `signal_outcomes` | Win/loss tracking for adaptive learning |
| `signal_weights` | Per-source adaptive weights (6 sources) |
| `market_regime` | Daily regime snapshots (BULL/BEAR/SIDEWAYS) |
| `trading_config` | Kill switch persistence |
| `cron_lock` | Idempotency lock (survives cold starts) |
| `index_prices` | Nifty 50/50 daily closes for benchmarking |
| `tars_memory` | RAG knowledge base (FTS5 + vector embeddings) |
| `earnings_calendar` | Earnings dates for blackout periods |
| `gemini_decisions` | Gemini sell review audit log |
| `backtesting_prices` | 2-year OHLCV for backtesting |

## Signal Engine Details

6 signal sources tracked independently with adaptive weights (0.3–2.0):

1. **RSI** — 14-period RSI, regime-calibrated thresholds
2. **news_sentiment** — Keyword-scored NSE corporate announcements
3. **ml_momentum** — Linear regression on 60-day returns, normalized via tanh
4. **kelly_sizing** — Kelly Criterion with half-Kelly safety cap
5. **groq_llm** — Gemini primary / Groq fallback NLP analysis
6. **price_action** — 52-week range + day change + volume confirmation

Plus **fundamental analysis** (P/E, revenue growth, margins from Twelve Data) and **pattern confidence** (historical pattern matching).

## Adaptive Engine

```
Weight update: baseWeight = max(0.3, min(2.0, (winRate - 0.5) × 4 + 1.0))
               dampedWeight = 1.0 + confidenceFactor × (baseWeight - 1.0)
               confidenceFactor = min(1.0, totalSignals / 50)
```

Market regimes:
- **BULL** (Nifty RSI > 60): rsiBuy=45, rsiSell=80, stopLoss=10% — trend-following
- **BEAR** (Nifty RSI < 40 or -1.5%): rsiBuy=28, rsiSell=60, stopLoss=6% — defensive
- **SIDEWAYS** (default): rsiBuy=35, rsiSell=68, stopLoss=8% — mean-reversion

## API Endpoints

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service liveness |
| GET | `/api/health/db` | Database connectivity |
| GET | `/api/health/market-data` | Price provider reachability |
| GET | `/api/health/cron` | Last cron cycle timestamp |

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Email + password registration |
| POST | `/api/auth/login` | Email + password login |
| POST | `/api/auth/logout` | Clear HttpOnly cookie |
| GET | `/api/auth/me` | Current user |
| GET | `/api/auth/google` | Google OAuth redirect |
| GET | `/api/auth/google/callback` | OAuth callback |

### Portfolios
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolios` | List (owner-scoped, live NAV) |
| POST | `/api/portfolios` | Create (Zod validated, auto risk-classify) |
| PATCH | `/api/portfolios/:id` | Update (strategy field locking) |
| DELETE | `/api/portfolios/:id` | Soft-delete |
| GET | `/api/portfolios/:id/summary` | Holdings, cash, live prices, PnL |
| GET | `/api/portfolios/:id/edit-state` | Field-level lock metadata |
| POST | `/api/portfolios/:id/trade` | Manual trade |

### Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolios/:id/trades` | Paginated trade history |
| GET | `/api/portfolios/:id/trades/:id/explanation` | LLM trade explanation |
| GET | `/api/portfolios/:id/performance` | Performance snapshots |
| GET | `/api/portfolios/:id/sectors` | Sector allocation breakdown |
| GET | `/api/portfolios/:id/benchmark` | Portfolio vs Nifty 50/500 |

### ML & Adaptive
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ml/momentum/:symbol` | ML momentum score |
| GET | `/api/ml/kelly/:symbol` | Kelly Criterion position size |
| GET | `/api/ml/correlation/:id` | Portfolio correlation matrix |
| GET | `/api/adaptive/report` | Full adaptive learning report |
| GET | `/api/adaptive/regime` | Current market regime |

### Market & News
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/news` | All NSE announcements |
| GET | `/api/news/high-signal` | High-signal announcements |
| GET | `/api/news/intelligence` | LLM market intelligence |
| GET | `/api/market/quote/:symbol` | Live quote |
| GET | `/api/market/watchlist` | Default watchlist |

### TARS Chatbot
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tars/chat` | Chat with RAG context + live market data |

### Cron / Admin (requires `Authorization: Bearer <CRON_SECRET>`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/cron/market-cycle` | Full trading cycle |
| POST | `/api/cron/price-update` | Price-only refresh |
| POST | `/api/cron/nightly-training` | Label generation + model governance + ML retrain + walk-forward (added 2026-07-22 — see Cron Schedule below) |
| POST | `/api/admin/trading-enabled` | Toggle kill switch |
| POST | `/api/admin/backtest/run` | Bootstrap signal weights |

## Cron Schedule (IST)

| When | Frequency | Job |
|------|-----------|-----|
| 5-min | `*/5 9-15 * * 1-5` | Full market cycle (sell + buy + execute) |
| 08:55 | `55 8 * * 1-5` | Pre-market price fetch |
| Hourly | `0 * * * *` | Performance snapshot |
| 16:00 | `0 16 * * 1-5` | After-market snapshot |
| 20:00 | `0 20 * * 1-5` | Adaptive learning + Gemini portfolio insights |
| Sunday 08:00 | `0 8 * * 0` | Weekly earnings calendar refresh |

**Important (2026-07-22):** the 20:00 row above is registered via in-process
`node-cron`, which only fires on a persistently-running process. This app
deploys as a Vercel serverless function (no persistent process), and
Vercel's Hobby-plan native cron support (`vercel.json`) is limited to one
job — already used by the 5-min market cycle. **The 20:00 job will not run
in production unless an external scheduler hits
`POST /api/cron/nightly-training` directly** (same `cron-job.org` pattern as
Step 3 in `DEPLOY.md` — see that file for the exact job config). Without
this, labels never generate, the model never promotes past CANDIDATE/SHADOW,
and it never retrains, regardless of trade volume.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `turso_region` | Yes | Turso database URL (`libsql://...`) |
| `turso_sb_key` | Yes | Turso auth token |
| `groq_key` | Yes | Groq API key |
| `GEMINI_API_KEY` | No | Gemini API key (recommended, primary LLM) |
| `JWT_SECRET` | Yes | 32+ random chars for auth tokens |
| `CRON_SECRET` | Yes | Bearer token for cron/admin endpoints |
| `FRONTEND_URL` | Yes | CORS origin |
| `TWELVE_DATA_API_KEY` | No | Primary price provider |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | No | Google OAuth |
| `ADMIN_EMAIL` | No | Auto-promotes user to admin on register |
| `TRADING_ENABLED` | No | Kill switch (`false` disables all trades) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto | Vercel KV (injected by Vercel) |

## Safety & Risk Controls

1. **Kill switch** — env var or DB override
2. **NSE holiday calendar** — 2025–2026 hardcoded
3. **Market hours gate** — 09:15–15:30 IST, Mon–Fri
4. **Price freshness** — rejects >30 min stale quotes
5. **Provider cross-validation** — two Yahoo CDNs in parallel; >2% diff = abort
6. **Daily trade limit** — max 10/day per portfolio
7. **Daily turnover limit** — max 25% NAV per day
8. **Position cap** — max 10% NAV per symbol (auto-reduces quantity)
9. **Portfolio drawdown halt** — stops BUYs if >20% from peak NAV
10. **Sector concentration cap** — no single sector >35% NAV
11. **Earnings blackout** — blocks BUYs ±48h of earnings
12. **Fail-closed** — any uncertainty in price, freshness, or risk gates blocks the trade

## Deployment

```bash
# Install
npm run install:all

# Build (TypeScript backend + Vite frontend)
npm run build

# Deploy
vercel --prod
```

Vercel config: `vercel.json` routes `/api/*` to serverless function (`api/index.ts`) and `/*` to static frontend build (`frontend/dist`).

Local dev:
```bash
# Backend (Express on :3001)
cd backend && npm run dev

# Frontend (Vite on :3000, proxies /api to :3001)
cd frontend && npm run dev
```

## Key Design Decisions

See [`TECHNICAL_DECISIONS.md`](./TECHNICAL_DECISIONS.md) for the full architectural rationale covering:
- Why Turso over Vercel Postgres
- Why Groq + Gemini over OpenAI
- Confidence dampening formula for adaptive weights
- Three-tier cache auto-detection
- Atomic batch execution
- Signal pattern memory architecture

*QuantumMind is a paper trading simulator. All trades are virtual. No real capital is at risk.*
