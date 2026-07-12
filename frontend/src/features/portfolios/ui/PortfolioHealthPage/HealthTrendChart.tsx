import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import CircularProgress from '@mui/material/CircularProgress';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Legend,
} from 'recharts';
import { useGetPortfolioHealthHistoryQuery } from '../../../../store/portfolios/portfolios.api.ts';

const RANGES = ['7D', '30D', '90D'] as const;
type Range = typeof RANGES[number];

const GRADE_COLOR: Record<string, string> = {
  EXCELLENT: '#10b981',
  GOOD:      '#3b82f6',
  WARNING:   '#f59e0b',
  CRITICAL:  '#ef4444',
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

export const HealthTrendChart = ({ portfolioId }: { portfolioId: number }) => {
  const [range, setRange] = useState<Range>('30D');

  const { data = [], isLoading } = useGetPortfolioHealthHistoryQuery(
    { id: portfolioId, range },
    { pollingInterval: 0 },
  );

  const chartData = data.map(p => ({
    date: fmtDate(p.snapshotTime),
    health: p.healthScore,
    goalProb: p.goalProbabilityPct,
    returnPct: p.currentReturnPct,
    grade: p.healthGrade,
  }));

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
        <Typography variant="subtitle2" fontWeight={700}>Health Score Trend</Typography>
        <ButtonGroup size="small" variant="outlined">
          {RANGES.map(r => (
            <Button key={r} variant={range === r ? 'contained' : 'outlined'} onClick={() => setRange(r)}>
              {r}
            </Button>
          ))}
        </ButtonGroup>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={4}><CircularProgress size={24} /></Box>
      ) : chartData.length === 0 ? (
        <Box py={4} textAlign="center">
          <Typography variant="body2" color="text.secondary">No history yet — check back after the next health refresh.</Typography>
        </Box>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              formatter={(val: number, name: string) => [
                name === 'health' ? `${val}/100` : name === 'goalProb' ? `${val?.toFixed(0)}%` : `${val?.toFixed(1)}%`,
                name === 'health' ? 'Health' : name === 'goalProb' ? 'Goal Prob' : 'Return',
              ]}
            />
            <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
            {/* Reference lines for grade thresholds */}
            <ReferenceLine y={85} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.3} />
            <ReferenceLine y={70} stroke="#3b82f6" strokeDasharray="4 4" strokeOpacity={0.3} />
            <ReferenceLine y={50} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.3} />
            <Line
              type="monotone" dataKey="health" name="health" stroke="#8b5cf6"
              strokeWidth={2} dot={false} activeDot={{ r: 4 }}
            />
            <Line
              type="monotone" dataKey="goalProb" name="goalProb" stroke="#3b82f6"
              strokeWidth={1.5} dot={false} strokeDasharray="5 3" activeDot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Grade legend */}
      <Box display="flex" gap={2} mt={1} justifyContent="center" flexWrap="wrap">
        {Object.entries(GRADE_COLOR).map(([grade, color]) => (
          <Box key={grade} display="flex" alignItems="center" gap={0.5}>
            <Box sx={{ width: 10, height: 2, bgcolor: color, borderRadius: 1 }} />
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>{grade}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
};
