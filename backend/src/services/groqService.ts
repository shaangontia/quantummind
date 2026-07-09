import Groq from 'groq-sdk';
import 'dotenv/config';
import { fetchAnnouncements, type CorporateAnnouncement } from './newsService.js';
import { geminiGenerate } from './geminiService.js';

// ─── In-process sentiment cache (2-hour TTL) ──────────────────────────────────────────
// NSE announcements update intraday but not every 5 min.
// 2-hour TTL gives ~3 refreshes during market hours (9:15-15:30 IST) per symbol,
// shared across ALL portfolios in the same process — no duplicate Gemini calls.
const SENTIMENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const _sentimentCache = new Map<string, { result: LLMSentimentResult; expiresAt: number }>();

function getCachedSentiment(symbol: string): LLMSentimentResult | null {
  const entry = _sentimentCache.get(symbol);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _sentimentCache.delete(symbol); return null; }
  return entry.result;
}

function cacheSentiment(symbol: string, result: LLMSentimentResult): void {
  _sentimentCache.set(symbol, { result, expiresAt: Date.now() + SENTIMENT_TTL_MS });
}

let _groq: Groq | null = null;

function getGroq(): Groq {
  if (_groq) return _groq;
  const key = process.env.groq_key;
  if (!key) throw new Error('groq_key env var not set');
  _groq = new Groq({ apiKey: key });
  return _groq;
}

export interface LLMSentimentResult {
  symbol: string;
  sentiment: 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';
  score: number;          // -2 to +2
  summary: string;        // 1-sentence LLM explanation
  keyEvents: string[];    // up to 3 key events
  tradeImplication: string; // BUY / SELL / HOLD with brief reason
}

// Batch analyse announcements for one symbol using Groq LLM
export async function analyseStockNews(
  symbol: string,
  announcements: CorporateAnnouncement[]
): Promise<LLMSentimentResult | null> {
  if (announcements.length === 0) return null;

  const groq = getGroq();
  const newsText = announcements
    .slice(0, 5) // limit to 5 most recent
    .map(a => `[${a.date}] ${a.category}: ${a.headline}`)
    .join('\n');

  const prompt = `You are an expert Indian stock market analyst. Analyse the following recent corporate announcements for ${symbol.replace('.NS', '')} (NSE-listed Indian company) and provide a structured sentiment assessment.

ANNOUNCEMENTS:
${newsText}

Respond in this exact JSON format (no markdown):
{
  "sentiment": "VERY_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "VERY_BEARISH",
  "score": <integer -2 to +2>,
  "summary": "<1 sentence summary of overall news impact>",
  "keyEvents": ["<event 1>", "<event 2>"],
  "tradeImplication": "<BUY|SELL|HOLD>: <brief reason>"
}`;

  try {
    // Try Gemini first (better reasoning); fall back to Groq on rate-limit or error
    let text = await geminiGenerate(prompt, { temperature: 0.1, maxTokens: 300 });
    if (!text) {
      const groq = getGroq();
      const response = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      });
      text = response.choices[0]?.message?.content?.trim() ?? '';
    }
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      symbol,
      sentiment: parsed.sentiment ?? 'NEUTRAL',
      score: Math.max(-2, Math.min(2, parseInt(parsed.score ?? 0))),
      summary: parsed.summary ?? '',
      keyEvents: parsed.keyEvents ?? [],
      tradeImplication: parsed.tradeImplication ?? 'HOLD: No clear signal',
    };
  } catch (err) {
    console.error(`[Groq] Analysis failed for ${symbol}:`, err);
    return null;
  }
}

// Full pipeline: fetch NSE announcements → LLM analysis (Gemini primary, Groq fallback)
// Cached per symbol per trading day — drastically reduces Gemini API calls.
export async function getGroqStockSentiment(symbol: string): Promise<LLMSentimentResult | null> {
  // Serve from cache if same trading day (NSE announcements don't change every 5 min)
  const cached = getCachedSentiment(symbol);
  if (cached) return cached;

  try {
    const allAnnouncements = await fetchAnnouncements();
    const nseBase = symbol.replace('.NS', '');
    const stockNews = allAnnouncements.filter(a =>
      a.symbol.replace('.NS', '').toUpperCase() === nseBase.toUpperCase()
    );

    if (stockNews.length === 0) return null;
    const result = await analyseStockNews(symbol, stockNews);
    if (result) cacheSentiment(symbol, result);
    return result;
  } catch {
    return null;
  }
}

// Analyse ALL recent high-signal announcements across the market
export async function getMarketIntelligence(): Promise<LLMSentimentResult[]> {
  try {
    const announcements = await fetchAnnouncements();
    const grouped = new Map<string, CorporateAnnouncement[]>();

    for (const a of announcements) {
      const existing = grouped.get(a.symbol) ?? [];
      existing.push(a);
      grouped.set(a.symbol, existing);
    }

    const results: LLMSentimentResult[] = [];
    for (const [symbol, news] of grouped.entries()) {
      if (news.length === 0) continue;
      const result = await analyseStockNews(symbol, news);
      if (result && result.score !== 0) results.push(result);
    }

    return results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  } catch {
    return [];
  }
}
