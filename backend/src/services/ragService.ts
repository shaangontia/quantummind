/**
 * ragService.ts — Phase 6: RAG-Based TARS Memory
 *
 * Embedding model : OpenAI text-embedding-3-small (512-dim truncated)
 * Vector store    : Turso tars_memory table via LibSQL vector() functions
 *
 * Fails gracefully: if OPENAI_API_KEY is unset, all functions are no-ops and
 * TARS continues without RAG context.
 */
import 'dotenv/config';
import { getClient } from '../db/turso.js';

const EMBED_DIM     = 512;   // reduced dimension — good quality, half the storage of 1536
const TOP_K         = 3;     // memories retrieved per TARS query
const MAX_CONTENT   = 1200;  // truncate content before embedding to stay within token limits

// ─── OpenAI embedding (raw fetch — no openai SDK needed) ──────────────────────
async function embed(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;  // RAG disabled — silently degrade

  const payload = {
    model: 'text-embedding-3-small',
    input: text.slice(0, MAX_CONTENT).replace(/\n+/g, ' '),
    dimensions: EMBED_DIM,
  };

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.warn(`[RAG] Embedding API error ${res.status}: ${await res.text()}`);
    return null;
  }
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0]?.embedding ?? null;
}

// ─── Vector to LibSQL wire format ─────────────────────────────────────────────
// LibSQL vector() accepts a JSON array string: vector('[0.1,0.2,...]')
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

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
  const vec = await embed(content);
  if (!vec) return;  // embedding failed or RAG disabled

  const db = getClient();
  await db.execute({
    sql: `INSERT INTO tars_memory (content, embedding, source_type, source_id)
          VALUES (?, vector(?), ?, ?)`,
    args: [content.slice(0, MAX_CONTENT), toVectorLiteral(vec), sourceType, sourceId ?? null],
  });
}

/**
 * Retrieve top-K memories most relevant to the query string.
 * Returns empty array if OPENAI_API_KEY is unset or embedding fails.
 */
export async function retrieveMemories(query: string): Promise<string[]> {
  const vec = await embed(query);
  if (!vec) return [];

  const db = getClient();
  try {
    const result = await db.execute({
      sql: `SELECT content, vector_distance_cos(embedding, vector(?)) AS dist
            FROM tars_memory
            ORDER BY dist
            LIMIT ?`,
      args: [toVectorLiteral(vec), TOP_K],
    });
    return result.rows.map(r => String(r.content));
  } catch (err) {
    // Vector index may not exist yet on first boot — degrade gracefully
    console.warn('[RAG] Memory retrieval failed:', err);
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
