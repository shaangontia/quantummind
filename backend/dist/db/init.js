"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.persistDb = persistDb;
exports.initDb = initDb;
const sql_js_1 = __importDefault(require("sql.js"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const DB_PATH = path_1.default.join(__dirname, '../../data/quantummind.db');
let _db = null;
async function getDb() {
    if (_db)
        return _db;
    const SQL = await (0, sql_js_1.default)();
    const dataDir = path_1.default.dirname(DB_PATH);
    if (!fs_1.default.existsSync(dataDir))
        fs_1.default.mkdirSync(dataDir, { recursive: true });
    if (fs_1.default.existsSync(DB_PATH)) {
        const fileBuffer = fs_1.default.readFileSync(DB_PATH);
        _db = new SQL.Database(fileBuffer);
    }
    else {
        _db = new SQL.Database();
    }
    return _db;
}
function persistDb(db) {
    const data = db.export();
    fs_1.default.writeFileSync(DB_PATH, Buffer.from(data));
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    initial_capital REAL NOT NULL DEFAULT 5000000,
    current_cash REAL NOT NULL DEFAULT 5000000,
    risk_tolerance TEXT NOT NULL DEFAULT 'Medium',
    investment_horizon_months INTEGER NOT NULL DEFAULT 24,
    target_return_pct REAL NOT NULL DEFAULT 15.0,
    preferred_sectors TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    company_name TEXT NOT NULL,
    sector TEXT,
    quantity REAL NOT NULL DEFAULT 0,
    avg_buy_price REAL NOT NULL DEFAULT 0,
    current_price REAL,
    last_price_updated TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, symbol)
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    trade_time TEXT NOT NULL DEFAULT (datetime('now')),
    symbol TEXT NOT NULL,
    company_name TEXT,
    action TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    amount REAL NOT NULL,
    brokerage REAL DEFAULT 0,
    net_amount REAL NOT NULL,
    signal_reason TEXT,
    portfolio_value_before REAL,
    status TEXT DEFAULT 'EXECUTED'
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    snapshot_time TEXT NOT NULL DEFAULT (datetime('now')),
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
    portfolio_id INTEGER NOT NULL,
    signal_time TEXT NOT NULL DEFAULT (datetime('now')),
    symbol TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    strength TEXT,
    reason TEXT,
    price_at_signal REAL,
    acted_upon INTEGER DEFAULT 0,
    trade_id INTEGER
);
`;
async function initDb() {
    const db = await getDb();
    db.exec(SCHEMA);
    // Seed default portfolio if none
    const result = db.exec('SELECT COUNT(*) as cnt FROM portfolios');
    const count = result[0]?.values?.[0]?.[0] ?? 0;
    if (count === 0) {
        db.run(`
      INSERT INTO portfolios (name, description, initial_capital, current_cash, risk_tolerance, investment_horizon_months, target_return_pct)
      VALUES ('Portfolio Alpha', 'Aggressive, 2-year horizon — 50L initial capital', 5000000, 5000000, 'High', 24, 15.0)
    `);
        console.log('[DB] Seeded Portfolio Alpha (₹50,00,000 — Aggressive)');
    }
    persistDb(db);
    console.log('[DB] Initialized at', DB_PATH);
}
