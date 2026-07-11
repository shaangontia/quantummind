import { getStrategyBadgeStyle } from './StrategyTypeBadge.styles.ts';
import type { StrategyTypeBadgeProps, StrategyType } from './StrategyTypeBadge.types.ts';

const STRATEGY_LABEL: Record<StrategyType, string> = {
  MEAN_REVERSION: 'Mean Reversion',
  MOMENTUM:       'Momentum',
  VALUE:          'Value',
  NEWS_CATALYST:  'News Catalyst',
};

/**
 * Colour-coded badge showing which strategy triggered a holding or signal.
 * Renders nothing if strategyType is absent (safe before backend ships field).
 */
export const StrategyTypeBadge = ({ strategy }: StrategyTypeBadgeProps) => {
  if (!strategy) return null;
  return (
    <span style={getStrategyBadgeStyle(strategy)} title={`Strategy: ${STRATEGY_LABEL[strategy]}`}>
      {STRATEGY_LABEL[strategy]}
    </span>
  );
};
