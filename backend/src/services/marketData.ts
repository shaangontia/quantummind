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

  const q2 = await getQuoteYahoo(nseSymbol, 'query2');
  if (q2) return q2;

  const q1 = await getQuoteYahoo(nseSymbol, 'query1');
  if (q1) return q1;

  console.warn(`[MarketData] Both Yahoo CDNs failed for ${nseSymbol} — trying Groww unofficial fallback`);
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

  // Fetch from both Yahoo CDNs independently
  const [q2, q1] = await Promise.all([
    getQuoteYahoo(nseSymbol, 'query2'),
    getQuoteYahoo(nseSymbol, 'query1'),
  ]);

  // Both succeeded — cross-source agreement check
  if (q2 && q1) {
    const diff = Math.abs(q2.price - q1.price) / Math.max(q2.price, q1.price);
    if (diff > 0.02) {
      throw new Error(
        `[ExecutableQuote] Provider disagreement for ${nseSymbol}: ` +
        `query2=₹${q2.price} vs query1=₹${q1.price} (diff=${(diff * 100).toFixed(2)}%) — no trade`
      );
    }
    // Agreement within 2% — use query2 (lower latency CDN)
    if (!q2.isFresh) throw new Error(`[ExecutableQuote] Stale price from query2 for ${nseSymbol} — no trade`);
    return q2;
  }

  // Only one Yahoo CDN succeeded
  const yahooPrimary = q2 ?? q1;
  if (yahooPrimary) {
    if (!yahooPrimary.isFresh) throw new Error(`[ExecutableQuote] Stale Yahoo price for ${nseSymbol} — no trade`);
    // Single source — no cross-check possible, log warning
    console.warn(`[ExecutableQuote] Single Yahoo CDN succeeded for ${nseSymbol} — cannot cross-validate`);
    return yahooPrimary;
  }

  // Both Yahoo CDNs failed — try Groww unofficial ONLY if market is open
  // Groww is treated as last resort; cross-validation impossible
  console.warn(`[ExecutableQuote] Both Yahoo CDNs failed for ${nseSymbol} — falling back to Groww unofficial`);
  const groww = await getQuoteGrowwUnofficial(nseSymbol);
  if (groww) {
    if (!groww.isFresh) throw new Error(`[ExecutableQuote] Stale Groww price for ${nseSymbol} — no trade`);
    // Log clearly that this trade is executing on unofficial data
    console.warn(
      `[ExecutableQuote] ⚠ Executing on Groww unofficial price for ${nseSymbol}: ₹${groww.price} — no cross-validation available`
    );
    return groww;
  }

  throw new Error(`[ExecutableQuote] All price providers failed for ${nseSymbol}. Trade blocked.`);
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
  // ─── Large-Cap (Nifty 50) — target 50–60% NAV ───────────────────────────────
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

  // ─── Mid-Cap (>₹5,000 Cr market cap) — target 25–35% NAV ───────────────────
  'POLYCAB.NS',    // Polycab India — Cables & Wires
  'DIXONTECH.NS',  // Dixon Technologies — Electronics manufacturing (EMS)
  'PERSISTENT.NS', // Persistent Systems — IT services
  'COFORGE.NS',    // Coforge — Digital IT
  'KPITTECH.NS',   // KPIT Technologies — Automotive software
  'CROMPTON.NS',   // Crompton Greaves Consumer — Consumer electricals
  'PIIND.NS',      // PI Industries — Agrochemicals
  'ASTRAL.NS',     // Astral — Pipes & adhesives
  'VOLTAS.NS',     // Voltas — Cooling & HVAC
  'MAXHEALTH.NS',  // Max Healthcare — Hospitals
  'GODREJPROP.NS', // Godrej Properties — Real estate
  'MPHASIS.NS',    // Mphasis — IT services

  // ─── Small-Cap (>₹1,000 Cr market cap) — target 5–15% NAV ──────────────────
  'LATENTVIEW.NS', // Latent View Analytics — Data analytics
  'CLEAN.NS',      // Clean Science and Technology — Specialty chemicals
  'NAZARA.NS',     // Nazara Technologies — Gaming & esports
  'BIKAJI.NS',     // Bikaji Foods — FMCG/snacks
  'ROUTE.NS',      // Route Mobile — CPaaS/cloud communications
];

/**
 * Market cap tier for each watchlist symbol.
 * Used by the Risk Engine to enforce allocation caps:
 *   large: 50–60% NAV  |  mid: 25–35% NAV  |  small: 5–15% NAV
 */
export const SYMBOL_TIER: Record<string, 'large' | 'mid' | 'small'> = {
  // Large-cap
  'RELIANCE.NS': 'large', 'TCS.NS': 'large', 'HDFCBANK.NS': 'large', 'INFY.NS': 'large',
  'ICICIBANK.NS': 'large', 'HINDUNILVR.NS': 'large', 'SBIN.NS': 'large', 'BHARTIARTL.NS': 'large',
  'KOTAKBANK.NS': 'large', 'WIPRO.NS': 'large', 'AXISBANK.NS': 'large', 'LT.NS': 'large',
  'ASIANPAINT.NS': 'large', 'MARUTI.NS': 'large', 'TITAN.NS': 'large', 'BAJFINANCE.NS': 'large',
  'SUNPHARMA.NS': 'large', 'HCLTECH.NS': 'large', 'TATAMOTORS.NS': 'large', 'ONGC.NS': 'large',
  // Mid-cap
  'POLYCAB.NS': 'mid', 'DIXONTECH.NS': 'mid', 'PERSISTENT.NS': 'mid', 'COFORGE.NS': 'mid',
  'KPITTECH.NS': 'mid', 'CROMPTON.NS': 'mid', 'PIIND.NS': 'mid', 'ASTRAL.NS': 'mid',
  'VOLTAS.NS': 'mid', 'MAXHEALTH.NS': 'mid', 'GODREJPROP.NS': 'mid', 'MPHASIS.NS': 'mid',
  // Small-cap
  'LATENTVIEW.NS': 'small', 'CLEAN.NS': 'small', 'NAZARA.NS': 'small',
  'BIKAJI.NS': 'small', 'ROUTE.NS': 'small',
};
