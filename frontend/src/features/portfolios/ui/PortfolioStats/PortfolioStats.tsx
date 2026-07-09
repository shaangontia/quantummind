import { memo } from 'react';
import { useGetPortfolioSummaryQuery } from '../../../../store/portfolios/index.ts';
import { StatCard } from '../../../../shared/ui/StatCard/StatCard.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { formatINR, formatPct } from '../../model/portfolios.utils.ts';
import { useMarketPolling } from '../../hooks/useMarketPolling.ts';
import type { PortfolioStatsProps } from './PortfolioStats.types.ts';

/**
 * Owns its own RTK Query subscription for summary stats.
 * Only re-renders when the stats slice of summary data changes.
 * Polls during NSE market hours only.
 */
/**
 * Memoized — `portfolioId` is a stable number, so this component only re-renders
 * from its own RTK Query subscription (selectFromResult stats slice), never from
 * the parent orchestrator's re-renders.
 */
export const PortfolioStats = memo(({ portfolioId }: PortfolioStatsProps) => {
  const pollingInterval = useMarketPolling();

  const { data: stats, isLoading } = useGetPortfolioSummaryQuery(portfolioId, {
    pollingInterval,
    selectFromResult: ({ data, isLoading: loading }) => ({
      isLoading: loading,
      data: data
        ? {
            totalValue:              data.totalValue,
            investedValue:           data.investedValue,
            cashBalance:             data.cashBalance,
            unrealizedPnl:           data.unrealizedPnl,
            unrealizedPnlPct:        data.unrealizedPnlPct,  // already uses initialCapital denominator
            totalPnl:                data.totalPnl,
            totalPnlPct:             data.totalPnlPct,       // already uses initialCapital denominator
            totalBrokerage:          data.totalBrokerage,
            returnPct:               data.returnPct,
            targetReturnPct:         data.targetReturnPct,
            investmentHorizonMonths: data.investmentHorizonMonths,
            holdingsCount:           data.holdings.length,
          }
        : undefined,
    }),
  });

  if (isLoading || !stats) {
    return (
      <div className="stats-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} height={80} borderRadius={8} />
        ))}
      </div>
    );
  }

  const isPositive     = stats.returnPct >= 0;
  const targetGapPct   = stats.targetReturnPct - stats.returnPct;
  // Use backend-computed pcts (initialCapital denominator) for consistency with returnPct
  const unrealizedPnlPct = stats.unrealizedPnlPct;
  const totalPnlPct      = stats.totalPnlPct;

  return (
    <div className="stats-grid">
      <StatCard
        label="Total Portfolio Value"
        value={formatINR(stats.totalValue)}
        sub={formatPct(stats.returnPct)}
        trend={isPositive ? 'up' : 'down'}
      />
      <StatCard
        label="Invested Value"
        value={formatINR(stats.investedValue)}
      />
      <StatCard
        label="Cash Balance"
        value={formatINR(stats.cashBalance)}
        sub="Available"
        trend="neutral"
      />
      <StatCard
        label="Unrealized P&L"
        value={(stats.unrealizedPnl >= 0 ? '+' : '') + formatINR(stats.unrealizedPnl)}
        sub={formatPct(unrealizedPnlPct) + ' of capital'}
        trend={stats.unrealizedPnl >= 0 ? 'up' : 'down'}
        accent={stats.unrealizedPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}
      />
      <StatCard
        label="Total P&L"
        value={(stats.totalPnl >= 0 ? '+' : '') + formatINR(stats.totalPnl)}
        sub={formatPct(totalPnlPct) + ' of capital'}
        trend={stats.totalPnl >= 0 ? 'up' : 'down'}
        accent={stats.totalPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}
      />
      {/* NOTE: totalBrokerage is tracked and present in stats but intentionally not displayed.
           TODO: Surface this when CostAdjustedSignalValidator integration is prioritised.
           Data is already captured per-trade for future cost-aware signal scoring. */}
      <StatCard
        label="Target Return"
        value={`${stats.targetReturnPct}%`}
        sub={targetGapPct > 0 ? `${targetGapPct.toFixed(1)}% to go` : 'Target achieved!'}
        trend={targetGapPct <= 0 ? 'up' : 'neutral'}
        accent="var(--accent-purple)"
      />
      <StatCard
        label="Holdings"
        value={String(stats.holdingsCount)}
        sub={`${stats.investmentHorizonMonths}m horizon`}
        trend="neutral"
      />
    </div>
  );
});

PortfolioStats.displayName = 'PortfolioStats';
