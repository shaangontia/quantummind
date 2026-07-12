/**
 * admin.routes.ts — health checks, admin controls, cron triggers, backtest
 */
import { Router, Request, Response } from 'express';
import { query, queryOne, run } from '../../db/turso.js';
import { requireAdminAuth, requireUserAdminAuth } from './helpers.js';
import { verifyAuth } from '../../middleware/auth.js';

const router = Router();

// ─── Health checks ────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'OK', service: 'QuantumMind', ts: new Date().toISOString() });
});
router.get('/health/db', async (_req: Request, res: Response) => {
  try { await query('SELECT 1'); res.json({ status: 'OK', db: 'turso' }); }
  catch (err) { res.status(503).json({ status: 'DOWN', db: 'turso', error: String(err) }); }
});
router.get('/health/market-data', async (_req: Request, res: Response) => {
  const start = Date.now();
  try {
    const { getExecutableQuote } = await import('../../services/marketData.js');
    const q = await getExecutableQuote('RELIANCE.NS');
    res.json({ status: q.isFresh ? 'OK' : 'DEGRADED', provider: q.provider, price: q.price, isFresh: q.isFresh, latencyMs: Date.now() - start });
  } catch (err) { res.status(503).json({ status: 'DOWN', latencyMs: Date.now() - start, error: String(err) }); }
});
router.get('/health/cron', async (_req: Request, res: Response) => {
  try {
    const row = await queryOne("SELECT * FROM cron_lock WHERE key='market-cycle'");
    res.json({ status: 'OK', lastCycleLockedUntil: row ? row.locked_until : null });
  } catch { res.json({ status: 'OK', lastCycleLockedUntil: null }); }
});

// ─── Admin: kill switch ───────────────────────────────────────────────────────
router.post('/admin/trading-enabled', requireAdminAuth, async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  await run("UPDATE trading_config SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='global_trading_enabled'", [String(enabled)]);
  res.json({ success: true, global_trading_enabled: enabled });
});

// ─── Admin: backtest ──────────────────────────────────────────────────────────
router.post('/admin/backtest/run', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, message: 'Backtest bootstrap started asynchronously.' });
    const { symbols } = req.body as { symbols?: string[] };
    setImmediate(() => {
      (async () => {
        const { bootstrapSignalWeights } = await import('../../services/backtestWeights.js');
        const result = await bootstrapSignalWeights(symbols);
        console.log('[Admin] Backtest bootstrap complete:', JSON.stringify(result, null, 2));
      })().catch(e => console.error('[Admin] Backtest bootstrap FAILED:', String(e)));
    });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.get('/admin/backtest/weights', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const weights     = await query('SELECT * FROM signal_weights ORDER BY source');
    const priceRows   = await query('SELECT COUNT(*) as cnt FROM backtesting_prices').catch(() => [{ cnt: 0 }]);
    res.json({ success: true, weights, backtestingPricesRows: priceRows[0]?.cnt ?? 0 });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Cron triggers ────────────────────────────────────────────────────────────
router.post('/cron/market-cycle', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const { runMarketCycle } = await import('../../scheduler/marketMonitor.js');
    await runMarketCycle();
    res.json({ success: true, ran: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});
router.post('/cron/price-update', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const { getMultipleQuotes } = await import('../../services/marketData.js');
    const holdings = await query('SELECT DISTINCT symbol FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.is_active = 1');
    if (!holdings.length) return res.json({ success: true, updated: 0 });
    const quotes = await getMultipleQuotes(holdings.map((h: any) => h.symbol as string));
    let updated = 0;
    for (const q of quotes) {
      await run('UPDATE holdings SET current_price = ?, last_price_updated = CURRENT_TIMESTAMP WHERE symbol = ?', [q.price, q.symbol]);
      updated++;
    }
    res.json({ success: true, updated, ts: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

// ─── Phase 20: Decision Replay — Admin endpoints ─────────────────────────────────

/**
 * GET /api/admin/decisions
 * Cross-portfolio decision list. Admin sees all portfolios.
 * Query params: portfolioId?, symbol?, decision_type?, dateFrom?, dateTo?, limit, offset
 */
router.get('/admin/decisions', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit  as string ?? '50', 10) || 50, 200);
    const offset    = parseInt(req.query.offset as string ?? '0', 10) || 0;
    const conditions: string[] = [];
    const args: any[] = [];
    if (req.query.portfolioId) { conditions.push('dre.portfolio_id = ?'); args.push(Number(req.query.portfolioId)); }
    if (req.query.decision_type) { conditions.push('dre.decision_type = ?'); args.push(String(req.query.decision_type).toUpperCase()); }
    if (req.query.dateFrom) { conditions.push('dre.decision_time >= ?'); args.push(String(req.query.dateFrom)); }
    if (req.query.dateTo)   { conditions.push('dre.decision_time <= ?'); args.push(String(req.query.dateTo)); }
    if (req.query.symbol) {
      conditions.push('tc.symbol = ?');
      args.push(String(req.query.symbol).toUpperCase());
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await query(
      `SELECT dre.id as decisionId, dre.portfolio_id, dre.decision_type as decision,
              dre.decision_time, dre.explanation_version, dre.model_version, dre.policy_version,
              dre.user_summary, dre.user_reason_codes_json,
              de.title,
              tc.symbol
       FROM decision_replay_events dre
       LEFT JOIN decision_explanations de ON de.decision_replay_event_id = dre.id AND de.visibility = 'USER'
       LEFT JOIN trade_candidates tc ON tc.id = dre.candidate_id
       ${where}
       ORDER BY dre.decision_time DESC
       LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    const total = await queryOne(
      `SELECT COUNT(*) as cnt FROM decision_replay_events dre
       LEFT JOIN trade_candidates tc ON tc.id = dre.candidate_id ${where}`,
      args,
    );
    return res.json({ success: true, data: rows, pagination: { limit, offset, total: Number(total?.cnt ?? 0) } });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/**
 * GET /api/admin/decisions/:decisionId/replay
 * Full trace replay for a specific decision. Returns BOTH user + admin visibility rows.
 */
router.get('/admin/decisions/:decisionId/replay', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const decisionId = parseInt(req.params.decisionId, 10);
    if (isNaN(decisionId)) return res.status(400).json({ success: false, error: 'Invalid decisionId' });

    const event = await queryOne(
      `SELECT dre.*, tc.symbol
       FROM decision_replay_events dre
       LEFT JOIN trade_candidates tc ON tc.id = dre.candidate_id
       WHERE dre.id = ?`,
      [decisionId],
    );
    if (!event) return res.status(404).json({ success: false, error: 'Decision not found' });

    // Fetch both USER and ADMIN explanation rows
    const explanations = await query(
      'SELECT visibility, title, summary, reason_codes_json, metrics_json FROM decision_explanations WHERE decision_replay_event_id = ?',
      [decisionId],
    );
    const userExp  = explanations.find((e: any) => e.visibility === 'USER');
    const adminExp = explanations.find((e: any) => e.visibility === 'ADMIN');

    const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } };

    return res.json({
      success: true,
      data: {
        decisionId,
        candidateId:  event.candidate_id,
        portfolioId:  event.portfolio_id,
        symbol:       event.symbol ?? 'UNKNOWN',
        decision:     event.decision_type,
        userExplanation: {
          title:       userExp?.title ?? '',
          summary:     userExp?.summary ?? '',
          reasonCodes: parseJ(userExp?.reason_codes_json) ?? [],
          metrics:     parseJ(userExp?.metrics_json),
        },
        adminTrace: {
          featureSnapshot:  parseJ(event.raw_feature_snapshot_json),
          modelTrace:       parseJ(event.model_trace_json),
          ruleTrace:        parseJ(event.rule_trace_json),
          riskTrace:        parseJ(event.risk_trace_json),
          llmTrace:         parseJ(event.llm_trace_json),
          executionTrace:   parseJ(event.execution_trace_json),
          fullTrace:        parseJ(event.admin_trace_json),
          adminMetrics:     parseJ(adminExp?.metrics_json),
        },
        versions: {
          explanationVersion:          event.explanation_version,
          modelVersion:                event.model_version,
          policyVersion:               event.policy_version,
          strategyClassifierVersion:   event.strategy_classifier_version,
        },
        idempotencyKey: event.idempotency_key,
        createdAt:      event.created_at,
      },
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/**
 * GET /api/admin/decisions/failed
 * All VETO + SKIP decisions with rejection reason breakdown.
 */
router.get('/admin/decisions/failed', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  as string ?? '100', 10) || 100, 500);
    const offset = parseInt(req.query.offset as string ?? '0', 10) || 0;
    const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : null;

    const conditions = [`dre.decision_type IN ('VETO','SKIP')`];
    const args: any[] = [];
    if (portfolioId) { conditions.push('dre.portfolio_id = ?'); args.push(portfolioId); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = await query(
      `SELECT dre.id as decisionId, dre.portfolio_id, dre.decision_type, dre.decision_time,
              dre.user_reason_codes_json, dre.user_summary,
              de.title,
              tc.symbol
       FROM decision_replay_events dre
       LEFT JOIN decision_explanations de ON de.decision_replay_event_id = dre.id AND de.visibility = 'USER'
       LEFT JOIN trade_candidates tc ON tc.id = dre.candidate_id
       ${where}
       ORDER BY dre.decision_time DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };

    // Aggregate rejection reason counts
    const reasonCounts: Record<string, number> = {};
    for (const row of rows) {
      const codes: string[] = parseJ(row.user_reason_codes_json);
      for (const c of codes) reasonCounts[c] = (reasonCounts[c] ?? 0) + 1;
    }
    const topReasons = Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([code, count]) => ({ code, count }));

    return res.json({
      success: true,
      data: rows.map((r: any) => ({
        decisionId:    r.decisionId,
        portfolioId:   r.portfolio_id,
        symbol:        r.symbol ?? 'UNKNOWN',
        decision:      r.decision_type,
        title:         r.title ?? '',
        userSummary:   r.user_summary ?? '',
        reasonCodes:   parseJ(r.user_reason_codes_json),
        decisionTime:  r.decision_time,
      })),
      topReasons,
      pagination: { limit, offset },
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/**
 * GET /api/admin/candidates/:portfolioId/trace
 * Full candidate universe trace for a portfolio+date range.
 * Shows all candidates evaluated in a cycle: eligibility, utility, rank, final decision.
 */
router.get('/admin/candidates/:portfolioId/trace', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId, 10);
    if (isNaN(portfolioId)) return res.status(400).json({ success: false, error: 'Invalid portfolioId' });
    const dateFrom = (req.query.dateFrom as string) ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const dateTo   = (req.query.dateTo as string)   ?? new Date().toISOString().slice(0, 10);

    const evals = await query(
      `SELECT ppe.id, ppe.candidate_id, ppe.decision, ppe.eligible,
              ppe.utility_score, ppe.portfolio_rank, ppe.rejection_reasons_json,
              ppe.strategy_fit_multiplier, ppe.horizon_fit_multiplier, ppe.regime_fit_multiplier,
              ppe.selection_reason, ppe.created_at,
              tc.symbol, tc.strategy_type, tc.signal_score
       FROM portfolio_policy_evaluations ppe
       JOIN trade_candidates tc ON tc.id = ppe.candidate_id
       WHERE ppe.portfolio_id = ?
         AND date(ppe.created_at) BETWEEN date(?) AND date(?)
       ORDER BY ppe.created_at DESC, COALESCE(ppe.utility_score, -999) DESC`,
      [portfolioId, dateFrom, dateTo],
    );
    const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };
    return res.json({
      success: true,
      data: evals.map((e: any) => ({
        evaluationId:      e.id,
        candidateId:       e.candidate_id,
        symbol:            e.symbol,
        decision:          e.decision,
        eligible:          Boolean(e.eligible),
        utilityScore:      e.utility_score,
        rank:              e.portfolio_rank,
        rejectionReasons:  parseJ(e.rejection_reasons_json),
        selectionReason:   e.selection_reason,
        strategyType:      e.strategy_type,
        multipliers: {
          strategyFit: e.strategy_fit_multiplier,
          horizonFit:  e.horizon_fit_multiplier,
          regimeFit:   e.regime_fit_multiplier,
        },
        evaluatedAt: e.created_at,
      })),
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/**
 * POST /api/admin/decisions/:decisionId/replay/simulate
 * Dry-run: re-evaluates the original candidate feature snapshot under a
 * different policy/model version. NEVER executes actual trades.
 * dryRun is ALWAYS enforced server-side regardless of payload.
 */
router.post('/admin/decisions/:decisionId/replay/simulate', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const decisionId = parseInt(req.params.decisionId, 10);
    if (isNaN(decisionId)) return res.status(400).json({ success: false, error: 'Invalid decisionId' });

    const { policyVersion, modelVersion } = req.body as { policyVersion?: string; modelVersion?: string };
    // dryRun is ALWAYS true server-side — payload value is ignored for safety
    const dryRun = true;

    const event = await queryOne(
      `SELECT dre.*, tc.symbol,
              ppe.policy_type, ppe.risk_level, ppe.horizon_days,
              ppe.policy_snapshot_json,
              ppe.rejection_reasons_json as original_rejections,
              ppe.utility_score as original_utility, ppe.decision as original_decision
       FROM decision_replay_events dre
       LEFT JOIN trade_candidates tc ON tc.id = dre.candidate_id
       LEFT JOIN portfolio_policy_evaluations ppe ON ppe.id = dre.policy_evaluation_id
       WHERE dre.id = ?`,
      [decisionId],
    );
    if (!event) return res.status(404).json({ success: false, error: 'Decision not found' });

    const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } };
    const featureSnapshot = parseJ(event.raw_feature_snapshot_json);
    const ruleTrace       = parseJ(event.rule_trace_json);

    if (!featureSnapshot) {
      return res.status(422).json({
        success: false,
        error: 'Feature snapshot not available for this decision — simulation not possible',
      });
    }

    const { checkEligibility }        = await import('../../services/portfolioEligibilityFilter.js');
    const { computePortfolioUtility } = await import('../../services/portfolioUtilityScore.js');
    const { getPortfolioPolicy }      = await import('../../services/portfolioPolicy.js');

    // Fix 1 + Suggestion 3: Prefer the frozen policy_snapshot_json stored at decision time.
    // This ensures simulation re-runs against the rules that were ACTUALLY in effect —
    // not the current portfolio settings which may have changed since.
    // If policyVersion is supplied and differs from the stored snapshot version, warn the caller.
    const frozenPolicy: any = parseJ(event.policy_snapshot_json);
    const portfolioId = Number(event.portfolio_id);
    const livePolicy = frozenPolicy
      ? null                                                      // prefer frozen
      : await getPortfolioPolicy(portfolioId).catch(() => null);  // fallback for SELL (no PPE row)
    const policy: any = frozenPolicy ?? livePolicy;
    if (!policy) return res.status(422).json({ success: false, error: 'Policy not resolvable for this decision' });

    const storedPolicyVersion = String(event.policy_version ?? frozenPolicy?.policyVersion ?? 'unknown');
    const storedModelVersion  = String(event.model_version ?? 'unknown');

    // Warn when requested version differs from what was frozen (version-specific re-evaluation
    // is a Phase 22 capability; for now we simulate against the frozen snapshot only).
    const warnings: string[] = [];
    if (policyVersion && policyVersion !== storedPolicyVersion) {
      warnings.push(`Requested policyVersion "${policyVersion}" not available — simulating against frozen snapshot version "${storedPolicyVersion}" instead`);
    }
    if (modelVersion && modelVersion !== storedModelVersion) {
      warnings.push(`Requested modelVersion "${modelVersion}" not available — ML P(win) from original feature snapshot used`);
    }

    // Fix 2: Simulate with ZEROED exposure context (sector map, drawdown are unknown at replay time).
    // This is a fundamental limitation of decision replay — the portfolio state at that exact
    // moment is not stored. Sector-concentration and drawdown gates will not reproduce correctly.
    const simulationLimitations = [
      'sector_exposure_not_replayed: Gate 6 (sector cap) uses empty sector map — SECTOR_OVEREXPOSED veto may not reproduce',
      'drawdown_context_empty: Gate 9 (drawdown penalty) uses 0% drawdown — DRAWDOWN_PENALTY may differ',
      'portfolio_state_snapshot_absent: position count and cash % are set to neutral defaults',
    ];

    const emptyExposure = { sectorPct: {}, currentPositionCount: 0, cashPct: 1, drawdownPct: 0 };

    const eligInput = {
      symbol:           event.symbol ?? '',
      strategyType:     featureSnapshot.strategyType ?? 'UNKNOWN',
      fundamentalScore: featureSnapshot.fundamentalScore ?? null,
      atrPct:           featureSnapshot.atrPct ?? null,
      beta:             null,
      liquidityScore:   null,
      sector:           featureSnapshot.sector ?? null,
      eps:              null,
      mlPwin:           featureSnapshot.mlPwin ?? null,
      evPct:            null,
      marketRegime:     featureSnapshot.marketRegime ?? 'UNKNOWN',
    };
    const simulatedElig = checkEligibility(eligInput as any, policy, emptyExposure, 'ADVISORY');

    let simulatedUtility = null;
    if (simulatedElig.eligible) {
      const utilInput = {
        symbol:              event.symbol ?? '',
        strategyType:        featureSnapshot.strategyType ?? 'UNKNOWN',
        evPct:               (featureSnapshot.mlPwin ?? 0.52) * 100,
        mlPwin:              featureSnapshot.mlPwin ?? null,
        atrPct:              featureSnapshot.atrPct ?? 2.0,
        liquidityScore:      0.5,
        sector:              featureSnapshot.sector ?? null,
        expectedHoldingDays: 15,
        marketRegime:        featureSnapshot.marketRegime ?? 'UNKNOWN',
      };
      simulatedUtility = computePortfolioUtility(utilInput as any, policy, emptyExposure);
    }

    const originalUtility = ruleTrace?.utilityComponents?.finalScore ?? event.original_utility ?? null;
    const usedFrozenPolicy = frozenPolicy != null;

    return res.json({
      success: true,
      dryRun,
      data: {
        decisionId,
        symbol: event.symbol ?? 'UNKNOWN',
        originalDecision: {
          decision:         event.decision_type,
          eligible:         !(parseJ(event.original_rejections)?.length > 0),
          utilityScore:     originalUtility,
          rejectionReasons: parseJ(event.original_rejections) ?? [],
          policyVersion:    storedPolicyVersion,
          modelVersion:     storedModelVersion,
        },
        simulatedDecision: {
          // Policy used: frozen snapshot when available (correct), live policy as fallback
          policySource:     usedFrozenPolicy ? 'FROZEN_SNAPSHOT' : 'LIVE_POLICY',
          policyVersion:    storedPolicyVersion,
          requestedPolicyVersion: policyVersion ?? null,
          requestedModelVersion:  modelVersion ?? null,
          eligible:         simulatedElig.eligible,
          rejectionReasons: simulatedElig.rejectionReasons,
          utilityScore:     simulatedUtility?.finalScore ?? null,
          decision:         simulatedElig.eligible
            ? (simulatedUtility && simulatedUtility.finalScore >= 0 ? 'BUY' : 'SKIP')
            : 'VETO',
        },
        utilityDiff: simulatedUtility != null && originalUtility != null
          ? simulatedUtility.finalScore - Number(originalUtility) : null,
        warnings,
        simulationLimitations,
        note: 'Dry-run simulation. No trades executed or recorded.',
      },
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

export default router;
