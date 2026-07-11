export type GeminiRiskLevel = 'low' | 'medium' | 'high';
export type GeminiNewsEventType = 'earnings' | 'fraud' | 'downgrade' | 'macro' | 'sector' | 'none';

export interface GeminiRiskSummaryProps {
  riskLevel?: GeminiRiskLevel;
  redFlags?: string[];
  newsEventType?: GeminiNewsEventType;
  confidence?: number;
}
