/**
 * Vercel Serverless Function — QuantumMind API (CommonJS, Node target)
 * backend/dist is compiled by buildCommand before this runs.
 */
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const FRONTEND_ORIGIN = process.env.FRONTEND_URL || '';
if (!FRONTEND_ORIGIN) console.warn('[CORS] FRONTEND_URL env var is not set — CORS will block all cross-origin requests');

const app = express();
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,  // required for HttpOnly cookie exchange
}));
app.use(express.json());
app.use(cookieParser());

// Run DB migrations on cold start (idempotent)
let migrated = false;
async function ensureMigrations() {
  if (migrated) return;
  try {
    const { runMigrations } = require('../backend/dist/db/turso');
    await runMigrations();
    const { ensureTradingConfigTable } = require('../backend/dist/services/tradingGuards');
    await ensureTradingConfigTable();
  } catch (e) {
    console.warn('[Migration] skipped:', String(e));
  }
  migrated = true;
}

// Mount compiled routes
const apiRouter = require('../backend/dist/api/routes');
app.use('/api', async (req: any, res: any, next: any) => {
  await ensureMigrations();
  next();
}, apiRouter.default || apiRouter);

app.get('/health', (_req: any, res: any) =>
  res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() })
);

module.exports = app;
