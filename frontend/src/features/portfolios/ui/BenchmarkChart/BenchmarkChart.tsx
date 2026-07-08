import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import './BenchmarkChart.css';

interface BenchmarkPoint {
  date: string;
  portfolioReturn: number;   // % since inception
  nifty50Return: number;
  nifty500Return: number;
}

interface BenchmarkData {
  alpha: number;       // portfolio return - nifty50 return (latest)
  data: BenchmarkPoint[];
}

interface Props {
  portfolioId: number;
}

const DOT_STYLE = { r: 0 };
const ACTIVE_DOT_STYLE = { r: 4 };

export const BenchmarkChart = ({ portfolioId }: Props) => {
  const { data, isLoading, error } = useQuery<BenchmarkData>({
    queryKey: ['benchmark', portfolioId],
    queryFn: async () => {
      const res = await fetch(`/api/portfolios/${portfolioId}/benchmark`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load benchmark');
      return json.data as BenchmarkData;
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  if (isLoading) return <SkeletonBlock height={260} borderRadius={8} />;
  if (error || !data) return (
    <EmptyState icon="📊" title="Benchmark data unavailable" description="Will appear after Nifty index data is fetched by the cron cycle." />
  );
  if (data.data.length === 0) return (
    <EmptyState icon="📊" title="No benchmark data yet" description="Benchmark comparison will appear after the first few cron cycles." />
  );

  const alpha = data.alpha;
  const alphaColor = alpha >= 0 ? '#10b981' : '#ef4444';

  return (
    <div className="benchmark-wrap">
      {/* Alpha badge */}
      <div className="benchmark-alpha-row">
        <span className="benchmark-alpha-label">Alpha vs Nifty 50</span>
        <span className="benchmark-alpha-value" style={{ color: alphaColor }}>
          {alpha >= 0 ? '+' : ''}{alpha.toFixed(2)}%
        </span>
        <span className="benchmark-alpha-hint">
          {alpha >= 0 ? '📈 Outperforming the index' : '📉 Underperforming the index'}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data.data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
          />
          <ReferenceLine y={0} stroke="#334155" strokeDasharray="4 4" />
          <Tooltip
            formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: '0.82rem' }}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '0.8rem' }} />
          <Line
            type="monotone"
            dataKey="portfolioReturn"
            name="My Portfolio"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            dot={DOT_STYLE}
            activeDot={ACTIVE_DOT_STYLE}
          />
          <Line
            type="monotone"
            dataKey="nifty50Return"
            name="Nifty 50"
            stroke="#10b981"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={DOT_STYLE}
            activeDot={ACTIVE_DOT_STYLE}
          />
          <Line
            type="monotone"
            dataKey="nifty500Return"
            name="Nifty 500"
            stroke="#64748b"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={DOT_STYLE}
            activeDot={ACTIVE_DOT_STYLE}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
