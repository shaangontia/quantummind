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
}

export function toNseSymbol(symbol: string): string {
  return symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', ...headers } };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/** Groww public API — no auth, live NSE prices */
async function getQuoteGroww(nseSymbol: string): Promise<StockQuote | null> {
  try {
    const ticker = nseSymbol.replace('.NS', '').toUpperCase();
    const url = `https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/CASH/${ticker}/latest`;
    const d = await httpsGet(url, { Accept: 'application/json', Referer: 'https://groww.in/' });
    if (!d?.ltp) return null;
    const prev = d.ltp - (d.dayChange ?? 0);
    return {
      symbol: nseSymbol,
      price: d.ltp,
      change: d.dayChange ?? 0,
      changePct: d.dayChangePerc ?? 0,
      volume: d.volume ?? 0,
      fiftyTwoWeekHigh: d.yearHighPrice,
      fiftyTwoWeekLow: d.yearLowPrice,
      timestamp: new Date(),
    };
  } catch { return null; }
}

/** Yahoo Finance v8 — primary source */
async function getQuoteYahoo(nseSymbol: string): Promise<StockQuote | null> {
  try {
    // Try query2 first (different CDN, less blocked)
    const urls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=1d`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=1d`,
    ];
    for (const url of urls) {
      try {
        const json = await httpsGet(url);
        const meta = json.chart?.result?.[0]?.meta ?? {};
        if (!meta.regularMarketPrice) continue;
        return {
          symbol: nseSymbol,
          price: meta.regularMarketPrice,
          change: (meta.regularMarketPrice) - (meta.chartPreviousClose ?? meta.regularMarketPrice),
          changePct: meta.chartPreviousClose
            ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
          volume: meta.regularMarketVolume ?? 0,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          shortName: meta.shortName,
          timestamp: new Date(),
        };
      } catch { continue; }
    }
    return null;
  } catch { return null; }
}

/** Primary: Yahoo Finance → Fallback: Groww */
export async function getQuote(symbol: string): Promise<StockQuote> {
  const nseSymbol = toNseSymbol(symbol);
  const yahoo = await getQuoteYahoo(nseSymbol);
  if (yahoo) return yahoo;
  const groww = await getQuoteGroww(nseSymbol);
  if (groww) { console.log(`[MarketData] Yahoo failed for ${nseSymbol}, used Groww`); return groww; }
  throw new Error(`All price sources failed for ${nseSymbol}`);
}

export async function getMultipleQuotes(symbols: string[]): Promise<StockQuote[]> {
  const results = await Promise.allSettled(symbols.map(getQuote));
  return results
    .filter((r): r is PromiseFulfilledResult<StockQuote> => r.status === 'fulfilled')
    .map(r => r.value);
}

// Get historical closes for RSI calculation
async function getHistoricalCloses(symbol: string, days = 40): Promise<number[]> {
  const nseSymbol = toNseSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=3mo`;
  const json = await yahooGet(url);
  const closes: number[] = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  return closes.filter((c: any) => c !== null).slice(-days);
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
