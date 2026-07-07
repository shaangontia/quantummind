import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import apiRouter from './api/routes.js';
import { startScheduler } from './scheduler/marketMonitor.js';

const PORT = process.env.PORT || 3001;
const app = express();

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3000'] }));
app.use(express.json());
app.use('/api', apiRouter);
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'QuantumMind', ts: new Date().toISOString() }));

function bootstrap(): void {
  // DB is Turso (cloud) — no local init needed
  app.listen(PORT, () => {
    console.log(`\n🚀 QuantumMind Backend → http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   API:    http://localhost:${PORT}/api/portfolios\n`);
  });
  startScheduler();
}

bootstrap();
