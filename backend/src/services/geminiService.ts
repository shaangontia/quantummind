/**
 * geminiService.ts — Gemini AI integration (primary LLM + embeddings)
 *
 * Primary  : Gemini 1.5 Flash (chat / sentiment) + text-embedding-004 (RAG)
 * Fallback : Groq llama-3.1-8b-instant for chat/sentiment when Gemini rate-limits
 *
 * Fails gracefully: if GEMINI_API_KEY is unset, returns null and callers fall back to Groq.
 */
import 'dotenv/config';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';

export const EMBED_DIM = 768;  // text-embedding-004 output dimension

let _genAI: GoogleGenerativeAI | null = null;
let _chatModel: GenerativeModel | null = null;
let _embedModel: GenerativeModel | null = null;

function getGenAI(): GoogleGenerativeAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!_genAI) _genAI = new GoogleGenerativeAI(key);
  return _genAI;
}

function getChatModel(): GenerativeModel | null {
  const ai = getGenAI();
  if (!ai) return null;
  if (!_chatModel) _chatModel = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
  return _chatModel;
}

function getEmbedModel(): GenerativeModel | null {
  const ai = getGenAI();
  if (!ai) return null;
  if (!_embedModel) _embedModel = ai.getGenerativeModel({ model: 'text-embedding-004' });
  return _embedModel;
}

// ─── Chat / Text generation ───────────────────────────────────────────────────

/**
 * Generate a text response from Gemini 1.5 Flash.
 * Returns null if GEMINI_API_KEY is unset or on rate-limit/error.
 */
export async function geminiGenerate(
  prompt: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
  const model = getChatModel();
  if (!model) return null;
  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 500,
      },
    });
    return result.response.text().trim() || null;
  } catch (err) {
    console.warn('[Gemini] generateContent failed:', err);
    return null;  // caller falls back to Groq
  }
}

/**
 * Multi-turn chat with Gemini 1.5 Flash.
 * history: array of {role: 'user'|'model', content: string}
 */
export async function geminiChat(
  systemPrompt: string,
  history: Array<{ role: 'user' | 'model'; content: string }>,
  userMessage: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
  const model = getChatModel();
  if (!model) return null;
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
  } catch (err) {
    console.warn('[Gemini] chat failed:', err);
    return null;  // caller falls back to Groq
  }
}

// ─── Trading intelligence ───────────────────────────────────────────────────

export interface TradeVetoContext {
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  rsiValue?: number | null;
  momentumTrend?: string;
  groqSentiment?: string;   // e.g. 'BULLISH: strong earnings...'
  voteScore: number;        // raw buy/sell score from rule engine
  portfolioContext: {
    sectorExposurePct?: number;  // % NAV already in this sector
    positionSizePct: number;     // proposed position as % of NAV
    totalHoldings: number;
    cashBalancePct: number;      // cash as % of NAV
  };
}

/**
 * Pre-trade Gemini reasoning gate.
 * Returns 'EXECUTE' | 'SKIP' | 'REDUCE'.
 * Defaults to 'EXECUTE' if Gemini unavailable (fail-open so trading isn't blocked).
 */
export async function geminiTradeVeto(ctx: TradeVetoContext): Promise<{
  verdict: 'EXECUTE' | 'SKIP' | 'REDUCE';
  reason: string;
}> {
  const model = getChatModel();
  if (!model) return { verdict: 'EXECUTE', reason: 'Gemini unavailable — proceeding' };

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
    if (!text) return { verdict: 'EXECUTE', reason: 'Gemini timeout — proceeding' };
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { verdict: 'EXECUTE', reason: 'Gemini parse error — proceeding' };
    const parsed = JSON.parse(jsonMatch[0]);
    const verdict = ['EXECUTE', 'SKIP', 'REDUCE'].includes(parsed.verdict) ? parsed.verdict : 'EXECUTE';
    return { verdict, reason: String(parsed.reason ?? '') };
  } catch (err) {
    console.warn('[Gemini] tradeVeto failed:', err);
    return { verdict: 'EXECUTE', reason: 'Gemini error — proceeding' };
  }
}

/**
 * Gemini-curated sector focus for the current market cycle.
 * Returns up to 3 sector names to over-weight in watchlist scanning.
 * Returns empty array if Gemini unavailable (caller uses full universe).
 */
export async function geminiCycleFocus(
  recentNewsHeadlines: string[],
  currentRegime: string,
): Promise<string[]> {
  const model = getChatModel();
  if (!model) return [];

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
    if (!text) return [];
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.sectors) ? parsed.sectors.slice(0, 3) : [];
  } catch (err) {
    console.warn('[Gemini] cycleFocus failed:', err);
    return [];
  }
}

/**
 * Gemini portfolio health check — returns strategic insight stored in RAG memory.
 * Called weekly after resolveSignalOutcomes. Non-blocking, best-effort.
 */
export async function geminiPortfolioInsight(
  portfolioName: string,
  navChange: number,
  topHoldings: Array<{ symbol: string; weight: number; pnlPct: number }>,
  sectorBreakdown: Record<string, number>,
  winRate: number,
): Promise<string | null> {
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
export async function geminiEmbed(text: string): Promise<number[] | null> {
  const model = getEmbedModel();
  if (!model) return null;
  try {
    const result = await model.embedContent(text.slice(0, 2000));
    return result.embedding.values ?? null;
  } catch (err) {
    console.warn('[Gemini] embedContent failed:', err);
    return null;
  }
}
