export type MarketRegime = 'BULL' | 'BEAR' | 'SIDEWAYS';

export interface RegimeData {
  regime: MarketRegime;
  nifty50Trend: number;
  nifty50Rsi: number;
  volatilityPct: number;
  rsiBuy: number;
  rsiSell: number;
  stopLoss: number;
  notes: string;
}

export interface SignalWeight {
  source: string;
  weight: number;
  winRate: number;
  totalSignals: number;
  winningSignals: number;
}

export interface AdaptiveReport {
  regime: RegimeData;
  signalWeights: SignalWeight[];
  recentOutcomes?: unknown[];
}
