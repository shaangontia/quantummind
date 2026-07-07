/**
 * Vercel Serverless Function — QuantumMind API
 * buildCommand compiles backend/src → backend/dist before this runs
 */
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Lazy-load compiled routes — backend/dist built by buildCommand
let routerLoaded = false;
app.use('/api', async (req, res, next) => {
  if (!routerLoaded) {
    const { default: router } = await import('../backend/dist/api/routes.js');
    app.use('/api', router);
    routerLoaded = true;
  }
  next();
});

app.use('/api', async (req, res, next) => {
  const { default: router } = await import('../backend/dist/api/routes.js');
  router(req, res, next);
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() })
);

export default app;
