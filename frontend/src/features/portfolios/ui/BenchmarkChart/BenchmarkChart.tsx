import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useGetPortfolioBenchmarkQuery } from '../../../../store/portfolios/index.ts';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

interface Props { portfolioId: number; }

const DOT        = { r: 0 };
const ACTIVE_DOT = { r: 4 };

export const BenchmarkChart = ({ portfolioId }: Props) => {
  const { data, isLoading, isError } = useGetPortfolioBenchmarkQuery(portfolioId, { pollingInterval: 10 * 60_000 });

  if (isLoading) return <SkeletonBlock height={260} borderRadius={8} />;
  if (isError || !data) return (
    <EmptyState icon="📊" title="Benchmark data unavailable" description="Will appear after Nifty index data is fetched by the cron cycle." />
  );
  if (data.data.length === 0) return (
    <EmptyState icon="📊" title="No benchmark data yet" description="Benchmark comparison will appear after the first few cron cycles." />
  );

  const alpha       = data.alpha;
  const alphaColor  = alpha >= 0 ? 'success' : 'error';
  const alphaLabel  = `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`;

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={2}>
        <Typography variant="body2" color="text.secondary">Alpha vs Nifty 50</Typography>
        <Chip
          label={alphaLabel}
          size="small"
          color={alphaColor}
          sx={{ fontWeight: 700 }}
        />
        <Typography variant="caption" color="text.secondary">
          {alpha >= 0 ? '📈 Outperforming' : '📉 Underperforming'} the index
        </Typography>
      </Box>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data.data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <ReferenceLine y={0} stroke="#334155" strokeDasharray="4 4" />
          <Tooltip
            formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: '0.82rem' }}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '0.8rem' }} />
          <Line type="monotone" dataKey="portfolioReturn" name="My Portfolio" stroke="#8b5cf6" strokeWidth={2.5} dot={DOT} activeDot={ACTIVE_DOT} />
          <Line type="monotone" dataKey="nifty50Return"   name="Nifty 50"    stroke="#10b981" strokeWidth={1.5} strokeDasharray="4 2" dot={DOT} activeDot={ACTIVE_DOT} />
          <Line type="monotone" dataKey="nifty500Return"  name="Nifty 500"   stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 2" dot={DOT} activeDot={ACTIVE_DOT} />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
};
