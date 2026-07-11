# QuantumMind Frontend

React + TypeScript + Vite dashboard for the QuantumMind AI trading platform.

## Stack
- React 18 + TypeScript
- React Router v6 (createBrowserRouter)
- Redux Toolkit (RTK Query) + TanStack React Query
- Recharts (performance charts, benchmark, sector allocation)
- Vite 5 (build)

## Structure
```
src/
  api/                          # Vanilla fetch wrappers + types
    portfolio.api.ts
    portfolio.api.types.ts
    news.api.ts
    news.api.types.ts
    adaptive.api.types.ts
  store/                        # Redux Toolkit + RTK Query
    store.ts
    api/baseApi.ts              # RTK Query base with Zod validation
    api/zodBaseQuery.ts
    auth/                       # Auth API (login, register, me, logout)
    portfolios/                 # Portfolio CRUD API + Redux slice
  shared/ui/
    AppLayout/                  # Header + nav + TARS floating button
    TarsChat/                   # AI chatbot (Gemini/Groq)
    RequireAuth/                # Auth guard (redirects to /login)
    OnboardingModal/            # First-time user onboarding
    StatCard/                   # KPI card component
    Badge/                      # Coloured label chips
    SkeletonBlock/              # Loading skeleton
    Spinner/                    # Loading indicator
    EmptyState/                 # Empty list placeholder
  features/
    auth/ui/LoginPage/
    auth/ui/RegisterPage/
    portfolios/
      hooks/                    # usePortfolios, usePortfolioSummary, useMarketPolling
      model/                    # Utils (formatINR, formatDate, marketHours)
      ui/
        PortfoliosPage/         # Portfolio list + create/edit modals
        PortfolioDashboard/     # Holdings, stats, performance chart, news, AI
        AuditLogPage/           # Paginated trade audit log
        SignalsPage/            # Live AI signals
        PerformanceChart/       # NAV vs target
        BenchmarkChart/         # Portfolio vs Nifty 50/500
        SectorAllocationChart/  # Sector breakdown
        HoldingsTable/          # Position table
        PortfolioStats/         # KPI row
        CreatePortfolioModal/   # Multi-field creation form
        EditPortfolioModal/     # Strategy settings editor
    news/
      hooks/useNewsFeed.ts
      ui/NewsFeed/              # NSE corporate announcements
    intelligence/
      hooks/useAdaptiveReport.ts
      ui/AdaptivePanel/         # Adaptive learning report
  styles/global.css             # CSS variables + base reset
```

## API Dependencies

Backend exposes endpoints at `/api/*` (Vite dev server proxies to `localhost:3001`):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolios` | List all portfolios |
| POST | `/api/portfolios` | Create new portfolio |
| PATCH | `/api/portfolios/:id` | Update portfolio |
| DELETE | `/api/portfolios/:id` | Deactivate portfolio |
| GET | `/api/portfolios/:id/summary` | Holdings + NAV |
| GET | `/api/portfolios/:id/trades` | Paginated audit log |
| GET | `/api/portfolios/:id/performance` | Performance snapshots |
| GET | `/api/portfolios/:id/signals` | Recent signals |
| GET | `/api/portfolios/:id/sectors` | Sector allocation |
| GET | `/api/portfolios/:id/benchmark` | vs Nifty 50/500 |
| GET | `/api/ml/momentum/:symbol` | ML momentum score |
| GET | `/api/ml/correlation/:id` | Correlation matrix |
| GET | `/api/adaptive/report` | Adaptive learning report |
| GET | `/api/adaptive/regime` | Market regime |
| GET | `/api/news` | NSE announcements |
| GET | `/api/news/intelligence` | LLM market intelligence |
| GET | `/api/market/quote/:symbol` | Live quote |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/register` | Register |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current user |
| POST | `/api/tars/chat` | AI chatbot |

## Dev

```bash
npm install
npm run dev          # http://localhost:3000 (proxies /api → :3001)
npm run build
npm run type-check
```
