import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ─── Param parser ──────────────────────────────────────────────────────────────

/** Parse an integer route/query param; returns null if invalid */
export function parseIntParam(val: string | undefined, fallback?: number): number | null {
  if (val === undefined && fallback !== undefined) return fallback;
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? null : n;
}

// ─── Validation schemas ────────────────────────────────────────────────────────

export const RISK_TOLERANCE  = ['Low', 'Medium', 'High', 'Very High'] as const;
export const REBALANCE_FREQ  = ['Weekly', 'Monthly', 'Quarterly', 'Never'] as const;
export const VOLATILITY_PREF = ['low', 'medium', 'high'] as const;
export const INVESTMENT_GOAL = ['growth', 'income', 'retirement'] as const;

export const portfolioCreateSchema = z.object({
  name:                    z.string().min(1).max(100),
  description:             z.string().max(500).optional(),
  initialCapital:          z.number().positive().max(1_000_000_000),
  riskTolerance:           z.enum(RISK_TOLERANCE).optional(),
  investmentHorizonMonths: z.number().int().min(1).max(600).optional(),
  targetReturnPct:         z.number().min(0).optional(), // no upper cap — multibagger targets valid
  preferredSectors:        z.array(z.string()).optional(),
  preferredCaps:           z.array(z.string()).optional(),
});

export const portfolioPatchSchema = z.object({
  name:                    z.string().min(1).max(100).optional(),
  description:             z.string().max(500).optional(),
  initialCapital:          z.number().positive().max(1_000_000_000).optional(),
  riskTolerance:           z.enum(RISK_TOLERANCE).optional(),
  investmentHorizonMonths: z.number().int().min(1).max(600).optional(),
  targetReturnPct:         z.number().min(0).optional(), // no upper cap — multibagger targets valid
  rebalanceFrequency:      z.enum(REBALANCE_FREQ).optional(),
  preferredSectors:        z.array(z.string()).optional(),
  preferredCaps:           z.array(z.string()).optional(),
  volatilityPreference:    z.enum(VOLATILITY_PREF).optional(),
  investmentGoal:          z.enum(INVESTMENT_GOAL).optional(),
  maxDrawdownPct:          z.number().min(1).max(100).optional(),
});

export const authRegisterSchema = z.object({
  email:    z.string().email().max(200),
  password: z.string().min(8).max(128),
});

// ─── Admin auth middleware ─────────────────────────────────────────────────────

/**
 * Session-based admin check for browser-facing admin UI routes.
 * Requires a valid JWT cookie (verifyAuth must run first) with isAdmin=true.
 * Use for all /admin/* routes accessible from the browser.
 */
export function requireUserAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'Admin only' }); return; }
  next();
}

/** Fail-closed admin auth middleware for server-to-server cron calls. Rejects if CRON_SECRET is unset. */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(503).json({ error: 'Auth not configured - set CRON_SECRET env var' }); return; }
  const provided = req.headers.authorization?.replace('Bearer ', '') ?? (req.query.secret as string | undefined);
  if (provided !== secret) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}
