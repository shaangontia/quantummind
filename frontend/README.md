# QuantumMind Frontend

React + TypeScript + Vite dashboard for the QuantumMind AI trading platform.

## Stack
- React 18 + TypeScript
- React Router v6
- Recharts (performance charts)
- Vite (build)

## Structure
```
src/
  api/                          # API client + types
    portfolio.api.ts            # Typed fetch wrappers
    portfolio.api.types.ts      # Shared types
  features/
    portfolios/
      hooks/                    # usePortfolios, usePortfolioSummary
      model/                    # Utils (formatINR, formatDate, etc.)
      ui/
        PortfoliosPage/         # Portfolio list + create
        PortfolioDashboard/     # Holdings, stats, performance chart
        AuditLogPage/           # Paginated trade audit log
        SignalsPage/            # Live AI signals (auto-refresh 30s)
        CreatePortfolioModal/   # Multi-field portfolio creation form
  shared/
    ui/
      AppLayout/                # Header + nav
      StatCard/                 # KPI card
      Badge/                    # Coloured label chips
      Spinner/                  # Loading indicator
      EmptyState/               # Empty list placeholder
  styles/
    global.css                  # CSS variables + base reset
```

## API Dependencies

Backend must expose these endpoints (see Vinidicare's backend):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/portfolios` | List all portfolios |
| POST | `/api/portfolios` | Create new portfolio |
| GET | `/api/portfolios/:id/summary` | Holdings + NAV |
| GET | `/api/portfolios/:id/trades` | Paginated audit log |
| GET | `/api/portfolios/:id/performance` | Performance snapshots |
| GET | `/api/portfolios/:id/signals` | Recent signals |
| DELETE | `/api/portfolios/:id` | Deactivate portfolio |

## Dev
```bash
npm install
npm run dev        # http://localhost:3000 (proxies /api → :4000)
npm run build
npm run type-check
```
