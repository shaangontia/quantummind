import {
  getContainerStyle,
  getHeaderStyle,
  flagListStyle,
  flagChipStyle,
  eventTypeStyle,
} from './GeminiRiskSummary.styles.ts';
import type { GeminiRiskSummaryProps } from './GeminiRiskSummary.types.ts';

const RISK_ICON: Record<string, string> = { low: '✅', medium: '⚠️', high: '🚨' };

/**
 * Structured Gemini risk analysis display for a signal card.
 * Shows risk level, red flags, and detected news event type.
 * Renders nothing if no Gemini data is present (safe pre-rollout).
 */
export const GeminiRiskSummary = ({
  riskLevel,
  redFlags,
  newsEventType,
  confidence,
}: GeminiRiskSummaryProps) => {
  if (!riskLevel) return null;

  const hasFlags = redFlags && redFlags.length > 0;
  const hasEvent = newsEventType && newsEventType !== 'none';

  return (
    <div style={getContainerStyle(riskLevel)} aria-label={`Gemini risk: ${riskLevel}`}>
      <div style={getHeaderStyle(riskLevel)}>
        {RISK_ICON[riskLevel]} Gemini: {riskLevel} risk
        {confidence != null && (
          <span style={{ fontWeight: 400, fontSize: '0.68rem', opacity: 0.7, textTransform: 'none' }}>
            ({confidence}% confidence)
          </span>
        )}
      </div>
      {hasFlags && (
        <div style={flagListStyle}>
          {redFlags.map(flag => (
            <span key={flag} style={flagChipStyle}>{flag}</span>
          ))}
        </div>
      )}
      {hasEvent && (
        <span style={eventTypeStyle}>📅 Event: {newsEventType}</span>
      )}
    </div>
  );
};
