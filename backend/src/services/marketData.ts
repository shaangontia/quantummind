import https from 'https';
import { memCache } from '../lib/cache.js';
import { recordApiSuccess, recordApiFailure } from './killSwitch.js';

export interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  shortName?: string;
  timestamp: Date;
  /** 20-day average volume from provider */
  averageVolume?: number;
  /** volume / averageVolume — > 1 means above-average activity today */
  volumeRatio?: number;
  /** Trailing twelve-month P/E ratio — null if loss-making or unavailable */
  peRatio?: number | null;
  /** Trailing twelve-month EPS */
  eps?: number | null;
  /** Which provider delivered this quote */
  provider: 'twelve_data' | 'yahoo_query2' | 'yahoo_query1' | 'groww_unofficial' | 'cached';
  /** Whether this quote is fresh enough to trade on */
  isFresh: boolean;
}

export function toNseSymbol(symbol: string): string {
  return symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
}

// ── Symbol mapping ────────────────────────────────────────────────────────────
// Yahoo uses TCS.NS; Groww unofficial endpoint uses the bare ticker.
// Only NSE-listed (.NS) equities are supported for the Groww fallback.
// BSE-only (.BO), indices (^NSEI), and foreign tickers are NOT mapped.
function toGrowwTicker(nseSymbol: string): string | null {
  if (!nseSymbol.endsWith('.NS')) return null; // BSE / index / foreign → no Groww mapping
  return nseSymbol.slice(0, -3).toUpperCase();  // TCS.NS → TCS
}

// ── Price validation ──────────────────────────────────────────────────────────
const MAX_STALE_MS = 30 * 60 * 1000; // 30 minutes — quotes older than this are stale

function validatePrice(price: number, symbol: string, source: string): void {
  if (!price || price <= 0)
    throw new Error(`[${source}] Invalid price ${price} for ${symbol}`);
}

function isQuoteFresh(quoteTimestamp: Date): boolean {
  const ageMs = Date.now() - quoteTimestamp.getTime();
  // Allow stale outside market hours (NSE: 09:15-15:30 IST = UTC+5:30)
  const now = new Date();
  const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  const istMin = (now.getUTCMinutes() + 30) % 60;
  const istTimeMin = istHour * 60 + istMin;
  const marketOpen = 9 * 60 + 15;   // 09:15
  const marketClose = 15 * 60 + 30; // 15:30
  const isMarketHours = istTimeMin >= marketOpen && istTimeMin <= marketClose;
  return isMarketHours ? ageMs < MAX_STALE_MS : true; // Outside hours, stale is acceptable
}

// ── Market hours check ────────────────────────────────────────────────────────
export function isNseMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun 6=Sat
  if (day === 0 || day === 6) return false;
  const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  const istMin = (now.getUTCMinutes() + 30) % 60;
  const istTimeMin = istHour * 60 + istMin;
  return istTimeMin >= (9 * 60 + 15) && istTimeMin <= (15 * 60 + 30);
}

// ── Min price threshold ─────────────────────────────────────────────────────
export const MIN_TRADE_PRICE = 30; // ₹30 — applies to all signals and universe filtering

// ── Dynamic NSE Universe ──────────────────────────────────────────────────────
/**
 * Fetches ALL NSE-listed equity symbols from NSE India's public equity list CSV.
 * URL: https://archives.nseindia.com/content/equities/EQUITY_L.csv
 * Format: SYMBOL,NAME OF COMPANY,SERIES,DATE OF LISTING,...
 * Cached for 24 hours. Falls back to NSE_UNIVERSE static list if fetch fails
 * (NSE India may block cloud IPs — Vercel serverless is an outbound cloud IP).
 *
 * Each symbol is appended with .NS for Yahoo Finance compatibility.
 * Series 'EQ' only — excludes ETFs, SME boards, SGBs, preference shares.
 */
async function fetchNseEquityList(): Promise<string[]> {
  const CACHE_KEY = 'nse_equity_universe_v1';
  const cached = memCache.get<string[]>(CACHE_KEY);
  if (cached && cached.length > 0) return cached;

  return new Promise<string[]>((resolve) => {
    const url = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://www.nseindia.com/',
      }
    }, (res) => {
      // Follow redirect if any
      if (res.statusCode === 301 || res.statusCode === 302) {
        // For simplicity, fall back on redirect (rare)
        console.warn('[NSE Universe] Redirect — falling back to static list');
        resolve(NSE_UNIVERSE);
        return;
      }
      if (res.statusCode !== 200) {
        console.warn(`[NSE Universe] HTTP ${res.statusCode} — falling back to static list`);
        resolve(NSE_UNIVERSE);
        return;
      }
      let csv = '';
      res.on('data', (chunk: Buffer) => { csv += chunk.toString(); });
      res.on('end', () => {
        try {
          const lines = csv.split('\n').slice(1); // skip header
          const symbols: string[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            const cols = line.split(',');
            const symbol = cols[0]?.trim();
            const series = cols[2]?.trim();
            // Only EQ series (main board equities)
            if (symbol && series === 'EQ' && /^[A-Z0-9&-]+$/.test(symbol)) {
              symbols.push(`${symbol}.NS`);
            }
          }
          if (symbols.length < 100) {
            console.warn(`[NSE Universe] Too few symbols (${symbols.length}) — falling back to static list`);
            resolve(NSE_UNIVERSE);
            return;
          }
          console.log(`[NSE Universe] Loaded ${symbols.length} NSE equity symbols dynamically`);
          memCache.set(CACHE_KEY, symbols, 24 * 3600); // cache 24h
          resolve(symbols);
        } catch (err) {
          console.warn('[NSE Universe] Parse error — falling back to static list:', err);
          resolve(NSE_UNIVERSE);
        }
      });
    });
    req.on('error', (err) => {
      console.warn('[NSE Universe] Fetch error — falling back to static list:', err.message);
      resolve(NSE_UNIVERSE);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      console.warn('[NSE Universe] Timeout — falling back to static list');
      resolve(NSE_UNIVERSE);
    });
  });
}

/**
 * Returns a rotating sample from the FULL NSE equity universe (dynamic or static fallback).
 * sampleSize: number of stocks to evaluate per cycle (default 50).
 * Price filter (₹30+) is applied at signal generation time via Yahoo Finance quote.
 */
export async function getDynamicCycleWatchlist(rotationSeed: number, sampleSize = 50): Promise<string[]> {
  const universe = await fetchNseEquityList();
  const shuffled = [...universe];
  let seed = rotationSeed;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(sampleSize, shuffled.length));
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
interface FetchResult { data: any; statusCode: number; latencyMs: number }

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers } };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d; });
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        try {
          resolve({ data: JSON.parse(data), statusCode: res.statusCode ?? 0, latencyMs });
        } catch (e) {
          reject(new Error(`JSON parse failed (status=${res.statusCode}, latency=${latencyMs}ms)`));
        }
      });
    }).on('error', reject);
  });
}

// ── Twelve Data (primary — works from cloud IPs, 800 calls/day free) ────────
// Symbol format: TCS.NS → TCS:NSE
function toTwelveDataSymbol(nseSymbol: string): string {
  return nseSymbol.replace(/\.NS$/i, ':NSE');
}

const TWELVE_DATA_CACHE_PREFIX = 'td_quote:';
const TWELVE_DATA_CACHE_TTL = 270; // 4.5 min — slightly under the 5-min cron cycle

/**
 * Warm the per-cycle Twelve Data cache by batch-fetching all symbols up front.
 * Call once per cron cycle before signal generation begins.
 * Reduces individual /quote calls to zero for cache-hit symbols.
 */
export async function warmTwelveDataCache(nseSymbols: string[]): Promise<void> {
  if (!process.env.TWELVE_DATA_API_KEY || nseSymbols.length === 0) return;
  try {
    const batchMap = await batchQuoteTwelveData(nseSymbols);
    for (const [symbol, quote] of batchMap) {
      memCache.set(`${TWELVE_DATA_CACHE_PREFIX}${symbol}`, quote, TWELVE_DATA_CACHE_TTL);
    }
    if (batchMap.size > 0) {
      void recordApiSuccess();  // Phase 17: data freshness signal (async, fire-and-forget)
    } else {
      void recordApiFailure();  // Phase 17: empty batch = API issue
    }
    console.log(`[MarketData] twelve_data cache warmed: ${batchMap.size}/${nseSymbols.length} symbols`);
  } catch (err) {
    void recordApiFailure();  // Phase 17: exception = API failure
    console.warn('[MarketData] warmTwelveDataCache failed:', String(err));
  }
}

async function getQuoteTwelveData(nseSymbol: string): Promise<StockQuote | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null; // not configured — skip silently

  // Check cycle cache first — avoids individual API call if warmTwelveDataCache() was called
  const cached = memCache.get<StockQuote>(`${TWELVE_DATA_CACHE_PREFIX}${nseSymbol}`);
  if (cached) return cached;

  const tdSymbol = toTwelveDataSymbol(nseSymbol);
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${apiKey}`;
  const start = Date.now();
  try {
    const { data: d, statusCode, latencyMs } = await httpsGet(url);

    if (d?.status === 'error' || !d?.close) {
      console.warn(`[MarketData] twelve_data: ${d?.message ?? 'no close price'} for ${nseSymbol} (${latencyMs}ms)`);
      return null;
    }

    const price = parseFloat(d.close);
    validatePrice(price, nseSymbol, 'twelve_data');

    const ts = d.timestamp ? new Date(Number(d.timestamp) * 1000) : new Date();
    const prevClose = parseFloat(d.previous_close ?? d.close);
    const quote: StockQuote = {
      symbol: nseSymbol,
      price,
      change: parseFloat(d.change ?? '0'),
      changePct: parseFloat(d.percent_change ?? '0'),
      volume: parseInt(d.volume ?? '0', 10),
      averageVolume: d.average_volume ? parseInt(d.average_volume, 10) : undefined,
      volumeRatio: d.average_volume && d.volume && parseInt(d.average_volume, 10) > 0
        ? parseInt(d.volume, 10) / parseInt(d.average_volume, 10)
        : undefined,
      fiftyTwoWeekHigh: d.fifty_two_week?.high ? parseFloat(d.fifty_two_week.high) : undefined,
      fiftyTwoWeekLow: d.fifty_two_week?.low ? parseFloat(d.fifty_two_week.low) : undefined,
      shortName: d.name,
      peRatio: d.pe != null && d.pe !== 'N/A' ? parseFloat(d.pe) : null,
      eps: d.eps != null && d.eps !== 'N/A' ? parseFloat(d.eps) : null,
      timestamp: ts,
      provider: 'twelve_data',
      isFresh: isQuoteFresh(ts),
    };
    console.log(`[MarketData] twelve_data OK ${nseSymbol} ₹${price} PE=${quote.peRatio ?? 'N/A'} (${latencyMs}ms)`);
    // Populate cycle cache so repeat lookups within same cycle are free
    memCache.set(`${TWELVE_DATA_CACHE_PREFIX}${nseSymbol}`, quote, TWELVE_DATA_CACHE_TTL);
    return quote;
  } catch (err) {
    console.warn(`[MarketData] twelve_data FAIL ${nseSymbol}: ${String(err)}`);
    return null;
  }
}

/**
 * Batch fetch via Twelve Data — up to 120 symbols per call.
 * Returns a map of nseSymbol → StockQuote (only successful ones).
 */
async function batchQuoteTwelveData(nseSymbols: string[]): Promise<Map<string, StockQuote>> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey || nseSymbols.length === 0) return new Map();

  const tdSymbols = nseSymbols.map(toTwelveDataSymbol);
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSymbols.join(','))}&apikey=${apiKey}`;
  const result = new Map<string, StockQuote>();
  try {
    const { data, latencyMs } = await httpsGet(url);
    for (let i = 0; i < nseSymbols.length; i++) {
      const nse = nseSymbols[i];
      const td = tdSymbols[i];
      const entry = data[td] ?? data[td.split(':')[0]];
      if (!entry?.price) continue;
      const price = parseFloat(entry.price);
      if (price <= 0) continue;
      const ts = new Date();
      result.set(nse, {
        symbol: nse, price, change: 0, changePct: 0, volume: 0,
        timestamp: ts, provider: 'twelve_data', isFresh: isQuoteFresh(ts),
      });
    }
    console.log(`[MarketData] twelve_data batch: ${result.size}/${nseSymbols.length} quotes OK (${latencyMs}ms)`);
  } catch (err) {
    console.warn(`[MarketData] twelve_data batch FAIL: ${String(err)}`);
  }
  return result;
}

// ── Yahoo Finance (fallback) ───────────────────────────────────────────────────
async function getQuoteYahoo(
  nseSymbol: string,
  cdnHost: 'query2' | 'query1'
): Promise<StockQuote | null> {
  const provider = cdnHost === 'query2' ? 'yahoo_query2' : 'yahoo_query1';
  const url = `https://${cdnHost}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=1d`;
  const start = Date.now();
  try {
    const { data: json, statusCode, latencyMs } = await httpsGet(url);
    const meta = json.chart?.result?.[0]?.meta ?? {};
    if (!meta.regularMarketPrice) {
      console.warn(`[MarketData] ${provider} returned empty result for ${nseSymbol} (status=${statusCode}, ${latencyMs}ms)`);
      return null;
    }
    const price = meta.regularMarketPrice;
    validatePrice(price, nseSymbol, provider);
    const ts = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date();
    const quote: StockQuote = {
      symbol: nseSymbol,
      price,
      change: price - (meta.chartPreviousClose ?? price),
      changePct: meta.chartPreviousClose ? ((price - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
      volume: meta.regularMarketVolume ?? 0,
      averageVolume: meta.averageDailyVolume3Month ?? undefined,
      volumeRatio: meta.averageDailyVolume3Month && meta.regularMarketVolume
        ? meta.regularMarketVolume / meta.averageDailyVolume3Month
        : undefined,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      shortName: meta.shortName,
      peRatio: meta.trailingPE ?? null,
      eps: meta.trailingEps ?? null,
      timestamp: ts,
      provider,
      isFresh: isQuoteFresh(ts),
    };
    console.log(`[MarketData] ${provider} OK ${nseSymbol} ₹${price} (${latencyMs}ms)`);
    return quote;
  } catch (err) {
    console.warn(`[MarketData] ${provider} FAIL ${nseSymbol}: ${String(err)}`);
    return null;
  }
}

// ── Groww unofficial fallback ─────────────────────────────────────────────────
// WARNING: This uses Groww's undocumented web/frontend endpoint.
// It is NOT the official Groww Trade API (which requires a bearer token + subscription).
// This endpoint has no SLA, schema may change without notice, and may be blocked.
// Use ONLY as a last resort. Do NOT execute trades from this source if price is stale.
async function getQuoteGrowwUnofficial(nseSymbol: string): Promise<StockQuote | null> {
  const ticker = toGrowwTicker(nseSymbol);
  if (!ticker) {
    console.warn(`[MarketData] groww_unofficial: symbol ${nseSymbol} is not an NSE equity — skipping`);
    return null;
  }
  const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${ticker}/latest`;
  try {
    const { data: d, statusCode, latencyMs } = await httpsGet(url, {
      Accept: 'application/json',
      Referer: 'https://groww.in/',
    });

    // Validate response shape — unofficial API: schema may change
    if (!d || typeof d !== 'object') {
      console.warn(`[MarketData] groww_unofficial: unexpected response shape for ${nseSymbol} (status=${statusCode})`);
      return null;
    }

    // Confirm the returned symbol matches what we requested
    const returnedSymbol: string = (d.symbol ?? '').toUpperCase();
    if (returnedSymbol && returnedSymbol !== ticker) {
      console.warn(`[MarketData] groww_unofficial: symbol mismatch — requested ${ticker}, got ${returnedSymbol}`);
      return null;
    }

    const price = d.ltp;
    if (!price || price <= 0) {
      console.warn(`[MarketData] groww_unofficial: invalid price ${price} for ${nseSymbol} (status=${statusCode}, ${latencyMs}ms)`);
      return null;
    }

    // Groww returns lastTradeTime as epoch seconds
    const ts = d.tsInMillis ? new Date(d.tsInMillis) : d.lastTradeTime ? new Date(d.lastTradeTime * 1000) : new Date();
    const fresh = isQuoteFresh(ts);
    const quote: StockQuote = {
      symbol: nseSymbol,
      price,
      change: d.dayChange ?? 0,
      changePct: d.dayChangePerc ?? 0,
      volume: d.volume ?? 0,
      fiftyTwoWeekHigh: d.yearHighPrice,
      fiftyTwoWeekLow: d.yearLowPrice,
      timestamp: ts,
      provider: 'groww_unofficial',
      isFresh: fresh,
    };
    console.log(`[MarketData] groww_unofficial OK ${nseSymbol} ₹${price} fresh=${fresh} (${latencyMs}ms) ⚠ unofficial endpoint`);
    return quote;
  } catch (err) {
    console.warn(`[MarketData] groww_unofficial FAIL ${nseSymbol}: ${String(err)}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a quote suitable for DISPLAY only.
 * May return cached/stale data. MUST NOT be used for trade execution.
 * Call getExecutableQuote() instead for any trade decision.
 */
export async function getDisplayQuote(symbol: string): Promise<StockQuote> {
  return getQuote(symbol);
}

/**
 * Fetch a live quote via fallback chain:
 *   1. Yahoo query2 (primary CDN)
 *   2. Yahoo query1 (alternate CDN)
 *   3. Groww unofficial web endpoint (NSE equities only, no SLA)
 *
 * Returns a StockQuote with `.provider` and `.isFresh` fields.
 * Callers MUST check `isFresh` before executing a trade.
 * Throws if all providers fail.
 */
export async function getQuote(symbol: string): Promise<StockQuote> {
  const nseSymbol = toNseSymbol(symbol);

  // Primary: Twelve Data (works from cloud IPs, 800 calls/day free)
  const td = await getQuoteTwelveData(nseSymbol);
  if (td) return td;

  // Fallback: Yahoo Finance CDN chain
  const q2 = await getQuoteYahoo(nseSymbol, 'query2');
  if (q2) return q2;

  const q1 = await getQuoteYahoo(nseSymbol, 'query1');
  if (q1) return q1;

  console.warn(`[MarketData] Yahoo CDNs failed for ${nseSymbol} — trying Groww unofficial fallback`);
  const groww = await getQuoteGrowwUnofficial(nseSymbol);
  if (groww) return groww;

  throw new Error(`[MarketData] All price providers failed for ${nseSymbol}. No trade will be executed.`);
}

/**
 * Fetch a quote for TRADE EXECUTION.
 * Always makes a fresh network call. Never uses in-memory state from previous calls.
 * Performs cross-source agreement check: if two sources differ by > 2%, throws.
 * Callers must ALSO check isFresh on the returned quote.
 */
export async function getExecutableQuote(symbol: string): Promise<StockQuote> {
  const nseSymbol = toNseSymbol(symbol);

  // Primary: Twelve Data — fetch independently from Yahoo for cross-validation
  const [td, q2, q1] = await Promise.all([
    getQuoteTwelveData(nseSymbol),
    getQuoteYahoo(nseSymbol, 'query2'),
    getQuoteYahoo(nseSymbol, 'query1'),
  ]);

  // Best case: Twelve Data + at least one Yahoo — cross-validate
  const yahooPrimary = q2 ?? q1;
  if (td && yahooPrimary) {
    const diff = Math.abs(td.price - yahooPrimary.price) / Math.max(td.price, yahooPrimary.price);
    if (diff > 0.02) {
      console.warn(
        `[ExecutableQuote] twelve_data vs yahoo disagreement for ${nseSymbol}: ` +
        `₹${td.price} vs ₹${yahooPrimary.price} (${(diff*100).toFixed(2)}%) — using Twelve Data (primary)`
      );
    }
    if (!td.isFresh) throw new Error(`[ExecutableQuote] Stale Twelve Data price for ${nseSymbol} — no trade`);
    return td;
  }

  // Twelve Data only (Yahoo blocked)
  if (td) {
    if (!td.isFresh) throw new Error(`[ExecutableQuote] Stale Twelve Data price for ${nseSymbol} — no trade`);
    console.warn(`[ExecutableQuote] Yahoo unavailable for ${nseSymbol} — using Twelve Data only`);
    return td;
  }

  // Twelve Data unavailable — fall through to Yahoo
  if (q2 && q1) {
    const diff = Math.abs(q2.price - q1.price) / Math.max(q2.price, q1.price);
    if (diff > 0.02) {
      throw new Error(
        `[ExecutableQuote] Yahoo provider disagreement for ${nseSymbol}: ` +
        `query2=₹${q2.price} vs query1=₹${q1.price} (diff=${(diff * 100).toFixed(2)}%) — no trade`
      );
    }
    if (!q2.isFresh) throw new Error(`[ExecutableQuote] Stale Yahoo price for ${nseSymbol} — no trade`);
    return q2;
  }

  if (yahooPrimary) {
    if (!yahooPrimary.isFresh) throw new Error(`[ExecutableQuote] Stale Yahoo price for ${nseSymbol} — no trade`);
    console.warn(`[ExecutableQuote] Single Yahoo CDN for ${nseSymbol} — cannot cross-validate`);
    return yahooPrimary;
  }

  // All cloud sources failed — last resort: Groww unofficial
  console.warn(`[ExecutableQuote] All primary sources failed for ${nseSymbol} — Groww last resort`);
  const groww = await getQuoteGrowwUnofficial(nseSymbol);
  if (groww) {
    if (!groww.isFresh) throw new Error(`[ExecutableQuote] Stale Groww price for ${nseSymbol} — no trade`);
    console.warn(`[ExecutableQuote] ⚠ Executing on Groww unofficial for ${nseSymbol}: ₹${groww.price}`);
    return groww;
  }

  throw new Error(`[ExecutableQuote] All price providers failed for ${nseSymbol}. Trade blocked.`);
}

export async function getMultipleQuotes(symbols: string[]): Promise<StockQuote[]> {
  const nseSymbols = symbols.map(toNseSymbol);

  // Prefer Twelve Data batch (one API call for all symbols — preserves daily quota)
  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      const batchMap = await batchQuoteTwelveData(nseSymbols);
      if (batchMap.size > 0) {
        void recordApiSuccess();  // Phase 17: successful price fetch
        // Fill in any missing symbols via individual fallback calls
        const missing = nseSymbols.filter(s => !batchMap.has(s));
        if (missing.length > 0) {
          const fallbacks = await Promise.allSettled(missing.map(getQuote));
          for (const r of fallbacks) {
            if (r.status === 'fulfilled') batchMap.set(r.value.symbol, r.value);
          }
        }
        return nseSymbols.map(s => batchMap.get(s)).filter(Boolean) as StockQuote[];
      } else {
        void recordApiFailure();  // Phase 17: empty batch
      }
    } catch (err) {
      void recordApiFailure();  // Phase 17: exception
      console.warn('[MarketData] getMultipleQuotes twelve_data error:', String(err));
    }
  }

  // Twelve Data not configured or failed — fall back to individual calls
  const results = await Promise.allSettled(nseSymbols.map(getQuote));
  const quotes: StockQuote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') quotes.push(r.value);
    else console.warn('[MarketData] getMultipleQuotes error:', r.reason);
  }
  // Record success/failure based on yahoo fallback results too
  if (quotes.length > 0) void recordApiSuccess();
  else void recordApiFailure();
  return quotes;
}

// ── Historical data (Yahoo only — Groww unofficial has no history endpoint) ──
/**
 * P2.14 fix (2026-07-22): exported (was module-private) so mlEngine.ts's ML
 * feature functions (momentum, MACD/EMA, Kelly, correlation) route their
 * Yahoo history fetches through this shared function instead of maintaining
 * a second, parallel `https.get()` implementation. That duplicate path bypassed
 * killSwitch.recordApiFailure() entirely, so Yahoo outages affecting only the
 * ML layer never tripped the circuit breaker / kill switch. Now every caller
 * — RSI (getRsi) and the ML layer alike — shares one fetch path whose
 * failures are recorded consistently. See QuantumMind_Algorithm_Analysis.md §4.
 */
export async function getHistoricalCloses(
  symbol: string,
  days = 40,
  range: '1mo' | '3mo' | '6mo' | '1y' = '3mo',
): Promise<number[]> {
  const nseSymbol = toNseSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=${range}`;
  try {
    const { data: json } = await httpsGet(url);
    const closes: number[] = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const filtered = closes.filter((c: any) => c !== null && c > 0).slice(-days);
    if (filtered.length > 0) void recordApiSuccess();
    else void recordApiFailure();
    return filtered;
  } catch (err) {
    void recordApiFailure();
    throw err;
  }
}

export async function getRsi(symbol: string, period = 14): Promise<number | null> {
  try {
    const closes = await getHistoricalCloses(symbol, period + 10);
    if (closes.length < period + 1) return null;

    const recent = closes.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i] - recent[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  } catch {
    return null;
  }
}

// NSE blue-chip watchlist — no penny stocks, all established companies
/**
 * NSE Open Universe — ~150 liquid NSE-listed stocks across all market cap segments.
 * No tier restrictions. The Risk Engine enforces only per-symbol position caps (10% NAV).
 * The market cycle evaluates a rotating sample each run to stay within API rate limits.
 * Min price filter: ₹30 (MIN_TRADE_PRICE, applied in signal engine — see
 * tradingEngine.ts MIN_STOCK_PRICE). No sector or cap-size restrictions.
 * (P2.12 fix 2026-07-22: this comment previously said ₹50, disagreeing with
 * the actual ₹30 enforced everywhere in code — corrected to match reality.)
 *
 * Expansion: Add any NSE-listed symbol ending in .NS. The system will automatically
 * include it in rotation on the next deploy.
 */
export const NSE_UNIVERSE: string[] = [
  // ── Nifty 50 ───────────────────────────────────────────────────────────
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS',
  'HINDUNILVR.NS', 'SBIN.NS', 'BHARTIARTL.NS', 'KOTAKBANK.NS', 'WIPRO.NS',
  'AXISBANK.NS', 'LT.NS', 'ASIANPAINT.NS', 'MARUTI.NS', 'TITAN.NS',
  'BAJFINANCE.NS', 'SUNPHARMA.NS', 'HCLTECH.NS', 'TATAMOTORS.NS', 'ONGC.NS',
  'NTPC.NS', 'POWERGRID.NS', 'JSWSTEEL.NS', 'GRASIM.NS', 'ULTRACEMCO.NS',
  'BPCL.NS', 'DRREDDY.NS', 'HEROMOTOCO.NS', 'DIVISLAB.NS', 'NESTLEIND.NS',
  'APOLLOHOSP.NS', 'CIPLA.NS', 'TATACONSUM.NS', 'EICHERMOT.NS', 'SHRIRAMFIN.NS',
  'BAJAJFINSV.NS', 'ADANIENT.NS', 'COALINDIA.NS', 'HINDALCO.NS', 'M&M.NS',
  'BRITANNIA.NS', 'TATAPOWER.NS', 'SBILIFE.NS', 'HDFCLIFE.NS', 'BAJAJ-AUTO.NS',
  'INDUSINDBK.NS', 'LTF.NS', 'TECHM.NS', 'ADANIPORTS.NS', 'TATASTEEL.NS',

  // ── Nifty Next 50 / MidCap 150 ─────────────────────────────────────────
  'POLYCAB.NS', 'DIXONTECH.NS', 'PERSISTENT.NS', 'COFORGE.NS', 'KPITTECH.NS',
  'CROMPTON.NS', 'PIIND.NS', 'ASTRAL.NS', 'VOLTAS.NS', 'MAXHEALTH.NS',
  'GODREJPROP.NS', 'MPHASIS.NS', 'RVNL.NS', 'IRFC.NS', 'PFC.NS',
  'RECLTD.NS', 'CHOLAFIN.NS', 'MUTHOOTFIN.NS', 'VEDL.NS', 'TRENT.NS',
  'AMBUJACEM.NS', 'ACC.NS', 'BERGEPAINT.NS', 'CONCOR.NS', 'CUMMINSIND.NS',
  'MOTHERSON.NS', 'BALKRISIND.NS', 'AUROPHARMA.NS', 'SYNGENE.NS', 'LALPATHLAB.NS',
  'METROPOLIS.NS', 'SUNTV.NS', 'INDUSTOWER.NS', 'NAUKRI.NS', 'DMART.NS',
  'ZOMATO.NS', 'PAYTM.NS', 'NYKAA.NS', 'DELHIVERY.NS', 'CARTRADE.NS',
  'ABFRL.NS', 'PAGEIND.NS', 'KAYNES.NS', 'SYRMA.NS', 'AEROFLEX.NS',
  'GRINDWELL.NS', 'JYOTHYLAB.NS', 'KAJARIACER.NS', 'RAMKRISHNA.NS', 'ELGIEQUIP.NS',

  // ── Nifty SmallCap 250 (liquid, >₹50, positive cash flow) ──────────────────
  'LATENTVIEW.NS', 'CLEAN.NS', 'NAZARA.NS', 'BIKAJI.NS', 'ROUTE.NS',
  'CAMPUS.NS', 'MEDPLUS.NS', 'HAPPYFORGE.NS', 'KIMS.NS', 'RAINBOW.NS',
  'TARSONS.NS', 'SUDARSCHEM.NS', 'TIINDIA.NS', 'JKPAPER.NS', 'HFCL.NS',
  'FINEORG.NS', 'INTELLECT.NS', 'MASTEK.NS', 'ZENSAR.NS', 'RATEGAIN.NS',
  'INOX.NS', 'INOXWIND.NS', 'TRIVENI.NS', 'KPRMILL.NS', 'WELSPUNIND.NS',
  'GPPL.NS', 'RHIM.NS', 'NOCIL.NS', 'TATVA.NS', 'ANURAS.NS',
  'CRAFTSMAN.NS', 'JINDALSAW.NS', 'GARFIBRES.NS', 'ELECON.NS', 'DYNAMATECH.NS',
  'TEJASNET.NS', 'GLAND.NS', 'VIJAYA.NS', 'IDFCFIRSTB.NS', 'BANDHANBNK.NS',

  // ── Sectoral Picks — PSU, Defence, EV, Green Energy ────────────────────
  'HAL.NS', 'BEL.NS', 'BHEL.NS', 'BEML.NS', 'MAZAGON.NS',
  'COCHINSHIP.NS', 'GRSE.NS', 'IDEA.NS', 'IREDA.NS', 'NHPC.NS',
  'SJVN.NS', 'TORNTPOWER.NS', 'CESC.NS', 'RELINFRA.NS', 'TATACHEM.NS',
];

/** Backward-compat alias — same as NSE_UNIVERSE */
export const DEFAULT_WATCHLIST = NSE_UNIVERSE;

/**
 * GICS-aligned sector taxonomy for NSE_UNIVERSE symbols.
 * Used for sector concentration checks in the risk engine and
 * sector allocation display in the dashboard.
 * Symbols not listed here default to 'Other'.
 */
export const SECTOR_MAP: Record<string, string> = {
  // Information Technology
  'TCS.NS': 'IT', 'INFY.NS': 'IT', 'WIPRO.NS': 'IT', 'HCLTECH.NS': 'IT',
  'TECHM.NS': 'IT', 'MPHASIS.NS': 'IT', 'COFORGE.NS': 'IT', 'PERSISTENT.NS': 'IT',
  'KPITTECH.NS': 'IT', 'MASTEK.NS': 'IT', 'ZENSAR.NS': 'IT', 'INTELLECT.NS': 'IT',
  'RATEGAIN.NS': 'IT', 'TEJASNET.NS': 'IT', 'LATENTVIEW.NS': 'IT',

  // Financials (Banks)
  'HDFCBANK.NS': 'Financials', 'ICICIBANK.NS': 'Financials', 'SBIN.NS': 'Financials',
  'KOTAKBANK.NS': 'Financials', 'AXISBANK.NS': 'Financials', 'INDUSINDBK.NS': 'Financials',
  'BANDHANBNK.NS': 'Financials', 'IDFCFIRSTB.NS': 'Financials',

  // Financials (NBFC / Insurance)
  'BAJFINANCE.NS': 'Financials', 'BAJAJFINSV.NS': 'Financials', 'SHRIRAMFIN.NS': 'Financials',
  'CHOLAFIN.NS': 'Financials', 'MUTHOOTFIN.NS': 'Financials', 'LTF.NS': 'Financials',
  'SBILIFE.NS': 'Financials', 'HDFCLIFE.NS': 'Financials', 'IRFC.NS': 'Financials',
  'PFC.NS': 'Financials', 'RECLTD.NS': 'Financials',

  // Energy & Oil
  'RELIANCE.NS': 'Energy', 'ONGC.NS': 'Energy', 'BPCL.NS': 'Energy',
  'TATAPOWER.NS': 'Energy', 'NHPC.NS': 'Energy', 'SJVN.NS': 'Energy',
  'IREDA.NS': 'Energy', 'TORNTPOWER.NS': 'Energy', 'CESC.NS': 'Energy',
  'RELINFRA.NS': 'Energy', 'INOXWIND.NS': 'Energy', 'NTPC.NS': 'Energy',
  'POWERGRID.NS': 'Energy',

  // FMCG & Consumer
  'HINDUNILVR.NS': 'FMCG', 'NESTLEIND.NS': 'FMCG', 'BRITANNIA.NS': 'FMCG',
  'TATACONSUM.NS': 'FMCG', 'MARICO.NS': 'FMCG', 'DABUR.NS': 'FMCG',
  'JYOTHYLAB.NS': 'FMCG', 'BIKAJI.NS': 'FMCG', 'PAGEIND.NS': 'FMCG',

  // Healthcare & Pharma
  'SUNPHARMA.NS': 'Healthcare', 'DRREDDY.NS': 'Healthcare', 'CIPLA.NS': 'Healthcare',
  'DIVISLAB.NS': 'Healthcare', 'AUROPHARMA.NS': 'Healthcare', 'APOLLOHOSP.NS': 'Healthcare',
  'MAXHEALTH.NS': 'Healthcare', 'KIMS.NS': 'Healthcare', 'RAINBOW.NS': 'Healthcare',
  'SYNGENE.NS': 'Healthcare', 'LALPATHLAB.NS': 'Healthcare', 'METROPOLIS.NS': 'Healthcare',
  'GLAND.NS': 'Healthcare',

  // Industrials & Capital Goods
  'LT.NS': 'Industrials', 'BHEL.NS': 'Industrials', 'BEML.NS': 'Industrials',
  'HAL.NS': 'Industrials', 'BEL.NS': 'Industrials', 'MAZAGON.NS': 'Industrials',
  'COCHINSHIP.NS': 'Industrials', 'GRSE.NS': 'Industrials', 'CONCOR.NS': 'Industrials',
  'CUMMINSIND.NS': 'Industrials', 'POLYCAB.NS': 'Industrials', 'CROMPTON.NS': 'Industrials',
  'ELECON.NS': 'Industrials', 'CRAFTSMAN.NS': 'Industrials', 'KAYNES.NS': 'Industrials',
  'SYRMA.NS': 'Industrials', 'AEROFLEX.NS': 'Industrials', 'DYNAMATECH.NS': 'Industrials',
  'ELGIEQUIP.NS': 'Industrials', 'RAMKRISHNA.NS': 'Industrials', 'GRINDWELL.NS': 'Industrials',
  'RVNL.NS': 'Industrials', 'GPPL.NS': 'Industrials', 'TIINDIA.NS': 'Industrials',

  // Materials & Metals
  'JSWSTEEL.NS': 'Materials', 'TATASTEEL.NS': 'Materials', 'HINDALCO.NS': 'Materials',
  'VEDL.NS': 'Materials', 'COALINDIA.NS': 'Materials', 'GRASIM.NS': 'Materials',
  'ULTRACEMCO.NS': 'Materials', 'AMBUJACEM.NS': 'Materials', 'ACC.NS': 'Materials',
  'ASTRAL.NS': 'Materials', 'PIIND.NS': 'Materials', 'FINEORG.NS': 'Materials',
  'NOCIL.NS': 'Materials', 'TATVA.NS': 'Materials', 'TATACHEM.NS': 'Materials',
  'JINDALSAW.NS': 'Materials', 'GARFIBRES.NS': 'Materials', 'SUDARSCHEM.NS': 'Materials',
  'CLEAN.NS': 'Materials', 'JKPAPER.NS': 'Materials', 'WELSPUNIND.NS': 'Materials',
  'KPRMILL.NS': 'Materials', 'RHIM.NS': 'Materials', 'TARSONS.NS': 'Materials',

  // Automobiles
  'MARUTI.NS': 'Auto', 'TATAMOTORS.NS': 'Auto', 'M&M.NS': 'Auto',
  'EICHERMOT.NS': 'Auto', 'HEROMOTOCO.NS': 'Auto', 'BAJAJ-AUTO.NS': 'Auto',
  'BALKRISIND.NS': 'Auto', 'MOTHERSON.NS': 'Auto', 'TRIVENI.NS': 'Auto',

  // Real Estate
  'GODREJPROP.NS': 'Realty', 'DMART.NS': 'Realty', 'ANURAS.NS': 'Realty',

  // Telecom & Media
  'BHARTIARTL.NS': 'Telecom', 'IDEA.NS': 'Telecom', 'INDUSTOWER.NS': 'Telecom',
  'SUNTV.NS': 'Telecom', 'HFCL.NS': 'Telecom',

  // Consumer Discretionary / Retail / New-Age
  'TITAN.NS': 'Consumer', 'ASIANPAINT.NS': 'Consumer', 'BERGEPAINT.NS': 'Consumer',
  'KAJARIACER.NS': 'Consumer', 'VOLTAS.NS': 'Consumer', 'ABFRL.NS': 'Consumer',
  'TRENT.NS': 'Consumer', 'NAUKRI.NS': 'Consumer', 'ZOMATO.NS': 'Consumer',
  'PAYTM.NS': 'Consumer', 'NYKAA.NS': 'Consumer', 'DELHIVERY.NS': 'Consumer',
  'CARTRADE.NS': 'Consumer', 'CAMPUS.NS': 'Consumer', 'MEDPLUS.NS': 'Consumer',
  'NAZARA.NS': 'Consumer', 'ROUTE.NS': 'Consumer', 'INOX.NS': 'Consumer',
  'DIXON.NS': 'Consumer', 'DIXONTECH.NS': 'Consumer',
};

/**
 * Look up GICS sector for a symbol.
 * Falls back to 'Other' for unknown symbols.
 */
export function getSymbolSector(symbol: string): string {
  return SECTOR_MAP[symbol] ?? 'Other';
}

/**
 * Best-effort market cap tier classification for known NSE symbols.
 * Used for cap-preference biasing in portfolio stock selection.
 * NOT used as a hard allocation restriction (that feature was removed).
 * Symbols not in this map are treated as 'unknown' and included in all tiers.
 */
export const KNOWN_CAP_TIERS: Record<string, 'large' | 'mid' | 'small'> = {
  // Large-cap (Nifty 50 + Next 50 components)
  'RELIANCE.NS': 'large', 'TCS.NS': 'large', 'HDFCBANK.NS': 'large', 'INFY.NS': 'large',
  'ICICIBANK.NS': 'large', 'HINDUNILVR.NS': 'large', 'SBIN.NS': 'large', 'BHARTIARTL.NS': 'large',
  'KOTAKBANK.NS': 'large', 'WIPRO.NS': 'large', 'AXISBANK.NS': 'large', 'LT.NS': 'large',
  'ASIANPAINT.NS': 'large', 'MARUTI.NS': 'large', 'TITAN.NS': 'large', 'BAJFINANCE.NS': 'large',
  'SUNPHARMA.NS': 'large', 'HCLTECH.NS': 'large', 'TATAMOTORS.NS': 'large', 'ONGC.NS': 'large',
  'NTPC.NS': 'large', 'POWERGRID.NS': 'large', 'JSWSTEEL.NS': 'large', 'GRASIM.NS': 'large',
  'ULTRACEMCO.NS': 'large', 'BPCL.NS': 'large', 'DRREDDY.NS': 'large', 'HEROMOTOCO.NS': 'large',
  'DIVISLAB.NS': 'large', 'NESTLEIND.NS': 'large', 'APOLLOHOSP.NS': 'large', 'CIPLA.NS': 'large',
  'TATACONSUM.NS': 'large', 'EICHERMOT.NS': 'large', 'SHRIRAMFIN.NS': 'large',
  'BAJAJFINSV.NS': 'large', 'ADANIENT.NS': 'large', 'COALINDIA.NS': 'large',
  'HINDALCO.NS': 'large', 'BRITANNIA.NS': 'large', 'TATAPOWER.NS': 'large',
  'SBILIFE.NS': 'large', 'HDFCLIFE.NS': 'large', 'TECHM.NS': 'large',
  'ADANIPORTS.NS': 'large', 'TATASTEEL.NS': 'large', 'DMART.NS': 'large',
  'ZOMATO.NS': 'large', 'HAL.NS': 'large', 'BEL.NS': 'large', 'NAUKRI.NS': 'large',
  // Mid-cap
  'POLYCAB.NS': 'mid', 'DIXONTECH.NS': 'mid', 'PERSISTENT.NS': 'mid', 'COFORGE.NS': 'mid',
  'KPITTECH.NS': 'mid', 'CROMPTON.NS': 'mid', 'PIIND.NS': 'mid', 'ASTRAL.NS': 'mid',
  'VOLTAS.NS': 'mid', 'MAXHEALTH.NS': 'mid', 'GODREJPROP.NS': 'mid', 'MPHASIS.NS': 'mid',
  'RVNL.NS': 'mid', 'IRFC.NS': 'mid', 'PFC.NS': 'mid', 'RECLTD.NS': 'mid',
  'CHOLAFIN.NS': 'mid', 'MUTHOOTFIN.NS': 'mid', 'TRENT.NS': 'mid', 'AMBUJACEM.NS': 'mid',
  'ACC.NS': 'mid', 'BERGEPAINT.NS': 'mid', 'CONCOR.NS': 'mid', 'CUMMINSIND.NS': 'mid',
  'MOTHERSON.NS': 'mid', 'BALKRISIND.NS': 'mid', 'AUROPHARMA.NS': 'mid', 'SYNGENE.NS': 'mid',
  'LALPATHLAB.NS': 'mid', 'METROPOLIS.NS': 'mid', 'SUNTV.NS': 'mid', 'KAYNES.NS': 'mid',
  'SYRMA.NS': 'mid', 'GRINDWELL.NS': 'mid', 'KAJARIACER.NS': 'mid', 'ELGIEQUIP.NS': 'mid',
  'BHEL.NS': 'mid', 'BEML.NS': 'mid', 'MAZAGON.NS': 'mid', 'COCHINSHIP.NS': 'mid',
  'IREDA.NS': 'mid', 'NHPC.NS': 'mid', 'SJVN.NS': 'mid', 'TORNTPOWER.NS': 'mid',
  'PAGEIND.NS': 'mid', 'VEDL.NS': 'mid', 'INDUSTOWER.NS': 'mid',
  // Small-cap
  'LATENTVIEW.NS': 'small', 'CLEAN.NS': 'small', 'NAZARA.NS': 'small',
  'BIKAJI.NS': 'small', 'ROUTE.NS': 'small', 'CAMPUS.NS': 'small',
  'MEDPLUS.NS': 'small', 'KIMS.NS': 'small', 'RAINBOW.NS': 'small',
  'TARSONS.NS': 'small', 'SUDARSCHEM.NS': 'small', 'TIINDIA.NS': 'small',
  'JKPAPER.NS': 'small', 'HFCL.NS': 'small', 'FINEORG.NS': 'small',
  'INTELLECT.NS': 'small', 'MASTEK.NS': 'small', 'ZENSAR.NS': 'small',
  'RATEGAIN.NS': 'small', 'INOX.NS': 'small', 'INOXWIND.NS': 'small',
  'TRIVENI.NS': 'small', 'KPRMILL.NS': 'small', 'WELSPUNIND.NS': 'small',
  'CRAFTSMAN.NS': 'small', 'DYNAMATECH.NS': 'small', 'TEJASNET.NS': 'small',
  'GLAND.NS': 'small', 'AEROFLEX.NS': 'small', 'PAYTM.NS': 'small',
  'NYKAA.NS': 'small', 'DELHIVERY.NS': 'small', 'CARTRADE.NS': 'small',
  'ABFRL.NS': 'small', 'IDFCFIRSTB.NS': 'small', 'BANDHANBNK.NS': 'small',
};

/**
 * Returns a cap-biased candidate list for a portfolio with preferred_cap set.
 * preferred: 'small' | 'mid' | 'large' — the preferred cap type
 * biasRatio: fraction of slots allocated to preferred cap (default 0.5 = 50%)
 * The remaining slots come from the full rotated universe (any cap).
 */
export function getBiasedCycleWatchlist(
  universe: string[],
  preferred: 'small' | 'mid' | 'large',
  seed: number,
  sampleSize = 50,
  biasRatio = 0.5,
): string[] {
  const preferred_symbols = universe.filter(s => KNOWN_CAP_TIERS[s] === preferred);
  const other_symbols = universe.filter(s => KNOWN_CAP_TIERS[s] !== preferred);

  const preferredSlots = Math.round(sampleSize * biasRatio);
  const otherSlots = sampleSize - preferredSlots;

  // Seeded shuffle for preferred
  let seed1 = seed;
  const shuffledPref = [...preferred_symbols];
  for (let i = shuffledPref.length - 1; i > 0; i--) {
    seed1 = (seed1 * 1664525 + 1013904223) >>> 0;
    const j = seed1 % (i + 1);
    [shuffledPref[i], shuffledPref[j]] = [shuffledPref[j], shuffledPref[i]];
  }

  // Seeded shuffle for others
  let seed2 = seed + 1;
  const shuffledOther = [...other_symbols];
  for (let i = shuffledOther.length - 1; i > 0; i--) {
    seed2 = (seed2 * 1664525 + 1013904223) >>> 0;
    const j = seed2 % (i + 1);
    [shuffledOther[i], shuffledOther[j]] = [shuffledOther[j], shuffledOther[i]];
  }

  return [
    ...shuffledPref.slice(0, preferredSlots),
    ...shuffledOther.slice(0, otherSlots),
  ];
}

/**
 * Returns a deterministic rotating sample of stocks to evaluate each cycle.
 * rotationSeed: use cycle timestamp floored to 5-min bucket for determinism.
 * Size: evaluate 50 stocks per cycle → full universe covered every ~3 cycles (~15 min)
 */
export function getCycleWatchlist(rotationSeed: number, sampleSize = 50): string[] {
  const shuffled = [...NSE_UNIVERSE];
  // Seeded Fisher-Yates shuffle using cycle bucket as seed
  let seed = rotationSeed;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(sampleSize, shuffled.length));
}

// ─── Earnings Calendar ────────────────────────────────────────────────────────

/**
 * Fetch upcoming earnings dates for a batch of NSE symbols via Twelve Data /earnings.
 * Upserts into the earnings_calendar table. Called weekly as a background job.
 * Fails silently per-symbol — missing data never blocks trading.
 */
export async function fetchEarningsCalendar(nseSymbols: string[]): Promise<void> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return;

  const { run: dbRun } = await import('../db/turso.js');
  let fetched = 0;

  for (const sym of nseSymbols) {
    const tdSymbol = sym.replace('.NS', ':NSE');
    const url = `https://api.twelvedata.com/earnings?symbol=${encodeURIComponent(tdSymbol)}&outputsize=5&apikey=${apiKey}`;
    try {
      const { data } = await httpsGet(url);
      if (!data?.earnings || data.status === 'error') continue;
      for (const e of data.earnings as any[]) {
        if (!e.date) continue;
        await dbRun(
          `INSERT INTO earnings_calendar (symbol, earnings_date, is_confirmed)
           VALUES (?, ?, ?)
           ON CONFLICT(symbol, earnings_date) DO UPDATE SET is_confirmed=excluded.is_confirmed, fetched_at=CURRENT_TIMESTAMP`,
          [sym, e.date, e.time != null ? 1 : 0]
        );
        fetched++;
      }
    } catch {
      // Per-symbol failure is non-fatal
    }
  }
  console.log(`[EarningsCalendar] Upserted ${fetched} earnings dates for ${nseSymbols.length} symbols`);
}

/**
 * Returns true if the given NSE symbol has an earnings announcement within ±48h of now.
 * Used as a BUY blackout gate in the risk engine.
 */
export async function isInEarningsBlackout(nseSymbol: string): Promise<boolean> {
  const { queryOne: dbQueryOne } = await import('../db/turso.js');
  const row = await dbQueryOne(
    `SELECT earnings_date FROM earnings_calendar
     WHERE symbol = ?
       AND earnings_date BETWEEN date('now', '-2 days') AND date('now', '+2 days')
     LIMIT 1`,
    [nseSymbol]
  );
  return row != null;
}

/**
 * Phase 13: Returns average daily traded value (INR) for a symbol.
 * Computed as averageVolume × current price from cached quote data.
 * Returns null when quote unavailable (liquidity gate will skip the check).
 */
export async function getAvgDailyTradedValue(symbol: string): Promise<number | null> {
  try {
    const q = await getQuote(symbol);
    if (!q.averageVolume || !q.price) return null;
    return q.averageVolume * q.price;
  } catch {
    return null;
  }
}
