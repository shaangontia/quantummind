"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_CAP_TIERS = exports.SECTOR_MAP = exports.DEFAULT_WATCHLIST = exports.NSE_UNIVERSE = exports.MIN_TRADE_PRICE = void 0;
exports.toNseSymbol = toNseSymbol;
exports.isNseMarketOpen = isNseMarketOpen;
exports.getDynamicCycleWatchlist = getDynamicCycleWatchlist;
exports.getDisplayQuote = getDisplayQuote;
exports.getQuote = getQuote;
exports.getExecutableQuote = getExecutableQuote;
exports.getMultipleQuotes = getMultipleQuotes;
exports.getRsi = getRsi;
exports.getSymbolSector = getSymbolSector;
exports.getBiasedCycleWatchlist = getBiasedCycleWatchlist;
exports.getCycleWatchlist = getCycleWatchlist;
const https_1 = __importDefault(require("https"));
const cache_js_1 = require("../lib/cache.js");
function toNseSymbol(symbol) {
    return symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
}
// ── Symbol mapping ────────────────────────────────────────────────────────────
// Yahoo uses TCS.NS; Groww unofficial endpoint uses the bare ticker.
// Only NSE-listed (.NS) equities are supported for the Groww fallback.
// BSE-only (.BO), indices (^NSEI), and foreign tickers are NOT mapped.
function toGrowwTicker(nseSymbol) {
    if (!nseSymbol.endsWith('.NS'))
        return null; // BSE / index / foreign → no Groww mapping
    return nseSymbol.slice(0, -3).toUpperCase(); // TCS.NS → TCS
}
// ── Price validation ──────────────────────────────────────────────────────────
const MAX_STALE_MS = 30 * 60 * 1000; // 30 minutes — quotes older than this are stale
function validatePrice(price, symbol, source) {
    if (!price || price <= 0)
        throw new Error(`[${source}] Invalid price ${price} for ${symbol}`);
}
function isQuoteFresh(quoteTimestamp) {
    const ageMs = Date.now() - quoteTimestamp.getTime();
    // Allow stale outside market hours (NSE: 09:15-15:30 IST = UTC+5:30)
    const now = new Date();
    const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
    const istMin = (now.getUTCMinutes() + 30) % 60;
    const istTimeMin = istHour * 60 + istMin;
    const marketOpen = 9 * 60 + 15; // 09:15
    const marketClose = 15 * 60 + 30; // 15:30
    const isMarketHours = istTimeMin >= marketOpen && istTimeMin <= marketClose;
    return isMarketHours ? ageMs < MAX_STALE_MS : true; // Outside hours, stale is acceptable
}
// ── Market hours check ────────────────────────────────────────────────────────
function isNseMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun 6=Sat
    if (day === 0 || day === 6)
        return false;
    const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
    const istMin = (now.getUTCMinutes() + 30) % 60;
    const istTimeMin = istHour * 60 + istMin;
    return istTimeMin >= (9 * 60 + 15) && istTimeMin <= (15 * 60 + 30);
}
// ── Min price threshold ─────────────────────────────────────────────────────
exports.MIN_TRADE_PRICE = 30; // ₹30 — applies to all signals and universe filtering
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
async function fetchNseEquityList() {
    const CACHE_KEY = 'nse_equity_universe_v1';
    const cached = cache_js_1.memCache.get(CACHE_KEY);
    if (cached && cached.length > 0)
        return cached;
    return new Promise((resolve) => {
        const url = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
        const req = https_1.default.get(url, {
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
                resolve(exports.NSE_UNIVERSE);
                return;
            }
            if (res.statusCode !== 200) {
                console.warn(`[NSE Universe] HTTP ${res.statusCode} — falling back to static list`);
                resolve(exports.NSE_UNIVERSE);
                return;
            }
            let csv = '';
            res.on('data', (chunk) => { csv += chunk.toString(); });
            res.on('end', () => {
                try {
                    const lines = csv.split('\n').slice(1); // skip header
                    const symbols = [];
                    for (const line of lines) {
                        if (!line.trim())
                            continue;
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
                        resolve(exports.NSE_UNIVERSE);
                        return;
                    }
                    console.log(`[NSE Universe] Loaded ${symbols.length} NSE equity symbols dynamically`);
                    cache_js_1.memCache.set(CACHE_KEY, symbols, 24 * 3600); // cache 24h
                    resolve(symbols);
                }
                catch (err) {
                    console.warn('[NSE Universe] Parse error — falling back to static list:', err);
                    resolve(exports.NSE_UNIVERSE);
                }
            });
        });
        req.on('error', (err) => {
            console.warn('[NSE Universe] Fetch error — falling back to static list:', err.message);
            resolve(exports.NSE_UNIVERSE);
        });
        req.setTimeout(10000, () => {
            req.destroy();
            console.warn('[NSE Universe] Timeout — falling back to static list');
            resolve(exports.NSE_UNIVERSE);
        });
    });
}
/**
 * Returns a rotating sample from the FULL NSE equity universe (dynamic or static fallback).
 * sampleSize: number of stocks to evaluate per cycle (default 50).
 * Price filter (₹30+) is applied at signal generation time via Yahoo Finance quote.
 */
async function getDynamicCycleWatchlist(rotationSeed, sampleSize = 50) {
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
function httpsGet(url, headers = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers } };
        https_1.default.get(url, opts, (res) => {
            let data = '';
            res.on('data', (d) => { data += d; });
            res.on('end', () => {
                const latencyMs = Date.now() - start;
                try {
                    resolve({ data: JSON.parse(data), statusCode: res.statusCode ?? 0, latencyMs });
                }
                catch (e) {
                    reject(new Error(`JSON parse failed (status=${res.statusCode}, latency=${latencyMs}ms)`));
                }
            });
        }).on('error', reject);
    });
}
// ── Yahoo Finance (primary) ───────────────────────────────────────────────────
async function getQuoteYahoo(nseSymbol, cdnHost) {
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
        const quote = {
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
    }
    catch (err) {
        console.warn(`[MarketData] ${provider} FAIL ${nseSymbol}: ${String(err)}`);
        return null;
    }
}
// ── Groww unofficial fallback ─────────────────────────────────────────────────
// WARNING: This uses Groww's undocumented web/frontend endpoint.
// It is NOT the official Groww Trade API (which requires a bearer token + subscription).
// This endpoint has no SLA, schema may change without notice, and may be blocked.
// Use ONLY as a last resort. Do NOT execute trades from this source if price is stale.
async function getQuoteGrowwUnofficial(nseSymbol) {
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
        const returnedSymbol = (d.symbol ?? '').toUpperCase();
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
        const quote = {
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
    }
    catch (err) {
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
async function getDisplayQuote(symbol) {
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
async function getQuote(symbol) {
    const nseSymbol = toNseSymbol(symbol);
    const q2 = await getQuoteYahoo(nseSymbol, 'query2');
    if (q2)
        return q2;
    const q1 = await getQuoteYahoo(nseSymbol, 'query1');
    if (q1)
        return q1;
    console.warn(`[MarketData] Both Yahoo CDNs failed for ${nseSymbol} — trying Groww unofficial fallback`);
    const groww = await getQuoteGrowwUnofficial(nseSymbol);
    if (groww)
        return groww;
    throw new Error(`[MarketData] All price providers failed for ${nseSymbol}. No trade will be executed.`);
}
/**
 * Fetch a quote for TRADE EXECUTION.
 * Always makes a fresh network call. Never uses in-memory state from previous calls.
 * Performs cross-source agreement check: if two sources differ by > 2%, throws.
 * Callers must ALSO check isFresh on the returned quote.
 */
async function getExecutableQuote(symbol) {
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
            throw new Error(`[ExecutableQuote] Provider disagreement for ${nseSymbol}: ` +
                `query2=₹${q2.price} vs query1=₹${q1.price} (diff=${(diff * 100).toFixed(2)}%) — no trade`);
        }
        // Agreement within 2% — use query2 (lower latency CDN)
        if (!q2.isFresh)
            throw new Error(`[ExecutableQuote] Stale price from query2 for ${nseSymbol} — no trade`);
        return q2;
    }
    // Only one Yahoo CDN succeeded
    const yahooPrimary = q2 ?? q1;
    if (yahooPrimary) {
        if (!yahooPrimary.isFresh)
            throw new Error(`[ExecutableQuote] Stale Yahoo price for ${nseSymbol} — no trade`);
        // Single source — no cross-check possible, log warning
        console.warn(`[ExecutableQuote] Single Yahoo CDN succeeded for ${nseSymbol} — cannot cross-validate`);
        return yahooPrimary;
    }
    // Both Yahoo CDNs failed — try Groww unofficial ONLY if market is open
    // Groww is treated as last resort; cross-validation impossible
    console.warn(`[ExecutableQuote] Both Yahoo CDNs failed for ${nseSymbol} — falling back to Groww unofficial`);
    const groww = await getQuoteGrowwUnofficial(nseSymbol);
    if (groww) {
        if (!groww.isFresh)
            throw new Error(`[ExecutableQuote] Stale Groww price for ${nseSymbol} — no trade`);
        // Log clearly that this trade is executing on unofficial data
        console.warn(`[ExecutableQuote] ⚠ Executing on Groww unofficial price for ${nseSymbol}: ₹${groww.price} — no cross-validation available`);
        return groww;
    }
    throw new Error(`[ExecutableQuote] All price providers failed for ${nseSymbol}. Trade blocked.`);
}
async function getMultipleQuotes(symbols) {
    const results = await Promise.allSettled(symbols.map(getQuote));
    const quotes = [];
    for (const r of results) {
        if (r.status === 'fulfilled')
            quotes.push(r.value);
        else
            console.warn('[MarketData] getMultipleQuotes error:', r.reason);
    }
    return quotes;
}
// ── Historical data (Yahoo only — Groww unofficial has no history endpoint) ──
async function getHistoricalCloses(symbol, days = 40) {
    const nseSymbol = toNseSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=3mo`;
    const { data: json } = await httpsGet(url);
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    return closes.filter((c) => c !== null && c > 0).slice(-days);
}
async function getRsi(symbol, period = 14) {
    try {
        const closes = await getHistoricalCloses(symbol, period + 10);
        if (closes.length < period + 1)
            return null;
        const recent = closes.slice(-(period + 1));
        let gains = 0, losses = 0;
        for (let i = 1; i < recent.length; i++) {
            const diff = recent[i] - recent[i - 1];
            if (diff > 0)
                gains += diff;
            else
                losses += Math.abs(diff);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0)
            return 100;
        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }
    catch {
        return null;
    }
}
// NSE blue-chip watchlist — no penny stocks, all established companies
/**
 * NSE Open Universe — ~150 liquid NSE-listed stocks across all market cap segments.
 * No tier restrictions. The Risk Engine enforces only per-symbol position caps (10% NAV).
 * The market cycle evaluates a rotating sample each run to stay within API rate limits.
 * Min price filter: ₹50 (applied in signal engine). No sector or cap-size restrictions.
 *
 * Expansion: Add any NSE-listed symbol ending in .NS. The system will automatically
 * include it in rotation on the next deploy.
 */
exports.NSE_UNIVERSE = [
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
exports.DEFAULT_WATCHLIST = exports.NSE_UNIVERSE;
/**
 * GICS-aligned sector taxonomy for NSE_UNIVERSE symbols.
 * Used for sector concentration checks in the risk engine and
 * sector allocation display in the dashboard.
 * Symbols not listed here default to 'Other'.
 */
exports.SECTOR_MAP = {
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
function getSymbolSector(symbol) {
    return exports.SECTOR_MAP[symbol] ?? 'Other';
}
/**
 * Best-effort market cap tier classification for known NSE symbols.
 * Used for cap-preference biasing in portfolio stock selection.
 * NOT used as a hard allocation restriction (that feature was removed).
 * Symbols not in this map are treated as 'unknown' and included in all tiers.
 */
exports.KNOWN_CAP_TIERS = {
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
function getBiasedCycleWatchlist(universe, preferred, seed, sampleSize = 50, biasRatio = 0.5) {
    const preferred_symbols = universe.filter(s => exports.KNOWN_CAP_TIERS[s] === preferred);
    const other_symbols = universe.filter(s => exports.KNOWN_CAP_TIERS[s] !== preferred);
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
function getCycleWatchlist(rotationSeed, sampleSize = 50) {
    const shuffled = [...exports.NSE_UNIVERSE];
    // Seeded Fisher-Yates shuffle using cycle bucket as seed
    let seed = rotationSeed;
    for (let i = shuffled.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, Math.min(sampleSize, shuffled.length));
}
