# QuantumMind Roadmap & TODOs

Living document — update this whenever a task is started, finished, or
re-prioritized. Check items off in place rather than deleting them, so we
keep a record of what was actually decided and when.

Last updated: 2026-07-28

---

## Track 1 — ML self-learning

- [x] **Chronological holdout + AUC/Brier metrics** for the win-probability model (`mlProbabilityModel.ts`) — done 2026-07-22 (a3744fa)
- [x] **Interaction features** in `mlProbabilityModel.ts` (RSI×regime, volume×strategy, fundamentals×regime) — done 2026-07-28 (d307d18). Model bumped to `buy_win_probability_v2`.
- [x] **Bayesian shrinkage for signal weights** in `adaptiveEngine.ts` (replaced the two-stage hand-tuned clamp+confidence-cutoff formula) — done 2026-07-28 (d307d18)
- [x] **Per-source vote logging** (`signal_vote_log` table + `recordSignalVotes`/`resolveSignalVoteOutcomes` in `adaptiveEngine.ts`, wired into `tradingEngine.ts` generateSignal()/executeTrade() and the nightly job) — done 2026-07-28. **Data collection only — not usable yet.**
- [x] **Joint cross-source regression** — built 2026-07-28: `jointVoteModel.ts` (mirrors `mlProbabilityModel.ts`'s training loop — mini-batch GD, L2, chronological holdout — over the 5 signed votes + fundamental score, persisted under `model_name='signal_vote_joint_v1'` in the existing `ml_model_weights` table). Wired into the nightly job (trains right after `resolveSignalVoteOutcomes()`, before `resolveSignalOutcomes()`'s `recalibrateWeights()` call) and into `recalibrateWeights()` itself (prefers the joint model's per-source weight when available, falls back to the univariate Bayesian estimate otherwise). **Still dormant** — `trainJointVoteModel()` no-ops below `MIN_TRAIN_SAMPLES=250` resolved rows, which will be true for a long time from a fresh deploy. Check row count with:
  `SELECT COUNT(*) FROM signal_vote_log WHERE resolved = 1`
  The `1.0 + coefficient × 0.5` mapping from learned coefficient to the [0.3, 2.0] weight scale (`jointVoteModel.ts` `getJointSourceWeights()`) is a starting-point heuristic, not derived from anything — revisit once real coefficients exist to see what range they land in.
- [x] **Expected-value regression** — built 2026-07-28: `evMagnitudeModel.ts` (two small linear regressions — win magnitude, loss magnitude — same GD/L2/chronological-holdout shape, MSE loss instead of log-loss, features = RSI/regime/fundamentals/momentum). Trained across ALL symbols' resolved BUY trades in `signal_patterns`, not just one symbol's, so it generalizes for symbols with thin individual history. `computeExpectedValue()` (`patternEngine.ts`) now accepts an optional `magnitudeContext` param and uses the regression's predicted win/loss magnitude in place of the per-symbol trailing average whenever both models are trained on enough data; `pWin` is untouched (still this symbol's own win/loss frequency — that's a separate, already-solved problem via `mlProbabilityModel.ts`). Wired into `tradingEngine.ts`'s one call site and the nightly job (`trainMagnitudeModels()`). **Note:** `vote_score` was deliberately excluded from the feature set — the only writer of that column always persists 0, so it carries no signal. **Still dormant** — needs ≥40 resolved rows per outcome class (WIN and LOSS separately) in `signal_patterns` before either model activates; falls back to the existing trailing-average behavior until then.
- [x] **Embedding-based news similarity** — built 2026-07-28: `newsEmbeddingModel.ts` reuses `ragService.ts`'s exact Gemini-embedding + `vector_top_k`/`libsql_vector_idx` pattern (new `announcement_embeddings` table, not the same rows as `tars_memory`). `fetchAnnouncements()` now fire-and-forget records every announcement's embedding (deduped by symbol+date+headline so repeat 5-min-cycle fetches don't re-embed); nightly `resolveAnnouncementOutcomes()` marks each row BULLISH_MOVE/BEARISH_MOVE/FLAT from the actual subsequent price move (not the keyword guess); `getEmbeddingSimilarSentiment()` finds the 12 nearest resolved neighbors and turns "9 of 12 similar announcements led to a bullish move" into a score on the same -2..+2 scale. `getStockSentiment()` blends this 50/50 with the existing keyword score whenever ≥5 resolved neighbors exist. **Still dormant** — falls back to pure keyword scoring until enough announcements have been recorded AND resolved (5-day horizon after first deployment, same as the other resolvers this session).
- [x] **UCB1 bandit** over the buy-candidate pool — built 2026-07-28: `watchlistBandit.ts` (`getBanditPrioritizedCandidates()`). Reorders the non-held candidate pool (~50 symbols/cycle) toward under-explored symbols/sectors (blends symbol-level + sector-level executed-trade "pulls" 50/50, so a brand-new sector gets a strong exploration bonus) before picking the top 8, replacing a plain `.slice(0, 8)` off rotation order. Wired into `marketMonitor.ts`'s buy-scan candidate selection. **Unlike the other 4 items above, this is LIVE immediately, not dormant** — it reads existing `signal_patterns` history (however little exists) on every cycle, it doesn't wait for a data threshold. `EXPLORATION_CONSTANT=1.0` (standard UCB1 default) is unturned against this system's actual data — worth revisiting once there's a few weeks of behavior to look at.

## Track 2 — Infra / reliability

- [x] **Parallelize market-cycle** (portfolios loop + per-symbol signal generation) — fixed the cron timing out at cron-job.org's 30s budget — done 2026-07-28 (75bd161)
- [x] ~~Verify market-cycle no longer times out~~ — checked 2026-07-28: **still timing out on all 30 recent runs**. Unbounded `Promise.all` likely traded sequential-slow for rate-limit-throttled-slow. Fixed by capping concurrency to 5 via new `lib/concurrency.ts` (`mapWithConcurrency`) — done 2026-07-28 (2cabf44)
- [ ] **Re-verify market-cycle timing after the concurrency-cap fix** — check cron-job.org execution history again over the next several trading days. If still timing out, the next lever is lowering `SYMBOL_CONCURRENCY`/`PORTFOLIO_CONCURRENCY` further (e.g. 3) or profiling which specific provider call (Twelve Data vs Gemini vs Groq) is the actual bottleneck rather than guessing
- [ ] **Paid, SLA-backed market data feed** — Twelve Data free tier + NSE scraping is fine for paper trading, not for real capital
- [ ] **DR / backup story** — single Turso DB, no documented backup/restore runbook
- [ ] **Multi-tenancy scaling** — current cron/schema design assumes a handful of portfolios; onboarding many users needs per-user broker credentials (encrypted), per-user risk limits, horizontal scaling validation beyond the concurrency fix above

## Track 3 — Path to a real money-earning business

See full discussion in chat (2026-07-28) for the complete reasoning; summary below.

- [x] **Performance/audit dashboard** — `GET /admin/audit-dashboard` (backend) + `/admin/audit-dashboard` page (frontend, "Audit" nav link) — done 2026-07-28. Surfaces per-portfolio model governance/stage/promotion-gaps, `ml_model_weights` training history (holdout AUC/Brier/accuracy only, never in-sample), `model_calibration_buckets` reliability table, a realized-P&L timeline from actual SELL trades, and a decision-type breakdown from `decision_replay_events`. Deliberately a pure read-only surface over existing data — no new metrics invented. **Caveat:** stage *history* isn't really historical yet — `cold_start_state` only stores the latest evaluation (upsert, not append), so the dashboard shows current stage + trajectory-implying trends (training runs, calibration over time), not actual stage-transition dates. A `model_governance_history` append-only table would be needed for true stage-history — not yet built, add if this matters later.
- [ ] **Legal groundwork** — ToS, SEBI-mandated risk disclosure language, privacy policy (DPDP Act applies once any other user's data is stored), liability limitation. None of this exists in the repo yet.
- [ ] **Signal-only product** (lowest regulatory bar: SEBI Research Analyst registration) — sell BUY/SELL calls + model confidence as a subscription/API, no execution, no custody. Monetizable with zero broker-integration work once the audit dashboard exists.
- [ ] **Broker API integration** — needs an adapter layer; `executeTrade()` currently writes only to the internal virtual ledger. Real integration = Kite Connect / Upstox API / Angel SmartAPI, real order placement + fill polling + reconciliation against broker statements. **Do this only after the signal product and track record are live** — building it first without a track record won't convert users.
- [ ] **SEBI algo-empanelment path** ("bring your own broker" execution) — user connects their own broker account, engine executes under SEBI's 2025 algo-trading framework (unique Algo ID, static IP, order-level tagging, broker-side kill-switch/audit requirements). Existing kill-switches/risk-gates map closely to what empanelment expects — a real head start.
- [ ] **White-label B2B** — license the engine (governance/risk-gate layer, not the alpha) to smaller brokers/wealth-tech startups.
- [ ] Full discretionary PMS (₹5cr net worth + SEBI PMS registration) — multi-year ceiling, not a near-term target. Don't build toward this until the above is proven out.

---

## How to use this file

- Add new items under the relevant track as they come up in conversation — don't let a good idea evaporate at the end of a chat.
- Check `[x]` and add the commit hash + date when something ships.
- If a planned item turns out to be wrong/superseded, don't delete it — mark it `~~struck through~~` with a one-line note on why, so we don't re-propose it later without remembering we already ruled it out.
