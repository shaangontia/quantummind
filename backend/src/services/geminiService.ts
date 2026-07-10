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

// ─── Daily API budget guard ──────────────────────────────────────────────────
// Prevents rate-limit exhaustion on heavy signal days.
// Free tier: 1500 req/day. Reserve 300 for embeddings + chat. Veto budget: 1200.
const DAILY_VETO_BUDGET = 1200;
let _vetoCalls = 0;
let _vetoBudgetDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function consumeVetoBudget(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _vetoBudgetDate) { _vetoCalls = 0; _vetoBudgetDate = today; } // midnight reset
  if (_vetoCalls >= DAILY_VETO_BUDGET) return false;
  _vetoCalls++;
  return true;
}

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
  if (!consumeVetoBudget()) return { verdict: 'EXECUTE', reason: 'Gemini daily budget exhausted — proceeding' };

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

// Cycle focus cached 30 min — market themes don't flip every 5 minutes
let _cycleFocusCache: { sectors: string[]; expiresAt: number } | null = null;

/**
 * Gemini-curated sector focus for the current market cycle.
 * Cached 30 minutes — called at most ~16 times/day instead of 108.
 * Returns up to 3 sector names to over-weight in watchlist scanning.
 */
export async function geminiCycleFocus(
  recentNewsHeadlines: string[],
  currentRegime: string,
): Promise<string[]> {
  // Serve from 30-min cache
  if (_cycleFocusCache && Date.now() < _cycleFocusCache.expiresAt) return _cycleFocusCache.sectors;

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
    const sectors = Array.isArray(parsed.sectors) ? parsed.sectors.slice(0, 3) : [];
    _cycleFocusCache = { sectors, expiresAt: Date.now() + 30 * 60 * 1000 };
    return sectors;
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

// ─── Fundamental Analysis ─────────────────────────────────────────────────────

import type { FundamentalSnapshot, FundamentalVerdict } from './fundamentalService.js';

/**
 * Ask Gemini to explain a pre-computed fundamental verdict in plain English.
 * Gemini receives the ratios AND the deterministic verdict (score, vetoed, vetoReasons)
 * but makes ZERO decisions — it only provides a human-readable reasoning string.
 *
 * Veto and score are computed by computeFundamentalVerdict() in fundamentalService.ts.
 * Gemini = explanation layer only. Deterministic, auditable, unit-testable.
 *
 * Returns null if Gemini is unavailable — callers fall back to vetoReasons string.
 */
export async function geminiFundamentalAnalysis(
  snapshot: FundamentalSnapshot,
  verdict: FundamentalVerdict,
): Promise<string | null> {
  const statusLine = verdict.vetoed
    ? `VETOED (${verdict.vetoReasons.join('; ')})`
    : `Score ${verdict.score}/100 — ${verdict.score >= 70 ? 'strong' : verdict.score >= 40 ? 'neutral' : 'weak'} fundamentals`;

  const prompt = `You are a senior equity analyst. A rules engine has already assessed an NSE-listed company's latest quarterly financials and produced this verdict:

Verdict: ${statusLine}

Key ratios:
- Revenue Growth YoY: ${snapshot.revenueGrowthYoY.toFixed(1)}%
- PAT Growth YoY: ${snapshot.patGrowthYoY.toFixed(1)}%
- PAT Margin: ${snapshot.patMarginPct.toFixed(1)}%
- CFO/Net Income: ${snapshot.cfoToNetIncome.toFixed(2)}
- Debt-to-Equity: ${snapshot.debtToEquity.toFixed(2)}
- ROE: ${snapshot.roe.toFixed(1)}%

Write ONE concise sentence (max 120 chars) explaining what the fundamentals tell us about this company's financial health. Do not restate the verdict. No JSON, no markdown.`;

  return geminiGenerate(prompt, { temperature: 0.3, maxTokens: 80 });
}

// ─── Sell Review ──────────────────────────────────────────────────────────────

export interface SellReviewContext {
  symbol: string;
  unrealizedPnlPct: number;   // current unrealized P&L as %
  daysHeld: number;            // how long we've held this position
  rsiValue?: number;           // current RSI (high = overbought = sell pressure)
  momentumTrend?: string;      // e.g. 'bearish' | 'neutral' | 'bullish'
  groqSentiment?: string;      // latest news sentiment string
  stopLossTriggered: boolean;  // if true, this function is never called (hard rule)
}

export interface SellReviewResult {
  verdict: 'EXECUTE' | 'HOLD' | 'ACCELERATE';
  /** -1 = sell urgently, 0 = neutral, +1 = hold and let it run */
  score: number;
  reason: string;
}

/**
 * Ask Gemini whether to execute, delay, or accelerate a pending SELL signal.
 *
 * Decision contract:
 *   ACCELERATE → sell now even if technical score is marginal (Gemini sees urgency)
 *   EXECUTE    → technical signal is correct, proceed
 *   HOLD       → delay one cycle; recheck (max 2 consecutive holds enforced upstream)
 *
 * Stop-loss NEVER passes through this function — hard rule, no LLM involvement.
 * Returns null on Gemini unavailability; caller proceeds with technical signal.
 */
export async function geminiSellReview(ctx: SellReviewContext): Promise<SellReviewResult | null> {
  if (!consumeVetoBudget()) return null;

  const prompt = `You are a portfolio manager reviewing whether to sell an equity position.

Position context:
- Symbol: ${ctx.symbol}
- Unrealized P&L: ${ctx.unrealizedPnlPct.toFixed(1)}%
- Days held: ${ctx.daysHeld}
- RSI: ${ctx.rsiValue !== undefined ? ctx.rsiValue.toFixed(0) : 'unavailable'} (above 65 = overbought signal)
- Momentum trend: ${ctx.momentumTrend ?? 'unknown'}
- Latest news sentiment: ${ctx.groqSentiment ?? 'no recent news'}

The technical system has flagged this position as a SELL candidate based on RSI/momentum.
Your task is to decide whether to:
- ACCELERATE: sell immediately — the position has peaked or fundamentals are deteriorating fast
- EXECUTE: confirm the technical signal — sell is correct
- HOLD: delay one cycle (24h) — the signal may be premature, momentum could recover

Key principle: HOLD is not indefinite. It delays by one trading cycle only.
Do not HOLD if the position is already profitable and news is negative — book the profit.
Do not ACCELERATE just because RSI is high if the trend is still bullish.

Respond with JSON only (no markdown):
{"verdict":"EXECUTE"|"HOLD"|"ACCELERATE","score":<-1 to 1>,"reason":"<one sentence max 120 chars>"}

score: -1 = sell urgently, 0 = neutral, +1 = hold and let it run`;

  const raw = await geminiGenerate(prompt, { temperature: 0.2, maxTokens: 120 });
  if (!raw) return null;

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<SellReviewResult>;
    if (!['EXECUTE', 'HOLD', 'ACCELERATE'].includes(parsed.verdict ?? '')) return null;
    return {
      verdict: parsed.verdict!,
      score: Math.max(-1, Math.min(1, Number(parsed.score ?? 0))),
      reason: parsed.reason ?? '',
    };
  } catch {
    return null;
  }
}
