import type { CSSProperties } from 'react';
import type { StrategyType } from './StrategyTypeBadge.types.ts';

const STRATEGY_PALETTE: Record<StrategyType, { bg: string; color: string }> = {
  MEAN_REVERSION: { bg: 'rgba(139,92,246,0.15)', color: '#a78bfa' },
  MOMENTUM:       { bg: 'rgba(16,185,129,0.15)',  color: '#34d399' },
  VALUE:          { bg: 'rgba(245,158,11,0.15)',  color: '#fbbf24' },
  NEWS_CATALYST:  { bg: 'rgba(59,130,246,0.15)',  color: '#60a5fa' },
};

export const getStrategyBadgeStyle = (strategy: StrategyType): CSSProperties => ({
  display: 'inline-block',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  padding: '1px 6px',
  borderRadius: 4,
  background: STRATEGY_PALETTE[strategy].bg,
  color: STRATEGY_PALETTE[strategy].color,
  whiteSpace: 'nowrap',
});
