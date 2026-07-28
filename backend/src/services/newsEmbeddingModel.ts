/**
 * newsEmbeddingModel.ts — embedding-based nearest-neighbor sentiment for
 * corporate announcements, to replace/augment newsService.ts's keyword
 * scoring (BULLISH_STRONG/WEAK, BEARISH_STRONG/WEAK word lists).
 *
 * ragService.ts already pays the integration cost of Gemini embeddings +
 * libSQL vector search (`vector_top_k` / `libsql_vector_idx`) for TARS
 * memory retrieval — this reuses the exact same primitives (geminiEmbed,
 * the same vector-index pattern) for a different table, instead of
 * reinventing embedding plumbing.
 *
 * How it works:
 *   1. Every announcement fetched by newsService.fetchAnnouncements() gets
 *      recorded here (embedding + the price at the time), deduplicated by
 *      (symbol, ann_date, headline) so repeat fetches of the same
 *      announcement across 5-min cycles don't re-embed or re-quote it.
 *   2. `resolveAnnouncementOutcomes()` (nightly) marks each row's outcome —
 *      BULLISH_MOVE / BEARISH_MOVE / FLAT — from the ACTUAL subsequent price
 *      move, independent of what the keyword scorer guessed the direction
 *      would be.
 *   3. `getEmbeddingSimilarSentiment()` embeds a new announcement's text and
 *      finds the K most semantically similar RESOLVED past announcements —
 *      "12 similar announcements before, 9 led to a bullish move" — turning
 *      that into a sentiment score on the same scale newsService already
 *      uses.
 *
 * Like the other new models this session, this is dormant until real
 * resolved data accumulates (MIN_SIMILAR results with real outcomes) —
 * newsService.getStockSentiment() falls back to pure keyword scoring
 * whenever this returns null.
 */

import { getClient, run, query } from '../db/turso.js';
import { geminiEmbed } from './geminiService.js';
import { logger } from '../lib/logger.js';
import type { CorporateAnnouncement } from './newsService.js';

const TOP_K = 12;
const MIN_SIMILAR = 5; // need at least this many resolved neighbors for the score to mean anything
const RESOLVE_AFTER_DAYS = 5; // same horizon as adaptiveEngine's signal-outcome resolution

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function ensureAnnouncementEmbeddingsTable(): Promise<void> {
  try {
    await run(`CREATE TABLE IF NOT EXISTS announcement_embeddings (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol                TEXT NOT NULL,
      ann_date              TEXT NOT NULL,
      headline              TEXT NOT NULL,
      category              TEXT,
      embedding             F32_BLOB(3072),
      keyword_score         REAL,
      price_at_announcement REAL,
      resolved              INTEGER NOT NULL DEFAULT 0,
      outcome               TEXT,
      pnl_pct               REAL,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at           DATETIME,
      UNIQUE(symbol, ann_date, headline)
    )`, []);
  } catch (_) { /* already exists */ }
  try {
    await run(
      `CREATE INDEX IF NOT EXISTS announcement_embeddings_vec_idx ON announcement_embeddings (libsql_vector_idx(embedding))`,
      [],
    );
  } catch (err) { console.warn('[NewsEmbedding] vector index skipped (FTS fallback n/a for this table):', err); }
}

/**
 * Fire-and-forget: record an announcement + its embedding for future
 * nearest-neighbor lookups. Deduplicates via the UNIQUE constraint (checked
 * up front to avoid paying for an embed + quote fetch on a row we'd just
 * discard) — cheap on repeat fetches of the same announcement across
 * 5-min cycles.
 */
export async function recordAnnouncementEmbedding(a: CorporateAnnouncement, keywordScore: number): Promise<void> {
  try {
    const exists = await query(
      'SELECT 1 FROM announcement_embeddings WHERE symbol=? AND ann_date=? AND headline=? LIMIT 1',
      [a.symbol, a.date, a.headline],
    ).catch(() => []);
    if (exists.length > 0) return;

    const { getQuote } = await import('./marketData.js');
    const quote = await getQuote(a.symbol).catch(() => null);
    if (!quote || !quote.price) return; // no price to resolve against later — skip rather than store an unresolvable row

    const embedding = await geminiEmbed(`${a.category ?? ''}: ${a.headline}`.slice(0, 500));
    if (!embedding) return; // no embedding available (no API key / rate-limited) — nothing to store for ANN search

    await run(
      `INSERT OR IGNORE INTO announcement_embeddings
         (symbol, ann_date, headline, category, embedding, keyword_score, price_at_announcement)
       VALUES (?,?,?,?,vector(?),?,?)`,
      [a.symbol, a.date, a.headline, a.category, toVectorLiteral(embedding), keywordScore, quote.price],
    );
  } catch (err) {
    console.warn('[NewsEmbedding] recordAnnouncementEmbedding failed:', err);
  }
}

/** Nightly: resolve rows 5+ days old against the actual subsequent price move. */
export async function resolveAnnouncementOutcomes(): Promise<void> {
  const unresolved = await query(
    `SELECT * FROM announcement_embeddings WHERE resolved = 0 AND created_at <= datetime('now', ?)`,
    [`-${RESOLVE_AFTER_DAYS} days`],
  ).catch(() => []);

  const { getQuote } = await import('./marketData.js');
  let resolvedCount = 0;
  for (const row of unresolved) {
    const quote = await getQuote(String(row.symbol)).catch(() => null);
    if (!quote || !quote.price) continue;

    const priceAt = Number(row.price_at_announcement);
    const pnlPct = ((quote.price - priceAt) / priceAt) * 100;
    const outcome = pnlPct > 1 ? 'BULLISH_MOVE' : pnlPct < -1 ? 'BEARISH_MOVE' : 'FLAT';

    await run(
      'UPDATE announcement_embeddings SET resolved=1, outcome=?, pnl_pct=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?',
      [outcome, pnlPct, row.id],
    ).catch(() => null);
    resolvedCount++;
  }
  console.log(`[NewsEmbedding] Resolved ${resolvedCount}/${unresolved.length} announcement outcomes`);
}

export interface EmbeddingSentimentResult {
  score: number;   // same -2..+2 scale as newsService's keyword score
  label: 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';
  similarCount: number;
  bullishCount: number;
  bearishCount: number;
  summary: string;
}

/**
 * Embeds `text` and finds the most semantically similar RESOLVED past
 * announcements, returning a sentiment score derived from what actually
 * happened to those — not from keyword direction. Returns null when Gemini
 * embeddings aren't available or fewer than MIN_SIMILAR resolved neighbors
 * exist yet (expected to be null for a long time after first deployment).
 */
export async function getEmbeddingSimilarSentiment(text: string): Promise<EmbeddingSentimentResult | null> {
  const queryVec = await geminiEmbed(text.slice(0, 500)).catch(() => null);
  if (!queryVec) return null;

  try {
    const db = getClient();
    const result = await db.execute({
      sql: `SELECT a.outcome
            FROM vector_top_k('announcement_embeddings_vec_idx', vector(?), ?)
            JOIN announcement_embeddings a ON a.id = vector_top_k.id
            WHERE a.resolved = 1`,
      args: [toVectorLiteral(queryVec), TOP_K],
    });
    const outcomes = result.rows.map(r => String(r.outcome));
    if (outcomes.length < MIN_SIMILAR) return null;

    const bullishCount = outcomes.filter(o => o === 'BULLISH_MOVE').length;
    const bearishCount = outcomes.filter(o => o === 'BEARISH_MOVE').length;
    const total = outcomes.length;
    const netRatio = (bullishCount - bearishCount) / total; // -1..+1

    const score = Math.max(-2, Math.min(2, netRatio * 2));
    const label: EmbeddingSentimentResult['label'] =
      score >= 1.2 ? 'VERY_BULLISH' : score >= 0.4 ? 'BULLISH' :
      score <= -1.2 ? 'VERY_BEARISH' : score <= -0.4 ? 'BEARISH' : 'NEUTRAL';

    return {
      score, label, similarCount: total, bullishCount, bearishCount,
      summary: `${total} similar announcements before, ${bullishCount} led to a bullish move, ${bearishCount} bearish`,
    };
  } catch (err) {
    logger.warn({ job: 'news-embedding', reason: `vector_top_k lookup failed: ${err}` });
    return null;
  }
}
