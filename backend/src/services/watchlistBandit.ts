/**
 * watchlistBandit.ts — UCB1 bandit over the buy-candidate pool.
 *
 * getDynamicCycleWatchlist()/getBiasedCycleWatchlist() (marketData.ts)
 * already rotate a random sample of the NSE universe per cycle — that's
 * good for coverage, but the final `candidates = cycleUniverse.slice(0, 8)`
 * step in marketMonitor.ts just takes the first 8 non-held symbols in
 * whatever order the rotation/Gemini-sector-focus left them in. There's no
 * signal in that ordering about which symbols the SYSTEM actually needs
 * more data on.
 *
 * modelLifecycle.ts's promotion gates (SHADOW/ADVISORY/PRODUCTION) require
 * minimum EXECUTED-label counts, minimum distinct strategy types, AND
 * minimum distinct sectors (see THRESHOLDS in modelLifecycle.ts) — a
 * portfolio can have plenty of total trades and still be stuck in
 * CANDIDATE/SHADOW indefinitely if those trades all cluster in a handful of
 * symbols/sectors it happens to have rotated onto more often. A bandit that
 * prioritizes under-explored symbols/sectors directly accelerates hitting
 * those diversity gates, without touching the risk gates themselves — this
 * only affects which of the 8 pre-filtered, already-risk-eligible
 * candidates get evaluated first when the cold-start daily trade cap binds
 * (see modelLifecycle.ts STAGE_TRADE_LIMITS / marketMonitor.ts
 * coldStartDailyMax) — that cap is exactly where ORDER determines which
 * symbols actually execute today.
 *
 * UCB1: score = meanReward + C * sqrt(ln(totalPulls + 1) / (pulls + 1))
 * "pulls" blends symbol-level and sector-level executed-trade counts 50/50,
 * so an entirely new sector gets a strong exploration bonus (helps the
 * sector-diversity gate) while still tracking per-symbol history (helps
 * the overall label-count gate). C=1.0 is a standard UCB1 exploration
 * constant, not tuned against this system's actual data — reasonable
 * starting point, revisit once there's enough live behavior to judge.
 */

import { query } from '../db/turso.js';
import { getSymbolSector } from './marketData.js';

const EXPLORATION_CONSTANT = 1.0;

/**
 * Reorders `candidatePool` (already risk/held/liquidity-pre-filtered) so
 * under-explored symbols/sectors — the ones modelLifecycle.ts's diversity
 * gates most need more data on — sort first, then returns the top `topN`.
 * Falls back to the pool's original order if the DB reads fail.
 */
export async function getBanditPrioritizedCandidates(
  candidatePool: string[],
  portfolioId: number,
  topN: number,
): Promise<string[]> {
  if (candidatePool.length <= topN) return candidatePool;

  try {
    const symbolRows = await query(
      `SELECT symbol, COUNT(*) as pulls,
              AVG(CASE WHEN outcome='WIN' THEN 1.0 WHEN outcome='LOSS' THEN 0.0 ELSE NULL END) as winRate
       FROM signal_patterns
       WHERE portfolio_id=? AND action='BUY'
       GROUP BY symbol`,
      [portfolioId],
    ).catch(() => []);

    const symbolPulls = new Map<string, number>();
    const symbolReward = new Map<string, number>();
    for (const r of symbolRows) {
      symbolPulls.set(String(r.symbol), Number(r.pulls ?? 0));
      if (r.winRate != null) symbolReward.set(String(r.symbol), Number(r.winRate));
    }

    // Sector-level pulls derived from the same rows (getSymbolSector is a
    // pure in-process lookup, no extra query needed).
    const sectorPulls = new Map<string, number>();
    for (const r of symbolRows) {
      const sector = getSymbolSector(String(r.symbol));
      sectorPulls.set(sector, (sectorPulls.get(sector) ?? 0) + Number(r.pulls ?? 0));
    }

    const totalPulls = symbolRows.reduce((s, r) => s + Number(r.pulls ?? 0), 0);
    const lnTotal = Math.log(totalPulls + 1);

    const scored = candidatePool.map(symbol => {
      const sPulls = symbolPulls.get(symbol) ?? 0;
      const secPulls = sectorPulls.get(getSymbolSector(symbol)) ?? 0;
      const blendedPulls = 0.5 * sPulls + 0.5 * secPulls;
      const meanReward = symbolReward.get(symbol) ?? 0.5; // neutral prior — exploration bonus alone handles cold-start
      const exploration = EXPLORATION_CONSTANT * Math.sqrt(lnTotal / (blendedPulls + 1));
      return { symbol, ucb: meanReward + exploration };
    });

    scored.sort((a, b) => b.ucb - a.ucb);
    return scored.slice(0, topN).map(s => s.symbol);
  } catch {
    return candidatePool.slice(0, topN);
  }
}
