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
      `SELECT dre.id           AS decisionId,
              dre.portfolio_id  AS portfolioId,
              dre.decision_type AS decision,
              dre.decision_time AS decisionTime,
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
    return res.json({ success: true, data: rows ?? [], pagination: { limit, offset, total: Number(total?.cnt ?? 0) } });
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

    // ── Transform raw stored objects into frontend-compatible shapes ──────────
    const rawModel     = parseJ(event.model_trace_json)     ?? {};
    const rawRule      = parseJ(event.rule_trace_json)      ?? {};
    const rawRisk      = parseJ(event.risk_trace_json)      ?? {};
    const rawLlm       = parseJ(event.llm_trace_json)       ?? {};
    const rawExecution = parseJ(event.execution_trace_json) ?? {};

    // modelTrace: flat object → [{component, score, weight, contribution, detail}]
    const modelTrace = Object.entries(rawModel)
      .filter(([, v]) => v != null)
      .map(([k, v]) => ({
        component:    k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
        score:        typeof v === 'number' ? v : null,
        weight:       1,
        contribution: typeof v === 'number' ? v : null,
        detail:       typeof v !== 'number' ? String(v) : null,
      }));

    // ruleTrace: eligibilityGateResults array + rejectionReasons → [{rule, passed, value, threshold}]
    const eligibilityEntries: any[] = Array.isArray(rawRule?.eligibilityGateResults)
      ? rawRule.eligibilityGateResults.map((g: any) => ({
          rule:      g.gate ?? g.rule ?? g.name ?? 'Gate',
          passed:    g.passed ?? false,
          value:     g.value    != null ? String(g.value)     : null,
          threshold: g.threshold != null ? String(g.threshold) : null,
        }))
      : [];
    const rejectionEntries: any[] = Array.isArray(rawRule?.rejectionReasons)
      ? rawRule.rejectionReasons.map((r: string) => ({ rule: r, passed: false, value: null, threshold: null }))
      : [];
    const ruleTrace = [...eligibilityEntries, ...rejectionEntries];

    // riskTrace: flat object → [{rule, passed, value, threshold}]
    const riskTrace = Object.entries(rawRisk)
      .filter(([, v]) => v != null)
      .map(([k, v]) => ({
        rule:      k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
        passed:    true,
        value:     typeof v === 'object' ? JSON.stringify(v) : String(v),
        threshold: null,
      }));

    // llmTrace: map backend field names to frontend field names
    const llmTrace = {
      geminiVerdict:      rawLlm?.verdict        ?? rawLlm?.geminiVerdict        ?? null,
      geminiConfidence:   rawLlm?.confidence     ?? rawLlm?.geminiConfidence     ?? null,
      geminiRiskLevel:    rawLlm?.riskLevel      ?? rawLlm?.geminiRiskLevel      ?? null,
      geminiRedFlags:     rawLlm?.redFlags       ?? rawLlm?.geminiRedFlags       ??
                          rawLlm?.reasonCodes    ?? [],
      groqSentimentScore: rawLlm?.groqSentimentScore ?? null,
    };

    // executionTrace: map backend fields to frontend expected fields
    const executionTrace = {
      signalScore:   rawExecution?.signalScore   ?? rawExecution?.signalPrice    ?? null,
      utilityScore:  rawExecution?.utilityScore  ?? null,
      finalDecision: rawExecution?.fillStatus    ?? rawExecution?.orderSide      ?? null,
      rejectedBy:    rawExecution?.rejectionReason ?? rawExecution?.brokerErrorCode ?? null,
      executedAt:    rawExecution?.orderFilledAt ?? rawExecution?.orderPlacedAt  ?? null,
    };

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
          featureSnapshot: parseJ(event.raw_feature_snapshot_json),
          modelTrace,
          ruleTrace,
          riskTrace,
          llmTrace,
          executionTrace,
          fullTrace:       parseJ(event.admin_trace_json),
          adminMetrics:    parseJ(adminExp?.metrics_json),
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

    const recentDecisions = rows.map((r: any) => ({
      decisionId:   r.decisionId,
      portfolioId:  r.portfolio_id,
      symbol:       r.symbol ?? 'UNKNOWN',
      decision:     r.decision_type,
      title:        r.title ?? '',
      userSummary:  r.user_summary ?? '',
      reasonCodes:  parseJ(r.user_reason_codes_json),
      decisionTime: r.decision_time,
    }));

    const totalFailed = recentDecisions.length;
    const vetoCount   = recentDecisions.filter((d: any) => d.decision === 'VETO').length;
    const skipCount   = recentDecisions.filter((d: any) => d.decision === 'SKIP').length;

    // Aggregate rejection reason counts
    const reasonCounts: Record<string, number> = {};
    for (const row of rows) {
      const codes: string[] = parseJ(row.user_reason_codes_json);
      for (const c of codes) reasonCounts[c] = (reasonCounts[c] ?? 0) + 1;
    }
    const total = Object.values(reasonCounts).reduce((s, n) => s + n, 0) || 1;
    const topReasons = Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([code, count]) => ({
        reasonCode: code,
        label:      code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        count,
        pct:        (count / total) * 100,
      }));

    return res.json({
      success: true,
      data: {
        totalFailed,
        vetoCount,
        skipCount,
        topReasons,
        recentDecisions,
      },
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
              tc.symbol, tc.strategy_type, tc.signal_score,
              tc.fundamental_score, tc.filters_blocked, tc.filters_passed
       FROM portfolio_policy_evaluations ppe
       JOIN trade_candidates tc ON tc.id = ppe.candidate_id
       WHERE ppe.portfolio_id = ?
         AND date(ppe.created_at) BETWEEN date(?) AND date(?)
       ORDER BY ppe.created_at DESC, COALESCE(ppe.utility_score, -999) DESC`,
      [portfolioId, dateFrom, dateTo],
    );
    const parseJ = (v: any) => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };
    const decisionToAction = (d: string): string => {
      if (d === 'BUY')  return 'EXECUTED';
      if (d === 'SKIP') return 'SKIPPED';
      if (d === 'VETO') return 'VETOED';
      return 'WEAK';
    };
    const candidates = evals.map((e: any) => ({
      candidateId:       e.candidate_id,
      symbol:            e.symbol,
      companyName:       null,
      sector:            null,
      strategyType:      e.strategy_type ?? null,
      signalScore:       e.signal_score ?? null,
      utilityScore:      e.utility_score ?? null,
      mlWinProbability:  null,
      fundamentalScore:  e.fundamental_score ?? null,
      actionTaken:       decisionToAction(e.decision),
      filtersBlocked:    parseJ(e.rejection_reasons_json).length > 0
                           ? parseJ(e.rejection_reasons_json)
                           : parseJ(e.filters_blocked),
      filtersPassed:     parseJ(e.filters_passed),
    }));
    return res.json({
      success: true,
      data: {
        portfolioId,
        date: dateFrom,
        totalCandidates: candidates.length,
        candidates,
      },
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

// ─── Phase 21: Portfolio Health Admin APIs ───────────────────────────────────

/** GET /api/admin/portfolio-health/overview */
router.get('/admin/portfolio-health/overview', verifyAuth, requireUserAdminAuth, async (_req: Request, res: Response) => {
  try {
    // Latest snapshot per portfolio
    const latestRows = await query(
      `SELECT phs.portfolio_id, phs.health_score, phs.health_grade, phs.top_risks_json
       FROM portfolio_health_snapshots phs
       INNER JOIN (
         SELECT portfolio_id, MAX(snapshot_time) as latest FROM portfolio_health_snapshots GROUP BY portfolio_id
       ) latest_t ON phs.portfolio_id = latest_t.portfolio_id AND phs.snapshot_time = latest_t.latest`,
    );
    const totalPortfolios = latestRows.length;
    const distribution: Record<string, number> = { EXCELLENT: 0, GOOD: 0, WARNING: 0, CRITICAL: 0 };
    let scoreSum = 0;
    const reasonCounts: Record<string, number> = {};
    const parseJ = (v: any): string[] => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };
    for (const r of latestRows) {
      const grade = String(r.health_grade);
      if (distribution[grade] !== undefined) distribution[grade]++;
      scoreSum += Number(r.health_score ?? 0);
      for (const code of parseJ(r.top_risks_json)) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
    }
    const topRiskReasons = Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a).slice(0, 10).map(([code]) => code);
    return res.json({
      success: true,
      data: {
        totalPortfolios,
        healthDistribution: distribution,
        averageHealthScore: totalPortfolios > 0 ? Math.round(scoreSum / totalPortfolios) : 0,
        topRiskReasons,
      },
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/** GET /api/admin/portfolio-health/at-risk */
router.get('/admin/portfolio-health/at-risk', verifyAuth, requireUserAdminAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT phs.portfolio_id, p.name, phs.health_score, phs.health_grade,
              phs.goal_probability_pct, phs.top_risks_json, phs.snapshot_time
       FROM portfolio_health_snapshots phs
       INNER JOIN (
         SELECT portfolio_id, MAX(snapshot_time) as latest FROM portfolio_health_snapshots GROUP BY portfolio_id
       ) latest_t ON phs.portfolio_id = latest_t.portfolio_id AND phs.snapshot_time = latest_t.latest
       JOIN portfolios p ON p.id = phs.portfolio_id
       WHERE phs.health_score < 50
          OR phs.goal_probability_pct < 30
          OR phs.top_risks_json LIKE '%KILL_SWITCH_ACTIVE%'
          OR phs.top_risks_json LIKE '%CIRCUIT_BREAKER_ACTIVE%'
       ORDER BY phs.health_score ASC`,
    );
    const parseJ = (v: any): string[] => { try { return v ? JSON.parse(String(v)) : []; } catch { return []; } };
    return res.json({
      success: true,
      data: rows.map((r: any) => ({
        portfolioId:       Number(r.portfolio_id),
        name:              r.name,
        healthScore:       Number(r.health_score),
        healthGrade:       r.health_grade,
        goalProbabilityPct: r.goal_probability_pct != null ? Number(r.goal_probability_pct) : null,
        topRisks:          parseJ(r.top_risks_json),
        lastUpdated:       r.snapshot_time,
      })),
    });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/** GET /api/admin/portfolio-health/config */
router.get('/admin/portfolio-health/config', verifyAuth, requireUserAdminAuth, async (_req: Request, res: Response) => {
  try {
    const configs = await query('SELECT * FROM health_score_configs ORDER BY created_at DESC');
    return res.json({ success: true, data: configs });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/** POST /api/admin/portfolio-health/config */
router.post('/admin/portfolio-health/config', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const { weights_json, thresholds_json, goal_probability_assumptions_json } = req.body as {
      weights_json?: string; thresholds_json?: string; goal_probability_assumptions_json?: string;
    };
    if (!weights_json) return res.status(400).json({ success: false, error: 'weights_json required' });
    // Validate weights sum to 1.0
    const weights = JSON.parse(weights_json) as Record<string, number>;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.001)
      return res.status(400).json({ success: false, error: `Weights must sum to 1.0, got ${sum.toFixed(4)}` });
    const newVersion = `health-v${Date.now()}`;
    // Deactivate all existing configs
    await run('UPDATE health_score_configs SET is_active = 0');
    // Insert new active config
    const result = await run(
      `INSERT INTO health_score_configs (config_version, is_active, weights_json, thresholds_json, goal_probability_assumptions_json, created_by)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [newVersion, weights_json, thresholds_json ?? '{}', goal_probability_assumptions_json ?? '{}', (req.user as any)?.id ?? null],
    );
    const newConfig = await queryOne('SELECT * FROM health_score_configs WHERE id = ?', [result.lastInsertRowid]);
    return res.json({ success: true, data: newConfig });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/** POST /api/admin/portfolio-health/recalculate */
router.post('/admin/portfolio-health/recalculate', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const { portfolioId } = req.body as { portfolioId?: number };
    if (!portfolioId) return res.status(400).json({ success: false, error: 'portfolioId required' });
    const { calculatePortfolioHealth } = await import('../../services/portfolioHealthService.js');
    const snapshot = await calculatePortfolioHealth(Number(portfolioId));
    return res.json({ success: true, data: snapshot });
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

/** POST /api/admin/portfolio-health/recalculate-all (super-admin: all portfolios) */
router.post('/admin/portfolio-health/recalculate-all', verifyAuth, requireUserAdminAuth, async (_req: Request, res: Response) => {
  try {
    const portfolios = await query('SELECT id FROM portfolios WHERE is_active = 1');
    const n = portfolios.length;
    // Async — returns 202 immediately
    res.status(202).json({ success: true, message: `Recalculation started for ${n} portfolio${n !== 1 ? 's' : ''}` });
    const { runAllPortfoliosHealthJob } = await import('../../scheduler/portfolioHealthJob.js');
    runAllPortfoliosHealthJob().catch(console.error);
  } catch (err) { return res.status(500).json({ success: false, error: String(err) }); }
});

// ── Phase 22: Admin Virtual Reconciliation APIs ───────────────────────

import { getAdminVirtualExecutionQuality } from '../../services/virtualExecutionQualityService.js';
import { runVirtualReconciliationForPortfolio } from '../../scheduler/virtualReconciliationJob.js';
import { logger } from '../../lib/logger.js';

/**
 * GET /api/admin/virtual-reconciliation/overview
 * System-wide reconciliation status summary.
 */
router.get('/admin/virtual-reconciliation/overview', verifyAuth, requireUserAdminAuth, async (_req: Request, res: Response) => {
  try {
    // Latest reconciliation status per portfolio (one row each)
    const statusRows = await query(
      `SELECT reconciliation_status, new_buys_blocked FROM virtual_safety_states`,
      [],
    );

    const total    = statusRows.length;
    const healthy  = statusRows.filter((r: any) => r.reconciliation_status === 'HEALTHY').length;
    const warning  = statusRows.filter((r: any) => r.reconciliation_status === 'WARNING').length;
    const mismatch = statusRows.filter((r: any) => r.reconciliation_status === 'MISMATCH').length;
    const failed   = statusRows.filter((r: any) => r.reconciliation_status === 'FAILED').length;
    const blocked  = statusRows.filter((r: any) => Number(r.new_buys_blocked) === 1).length;

    // Top mismatch types from open CRITICAL mismatches
    const mismatchTypes = await query(
      `SELECT mismatch_type, COUNT(*) AS cnt
       FROM virtual_reconciliation_mismatches
       WHERE status = 'OPEN' AND severity = 'CRITICAL'
       GROUP BY mismatch_type ORDER BY cnt DESC LIMIT 5`,
      [],
    );

    return res.json({
      totalPortfolios: total,
      healthy, warning, mismatch, failed,
      newBuysBlocked: blocked,
      topMismatchTypes: mismatchTypes.map((r: any) => r.mismatch_type),
    });
  } catch (err) { return res.status(500).json({ error: String(err) }); }
});

/**
 * GET /api/admin/virtual-reconciliation/mismatches?status=OPEN&severity=CRITICAL
 */
router.get('/admin/virtual-reconciliation/mismatches', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const status   = req.query.status   ? String(req.query.status)   : null;
    const severity = req.query.severity ? String(req.query.severity) : null;
    const limit    = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);

    let sql = `SELECT id, reconciliation_run_id, portfolio_id, mismatch_type, severity,
                      symbol, expected_value, actual_value, difference_value,
                      blocks_new_buys, allows_only_risk_reducing_sells, status, reason, created_at
               FROM virtual_reconciliation_mismatches WHERE 1=1`;
    const args: any[] = [];

    if (status)   { sql += ` AND status = ?`;   args.push(status); }
    if (severity) { sql += ` AND severity = ?`; args.push(severity); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(limit);

    const rows = await query(sql, args);
    return res.json(rows.map((r: any) => ({
      id:                            Number(r.id),
      portfolioId:                   Number(r.portfolio_id),
      mismatchType:                  r.mismatch_type,
      severity:                      r.severity,
      symbol:                        r.symbol,
      expectedValue:                 r.expected_value,
      actualValue:                   r.actual_value,
      differenceValue:               r.difference_value,
      blocksNewBuys:                 Number(r.blocks_new_buys) === 1,
      allowsOnlyRiskReducingSells:   Number(r.allows_only_risk_reducing_sells) === 1,
      status:                        r.status,
      reason:                        r.reason,
      createdAt:                     r.created_at,
    })));
  } catch (err) { return res.status(500).json({ error: String(err) }); }
});

/**
 * POST /api/admin/virtual-reconciliation/mismatches/:id/resolve
 */
router.post('/admin/virtual-reconciliation/mismatches/:id/resolve', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const id         = parseInt(req.params.id, 10);
    const resolution = String(req.body?.resolution ?? 'MANUALLY_RESOLVED');
    const notes      = req.body?.notes ? String(req.body.notes) : null;

    await run(
      `UPDATE virtual_reconciliation_mismatches
       SET status = ?, reason = ?, resolved_at = ?
       WHERE id = ?`,
      [resolution, notes, new Date().toISOString(), id],
    );

    // Check if all CRITICAL mismatches for this portfolio are now resolved
    const mismatch = await queryOne(
      'SELECT portfolio_id FROM virtual_reconciliation_mismatches WHERE id = ?', [id],
    );
    if (mismatch?.portfolio_id) {
      const openCriticals = await query(
        `SELECT id FROM virtual_reconciliation_mismatches
         WHERE portfolio_id = ? AND severity = 'CRITICAL' AND status = 'OPEN'`,
        [mismatch.portfolio_id],
      );
      if (openCriticals.length === 0) {
        // Auto-clear safety halt when all criticals resolved
        const { clearVirtualSafetyHalt } = await import('../../services/virtualSafetyService.js');
        await clearVirtualSafetyHalt(Number(mismatch.portfolio_id)).catch(err =>
          logger.error({ service: 'admin-reconciliation', portfolioId: mismatch.portfolio_id, err: String(err), msg: 'Failed to clear virtual safety halt after mismatch resolution' })
        );
      }
    }

    return res.json({ success: true, message: 'Mismatch resolved' });
  } catch (err) { return res.status(500).json({ error: String(err) }); }
});

/**
 * POST /api/admin/virtual-reconciliation/:portfolioId/retry
 */
router.post('/admin/virtual-reconciliation/:portfolioId/retry', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId, 10);
    if (isNaN(portfolioId)) return res.status(400).json({ error: 'Invalid portfolio ID' });

    const result = await runVirtualReconciliationForPortfolio(portfolioId);
    return res.json({
      success: true,
      status:        result.status,
      mismatchCount: result.mismatchCount,
      criticalCount: result.criticalMismatchCount,
      runId:         result.runId,
    });
  } catch (err) { return res.status(500).json({ error: String(err) }); }
});

/**
 * GET /api/admin/virtual-execution-quality?range=7D|30D|90D
 */
router.get('/admin/virtual-execution-quality', verifyAuth, requireUserAdminAuth, async (req: Request, res: Response) => {
  try {
    const range   = String(req.query.range ?? '30D');
    const quality = await getAdminVirtualExecutionQuality(range);
    return res.json(quality);
  } catch (err) { return res.status(500).json({ error: String(err) }); }
});

export default router;
