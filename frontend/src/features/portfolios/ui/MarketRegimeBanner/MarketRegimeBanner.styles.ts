import type { CSSProperties } from 'react';
import type { MarketRegimeLabel } from './MarketRegimeBanner.types.ts';

const REGIME_COLORS: Record<MarketRegimeLabel, { bg: string; border: string; text: string; dot: string }> = {
  BULLISH: { bg: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', text: '#10b981', dot: '#10b981' },
  NEUTRAL: { bg: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', text: '#f59e0b', dot: '#f59e0b' },
  BEARISH: { bg: 'rgba(239,68,68,0.08)',  border: '1px solid rgba(239,68,68,0.25)',  text: '#ef4444', dot: '#ef4444' },
};

export const getBannerStyles = (label: MarketRegimeLabel) => {
  const c = REGIME_COLORS[label];
  return {
    banner: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 14px',
      borderRadius: 8,
      background: c.bg,
      border: c.border,
      marginBottom: 16,
      flexWrap: 'wrap' as CSSProperties['flexWrap'],
    } as CSSProperties,
    dot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: c.dot,
      flexShrink: 0,
    } as CSSProperties,
    label: {
      fontWeight: 700,
      fontSize: '0.78rem',
      color: c.text,
      letterSpacing: '0.05em',
    } as CSSProperties,
  };
};

export const dmaChipStyle: CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--text-muted, #64748b)',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 4,
  padding: '1px 6px',
};

export const niftyPriceStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--text-muted, #64748b)',
  marginLeft: 'auto',
};
