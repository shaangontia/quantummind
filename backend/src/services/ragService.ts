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
 * Tokenises the query into FTS5-safe terms (strips punctuation, deduplicates).
 * Returns empty array if no matching memories or table not yet populated.
 */
export async function retrieveMemories(userQuery: string): Promise<string[]> {
  const db = getClient();

  // Build FTS5 query: keep only alphanumeric tokens >= 3 chars, join with OR
  const ftsQuery = userQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 8)   // cap terms to avoid FTS5 parse errors on very long queries
    .join(' OR ');

  if (!ftsQuery) return [];

  try {
    const result = await db.execute({
      sql: `SELECT m.content
            FROM tars_memory_fts fts
            JOIN tars_memory m ON m.id = fts.rowid
            WHERE tars_memory_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
      args: [ftsQuery, TOP_K],
    });
    return result.rows.map(r => String(r.content));
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
