-- QuantumMind Database Schema (Multi-Portfolio)

CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    initial_capital REAL NOT NULL DEFAULT 5000000,  -- Default 50 lakh INR
    current_cash REAL NOT NULL DEFAULT 5000000,
    risk_tolerance TEXT NOT NULL DEFAULT 'Medium'
        CHECK(risk_tolerance IN ('Low', 'Medium', 'High')),
    investment_horizon_months INTEGER NOT NULL DEFAULT 12,
    target_return_pct REAL NOT NULL DEFAULT 15.0,
    rebalance_frequency TEXT NOT NULL DEFAULT 'Monthly'
        CHECK(rebalance_frequency IN ('Weekly', 'Monthly', 'Quarterly')),
    preferred_sectors TEXT,       -- JSON array of sectors
    preferred_cap TEXT,            -- 'small' | 'mid' | 'large' | NULL (AI decides freely)
    strategy_rules TEXT,          -- JSON object: signal thresholds, stop-loss %, take-profit %
    is_active INTEGER DEFAULT 1,  -- 0 = deactivated / archived
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    company_name TEXT NOT NULL,
    sector TEXT,
    quantity REAL NOT NULL DEFAULT 0,
    avg_buy_price REAL NOT NULL DEFAULT 0,
    current_price REAL,
    last_price_updated DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(portfolio_id, symbol)
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    trade_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    symbol TEXT NOT NULL,
    company_name TEXT,
    action TEXT NOT NULL CHECK(action IN ('BUY', 'SELL')),
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    amount REAL NOT NULL,
    brokerage REAL DEFAULT 0,
    net_amount REAL NOT NULL,
    signal_reason TEXT,
    portfolio_value_before REAL,
    portfolio_value_after REAL,
    status TEXT DEFAULT 'EXECUTED' CHECK(status IN ('EXECUTED', 'SIMULATED', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    snapshot_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total_portfolio_value REAL NOT NULL,
    invested_value REAL NOT NULL,
    cash_balance REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    total_pnl REAL NOT NULL,
    return_pct REAL NOT NULL,
    target_return_pct REAL NOT NULL DEFAULT 15.0,
    holdings_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    signal_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    symbol TEXT NOT NULL,
    signal_type TEXT NOT NULL CHECK(signal_type IN ('BUY', 'SELL', 'HOLD', 'WATCH')),
    strength TEXT CHECK(strength IN ('STRONG', 'MODERATE', 'WEAK')),
    reason TEXT,
    price_at_signal REAL,
    acted_upon INTEGER DEFAULT 0,
    trade_id INTEGER REFERENCES trades(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON trades(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(trade_time);
CREATE INDEX IF NOT EXISTS idx_signals_portfolio ON market_signals(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_signals_time ON market_signals(signal_time);
CREATE INDEX IF NOT EXISTS idx_performance_portfolio ON performance_snapshots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_performance_time ON performance_snapshots(snapshot_time);
