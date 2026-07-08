import { useQuery } from '@tanstack/react-query';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import './SectorAllocationChart.css';

interface SectorAllocation {
  sector: string;
  value: number;      // ₹ NAV in this sector
  pct: number;        // % of total holdings value
  holdings: number;   // number of stocks
}

const SECTOR_COLORS: Record<string, string> = {
  IT:          '#6366f1', // indigo
  Financials:  '#10b981', // green
  Energy:      '#f59e0b', // amber
  FMCG:        '#ec4899', // pink
  Healthcare:  '#14b8a6', // teal
  Industrials: '#8b5cf6', // purple
  Materials:   '#f97316', // orange
  Realty:      '#06b6d4', // cyan
  Auto:        '#84cc16', // lime
  Utilities:   '#64748b', // slate
  Other:       '#334155', // dark slate
};

interface Props {
  portfolioId: number;
}

export const SectorAllocationChart = ({ portfolioId }: Props) => {
  const { data, isLoading, error } = useQuery<SectorAllocation[]>({
    queryKey: ['sector-allocation', portfolioId],
    queryFn: async () => {
      const res = await fetch(`/api/portfolios/${portfolioId}/sectors`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load sectors');
      return json.data as SectorAllocation[];
    },
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) return <SkeletonBlock height={280} borderRadius={8} />;
  if (error || !data) return (
    <EmptyState icon="🗂" title="Sector data unavailable" description="Will populate after first cron cycle with sector taxonomy." />
  );
  if (data.length === 0) return (
    <EmptyState icon="🗂" title="No holdings yet" description="Sector allocation will appear once the AI builds positions." />
  );

  const sorted = [...data].sort((a, b) => b.value - a.value);

  return (
    <div className="sector-chart-wrap">
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={sorted}
            dataKey="pct"
            nameKey="sector"
            cx="45%"
            cy="50%"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={2}
            label={({ pct }: { pct: number }) => pct > 5 ? `${pct.toFixed(0)}%` : ''}
            labelLine={false}
          >
            {sorted.map(s => (
              <Cell
                key={s.sector}
                fill={SECTOR_COLORS[s.sector] ?? SECTOR_COLORS.Other}
              />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => [`${value.toFixed(1)}%`]}
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: '0.82rem' }}
          />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            iconType="circle"
            iconSize={10}
            formatter={(value: string) => {
              const s = sorted.find(x => x.sector === value);
              return <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{value} {s ? `(${s.pct.toFixed(1)}%)` : ''}</span>;
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* 35% cap warning */}
      {sorted.some(s => s.pct > 35) && (
        <div className="sector-cap-warning">
          ⚠ Sector concentration &gt; 35% — AI will not add more to this sector until rebalanced
        </div>
      )}
    </div>
  );
};
