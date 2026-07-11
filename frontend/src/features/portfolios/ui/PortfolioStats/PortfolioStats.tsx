import { memo } from 'react';
import Grid from '@mui/material/Grid';
import { useGetPortfolioSummaryQuery } from '../../../../store/portfolios/index.ts';
import { StatCard } from '../../../../shared/ui/StatCard/StatCard.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { formatINR, formatPct } from '../../model/portfolios.utils.ts';
import { useMarketPolling } from '../../hooks/useMarketPolling.ts';
import type { PortfolioStatsProps } from './PortfolioStats.types.ts';

export const PortfolioStats = memo(({ portfolioId }: PortfolioStatsProps) => {
  const pollingInterval = useMarketPolling();

  const { data: stats, isLoading } = useGetPortfolioSummaryQuery(portfolioId, {
    pollingInterval,
    selectFromResult: ({ data, isLoading: loading }) => ({
      isLoading: loading,
      data: data ? {
        totalValue:              data.totalValue,
        investedValue:           data.investedValue,
        cashBalance:             data.cashBalance,
        unrealizedPnl:           data.unrealizedPnl,
        unrealizedPnlPct:        data.unrealizedPnlPct,
        totalPnl:                data.totalPnl,
        totalPnlPct:             data.totalPnlPct,
        totalBrokerage:          data.totalBrokerage,
        returnPct:               data.returnPct,
        targetReturnPct:         data.targetReturnPct,
        investmentHorizonMonths: data.investmentHorizonMonths,
        holdingsCount:           data.holdings.length,
      } : undefined,
    }),
  });

  if (isLoading || !stats) {
    return (
      <Grid container spacing={2} mb={3}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Grid item xs={6} sm={4} lg={3} key={i}>
            <SkeletonBlock height={90} borderRadius={8} />
          </Grid>
        ))}
      </Grid>
    );
  }

  const isPositive   = stats.returnPct >= 0;
  const targetGapPct = stats.targetReturnPct - stats.returnPct;

  return (
    <Grid container spacing={2} mb={3}>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard
          label="Total Portfolio Value"
          value={formatINR(stats.totalValue)}
          sub={formatPct(stats.returnPct)}
          trend={isPositive ? 'up' : 'down'}
        />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard label="Invested Value" value={formatINR(stats.investedValue)} />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard label="Cash Balance" value={formatINR(stats.cashBalance)} sub="Available" trend="neutral" />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard
          label="Unrealized P&L"
          value={(stats.unrealizedPnl >= 0 ? '+' : '') + formatINR(stats.unrealizedPnl)}
          sub={formatPct(stats.unrealizedPnlPct) + ' of capital'}
          trend={stats.unrealizedPnl >= 0 ? 'up' : 'down'}
          accent={stats.unrealizedPnl >= 0 ? '#10b981' : '#ef4444'}
        />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard
          label="Total P&L"
          value={(stats.totalPnl >= 0 ? '+' : '') + formatINR(stats.totalPnl)}
          sub={formatPct(stats.totalPnlPct) + ' of capital'}
          trend={stats.totalPnl >= 0 ? 'up' : 'down'}
          accent={stats.totalPnl >= 0 ? '#10b981' : '#ef4444'}
        />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard
          label="Target Return"
          value={`${stats.targetReturnPct}%`}
          sub={targetGapPct > 0 ? `${targetGapPct.toFixed(1)}% to go` : 'Target achieved!'}
          trend={targetGapPct <= 0 ? 'up' : 'neutral'}
          accent="#8b5cf6"
        />
      </Grid>
      <Grid item xs={6} sm={4} lg={3}>
        <StatCard
          label="Holdings"
          value={String(stats.holdingsCount)}
          sub={`${stats.investmentHorizonMonths}m horizon`}
          trend="neutral"
        />
      </Grid>
    </Grid>
  );
});

PortfolioStats.displayName = 'PortfolioStats';
