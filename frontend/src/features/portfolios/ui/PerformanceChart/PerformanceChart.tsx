import { memo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import { useGetPortfolioPerformanceQuery } from '../../../../store/portfolios/index.ts';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { useMarketPolling } from '../../hooks/useMarketPolling.ts';
import type { PerformanceChartProps } from './PerformanceChart.types.ts';

/**
 * Owns its own RTK Query subscription for performance data.
 * Polls during NSE market hours only — performance snapshots only change
 * when the cron cycle writes a new snapshot.
 */
/** Memoized — re-renders only from its own performance query subscription. */
export const PerformanceChart = memo(({ portfolioId }: PerformanceChartProps) => {
  const pollingInterval = useMarketPolling();

  const { data: performanceData, isLoading } = useGetPortfolioPerformanceQuery(
    { id: portfolioId, days: 90 },
    { pollingInterval },
  );

  const chartData = (performanceData ?? []).map(s => ({
    date: new Date(s.snapshot_time).toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
    }),
    return: parseFloat(s.return_pct.toFixed(2)),
    target: s.target_return_pct,
  }));

  return (
    <div className="chart-card card">
      <h2 className="section-title">Performance vs Target</h2>
      {isLoading ? (
        <div className="chart-loading">
          <SkeletonBlock height={280} borderRadius={8} />
        </div>
      ) : chartData.length === 0 ? (
        <EmptyState
          icon="📈"
          title="No performance data yet"
          description="Data will appear after the first monitoring cycle."
        />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
            <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 12 }} />
            <YAxis stroke="#64748b" tick={{ fontSize: 12 }} unit="%" />
            <Tooltip
              contentStyle={{ background: '#1a2035', border: '1px solid #2d3748', borderRadius: 8 }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(v: number) => [`${v}%`]}
            />
            <Legend />
            <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="return"
              name="Portfolio Return"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="target"
              name="Target Return"
              stroke="#8b5cf6"
              strokeWidth={1.5}
              strokeDasharray="6 3"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
});

PerformanceChart.displayName = 'PerformanceChart';
