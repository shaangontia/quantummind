import { Router, Request, Response } from 'express';
import { verifyAuth, verifyOwner } from '../../middleware/auth.js';
import { query, queryOne, run } from '../../db/turso.js';
import { getPortfolioSummary } from '../../services/tradingEngine.js';
import { executeTrade } from '../../services/tradingEngine.js';
import { cache, TTL } from '../../lib/cache.js';
import { parseIntParam, portfolioCreateSchema, portfolioPatchSchema } from './helpers.js';
import { deriveRiskLevel } from '../../services/riskClassifier.js';

const router = Router();

// ─── List portfolios (owner-scoped) ───────────────────────────────────────────
router.get('/portfolios', verifyAuth, async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Admins see all active portfolios; regular users see only their own
    const user = await queryOne('SELECT is_admin FROM users WHERE id = ?', [req.user!.id]);
    const isAdmin = Number(user?.is_admin ?? 0) === 1;
    const portfolios = isAdmin
      ? await query('SELECT * FROM portfolios WHERE is_active = 1 ORDER BY owner_id, created_at DESC')
      : await query('SELECT * FROM portfolios WHERE owner_id = ? AND is_active = 1 ORDER BY created_at DESC', [req.user!.id]);
    const enriched = await Promise.all(portfolios.map(async (p: any) => {
      const [holdingsValue, tradeRow] = await Promise.all([
        query('SELECT COALESCE(SUM(quantity * COALESCE(current_price, avg_buy_price)), 0) as nav FROM holdings WHERE portfolio_id = ?', [p.id]),
        queryOne('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ? AND price > 0', [p.id]),
      ]);
      const nav = Number(holdingsValue[0]?.nav ?? 0) + Number(p.current_cash);
      const returnPct = Number(p.initial_capital) > 0
        ? ((nav - Number(p.initial_capital)) / Number(p.initial_capital)) * 100 : 0;
      const tradeCount = Number(tradeRow?.cnt ?? 0);
      return { ...p, current_nav: nav, return_pct: returnPct, trade_count: tradeCount };
    }));
    res.json({ success: true, data: enriched });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Create portfolio ─────────────────────────────────────────────────────────
router.post('/portfolios', verifyAuth, async (req: Request, res: Response) => {
  const parsed = portfolioCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  const { name, description, initialCapital, riskTolerance, investmentHorizonMonths, targetReturnPct, preferredSectors, preferredCaps } = parsed.data;
  // Derive risk level from inputs; honour explicit user override if provided
  const { level: derivedRisk, explanation: riskExplanation } = deriveRiskLevel({
    targetReturnPct,
    investmentHorizonMonths,
  });
  const effectiveRisk = riskTolerance ?? derivedRisk;
  const result = await run(
    'INSERT INTO portfolios (name,description,initial_capital,current_cash,risk_tolerance,investment_horizon_months,target_return_pct,preferred_sectors,preferred_caps,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [name, description || null, initialCapital, initialCapital, effectiveRisk, investmentHorizonMonths || 12, targetReturnPct || 15.0, preferredSectors ? JSON.stringify(preferredSectors) : null, preferredCaps ? JSON.stringify(preferredCaps) : null, req.user!.id]
  );
  const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json({ success: true, data: portfolio, meta: { derivedRisk, riskExplanation, overridden: !!riskTolerance } });
});

// ─── Portfolio summary (live NAV) ─────────────────────────────────────────────
router.get('/portfolios/:id/summary', async (req: Request, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (id === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const data = await cache.getOrSet(`portfolio_summary_${id}`, () => getPortfolioSummary(id), TTL.PORTFOLIO_SUMMARY);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Update portfolio ─────────────────────────────────────────────────────────
router.patch('/portfolios/:id', verifyAuth, verifyOwner, async (req: Request, res: Response) => {
  try {
    const parsed = portfolioPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { name, description, initialCapital, riskTolerance, investmentHorizonMonths, targetReturnPct, rebalanceFrequency, preferredSectors, preferredCaps, volatilityPreference, investmentGoal, maxDrawdownPct } = parsed.data;
    const id = parseIntParam(req.params.id);
    if (id === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const existing = await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Portfolio not found' });

    if (initialCapital != null) {
      const investedValue = Number(existing.initial_capital ?? 0) - Number(existing.current_cash ?? 0);
      if (Number(initialCapital) < investedValue) {
        return res.status(422).json({ success: false, error: `Cannot reduce capital below invested value (₹${investedValue.toLocaleString('en-IN')}). Sell positions first.`, code: 'CAPITAL_FLOOR_BREACH' });
      }
    }

    const holdingsRow  = await queryOne('SELECT COUNT(*) as cnt FROM holdings WHERE portfolio_id = ?', [id]);
    const tradesRow    = await queryOne('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ?', [id]);
    const holdingsCount = Number(holdingsRow?.cnt ?? 0);
    const tradeCount    = Number(tradesRow?.cnt ?? 0);
    const latestSnap    = await queryOne('SELECT total_portfolio_value FROM performance_snapshots WHERE portfolio_id = ? ORDER BY snapshot_time DESC LIMIT 1', [id]);
    const currentNAV    = latestSnap ? Number(latestSnap.total_portfolio_value) : Number(existing.initial_capital);
    const peakNAV       = existing.peak_nav != null ? Number(existing.peak_nav) : Number(existing.initial_capital);
    const drawdownPct   = peakNAV > 0 ? ((peakNAV - currentNAV) / peakNAV) * 100 : 0;
    const drawdownLimit = Number(existing.max_drawdown_pct ?? 20);
    const isVirgin = tradeCount === 0 && holdingsCount === 0;
    const isMature = tradeCount >= 20;
    const inDrawdown = drawdownPct >= drawdownLimit;
    const STRATEGY_FIELDS = [riskTolerance, preferredSectors, preferredCaps, volatilityPreference, investmentGoal, investmentHorizonMonths, targetReturnPct, rebalanceFrequency];
    const strategyChangeRequested = STRATEGY_FIELDS.some(f => f != null);

    // Once any trade has been executed, all strategy fields are locked
    if (!isVirgin && strategyChangeRequested) {
      return res.status(423).json({ success: false, error: 'Portfolio strategy is locked once trading has begun. No edits permitted.', code: 'TRADING_LOCK', meta: { tradeCount, holdingsCount } });
    }

    const cashDelta = initialCapital != null ? Number(initialCapital) - Number(existing.initial_capital ?? 0) : 0;

    // Auto-derive risk level when not explicitly provided and signals changed
    const signalFields = [targetReturnPct, investmentHorizonMonths, maxDrawdownPct, volatilityPreference];
    const signalChanged = signalFields.some(f => f != null);
    let effectiveRiskTolerance = riskTolerance ?? null;
    let derivedRiskMeta: { derivedRisk: string; riskExplanation: string } | null = null;
    if (!riskTolerance && !isMature && signalChanged) {
      const { level: derivedRisk, explanation: riskExplanation } = deriveRiskLevel({
        targetReturnPct: targetReturnPct ?? Number(existing.target_return_pct ?? 15),
        investmentHorizonMonths: investmentHorizonMonths ?? Number(existing.investment_horizon_months ?? 12),
        maxDrawdownPct: maxDrawdownPct ?? Number(existing.max_drawdown_pct ?? 20),
        volatilityPreference: volatilityPreference ?? existing.volatility_preference ?? 'medium',
      });
      effectiveRiskTolerance = derivedRisk;
      derivedRiskMeta = { derivedRisk, riskExplanation };
    }

    await run(
      `UPDATE portfolios SET name=COALESCE(?,name), description=COALESCE(?,description), initial_capital=COALESCE(?,initial_capital),
        current_cash=CASE WHEN ? IS NOT NULL THEN MAX(0,current_cash+?) ELSE current_cash END,
        risk_tolerance=COALESCE(?,risk_tolerance), investment_horizon_months=COALESCE(?,investment_horizon_months),
        target_return_pct=COALESCE(?,target_return_pct), rebalance_frequency=COALESCE(?,rebalance_frequency),
        preferred_sectors=COALESCE(?,preferred_sectors), preferred_caps=COALESCE(?,preferred_caps),
        volatility_preference=COALESCE(?,volatility_preference), investment_goal=COALESCE(?,investment_goal),
        max_drawdown_pct=COALESCE(?,max_drawdown_pct),
        strategy_updated_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE strategy_updated_at END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [name ?? null, description ?? null, initialCapital ?? null, initialCapital ?? null, cashDelta,
       effectiveRiskTolerance, investmentHorizonMonths ?? null, targetReturnPct ?? null, rebalanceFrequency ?? null,
       preferredSectors != null ? JSON.stringify(preferredSectors) : null,
       preferredCaps != null ? JSON.stringify(preferredCaps) : null,
       volatilityPreference ?? null, investmentGoal ?? null, maxDrawdownPct ?? null,
       strategyChangeRequested ? 1 : 0, id]
    );
    const updated = await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]);
    res.json({ success: true, data: updated, meta: { state: isVirgin ? 'VIRGIN' : isMature ? 'MATURE' : 'ACTIVE', hasActiveHoldings: holdingsCount > 0, strategyQueued: strategyChangeRequested && holdingsCount > 0, tradeCount, drawdownPct: Math.round(drawdownPct * 10) / 10, ...derivedRiskMeta } });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Delete (archive) portfolio ───────────────────────────────────────────────
router.delete('/portfolios/:id', verifyAuth, verifyOwner, async (req: Request, res: Response) => {
  const id = parseIntParam(req.params.id);
  if (id === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
  await run('UPDATE portfolios SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
  res.json({ success: true });
});

// ─── Edit-state (field-level lock metadata for modal) ─────────────────────────
router.get('/portfolios/:id/edit-state', async (req: Request, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (id === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
    const portfolio = await queryOne('SELECT * FROM portfolios WHERE id = ?', [id]);
    if (!portfolio) return res.status(404).json({ success: false, error: 'Portfolio not found' });
    if (!portfolio.is_active) return res.json({ success: true, data: { state: 'ARCHIVED', editability: { free: [], warn: [], locked: ['all'] } } });

    const holdingsRow  = await queryOne('SELECT COUNT(*) as cnt FROM holdings WHERE portfolio_id = ?', [id]);
    const tradesRow    = await queryOne('SELECT COUNT(*) as cnt FROM trades WHERE portfolio_id = ?', [id]);
    const holdingsCount = Number(holdingsRow?.cnt ?? 0);
    const tradeCount    = Number(tradesRow?.cnt ?? 0);
    const latestSnap    = await queryOne('SELECT total_portfolio_value FROM performance_snapshots WHERE portfolio_id = ? ORDER BY snapshot_time DESC LIMIT 1', [id]);
    const currentNAV    = latestSnap ? Number(latestSnap.total_portfolio_value) : Number(portfolio.initial_capital);
    const peakNAV       = portfolio.peak_nav != null ? Number(portfolio.peak_nav) : Number(portfolio.initial_capital);
    const drawdownPct   = peakNAV > 0 ? ((peakNAV - currentNAV) / peakNAV) * 100 : 0;
    const drawdownLimit = Number(portfolio.max_drawdown_pct ?? 20);
    const investedValue = Number(portfolio.initial_capital ?? 0) - Number(portfolio.current_cash ?? 0);
    const isVirgin  = tradeCount === 0 && holdingsCount === 0;
    const isMature  = tradeCount >= 20;
    const inDrawdown = drawdownPct >= drawdownLimit;

    type FL = string[];
    let state: string; let free: FL; let warn: FL; let locked: FL;
    if (isVirgin) {
      state = 'VIRGIN'; locked = []; warn = [];
      free = ['name','description','initialCapital','riskTolerance','investmentHorizonMonths','targetReturnPct','rebalanceFrequency','preferredSectors','preferredCaps','volatilityPreference','investmentGoal','maxDrawdownPct'];
    } else if (inDrawdown) {
      state = 'DRAWDOWN_HALT'; free = ['name','description','maxDrawdownPct']; warn = [];
      locked = ['riskTolerance','investmentHorizonMonths','targetReturnPct','rebalanceFrequency','preferredSectors','preferredCaps','volatilityPreference','investmentGoal'];
    } else if (isMature) {
      state = 'MATURE'; locked = ['riskTolerance'];
      free = ['name','description','rebalanceFrequency','maxDrawdownPct'];
      warn = ['targetReturnPct','investmentHorizonMonths','preferredSectors','preferredCaps','volatilityPreference','investmentGoal'];
    } else {
      state = 'ACTIVE'; locked = [];
      free = ['name','description','rebalanceFrequency','maxDrawdownPct'];
      warn = ['riskTolerance','targetReturnPct','investmentHorizonMonths','preferredSectors','preferredCaps','volatilityPreference','investmentGoal'];
    }
    free.push('capitalTopUp');
    res.json({ success: true, data: { state, editability: { free, warn, locked, capitalFloor: Math.ceil(investedValue) }, meta: { holdingsCount, tradeCount, drawdownPct: Math.round(drawdownPct * 10) / 10, drawdownLimit, strategyUpdatedAt: portfolio.strategy_updated_at ?? null } } });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Manual trade ─────────────────────────────────────────────────────────────
router.post('/portfolios/:id/trade', verifyAuth, verifyOwner, async (req: Request, res: Response) => {
  const { symbol, companyName, action, quantity, price, reason } = req.body;
  if (!symbol || !action || !quantity || !price) return res.status(400).json({ success: false, error: 'symbol, action, quantity, price required' });
  const pid = parseIntParam(req.params.id);
  if (pid === null) return res.status(400).json({ success: false, error: 'Invalid portfolio id' });
  const tradeId = await executeTrade(pid, symbol, companyName || symbol, action, quantity, price, reason || 'Manual trade');
  if (tradeId) { cache.invalidate(`portfolio_summary_${pid}`); res.json({ success: true, tradeId }); }
  else res.status(400).json({ success: false, error: 'Trade failed - check cash or holdings' });
});

// ─── Risk classification preview (no auth required — used for live UI preview) ─
router.get('/risk/classify', (req: Request, res: Response) => {
  const targetReturnPct         = req.query.targetReturnPct         ? Number(req.query.targetReturnPct)         : undefined;
  const investmentHorizonMonths = req.query.investmentHorizonMonths ? Number(req.query.investmentHorizonMonths) : undefined;
  const maxDrawdownPct          = req.query.maxDrawdownPct          ? Number(req.query.maxDrawdownPct)          : undefined;
  const volatilityPreference    = req.query.volatilityPreference    ? String(req.query.volatilityPreference)    : undefined;
  const result = deriveRiskLevel({ targetReturnPct, investmentHorizonMonths, maxDrawdownPct, volatilityPreference });
  res.json({ success: true, data: result });
});

export default router;
