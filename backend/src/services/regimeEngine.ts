/**
 * regimeEngine.ts — Phase 13: Market regime classification
 *
 * Inputs:  NIFTY 50 price vs 50/200 DMA (from index_prices table)
 * Outputs: BULLISH | NEUTRAL | BEARISH + DMA positions
 *
 * Rules:
 *   NIFTY above 50 DMA AND above 200 DMA → BULLISH
 *   NIFTY below 50 DMA AND above 200 DMA → NEUTRAL (mild caution)
 *   NIFTY below 200 DMA                   → BEARISH
 */

import { query } from '../db/turso.js';

export type MarketRegimeLabel = 'BULLISH' | 'NEUTRAL' | 'BEARISH';

export interface MarketRegimeData {
  label: MarketRegimeLabel;
  nifty50Close: number | null;
  niftyVs50Dma: 'above' | 'below' | 'unavailable';
  niftyVs200Dma: 'above' | 'below' | 'unavailable';
  dma50: number | null;
  dma200: number | null;
  allowedStrategies: string[];
  positionSizeMultiplier: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — regime doesn't change intraday
let _cache: { data: MarketRegimeData; ts: number } | null = null;

/**
 * Classify market regime from NIFTY 50 daily index prices.
 * Falls back to NEUTRAL when data unavailable.
 */
export async function classifyMarketRegime(): Promise<MarketRegimeData> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.data;

  // Fetch last 200 NIFTY 50 daily closes
  const rows: Array<{ close: number; date: string }> = await query(
    `SELECT close, date FROM index_prices
     WHERE symbol='^NSEI'
     ORDER BY date DESC LIMIT 210`,
  ).then(r => r.map(x => ({ close: Number(x.close), date: String(x.date) }))).catch(() => []);

  if (rows.length < 51) {
    const fallback: MarketRegimeData = {
      label: 'NEUTRAL',
      nifty50Close: null,
      niftyVs50Dma: 'unavailable',
      niftyVs200Dma: 'unavailable',
      dma50: null,
      dma200: null,
      allowedStrategies: ['MEAN_REVERSION', 'VALUE', 'NEWS_CATALYST'],
      positionSizeMultiplier: 0.75,
    };
    _cache = { data: fallback, ts: Date.now() };
    return fallback;
  }

  const closes = rows.map(r => r.close); // index 0 = most recent
  const latestClose = closes[0];

  // 50 DMA: avg of last 50 closes
  const dma50 = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;

  // 200 DMA: avg of last 200 closes (if we have enough)
  const dma200 = rows.length >= 200
    ? closes.slice(0, 200).reduce((a, b) => a + b, 0) / 200
    : null;

  const vs50: 'above' | 'below'  = latestClose >= dma50  ? 'above' : 'below';
  const vs200: 'above' | 'below' | 'unavailable' = dma200
    ? (latestClose >= dma200 ? 'above' : 'below')
    : 'unavailable';

  let label: MarketRegimeLabel;
  let allowedStrategies: string[];
  let positionSizeMultiplier: number;

  if (vs200 === 'below') {
    label = 'BEARISH';
    allowedStrategies = ['VALUE'];          // only deep value buys allowed in bear market
    positionSizeMultiplier = 0.4;           // 40% of normal size
  } else if (vs50 === 'below') {
    label = 'NEUTRAL';
    allowedStrategies = ['MEAN_REVERSION', 'VALUE', 'NEWS_CATALYST'];
    positionSizeMultiplier = 0.75;
  } else {
    label = 'BULLISH';
    allowedStrategies = ['MEAN_REVERSION', 'MOMENTUM', 'VALUE', 'NEWS_CATALYST'];
    positionSizeMultiplier = 1.0;
  }

  const result: MarketRegimeData = {
    label,
    nifty50Close: latestClose,
    niftyVs50Dma: vs50,
    niftyVs200Dma: vs200,
    dma50,
    dma200,
    allowedStrategies,
    positionSizeMultiplier,
  };

  _cache = { data: result, ts: Date.now() };
  return result;
}

/** Invalidate cache (call after index_prices update) */
export function invalidateRegimeCache(): void {
  _cache = null;
}
