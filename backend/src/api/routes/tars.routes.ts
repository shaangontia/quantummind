/**
 * tars.routes.ts — TARS AI chatbot endpoint
 */
import { Router, Request, Response } from 'express';
import Groq from 'groq-sdk';
import { geminiChat } from '../../services/geminiService.js';
import { retrieveMemories } from '../../services/ragService.js';
import { NSE_UNIVERSE, getDisplayQuote } from '../../services/marketData.js';

const router = Router();
const groqClient = new Groq({ apiKey: process.env.groq_key });

// ─── Live market context injector ─────────────────────────────────────────────
async function tarsLiveContext(message: string): Promise<string> {
  const universeSet = new Set(NSE_UNIVERSE.map(s => s.replace('.NS', '')));
  const explicitMatch = message.match(/\b([A-Za-z0-9&-]+)\.NS\b/i);
  const explicitSym   = explicitMatch ? explicitMatch[1].toUpperCase() + '.NS' : null;
  const upperTokens   = [...message.matchAll(/\b([A-Z][A-Z0-9&-]{1,14})\b/g)].map(m => m[1]).filter(t => universeSet.has(t));
  const candidates: string[] = [];
  if (explicitSym) candidates.push(explicitSym);
  upperTokens.forEach(t => { if (!candidates.includes(t + '.NS')) candidates.push(t + '.NS'); });
  for (const sym of candidates.slice(0, 3)) {
    try {
      const q = await getDisplayQuote(sym);
      if (q.price > 0) {
        const ist  = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const sign = q.change >= 0 ? '+' : '';
        return `\n\n[LIVE MARKET DATA - as of ${ist} IST]\nStock: ${sym} (${q.shortName ?? ''})\nLTP: ₹${q.price.toFixed(2)}\nChange: ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)\nProvider: ${q.provider} | Fresh: ${q.isFresh}`;
      }
    } catch { /* try next */ }
  }
  return '';
}

const TARS_SYSTEM_PROMPT = `You are TARS, the AI assistant for QuantumMind - an AI-driven virtual Indian stock trading portal.
You are named after the robot from the movie Interstellar. Honesty setting: 90%. Humor setting: 75%.

CRITICAL RULE: You have access to LIVE market data via Yahoo Finance. When the user asks for a stock price, LTP, or current value, the system automatically fetches a real-time quote and injects it into this conversation as [LIVE MARKET DATA]. Use those exact figures in your answer. NEVER say you cannot access real-time data. NEVER mention a "knowledge cutoff" for prices - you have live data.

About QuantumMind:
- Fully autonomous AI-managed virtual trading system for NSE-listed Indian stocks
- Targets 15% annual return (30% over 2 years) with aggressive strategy
- Real-time NSE prices via Yahoo Finance (query2 → query1 CDN fallback) + Groww unofficial fallback
- LLM (Groq llama-3.1-8b-instant) analyses corporate news for trade signals
- ML stack: RSI(14), 52-week range, linear regression momentum, Kelly Criterion, MACD, EMA crossover
- Adaptive feedback loop: signal weights auto-adjust based on win/loss history
- Market regime detection: BULL / BEAR / SIDEWAYS gates trade thresholds
- Brokerage: 0.2% flat per trade (STT + NSE charges + stamp duty + GST ≈ 0.2-0.25%)
- Safety guards: kill switch, 10% NAV per symbol cap, daily trade limits, NSE holiday calendar, earnings blackout
- No real money - simulation only. All trades are virtual.
- Database: Turso cloud SQLite (Mumbai ap-south-1 region)
- Universe: ~1800+ NSE EQ-series stocks above ₹30

When [LIVE MARKET DATA] is present in this conversation, cite those exact figures.
When [RELEVANT MEMORY CONTEXT] is present, use it to answer questions about recent trades, market cycles, and portfolio activity. Cite it naturally — do not say "according to memory", just answer as if you know it.
Keep answers concise and accurate.`;

// ─── Chat endpoint ────────────────────────────────────────────────────────────
router.post('/tars/chat', async (req: Request, res: Response) => {
  const { message, history, portfolioId } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ success: false, error: 'message required' });
  const chatPortfolioId: number | undefined = (() => {
    if (typeof portfolioId === 'number') return portfolioId;
    if (typeof portfolioId === 'string') { const n = parseInt(portfolioId, 10); return Number.isNaN(n) ? undefined : n; }
    return undefined;
  })();
  try {
    res.set('Cache-Control', 'no-store');
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: TARS_SYSTEM_PROMPT }];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: String(h.content) });
      }
    }
    const memories    = await retrieveMemories(message, chatPortfolioId);
    const ragCtx      = memories.length > 0 ? `\n\n[RELEVANT MEMORY CONTEXT]\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}` : '';
    const liveCtx     = await tarsLiveContext(message);
    const userContent = message.slice(0, 500) + liveCtx + ragCtx;
    messages.push({ role: 'user', content: userContent });
    const geminiHistory = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, content: m.content }));
    const geminiUserMsg = geminiHistory.pop()?.content ?? userContent;
    let reply = await geminiChat(TARS_SYSTEM_PROMPT, geminiHistory, geminiUserMsg, { temperature: 0.6, maxTokens: 400 });
    if (!reply) {
      const groqResp = await groqClient.chat.completions.create({ model: 'llama-3.1-8b-instant', messages, temperature: 0.6, max_tokens: 400 });
      reply = groqResp.choices[0]?.message?.content?.trim() ?? 'No response from TARS.';
    }
    res.json({ success: true, reply });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

export default router;
