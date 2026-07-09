/**
 * auth.ts — JWT authentication middleware
 *
 * - Token lives in HttpOnly cookie `qm_token` (XSS-safe)
 * - verifyAuth: rejects 401 if token missing or invalid
 * - verifyOwner: rejects 403 if authenticated user does not own the portfolio
 *   Unclaimed portfolios (owner_id IS NULL) are accessible to any authenticated user
 *   so existing data is not orphaned after auth is added.
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db/turso.js';

export interface AuthUser {
  id: number;
  email: string;
  name?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
}

// Extend Express Request to carry the authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET env var is not set');
  return s;
}

/** Sign a JWT valid for 30 days */
export function signToken(user: AuthUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, isAdmin: user.isAdmin ?? false },
    jwtSecret(),
    { expiresIn: '30d' },
  );
}

/** Verify token from `qm_token` cookie; attach user to req or reject 401 */
export function verifyAuth(req: Request, res: Response, next: NextFunction): void {
  const token: string | undefined = req.cookies?.qm_token;
  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  try {
    const payload = jwt.verify(token, jwtSecret()) as AuthUser;
    req.user = { id: payload.id, email: payload.email, isAdmin: payload.isAdmin ?? false };
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * Verify authenticated user owns the portfolio at req.params.id.
 * Must be used after verifyAuth (req.user is guaranteed populated).
 *
 * Admin bypass: admins (isAdmin from JWT) may access any portfolio.
 * TRADING_LOCK is a separate gate checked downstream in the route handler.
 */
export async function verifyOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const portfolioId = parseInt(req.params.id, 10);
  if (Number.isNaN(portfolioId)) {
    res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    return;
  }
  const portfolio = await queryOne(
    'SELECT id, owner_id FROM portfolios WHERE id = ? AND is_active = 1',
    [portfolioId],
  );
  if (!portfolio) {
    res.status(404).json({ success: false, error: 'Portfolio not found' });
    return;
  }
  if (portfolio.owner_id == null) {
    // Unclaimed portfolio: no auto-claim — requires admin to assign ownership explicitly
    if (!req.user!.isAdmin) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }
    // Admin accessing unclaimed portfolio: allow, do NOT auto-assign
    next();
    return;
  }
  if (Number(portfolio.owner_id) !== req.user!.id && !req.user!.isAdmin) {
    res.status(403).json({ success: false, error: 'Access denied' });
    return;
  }
  next();
}
