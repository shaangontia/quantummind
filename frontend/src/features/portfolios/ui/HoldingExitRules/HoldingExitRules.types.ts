export interface HoldingExitRulesProps {
  atrStopPrice?: number;
  trailingStopPrice?: number;
  timeStopDate?: string;
  riskAmountInr?: number;
  currentPrice?: number;
  thesisInvalidated?: boolean;
}
