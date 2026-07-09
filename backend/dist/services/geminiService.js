"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMBED_DIM = void 0;
exports.geminiGenerate = geminiGenerate;
exports.geminiChat = geminiChat;
exports.geminiTradeVeto = geminiTradeVeto;
exports.geminiCycleFocus = geminiCycleFocus;
exports.geminiPortfolioInsight = geminiPortfolioInsight;
exports.geminiEmbed = geminiEmbed;
/**
 * geminiService.ts — Gemini AI integration (primary LLM + embeddings)
 *
 * Primary  : Gemini 1.5 Flash (chat / sentiment) + text-embedding-004 (RAG)
 * Fallback : Groq llama-3.1-8b-instant for chat/sentiment when Gemini rate-limits
 *
 * Fails gracefully: if GEMINI_API_KEY is unset, returns null and callers fall back to Groq.
 */
require("dotenv/config");
const generative_ai_1 = require("@google/generative-ai");
exports.EMBED_DIM = 768; // text-embedding-004 output dimension
let _genAI = null;
let _chatModel = null;
let _embedModel = null;
function getGenAI() {
    const key = process.env.GEMINI_API_KEY;
    if (!key)
        return null;
    if (!_genAI)
        _genAI = new generative_ai_1.GoogleGenerativeAI(key);
    return _genAI;
}
function getChatModel() {
    const ai = getGenAI();
    if (!ai)
        return null;
    if (!_chatModel)
        _chatModel = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
    return _chatModel;
}
function getEmbedModel() {
    const ai = getGenAI();
    if (!ai)
        return null;
    if (!_embedModel)
        _embedModel = ai.getGenerativeModel({ model: 'text-embedding-004' });
    return _embedModel;
}
// ─── Chat / Text generation ───────────────────────────────────────────────────
/**
 * Generate a text response from Gemini 1.5 Flash.
 * Returns null if GEMINI_API_KEY is unset or on rate-limit/error.
 */
async function geminiGenerate(prompt, opts = {}) {
    const model = getChatModel();
    if (!model)
        return null;
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: opts.temperature ?? 0.4,
                maxOutputTokens: opts.maxTokens ?? 500,
            },
        });
        return result.response.text().trim() || null;
    }
    catch (err) {
        console.warn('[Gemini] generateContent failed:', err);
        return null; // caller falls back to Groq
    }
}
/**
 * Multi-turn chat with Gemini 1.5 Flash.
 * history: array of {role: 'user'|'model', content: string}
 */
async function geminiChat(systemPrompt, history, userMessage, opts = {}) {
    const model = getChatModel();
    if (!model)
        return null;
    try {
        const chat = model.startChat({
            systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
            history: history.map(h => ({
                role: h.role,
                parts: [{ text: h.content }],
            })),
            generationConfig: {
                temperature: opts.temperature ?? 0.6,
                maxOutputTokens: opts.maxTokens ?? 400,
            },
        });
        const result = await chat.sendMessage(userMessage);
        return result.response.text().trim() || null;
    }
    catch (err) {
        console.warn('[Gemini] chat failed:', err);
        return null; // caller falls back to Groq
    }
}
// ─── Trading intelligence ───────────────────────────────────────────────────
// ─── Daily API budget guard ──────────────────────────────────────────────────
// Prevents rate-limit exhaustion on heavy signal days.
// Free tier: 1500 req/day. Reserve 300 for embeddings + chat. Veto budget: 1200.
const DAILY_VETO_BUDGET = 1200;
let _vetoCalls = 0;
let _vetoBudgetDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
function consumeVetoBudget() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _vetoBudgetDate) {
        _vetoCalls = 0;
        _vetoBudgetDate = today;
    } // midnight reset
    if (_vetoCalls >= DAILY_VETO_BUDGET)
        return false;
    _vetoCalls++;
    return true;
}
/**
 * Pre-trade Gemini reasoning gate.
 * Returns 'EXECUTE' | 'SKIP' | 'REDUCE'.
 * Defaults to 'EXECUTE' if Gemini unavailable (fail-open so trading isn't blocked).
 */
async function geminiTradeVeto(ctx) {
    const model = getChatModel();
    if (!model)
        return { verdict: 'EXECUTE', reason: 'Gemini unavailable — proceeding' };
    if (!consumeVetoBudget())
        return { verdict: 'EXECUTE', reason: 'Gemini daily budget exhausted — proceeding' };
    const prompt = `You are a senior NSE equity trader reviewing an algorithmic trade proposal.

TRADE PROPOSAL:
- Action: ${ctx.action} ${ctx.symbol}
- Price: ₹${ctx.price}
- Rule engine vote score: ${ctx.voteScore} (higher = stronger signal)
- RSI: ${ctx.rsiValue?.toFixed(1) ?? 'unknown'}
- Momentum: ${ctx.momentumTrend ?? 'unknown'}
- News sentiment: ${ctx.groqSentiment ?? 'none'}

PORTFOLIO CONTEXT:
- Sector exposure: ${ctx.portfolioContext.sectorExposurePct?.toFixed(1) ?? '?'}% of NAV
- Proposed position: ${ctx.portfolioContext.positionSizePct.toFixed(1)}% of NAV
- Cash available: ${ctx.portfolioContext.cashBalancePct.toFixed(1)}% of NAV
- Total holdings: ${ctx.portfolioContext.totalHoldings}

Assess this trade. Reply in this exact JSON format only, no markdown:
{
  "verdict": "EXECUTE" | "SKIP" | "REDUCE",
  "reason": "<1-2 sentence rationale>"
}

Rules:
- EXECUTE: trade looks sound given all signals and portfolio context
- SKIP: signals are conflicting, sector already over-exposed, or risk/reward poor
- REDUCE: direction is right but position size should be halved (over-extension risk)`;
    try {
        const text = await geminiGenerate(prompt, { temperature: 0.1, maxTokens: 150 });
        if (!text)
            return { verdict: 'EXECUTE', reason: 'Gemini timeout — proceeding' };
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return { verdict: 'EXECUTE', reason: 'Gemini parse error — proceeding' };
        const parsed = JSON.parse(jsonMatch[0]);
        const verdict = ['EXECUTE', 'SKIP', 'REDUCE'].includes(parsed.verdict) ? parsed.verdict : 'EXECUTE';
        return { verdict, reason: String(parsed.reason ?? '') };
    }
    catch (err) {
        console.warn('[Gemini] tradeVeto failed:', err);
        return { verdict: 'EXECUTE', reason: 'Gemini error — proceeding' };
    }
}
// Cycle focus cached 30 min — market themes don't flip every 5 minutes
let _cycleFocusCache = null;
/**
 * Gemini-curated sector focus for the current market cycle.
 * Cached 30 minutes — called at most ~16 times/day instead of 108.
 * Returns up to 3 sector names to over-weight in watchlist scanning.
 */
async function geminiCycleFocus(recentNewsHeadlines, currentRegime) {
    // Serve from 30-min cache
    if (_cycleFocusCache && Date.now() < _cycleFocusCache.expiresAt)
        return _cycleFocusCache.sectors;
    const model = getChatModel();
    if (!model)
        return [];
    const headlines = recentNewsHeadlines.slice(0, 15).join('\n');
    const prompt = `You are an NSE equity strategist. Based on today's corporate announcements and current market regime, identify which sectors offer the best intraday trading opportunities.

MARKET REGIME: ${currentRegime}

RECENT NSE ANNOUNCEMENTS:
${headlines || 'No recent announcements available'}

List up to 3 NSE GICS sectors that look most actionable today from: IT, Financials, Energy, FMCG, Healthcare, Industrials, Materials, Realty, Auto, Utilities

Reply in this exact JSON format only, no markdown:
{ "sectors": ["<sector1>", "<sector2>"] }`;
    try {
        const text = await geminiGenerate(prompt, { temperature: 0.2, maxTokens: 80 });
        if (!text)
            return [];
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return [];
        const parsed = JSON.parse(jsonMatch[0]);
        const sectors = Array.isArray(parsed.sectors) ? parsed.sectors.slice(0, 3) : [];
        _cycleFocusCache = { sectors, expiresAt: Date.now() + 30 * 60 * 1000 };
        return sectors;
    }
    catch (err) {
        console.warn('[Gemini] cycleFocus failed:', err);
        return [];
    }
}
/**
 * Gemini portfolio health check — returns strategic insight stored in RAG memory.
 * Called weekly after resolveSignalOutcomes. Non-blocking, best-effort.
 */
async function geminiPortfolioInsight(portfolioName, navChange, topHoldings, sectorBreakdown, winRate) {
    const holdingsSummary = topHoldings
        .slice(0, 5)
        .map(h => `${h.symbol}: ${h.weight.toFixed(1)}% weight, ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct.toFixed(1)}% P&L`)
        .join('; ');
    const sectorSummary = Object.entries(sectorBreakdown)
        .map(([s, p]) => `${s} ${p.toFixed(0)}%`).join(', ');
    const prompt = `You are a portfolio risk advisor reviewing an NSE virtual equity portfolio.

PORTFOLIO: ${portfolioName}
NAV change (recent): ${navChange >= 0 ? '+' : ''}${navChange.toFixed(2)}%
Signal win rate: ${(winRate * 100).toFixed(1)}%
Top holdings: ${holdingsSummary || 'none'}
Sector allocation: ${sectorSummary || 'no holdings'}

Provide a 2-3 sentence portfolio health assessment covering: risk concentration, signal quality, and one specific improvement suggestion. Be direct and concrete.`;
    return geminiGenerate(prompt, { temperature: 0.4, maxTokens: 200 });
}
// ─── Embeddings ───────────────────────────────────────────────────────────────
/**
 * Embed text using Gemini text-embedding-004 (768-dim).
 * Returns null if GEMINI_API_KEY is unset or embedding fails.
 */
async function geminiEmbed(text) {
    const model = getEmbedModel();
    if (!model)
        return null;
    try {
        const result = await model.embedContent(text.slice(0, 2000));
        return result.embedding.values ?? null;
    }
    catch (err) {
        console.warn('[Gemini] embedContent failed:', err);
        return null;
    }
}
