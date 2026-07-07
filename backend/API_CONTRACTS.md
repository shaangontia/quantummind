# QuantumMind Backend API Contracts

Base URL: `http://localhost:3001/api`

## Portfolios

### List all portfolios
`GET /portfolios`
```json
{ "success": true, "data": [{ "id": 1, "name": "Portfolio Alpha", "initial_capital": 5000000, "current_cash": 5000000, "risk_tolerance": "High", "investment_horizon_months": 24, "target_return_pct": 15, "is_active": 1 }] }
```

### Create portfolio
`POST /portfolios`
Body: `{ "name": "string", "initialCapital": 1000000, "riskTolerance": "Low|Medium|High", "investmentHorizonMonths": 12, "targetReturnPct": 15, "preferredSectors": ["IT", "Banking"] }`
Response: `{ "success": true, "data": { ...portfolio } }`

### Portfolio summary (holdings + NAV)
`GET /portfolios/:id/summary`
```json
{
  "data": {
    "id": 1, "name": "Portfolio Alpha",
    "totalValue": 5000000,
    "investedValue": 0,
    "cashBalance": 5000000,
    "unrealizedPnl": 0,
    "realizedPnl": 0,
    "totalPnl": 0,
    "returnPct": 0,
    "targetReturnPct": 15,
    "riskTolerance": "High",
    "investmentHorizonMonths": 24,
    "holdings": [{ "symbol": "TCS.NS", "companyName": "TCS", "quantity": 10, "avgBuyPrice": 2096, "currentPrice": 2110, "currentValue": 21100, "pnl": 140, "pnlPct": 0.67 }]
  }
}
```

### Update portfolio settings
`PATCH /portfolios/:id`
Body: `{ "name"?, "riskTolerance"?, "investmentHorizonMonths"?, "targetReturnPct"? }`

### Deactivate portfolio
`DELETE /portfolios/:id`

## Trades (Audit Log)

### Get audit log (paginated)
`GET /portfolios/:id/trades?page=1&limit=50`
```json
{ "data": [{ "id": 1, "trade_time": "2026-07-07 14:00:00", "symbol": "TCS.NS", "action": "BUY", "quantity": 10, "price": 2096, "amount": 20960, "brokerage": 41.92, "net_amount": 21001.92, "signal_reason": "RSI low; Near 52W low" }], "pagination": { "page": 1, "limit": 50, "total": 42, "pages": 1 } }
```

## Performance

### Performance history
`GET /portfolios/:id/performance?days=30`
```json
{ "data": [{ "snapshot_time": "2026-07-07T14:00:00", "total_portfolio_value": 5000000, "return_pct": 0, "target_return_pct": 15 }] }
```

## Signals

### Recent signals feed
`GET /portfolios/:id/signals`
```json
{ "data": [{ "signal_time": "2026-07-07 14:00:00", "symbol": "TCS.NS", "signal_type": "BUY", "strength": "STRONG", "reason": "RSI low; Near 52W low", "price_at_signal": 2096, "acted_upon": 1 }] }
```

## Market Data

### Live NSE quote
`GET /market/quote/:symbol`
Symbol examples: `RELIANCE.NS`, `TCS`, `HDFCBANK.NS`
```json
{ "data": { "symbol": "RELIANCE.NS", "price": 1308.4, "change": -12.9, "changePct": -0.98, "volume": 14333839, "fiftyTwoWeekHigh": 1611.8, "fiftyTwoWeekLow": 1253.2 } }
```

## Manual Trade

### Execute manual virtual trade
`POST /portfolios/:id/trade`
Body: `{ "symbol": "TCS.NS", "companyName": "TCS", "action": "BUY|SELL", "quantity": 10, "price": 2096, "reason": "Manual trade" }`
