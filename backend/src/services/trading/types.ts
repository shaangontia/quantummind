/** Shared types for the trading engine. */

export interface TradeSignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: 'STRONG' | 'MODERATE' | 'WEAK';
  reason: string;
  price: number;
  mlBoost?: number;
  groqSentiment?: string;
}

export interface HoldingSummary {
  symbol: string;
  companyName: string;
  sector?: string;
  quantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  /** LIVE = updated within last 15 min, STALE = older */
  priceStatus: 'LIVE' | 'STALE';
  priceUpdatedAt?: string;
}

export interface PortfolioSummary {
  id: number;
  name: string;
  totalValue: number;
  investedValue: number;
  cashBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  returnPct: number;
  targetReturnPct: number;
  riskTolerance: string;
  investmentHorizonMonths: number;
  holdings: HoldingSummary[];
}

export interface PortfolioSignalContext {
  totalNAV: number;
  cashBalance: number;
  holdings: number;
  sectorExposurePct?: number;
  proposedPositionPct?: number;
}

export interface TradeContext {
  rsiValue?: number | null;
  momentumScore?: number | null;
  mlBoost?: number | null;
  kellyFraction?: number | null;
  groqSentiment?: string | null;
  signalStrength?: string | null;
  riskChecks?: string[] | null;
}
