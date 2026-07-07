# QuantumMind — Technical Decisions & Data Flow

> Document version: 2026-07-07  
> Scope: Backend engine, data pipeline, trading logic, deployment architecture  
> Frontend UI layer documented separately by Mario.

---

## 1. Assumptions

| # | Assumption | Rationale |
|---|---|---|
| 1 | **Simulation only** — no real broker integration | System records trades in DB, updates cash/holdings virtually. No real orders are placed. |
| 2 | **NSE equities only** — `.NS` suffix (Yahoo Finance convention) | Focused scope; NSE is India's primary exchange. No BSE, no F&O, no indices, no foreign tickers. |
| 3 | **No penny stocks** — `price < ₹50` filtered out | Reduce manipulation risk and data noise. |
| 4 | **Brokerage = 0.2% of trade amount** | Approximate flat fee; no STT, exchange charges, GST modelling. |
| 5 | **Yahoo Finance price data is the authoritative source** | Free, covers `.NS` symbols, historical OHLCV available. |
| 6 | **Groq LLM (`llama-3.1-8b-instant`) replaces OpenAI** | Free tier, no credit card, sufficient instruction-following for structured JSON output. |
| 7 | **Turso (LibSQL/SQLite)** replaces traditional RDBMS | Serverless-compatible, Mumbai region, SQL-compatible, zero-config. |
| 8 | **Vercel Hobby plan** — one cron job per day max | Real 5-min cycle via `cron-job.org` as external scheduler. |
| 9 | **Portfolio Alpha is the primary portfolio** — id=1, ₹50L initial capital | Other portfolios supported by the same engine; each runs independently. |
| 10 | **Groww unofficial endpoint is a fallback only** — not contractual | No SLA. Schema may change. Used ONLY when all Yahoo CDNs fail for NSE equities. |

---

## 2. Technology Decisions

### Database — Turso (LibSQL)
- **Chose over**: Vercel Postgres, PlanetScale, Supabase  
- **Why**: SQLite-compatible (no ORMs needed), serverless-friendly, Mumbai region reduces latency for Indian data workloads, free tier sufficient, `@libsql/client` is pure JS (no native addons → Vercel-compatible)  
- **Eliminated**: `better-sqlite3` and `sql.js` (both require native compilation or WASM, incompatible with Vercel serverless)

### LLM — Groq (`llama-3.1-8b-instant`)
- **Chose over**: OpenAI GPT-4, Gemini, Anthropic  
- **Why**: Free tier, no credit card, 30K tokens/day free, fast inference (< 1s for structured JSON output)  
- **Usage**: News sentiment analysis only — NOT for price prediction. Returns structured JSON: `{ sentiment, score (-2 to +2), summary, tradeImplication }`

### Market Data — Yahoo Finance v8 API (direct HTTPS)
- **Chose over**: Alpha Vantage (25 req/day too low), Twelve Data (API key required), NSE direct (session cookie auth, complex)  
- **Why**: No auth, supports `.NS` suffix, historical OHLCV for RSI calculation  
- **Risk**: Yahoo blocks cloud provider IPs intermittently  
- **Mitigation**: Fallback chain (query2 CDN → query1 CDN → Groww unofficial)

### Caching — Three-tier in-memory
- Vercel KV (if `KV_REST_API_URL` env var present) → Upstash Redis (if `UPSTASH_REDIS_REST_URL` present) → in-process `Map`  
- TTLs: portfolio_summary=60s, news/ML/adaptive=300s, regime=3600s

### Deployment — Vercel + GitHub
- `api/index.ts` = CommonJS serverless function (compiled from TypeScript)  
- `frontend/dist/` = static Vite build  
- `buildCommand` compiles backend TypeScript before function is bundled  
- `functions.includeFiles: "backend/dist/**"` ensures compiled JS is packaged with the serverless function

---

## 3. Signal Pipeline — Full Data Flow

```
NSE Market Data (Yahoo / Groww)
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — Market Data Ingestion (marketData.ts)                │
│                                                                 │
│  getQuote(symbol) — fallback chain:                             │
│    → Yahoo query2.finance.yahoo.com/v8/finance/chart/TCS.NS     │
│    → Yahoo query1.finance.yahoo.com/v8/finance/chart/TCS.NS     │
│    → Groww unofficial /tr_live_prices/NSE/CASH/TCS/latest       │
│                                                                 │
│  Validation at every source:                                    │
│    ✓ price > 0                                                  │
│    ✓ symbol matches requested ticker                            │
│    ✓ isFresh (< 30min during market hours)                      │
│    ✓ provider + latency logged                                  │
│                                                                 │
│  Returns: StockQuote { price, change, volume, provider, isFresh }│
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — Signal Generation (tradingEngine.ts)                 │
│                                                                 │
│  generateSignal(symbol, riskTolerance)                          │
│                                                                 │
│  Guard: if !isFresh → HOLD (fail-closed)                        │
│  Guard: price < ₹50 → HOLD (penny stock)                        │
│                                                                 │
│  5 parallel data fetches:                                       │
│  ┌─────────────────────────────────────────────┐               │
│  │ Technical:  RSI (14-period), 52W range,      │               │
│  │             day change%                      │ weighted vote │
│  │ News:       NSE announcements keyword score  │ per source    │
│  │ ML:         Linear regression momentum       │               │
│  │ Kelly:      Position size, Sharpe ratio      │               │
│  │ Groq LLM:   NSE announcement NLP analysis    │               │
│  └─────────────────────────────────────────────┘               │
│                                                                 │
│  Scoring: buy_score / sell_score (weighted by signal_weights)   │
│    BUY  if buy_score > sell_score AND buy_score >= 2           │
│    SELL if sell_score > buy_score AND sell_score >= 2          │
│    HOLD otherwise                                               │
│                                                                 │
│  Strength: STRONG (score >= 4) | MODERATE (score >= 2) | WEAK  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3 — Regime Calibration (adaptiveEngine.ts)              │
│                                                                 │
│  getCurrentRegime() reads Turso `market_regime` table           │
│  detectMarketRegime() uses ^NSEI (Nifty 50 index) RSI + price  │
│                                                                 │
│  BULL:     RSI > 60, day change > +1%                           │
│    → higher RSI buy threshold (more selective)                  │
│    → higher stop-loss tolerance (let winners run)               │
│                                                                 │
│  BEAR:     RSI < 40, day change < -1%                           │
│    → lower RSI sell threshold (exit faster)                     │
│    → tighter stop-loss                                          │
│                                                                 │
│  SIDEWAYS: default thresholds                                   │
│                                                                 │
│  Thresholds override: rsiBuy, rsiSell, stopLoss                 │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 4 — Trade Execution (marketMonitor.ts)                   │
│                                                                 │
│  Guard: isNseMarketOpen() — Mon-Fri 09:15-15:30 IST            │
│    If market closed: signal logged, trade NOT executed           │
│                                                                 │
│  SELL scan (existing holdings):                                  │
│    - Stop-loss: lossRatio < -12% (High risk) / -8% / -5%       │
│    - Take-profit: gainRatio > 30% + SELL signal                 │
│    - Strong SELL signal from pipeline                            │
│                                                                 │
│  BUY scan (watchlist, not already held):                         │
│    - Cash available (> ₹10,000)                                 │
│    - BUY signal with strength != WEAK                            │
│    - Position size: min(8% of NAV, 30% of cash) [High risk]     │
│    - Kelly Criterion: half-Kelly, capped at maxPosPct           │
│                                                                 │
│  On execution:                                                   │
│    1. INSERT trades (with realized_pnl for SELLs)               │
│    2. UPDATE holdings (quantity, avg_buy_price, current_price)  │
│    3. UPDATE portfolios (current_cash +/-)                       │
│    4. INSERT market_signals (signal metadata)                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 5 — Adaptive Feedback (adaptiveEngine.ts)               │
│                                                                 │
│  After 5+ trading days: resolveOutcomes()                       │
│    - Compare signal direction vs actual price movement          │
│    - Mark outcome: WIN (price moved with signal) or LOSS        │
│                                                                 │
│  Weight update formula (per signal source):                     │
│    new_weight = max(0.3, min(2.0,                               │
│      (win_rate - 0.5) × 4 + 1.0))                              │
│                                                                 │
│  6 signal sources tracked independently:                         │
│    RSI, news_sentiment, ml_momentum, kelly_sizing,              │
│    groq_llm, price_action                                        │
│                                                                 │
│  Weights persisted in Turso `signal_weights` table              │
│  Low-performing source → weight approaches 0.3 (not silenced)  │
│  High-performing source → weight approaches 2.0                 │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
              Performance Snapshots (hourly)
              → `performance_snapshots` table
              → Returns % vs 15% annual target
```

---

## 4. Scheduler (Cron) Architecture

```
Vercel (Hobby) — 1 cron/day max:
  "0 4 * * 1-5" → POST /api/cron/market-cycle (daily pre-market)

cron-job.org (external, free):
  Every 5 min, Mon-Fri 09:15-15:45 IST
  → POST https://<deployed-url>/api/cron/market-cycle
```

The `/api/cron/market-cycle` endpoint calls `runMarketCycle()` which:
1. Updates all holding prices (try/catch — continues with stale if fetch fails)
2. Iterates all active portfolios
3. Runs full signal pipeline + trade execution per portfolio

---

## 5. Portfolio NAV Calculation

```
totalValue     = Σ(quantity × current_price) + current_cash
investedValue  = Σ(quantity × avg_buy_price)
unrealizedPnl  = totalValue - investedValue - current_cash
realizedPnl    = Σ(realized_pnl FROM trades WHERE action='SELL')
               = (sell_price - avg_buy_price) × quantity - brokerage
returnPct      = (totalValue - initial_capital) / initial_capital × 100
```

---

## 6. Known Gaps / Not Yet Implemented

| Gap | Risk Level | Notes |
|---|---|---|
| Provider price disagreement check | Medium | Cross-source diff > 2% should warn/block trade |
| Real NSE licensed data feed | Medium | Yahoo/Groww are not licensed for commercial use |
| No circuit-breaker / kill-switch | High | No manual override to halt all trading |
| No position concentration limit enforcement | Medium | Kelly sizing is computed but not always enforced |
| Groq prompt injection via news data | Low | NSE announcement text is passed to LLM unescaped |
| No backtesting engine | Low | Signal weights self-adjust but no historical simulation |
