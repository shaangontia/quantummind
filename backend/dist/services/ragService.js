"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rememberFact = rememberFact;
exports.retrieveMemories = retrieveMemories;
exports.pruneMemory = pruneMemory;
/**
 * ragService.ts — Phase 6: RAG-Based TARS Memory
 *
 * Primary retrieval  : Gemini text-embedding-004 (768-dim) — semantic vector search via Turso
 * Fallback retrieval : SQLite FTS5 BM25 full-text search (activates when GEMINI_API_KEY absent)
 *
 * Semantic RAG means "why did you sell last week" retrieves semantically related trade
 * narratives even when the exact words don't match.
 */
const turso_js_1 = require("../db/turso.js");
const geminiService_js_1 = require("./geminiService.js");
const TOP_K = 3; // memories retrieved per TARS query
const MAX_CONTENT = 1200; // truncate stored content to keep rows lean
// ─── Vector helpers ───────────────────────────────────────────────────────────
function toVectorLiteral(vec) {
    return `[${vec.join(',')}]`;
}
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Store a piece of knowledge into tars_memory.
 * Embeds via Gemini when available; stores plain text always (FTS5 fallback).
 */
async function rememberFact(content, sourceType, sourceId) {
    const db = (0, turso_js_1.getClient)();
    const trimmed = content.slice(0, MAX_CONTENT);
    const embedding = await (0, geminiService_js_1.geminiEmbed)(trimmed);
    try {
        if (embedding) {
            // Store with vector embedding for semantic search
            await db.execute({
                sql: `INSERT INTO tars_memory (content, embedding, source_type, source_id) VALUES (?, vector(?), ?, ?)`,
                args: [trimmed, toVectorLiteral(embedding), sourceType, sourceId ?? null],
            });
        }
        else {
            // No embedding available — store text only (FTS5 fallback will be used for retrieval)
            await db.execute({
                sql: `INSERT INTO tars_memory (content, source_type, source_id) VALUES (?, ?, ?)`,
                args: [trimmed, sourceType, sourceId ?? null],
            });
        }
    }
    catch (err) {
        console.warn('[RAG] rememberFact INSERT failed:', err);
    }
}
/**
 * Retrieve top-K memories relevant to the query.
 * Uses Gemini vector search (semantic) when embedding available,
 * falls back to FTS5 keyword search otherwise.
 */
async function retrieveMemories(userQuery, portfolioId) {
    const db = (0, turso_js_1.getClient)();
    const portfolioFilter = portfolioId != null
        ? `AND (m.source_id = ? OR m.source_id IS NULL)`
        : '';
    const portfolioArgs = portfolioId != null ? [String(portfolioId)] : [];
    // ── Semantic path (Gemini embeddings available) ───────────────────────────────────
    const queryVec = await (0, geminiService_js_1.geminiEmbed)(userQuery.slice(0, 500));
    if (queryVec) {
        try {
            // vector_top_k() uses the libsql_vector_idx ANN index — avoids full table scan
            const sql = portfolioId != null
                ? `SELECT m.content
           FROM vector_top_k('tars_memory_vec_idx', vector(?), ?)
           JOIN tars_memory m ON m.id = vector_top_k.id
           WHERE (m.source_id = ? OR m.source_id IS NULL)`
                : `SELECT m.content
           FROM vector_top_k('tars_memory_vec_idx', vector(?), ?)
           JOIN tars_memory m ON m.id = vector_top_k.id`;
            const args = portfolioId != null
                ? [toVectorLiteral(queryVec), TOP_K, String(portfolioId)]
                : [toVectorLiteral(queryVec), TOP_K];
            const result = await db.execute({ sql, args });
            if (result.rows.length > 0)
                return result.rows.map(r => String(r.content));
        }
        catch {
            // vector_top_k not available (index not yet created or table empty) — fall through to FTS5
        }
    }
    // ── FTS5 fallback (keyword BM25) ───────────────────────────────────────────
    const tokens = userQuery
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
        .slice(0, 8);
    if (tokens.length === 0)
        return [];
    const andQuery = tokens.join(' AND ');
    const orQuery = tokens.join(' OR ');
    const runFts = async (ftsMatch) => {
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
        const andResults = await runFts(andQuery);
        if (andResults.length > 0)
            return andResults;
        return await runFts(orQuery);
    }
    catch (err) {
        console.warn('[RAG] FTS5 fallback failed:', err);
        return [];
    }
}
/**
 * Prune old memories — keep max 5000 rows, drop oldest beyond that.
 */
async function pruneMemory(maxRows = 5000) {
    const db = (0, turso_js_1.getClient)();
    try {
        await db.execute({
            sql: `DELETE FROM tars_memory WHERE id NOT IN (
              SELECT id FROM tars_memory ORDER BY created_at DESC LIMIT ?
            )`,
            args: [maxRows],
        });
    }
    catch { /* non-critical */ }
}
