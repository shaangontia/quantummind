import Chip from '@mui/material/Chip';
import type { StrategyTypeBadgeProps, StrategyType } from './StrategyTypeBadge.types.ts';

const STRATEGY_CONFIG: Record<StrategyType, { label: string; bg: string; color: string }> = {
  MEAN_REVERSION: { label: 'Mean Reversion', bg: 'rgba(139,92,246,0.15)', color: '#a78bfa' },
  MOMENTUM:       { label: 'Momentum',       bg: 'rgba(16,185,129,0.15)',  color: '#34d399' },
  VALUE:          { label: 'Value',          bg: 'rgba(245,158,11,0.15)', color: '#fbbf24' },
  NEWS_CATALYST:  { label: 'News Catalyst',  bg: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
};

/**
 * Colour-coded MUI Chip showing which strategy triggered a holding or signal.
 * Renders nothing if strategyType is absent.
 */
export const StrategyTypeBadge = ({ strategy }: StrategyTypeBadgeProps) => {
  if (!strategy) return null;
  const cfg = STRATEGY_CONFIG[strategy];
  return (
    <Chip
      label={cfg.label}
      size="small"
      title={`Strategy: ${cfg.label}`}
      sx={{ bgcolor: cfg.bg, color: cfg.color, fontWeight: 600, fontSize: '0.65rem', height: 20, border: 'none', '& .MuiChip-label': { px: 0.75 } }}
    />
  );
};
