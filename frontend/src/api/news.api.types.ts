export type SentimentLabel = 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';

export interface NewsItem {
  symbol: string;
  companyName: string;
  date: string;
  category: string;
  headline: string;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
}
