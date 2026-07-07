import https from 'https';

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
  /** Which provider delivered this quote */
  provider: 'yahoo_query2' | 'yahoo_query1' | 'groww_unofficial' | 'cached';
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

// ── Yahoo Finance (primary) ───────────────────────────────────────────────────
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
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      shortName: meta.shortName,
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

  const q2 = await getQuoteYahoo(nseSymbol, 'query2');
  if (q2) return q2;

  const q1 = await getQuoteYahoo(nseSymbol, 'query1');
  if (q1) return q1;

  console.warn(`[MarketData] Both Yahoo CDNs failed for ${nseSymbol} — trying Groww unofficial fallback`);
  const groww = await getQuoteGrowwUnofficial(nseSymbol);
  if (groww) return groww;

  throw new Error(`[MarketData] All price providers failed for ${nseSymbol}. No trade will be executed.`);
}

export async function getMultipleQuotes(symbols: string[]): Promise<StockQuote[]> {
  const results = await Promise.allSettled(symbols.map(getQuote));
  const quotes: StockQuote[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') quotes.push(r.value);
    else console.warn('[MarketData] getMultipleQuotes error:', r.reason);
  }
  return quotes;
}

// ── Historical data (Yahoo only — Groww unofficial has no history endpoint) ──
async function getHistoricalCloses(symbol: string, days = 40): Promise<number[]> {
  const nseSymbol = toNseSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=3mo`;
  const { data: json } = await httpsGet(url);
  const closes: number[] = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c: any) => c !== null && c > 0).slice(-days);
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
export const DEFAULT_WATCHLIST = [
  'RELIANCE.NS',   // Reliance Industries — Conglomerate
  'TCS.NS',        // TCS — IT
  'HDFCBANK.NS',   // HDFC Bank — Banking
  'INFY.NS',       // Infosys — IT
  'ICICIBANK.NS',  // ICICI Bank — Banking
  'HINDUNILVR.NS', // Hindustan Unilever — FMCG
  'SBIN.NS',       // SBI — Banking
  'BHARTIARTL.NS', // Bharti Airtel — Telecom
  'KOTAKBANK.NS',  // Kotak Bank — Banking
  'WIPRO.NS',      // Wipro — IT
  'AXISBANK.NS',   // Axis Bank — Banking
  'LT.NS',         // L&T — Infrastructure
  'ASIANPAINT.NS', // Asian Paints — Consumer
  'MARUTI.NS',     // Maruti Suzuki — Auto
  'TITAN.NS',      // Titan — Consumer
  'BAJFINANCE.NS', // Bajaj Finance — NBFC
  'SUNPHARMA.NS',  // Sun Pharma — Pharma
  'HCLTECH.NS',    // HCL Tech — IT
  'TATAMOTORS.NS', // Tata Motors — Auto
  'ONGC.NS',       // ONGC — Energy
];
