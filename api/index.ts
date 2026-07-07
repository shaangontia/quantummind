/**
 * Vercel Serverless Function — QuantumMind API (CommonJS, Node target)
 * backend/dist is compiled by buildCommand before this runs.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Routes from compiled backend (CommonJS)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiRouter = require('../backend/dist/api/routes');
app.use('/api', apiRouter.default || apiRouter);

app.get('/health', (_req: any, res: any) =>
  res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() })
);

module.exports = app;
