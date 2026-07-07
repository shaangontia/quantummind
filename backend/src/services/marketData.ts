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

function yahooGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

export async function getQuote(symbol: string): Promise<StockQuote> {
  const nseSymbol = toNseSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(nseSymbol)}?interval=1d&range=1d`;
  const json = await yahooGet(url);
  const result = json.chart?.result?.[0];
  const meta = result?.meta ?? {};

  return {
    symbol: nseSymbol,
    price: meta.regularMarketPrice ?? 0,
    change: (meta.regularMarketPrice ?? 0) - (meta.chartPreviousClose ?? meta.regularMarketPrice ?? 0),
    changePct: meta.regularMarketPrice && meta.chartPreviousClose
      ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100
      : 0,
    volume: meta.regularMarketVolume ?? 0,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    shortName: meta.shortName,
    timestamp: new Date(),
  };
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
