/**
 * ragService.ts — Phase 6: RAG-Based TARS Memory
 *
 * Retrieval  : SQLite FTS5 full-text search (BM25 ranking) — zero API keys needed.
 *              Works on all Turso plans with no extensions required.
 * Storage    : tars_memory table + tars_memory_fts FTS5 virtual table (content mirror)
 *
 * Why FTS5 over vector search:
 * - Groq has no embedding API; no OpenAI key available
 * - FTS5 is built into SQLite/LibSQL — zero external dependencies
 * - BM25 ranking suits short factual memories (trade narratives, cycle summaries)
 * - Can be upgraded to vector search later if an embedding API becomes available
 */
import { getClient } from '../db/turso.js';

const TOP_K       = 3;     // memories retrieved per TARS query
const MAX_CONTENT = 1200;  // truncate stored content to keep rows lean

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Store a piece of knowledge into tars_memory.
 * source_type: 'cycle_summary' | 'news_analysis' | 'trade_narrative'
 */
export async function rememberFact(
  content: string,
  sourceType: 'cycle_summary' | 'news_analysis' | 'trade_narrative',
  sourceId?: string,
): Promise<void> {
  const db = getClient();
  const trimmed = content.slice(0, MAX_CONTENT);
  try {
    await db.execute({
      sql: `INSERT INTO tars_memory (content, source_type, source_id) VALUES (?, ?, ?)`,
      args: [trimmed, sourceType, sourceId ?? null],
    });
  } catch (err) {
    console.warn('[RAG] rememberFact failed:', err);
  }
}

/**
 * Retrieve top-K memories most relevant to the query using FTS5 BM25 ranking.
 *
 * @param userQuery   - The user's chat message
 * @param portfolioId - Optional: restrict results to memories for this portfolio
 *                      (source_id = portfolioId or cycle-level memories with no source_id)
 *
 * Search strategy: AND first (high precision), falls back to OR if AND yields nothing.
 */
export async function retrieveMemories(
  userQuery: string,
  portfolioId?: number,
): Promise<string[]> {
  const db = getClient();

  // Tokenise: keep alphanumeric tokens >= 3 chars, cap at 8
  const tokens = userQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 8);

  if (tokens.length === 0) return [];

  const andQuery = tokens.join(' AND ');
  const orQuery  = tokens.join(' OR ');

  const runQuery = async (ftsMatch: string): Promise<string[]> => {
    // Parameterized SQL — no string interpolation of portfolioId
    const sql = portfolioId != null
      ? `SELECT m.content
         FROM tars_memory_fts fts
         JOIN tars_memory m ON m.id = fts.rowid
         WHERE tars_memory_fts MATCH ?
           AND (m.source_id = ? OR m.source_id IS NULL)
         ORDER BY rank LIMIT ?`
      : `SELECT m.content
         FROM tars_memory_fts fts
         JOIN tars_memory m ON m.id = fts.rowid
         WHERE tars_memory_fts MATCH ?
         ORDER BY rank LIMIT ?`;
    const args = portfolioId != null
      ? [ftsMatch, String(portfolioId), TOP_K]
      : [ftsMatch, TOP_K];
    const result = await db.execute({ sql, args });
    return result.rows.map(r => String(r.content));
  };

  try {
    // AND first — precise match
    const andResults = await runQuery(andQuery);
    if (andResults.length > 0) return andResults;
    // OR fallback — broader recall when AND finds nothing
    return await runQuery(orQuery);
  } catch (err) {
    // FTS table not yet populated or query malformed — degrade gracefully
    console.warn('[RAG] retrieveMemories failed:', err);
    return [];
  }
}

/**
 * Prune old memories — keep max 5000 rows, drop oldest beyond that.
 * Called at end of each market cycle.
 */
export async function pruneMemory(maxRows = 5000): Promise<void> {
  const db = getClient();
  try {
    await db.execute({
      sql: `DELETE FROM tars_memory WHERE id NOT IN (
              SELECT id FROM tars_memory ORDER BY created_at DESC LIMIT ?
            )`,
      args: [maxRows],
    });
  } catch { /* non-critical */ }
}
