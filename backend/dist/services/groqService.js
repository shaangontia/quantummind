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
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 300,
        });
        const text = response.choices[0]?.message?.content?.trim() ?? '';
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
// Full pipeline: fetch NSE announcements → Groq analysis
async function getGroqStockSentiment(symbol) {
    try {
        const allAnnouncements = await (0, newsService_js_1.fetchAnnouncements)();
        const nseBase = symbol.replace('.NS', '');
        const stockNews = allAnnouncements.filter(a => a.symbol.replace('.NS', '').toUpperCase() === nseBase.toUpperCase());
        if (stockNews.length === 0)
            return null;
        return await analyseStockNews(symbol, stockNews);
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
