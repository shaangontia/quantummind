"use strict";
/**
 * Vercel Serverless Function — QuantumMind API (CommonJS, Node target)
 * backend/dist is compiled by buildCommand before this runs.
 */
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
// FRONTEND_URL must be set in Vercel env vars. Falls back to the known Vercel deployment URL
// so the app stays functional even if the var is omitted.
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'https://quantummind-shaangontia.vercel.app';
if (!process.env.FRONTEND_URL)
    console.warn('[CORS] FRONTEND_URL not set — falling back to default origin');
const app = express();
app.use(cors({
    origin: FRONTEND_ORIGIN,
    credentials: true, // required for HttpOnly cookie exchange
}));
app.use(express.json());
app.use(cookieParser());
// Run DB migrations on cold start (idempotent)
let migrated = false;
async function ensureMigrations() {
    if (migrated)
        return;
    try {
        const { runMigrations } = require('../backend/dist/db/turso');
        await runMigrations();
        const { ensureTradingConfigTable } = require('../backend/dist/services/tradingGuards');
        await ensureTradingConfigTable();
    }
    catch (e) {
        console.warn('[Migration] skipped:', String(e));
    }
    migrated = true;
}
// Mount compiled routes
const apiRouter = require('../backend/dist/api/routes');
app.use('/api', async (req, res, next) => {
    await ensureMigrations();
    next();
}, apiRouter.default || apiRouter);
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() }));
module.exports = app;
