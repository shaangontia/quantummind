export type RiskTolerance = 'Low' | 'Medium' | 'High' | 'Very High';
export type RebalanceFrequency = 'Weekly' | 'Monthly' | 'Quarterly';
export type TradeAction = 'BUY' | 'SELL';
export type SignalType = 'BUY' | 'SELL' | 'HOLD' | 'WATCH';
export type SignalStrength = 'STRONG' | 'MODERATE' | 'WEAK';

export interface Portfolio {
  id: number;
  name: string;
  description?: string;
  initial_capital: number;
  current_cash: number;
  risk_tolerance: RiskTolerance;
  investment_horizon_months: number;
  target_return_pct: number;
  rebalance_frequency: RebalanceFrequency;
  preferred_sectors?: string; // JSON array
  preferred_caps?: string;    // JSON array
  volatility_preference?: 'low' | 'medium' | 'high';
  investment_goal?: 'growth' | 'income' | 'retirement';
  max_drawdown_pct?: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export type UpdatePortfolioPayload = Partial<CreatePortfolioPayload>;

export type PortfolioLifecycleState = 'VIRGIN' | 'ACTIVE' | 'MATURE' | 'DRAWDOWN_HALT' | 'ARCHIVED';

export type EditableField =
  | 'name' | 'description' | 'capitalTopUp' | 'capitalReduction'
  | 'rebalanceFrequency' | 'targetReturnPct' | 'investmentHorizonMonths'
  | 'preferredSectors' | 'preferredCaps' | 'volatilityPreference'
  | 'investmentGoal' | 'riskTolerance' | 'maxDrawdownPct';

export interface PortfolioEditState {
  state: PortfolioLifecycleState;
  editability: {
    free: EditableField[];
    warn: EditableField[];
    locked: EditableField[];
    capitalFloor: number;
  };
  meta: {
    holdingsCount: number;
    tradeCount: number;
    drawdownPct: number;
    drawdownLimit: number;
  };
}

export interface CreatePortfolioPayload {
  name: string;
  description?: string;
  initialCapital: number;
  /** Optional — backend derives this from scoring inputs if omitted */
  riskTolerance?: RiskTolerance;
  investmentHorizonMonths: number;
  targetReturnPct: number;
  rebalanceFrequency: RebalanceFrequency;
  preferredSectors?: string[];
  preferredCaps?: string[];
  volatilityPreference?: 'low' | 'medium' | 'high';
  investmentGoal?: 'growth' | 'income' | 'retirement';
  maxDrawdownPct?: number;
}

export interface Holding {
  id: number;
  portfolio_id: number;
  symbol: string;
  company_name: string;
  sector?: string;
  quantity: number;
  avg_buy_price: number;
  current_price?: number;
  last_price_updated?: string;
}

export interface Trade {
  id: number;
  portfolio_id: number;
  trade_time: string;
  symbol: string;
  company_name?: string;
  action: TradeAction;
  quantity: number;
  price: number;
  amount: number;
  brokerage: number;
  net_amount: number;
  signal_reason?: string;
  portfolio_value_before?: number;
  portfolio_value_after?: number;
  realized_pnl?: number | null;
  status: 'EXECUTED' | 'SIMULATED' | 'FAILED';
}

export interface PerformanceSnapshot {
  id: number;
  portfolio_id: number;
  snapshot_time: string;
  total_portfolio_value: number;
  invested_value: number;
  cash_balance: number;
  unrealized_pnl: number;
  realized_pnl: number;
  total_pnl: number;
  return_pct: number;
  target_return_pct: number;
  holdings_count: number;
}

export interface MarketSignal {
  id: number;
  portfolio_id: number;
  signal_time: string;
  symbol: string;
  signal_type: SignalType;
  strength?: SignalStrength;
  reason?: string;
  price_at_signal?: number;
  acted_upon: number;
  trade_id?: number;
}

export interface SummaryHolding {
  symbol: string;
  companyName: string;
  quantity: number;
  avgBuyPrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  priceStatus?: 'LIVE' | 'STALE';
  priceUpdatedAt?: string;
}

export interface PortfolioSummary {
  id: number;
  name: string;
  initialCapital: number;
  totalValue: number;
  investedValue: number;
  cashBalance: number;
  unrealizedPnl: number;
  /** unrealizedPnl / initialCapital × 100 — same denominator as returnPct */
  unrealizedPnlPct: number;
  realizedPnl: number;
  realizedPnlPct: number;
  totalPnl: number;
  /** totalPnl / initialCapital × 100 — same denominator as returnPct */
  totalPnlPct: number;
  /** Sum of all brokerage charges paid across all valid trades */
  totalBrokerage: number;
  returnPct: number;
  targetReturnPct: number;
  riskTolerance: RiskTolerance;
  investmentHorizonMonths: number;
  holdings: SummaryHolding[];
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}
