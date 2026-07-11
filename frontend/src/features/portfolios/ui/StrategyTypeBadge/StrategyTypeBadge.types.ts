export type StrategyType = 'MEAN_REVERSION' | 'MOMENTUM' | 'VALUE' | 'NEWS_CATALYST';

export interface StrategyTypeBadgeProps {
  strategy?: StrategyType;
}
