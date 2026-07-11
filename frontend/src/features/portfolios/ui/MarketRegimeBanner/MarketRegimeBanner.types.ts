export type MarketRegimeLabel = 'BULLISH' | 'NEUTRAL' | 'BEARISH';
export type DmaPosition = 'above' | 'below';

export interface MarketRegimeData {
  label: MarketRegimeLabel;
  niftyVs50Dma: DmaPosition;
  niftyVs200Dma: DmaPosition;
  nifty50Close: number;
}

export interface MarketRegimeBannerProps {
  regime?: MarketRegimeData;
}
