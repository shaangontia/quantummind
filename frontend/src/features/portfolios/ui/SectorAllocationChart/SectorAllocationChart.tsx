import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useGetPortfolioSectorsQuery } from '../../../../store/portfolios/index.ts';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

const SECTOR_COLORS: Record<string, string> = {
  IT: '#6366f1', Financials: '#10b981', Energy: '#f59e0b', FMCG: '#ec4899',
  Healthcare: '#14b8a6', Industrials: '#8b5cf6', Materials: '#f97316',
  Realty: '#06b6d4', Auto: '#84cc16', Utilities: '#64748b', Other: '#334155',
};

interface Props { portfolioId: number; }

export const SectorAllocationChart = ({ portfolioId }: Props) => {
  const { data, isLoading, isError } = useGetPortfolioSectorsQuery(portfolioId, { pollingInterval: 5 * 60_000 });

  if (isLoading) return <SkeletonBlock height={280} borderRadius={8} />;
  if (isError || !data) return <EmptyState icon="🗂" title="Sector data unavailable" description="Will populate after first cron cycle." />;
  if (data.length === 0) return <EmptyState icon="🗂" title="No holdings yet" description="Sector allocation will appear once the AI builds positions." />;

  const sorted = [...data].sort((a, b) => b.value - a.value);

  return (
    <Box>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={sorted} dataKey="pct" nameKey="sector" cx="45%" cy="50%"
            innerRadius={70} outerRadius={110} paddingAngle={2}
            label={({ pct }: { pct: number }) => pct > 5 ? `${pct.toFixed(0)}%` : ''}
            labelLine={false}
          >
            {sorted.map(s => (
              <Cell key={s.sector} fill={SECTOR_COLORS[s.sector] ?? SECTOR_COLORS.Other} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => [`${value.toFixed(1)}%`]}
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: '0.82rem' }}
          />
          <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={10}
            formatter={(value: string) => {
              const s = sorted.find(x => x.sector === value);
              return <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{value} {s ? `(${s.pct.toFixed(1)}%)` : ''}</span>;
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      {sorted.some(s => s.pct > 35) && (
        <Alert severity="warning" sx={{ mt: 1, fontSize: '0.75rem' }}>
          Sector concentration &gt;35% — AI will not add more until rebalanced
        </Alert>
      )}
    </Box>
  );
};
