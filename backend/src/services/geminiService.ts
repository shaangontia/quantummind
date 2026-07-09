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
