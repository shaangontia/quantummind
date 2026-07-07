/**
 * Vercel Serverless Function entry point.
 *
 * All /api/* routes are handled here.
 * Scheduler (node-cron) does NOT run — market cycle is triggered by
 * the /api/cron/market-cycle endpoint (cron-job.org or Vercel cron).
 */
import express from 'express';
import cors from 'cors';
import { Router } from 'express';

// Re-export a Vercel-compatible handler
const app = express();

// Allow requests from any deployed Vercel URL + localhost
const ALLOWED = [
  /https:\/\/.*\.vercel\.app$/,
  /http:\/\/localhost:\d+$/,
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.some(r => r.test(origin))) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
}));
app.use(express.json());

// Lazy-load routes to keep cold start fast
let _router: Router | null = null;
async function getRouter(): Promise<Router> {
  if (_router) return _router;
  const { default: router } = await import('../backend/dist/api/routes.js');
  _router = router;
  return router;
}

app.use('/api', async (req, res, next) => {
  const router = await getRouter();
  router(req, res, next);
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() })
);

export default app;
