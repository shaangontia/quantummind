import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import { usePortfolioSummary } from '../../hooks/usePortfolioSummary.ts';
import type { PerformanceSnapshot, SummaryHolding } from '../../../../api/portfolio.api.types.ts';
import { StatCard } from '../../../../shared/ui/StatCard/StatCard.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { formatINR, formatPct, riskColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import { NewsFeed } from '../../../news/ui/NewsFeed/NewsFeed.tsx';
import { AdaptivePanel } from '../../../intelligence/ui/AdaptivePanel/AdaptivePanel.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import './PortfolioDashboard.css';

export const PortfolioDashboard = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);
  const navigate = useNavigate();

  const { summary, isLoading, error } = usePortfolioSummary(portfolioId);
  const [performance, setPerformance] = useState<PerformanceSnapshot[]>([]);
  const [perfLoading, setPerfLoading] = useState(true);
  const [showSecondary, setShowSecondary] = useState(false);
  const deferRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load performance in background — don't block initial render
  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/portfolios/${portfolioId}/performance?days=90`, { signal: ctrl.signal });
        const json = await res.json();
        if (json.success) setPerformance(json.data as PerformanceSnapshot[]);
      } catch { /* timeout or abort — silently skip */ } finally {
        setPerfLoading(false);
      }
    };
    void load();
    return () => ctrl.abort();
  }, [portfolioId]);

  // Defer news + adaptive panel by 300ms after first paint
  useEffect(() => {
    deferRef.current = setTimeout(() => setShowSecondary(true), 300);
    return () => { if (deferRef.current) clearTimeout(deferRef.current); };
  }, []);

  if (isLoading) {
    return <div className="center-page"><Spinner size={40} /></div>;
  }

  if (error || !summary) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load portfolio"
        description={error ?? 'Portfolio not found'}
        action={<button className="btn btn-ghost" onClick={() => navigate('/')}>← Back</button>}
      />
    );
  }

  const { holdings, returnPct, unrealizedPnl, totalValue, investedValue, cashBalance, targetReturnPct, riskTolerance, investmentHorizonMonths } = summary;
  const isPositive = returnPct >= 0;
  const targetGapPct = targetReturnPct - returnPct;

  const chartData = performance.map(s => ({
    date: new Date(s.snapshot_time).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
    return: parseFloat(s.return_pct.toFixed(2)),
    target: s.target_return_pct,
  }));

  return (
    <div className="dashboard">
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/" className="breadcrumb-link">Portfolios</Link>
        <span>›</span>
        <span>{summary.name}</span>
      </div>

      {/* Header */}
      <div className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            <h1 className="dashboard-title">{summary.name}</h1>
            <Badge variant={riskColor(riskTolerance) as BadgeVariant}>
              {riskTolerance} Risk
            </Badge>
          </div>
        </div>
        <div className="dashboard-actions">
          <Link to={`/portfolios/${portfolioId}/signals`} className="btn btn-ghost">
            Signals
          </Link>
          <Link to={`/portfolios/${portfolioId}/trades`} className="btn btn-ghost">
            Audit Log
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <StatCard
          label="Total Portfolio Value"
          value={formatINR(totalValue)}
          sub={formatPct(returnPct)}
          trend={isPositive ? 'up' : 'down'}
        />
        <StatCard
          label="Invested Value"
          value={formatINR(investedValue)}
        />
        <StatCard
          label="Cash Balance"
          value={formatINR(cashBalance)}
          sub="Available"
          trend="neutral"
        />
        <StatCard
          label="Unrealized P&L"
          value={formatINR(unrealizedPnl)}
          sub={formatPct(returnPct)}
          trend={isPositive ? 'up' : 'down'}
          accent={isPositive ? 'var(--accent-green)' : 'var(--accent-red)'}
        />
        <StatCard
          label="Target Return"
          value={`${targetReturnPct}%`}
          sub={targetGapPct > 0 ? `${targetGapPct.toFixed(1)}% to go` : 'Target achieved!'}
          trend={targetGapPct <= 0 ? 'up' : 'neutral'}
          accent="var(--accent-purple)"
        />
        <StatCard
          label="Holdings"
          value={String(holdings.length)}
          sub={`${investmentHorizonMonths}m horizon`}
          trend="neutral"
        />
      </div>

      {/* Performance Chart */}
      <div className="chart-card card">
        <h2 className="section-title">Performance vs Target</h2>
        {perfLoading ? (
          <div className="chart-loading">
            <SkeletonBlock height={280} borderRadius={8} />
          </div>
        ) : chartData.length === 0 ? (
          <EmptyState icon="📈" title="No performance data yet" description="Data will appear after the first monitoring cycle." />
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

      {/* Holdings Table */}
      <div className="card">
        <h2 className="section-title">Current Holdings</h2>
        {holdings.length === 0 ? (
          <EmptyState icon="💼" title="No holdings yet" description="The AI will build positions on the next trading cycle." />
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Company</th>
                  <th>Sector</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Avg Buy Price</th>
                  <th className="text-right">Current Price</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">P&L</th>
                  <th className="text-right">Return</th>
                  <th>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h: SummaryHolding) => (
                    <tr key={h.symbol}>
                      <td><strong>{h.symbol}</strong></td>
                      <td>{h.companyName}</td>
                      <td></td>
                      <td className="text-right">{h.quantity}</td>
                      <td className="text-right">{formatINR(h.avgBuyPrice)}</td>
                      <td className="text-right">
                          {formatINR(h.currentPrice)}
                          {h.priceStatus === 'STALE' && (
                            <span title="Price data is stale — not used for trade execution" style={{ marginLeft: 4, color: '#f59e0b', fontSize: '0.75rem' }}>⚠</span>
                          )}
                        </td>
                      <td className="text-right">{formatINR(h.currentValue)}</td>
                      <td className="text-right" style={{ color: h.pnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {h.pnl >= 0 ? '+' : ''}{formatINR(h.pnl)}
                      </td>
                      <td className="text-right" style={{ color: h.pnlPct >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {h.pnlPct >= 0 ? '+' : ''}{formatPct(h.pnlPct)}
                      </td>
                      <td className="text-muted">—</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Adaptive Intelligence Panel — deferred */}
      {showSecondary && (
        <div className="card">
          <h2 className="section-title">AI Intelligence Engine</h2>
          <AdaptivePanel />
        </div>
      )}

      {/* NSE News Feed — deferred */}
      {showSecondary && (
        <div className="card">
          <NewsFeed compact />
        </div>
      )}
    </div>
  );
};
