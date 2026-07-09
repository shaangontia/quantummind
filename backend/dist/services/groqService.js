"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyseStockNews = analyseStockNews;
exports.getGroqStockSentiment = getGroqStockSentiment;
exports.getMarketIntelligence = getMarketIntelligence;
const groq_sdk_1 = __importDefault(require("groq-sdk"));
require("dotenv/config");
const newsService_js_1 = require("./newsService.js");
const geminiService_js_1 = require("./geminiService.js");
// ─── In-process sentiment cache (2-hour TTL) ──────────────────────────────────────────
// NSE announcements update intraday but not every 5 min.
// 2-hour TTL gives ~3 refreshes during market hours (9:15-15:30 IST) per symbol,
// shared across ALL portfolios in the same process — no duplicate Gemini calls.
const SENTIMENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const _sentimentCache = new Map();
function getCachedSentiment(symbol) {
    const entry = _sentimentCache.get(symbol);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        _sentimentCache.delete(symbol);
        return null;
    }
    return entry.result;
}
function cacheSentiment(symbol, result) {
    _sentimentCache.set(symbol, { result, expiresAt: Date.now() + SENTIMENT_TTL_MS });
}
let _groq = null;
function getGroq() {
    if (_groq)
        return _groq;
    const key = process.env.groq_key;
    if (!key)
        throw new Error('groq_key env var not set');
    _groq = new groq_sdk_1.default({ apiKey: key });
    return _groq;
}
// Batch analyse announcements for one symbol using Groq LLM
async function analyseStockNews(symbol, announcements) {
    if (announcements.length === 0)
        return null;
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
        let text = await (0, geminiService_js_1.geminiGenerate)(prompt, { temperature: 0.1, maxTokens: 300 });
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
        if (!jsonMatch)
            return null;
        const parsed = JSON.parse(jsonMatch[0]);
        return {
            symbol,
            sentiment: parsed.sentiment ?? 'NEUTRAL',
            score: Math.max(-2, Math.min(2, parseInt(parsed.score ?? 0))),
            summary: parsed.summary ?? '',
            keyEvents: parsed.keyEvents ?? [],
            tradeImplication: parsed.tradeImplication ?? 'HOLD: No clear signal',
        };
    }
    catch (err) {
        console.error(`[Groq] Analysis failed for ${symbol}:`, err);
        return null;
    }
}
// Full pipeline: fetch NSE announcements → LLM analysis (Gemini primary, Groq fallback)
// Cached per symbol per trading day — drastically reduces Gemini API calls.
async function getGroqStockSentiment(symbol) {
    // Serve from cache if same trading day (NSE announcements don't change every 5 min)
    const cached = getCachedSentiment(symbol);
    if (cached)
        return cached;
    try {
        const allAnnouncements = await (0, newsService_js_1.fetchAnnouncements)();
        const nseBase = symbol.replace('.NS', '');
        const stockNews = allAnnouncements.filter(a => a.symbol.replace('.NS', '').toUpperCase() === nseBase.toUpperCase());
        if (stockNews.length === 0)
            return null;
        const result = await analyseStockNews(symbol, stockNews);
        if (result)
            cacheSentiment(symbol, result);
        return result;
    }
    catch {
        return null;
    }
}
// Analyse ALL recent high-signal announcements across the market
async function getMarketIntelligence() {
    try {
        const announcements = await (0, newsService_js_1.fetchAnnouncements)();
        const grouped = new Map();
        for (const a of announcements) {
            const existing = grouped.get(a.symbol) ?? [];
            existing.push(a);
            grouped.set(a.symbol, existing);
        }
        const results = [];
        for (const [symbol, news] of grouped.entries()) {
            if (news.length === 0)
                continue;
            const result = await analyseStockNews(symbol, news);
            if (result && result.score !== 0)
                results.push(result);
        }
        return results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    }
    catch {
        return [];
    }
}
