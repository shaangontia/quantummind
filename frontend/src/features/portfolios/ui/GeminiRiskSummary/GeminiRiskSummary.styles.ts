import type { CSSProperties } from 'react';
import type { GeminiRiskLevel } from './GeminiRiskSummary.types.ts';

const RISK_COLORS: Record<GeminiRiskLevel, { bg: string; border: string; badge: string; text: string }> = {
  low:    { bg: 'rgba(16,185,129,0.06)',  border: 'rgba(16,185,129,0.2)',  badge: '#10b981', text: '#10b981' },
  medium: { bg: 'rgba(245,158,11,0.06)',  border: 'rgba(245,158,11,0.2)',  badge: '#f59e0b', text: '#f59e0b' },
  high:   { bg: 'rgba(239,68,68,0.06)',   border: 'rgba(239,68,68,0.2)',   badge: '#ef4444', text: '#ef4444' },
};

export const getContainerStyle = (level: GeminiRiskLevel): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 10px',
  borderRadius: 6,
  background: RISK_COLORS[level].bg,
  border: `1px solid ${RISK_COLORS[level].border}`,
  marginTop: 4,
});

export const getHeaderStyle = (level: GeminiRiskLevel): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.72rem',
  fontWeight: 700,
  color: RISK_COLORS[level].text,
  textTransform: 'uppercase' as CSSProperties['textTransform'],
  letterSpacing: '0.06em',
});

export const flagListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

export const flagChipStyle: CSSProperties = {
  fontSize: '0.68rem',
  padding: '1px 6px',
  borderRadius: 4,
  background: 'rgba(239,68,68,0.12)',
  color: '#fca5a5',
  border: '1px solid rgba(239,68,68,0.2)',
};

export const eventTypeStyle: CSSProperties = {
  fontSize: '0.68rem',
  color: 'var(--text-muted, #64748b)',
};
