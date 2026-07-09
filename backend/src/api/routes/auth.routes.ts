import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signToken, verifyAuth } from '../../middleware/auth.js';
import { query as dbQuery, queryOne, run } from '../../db/turso.js';
import { authRegisterSchema } from './helpers.js';

const router = Router();

const GOOGLE_AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL  = 'https://www.googleapis.com/oauth2/v2/userinfo';

const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'strict' as const, maxAge: 30 * 24 * 60 * 60 * 1000 };

function googleCallbackUrl(): string {
  const base = process.env.FRONTEND_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3001');
  return `${base}/api/auth/google/callback`;
}

router.post('/auth/register', async (req: Request, res: Response) => {
  const parsed = authRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  const { email, password } = parsed.data;
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(409).json({ success: false, error: 'Email already registered' });
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
  const userId = result.lastInsertRowid;
  await run('UPDATE portfolios SET owner_id = ? WHERE owner_id IS NULL', [userId]);
  const token = signToken({ id: userId, email });
  res.cookie('qm_token', token, COOKIE_OPTS);
  res.status(201).json({ success: true, data: { id: userId, email } });
});

router.post('/auth/login', async (req: Request, res: Response) => {
  const parsed = authRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  const { email, password } = parsed.data;
  const user = await queryOne('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, String(user.password_hash)))) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }
  const token = signToken({ id: Number(user.id), email: String(user.email) });
  res.cookie('qm_token', token, COOKIE_OPTS);
  res.json({ success: true, data: { id: user.id, email: user.email } });
});

router.post('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('qm_token', { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ success: true });
});

router.get('/auth/me', verifyAuth, (req: Request, res: Response) => {
  res.json({ success: true, data: req.user });
});

router.get('/auth/google', (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ success: false, error: 'Google OAuth not configured' });
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: googleCallbackUrl(),
    response_type: 'code', scope: 'openid email profile',
    access_type: 'online', prompt: 'select_account',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

router.get('/auth/google/callback', async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`${frontendUrl}/login?error=google_denied`);
  try {
    const clientId     = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    if (!clientId || !clientSecret) throw new Error('Google OAuth not configured');
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(code), client_id: clientId, client_secret: clientSecret, redirect_uri: googleCallbackUrl(), grant_type: 'authorization_code' }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokens = await tokenRes.json() as { access_token: string };
    const profileRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileRes.ok) throw new Error('Failed to fetch Google profile');
    const profile = await profileRes.json() as { id: string; email: string; name: string; picture: string };
    let user = await queryOne('SELECT id, email, name, avatar_url FROM users WHERE google_id = ?', [profile.id]);
    if (!user) {
      const existingEmail = await queryOne('SELECT id, email FROM users WHERE email = ?', [profile.email]);
      if (existingEmail) {
        await run('UPDATE users SET google_id = ?, name = ?, avatar_url = ? WHERE id = ?', [profile.id, profile.name, profile.picture, Number(existingEmail.id)]);
        user = await queryOne('SELECT id, email, name, avatar_url FROM users WHERE id = ?', [Number(existingEmail.id)]);
      } else {
        const result = await run('INSERT INTO users (email, google_id, name, avatar_url) VALUES (?, ?, ?, ?)', [profile.email, profile.id, profile.name, profile.picture]);
        await run('UPDATE portfolios SET owner_id = ? WHERE owner_id IS NULL', [result.lastInsertRowid]);
        user = await queryOne('SELECT id, email, name, avatar_url FROM users WHERE id = ?', [result.lastInsertRowid]);
      }
    }
    if (!user) throw new Error('User record not found after upsert');
    const token = signToken({ id: Number(user.id), email: String(user.email), name: user.name ? String(user.name) : undefined, avatarUrl: user.avatar_url ? String(user.avatar_url) : undefined });
    res.cookie('qm_token', token, COOKIE_OPTS);
    res.redirect(`${frontendUrl}/`);
  } catch (err) {
    console.error('[GoogleOAuth] callback error:', err);
    res.redirect(`${frontendUrl}/login?error=google_failed`);
  }
});

export default router;
