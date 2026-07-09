import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useGetPortfolioSummaryQuery, useGetPortfoliosQuery } from '../../../../store/portfolios/index.ts';
import { EditPortfolioModal } from '../EditPortfolioModal/EditPortfolioModal.tsx';
import { PortfolioStats } from '../PortfolioStats/index.ts';
import { HoldingsTable } from '../HoldingsTable/index.ts';
import { PerformanceChart } from '../PerformanceChart/index.ts';
import { SectorAllocationChart } from '../SectorAllocationChart/SectorAllocationChart.tsx';
import { BenchmarkChart } from '../BenchmarkChart/BenchmarkChart.tsx';
import { NewsFeed } from '../../../news/ui/NewsFeed/NewsFeed.tsx';
import { AdaptivePanel } from '../../../intelligence/ui/AdaptivePanel/AdaptivePanel.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { riskColor } from '../../model/portfolios.utils.ts';
import { isNSEMarketOpen } from '../../model/portfolios.marketHours.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './PortfolioDashboard.css';

/**
 * Orchestrator — owns layout and header state only.
 * Each section (stats, holdings, performance, benchmark, sectors)
 * owns its own RTK Query subscription and market-hours polling.
 * RTK Query deduplicates network requests across components sharing the
 * same query key, so there is still only ONE request per endpoint.
 */
export const PortfolioDashboard = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);
  const navigate = useNavigate();

  const [isEditOpen, setIsEditOpen] = useState(false);

  // Pull the full Portfolio object from the list cache — already fetched on the portfolios page.
  // selectFromResult prevents this component re-rendering when OTHER portfolios change.
  const { data: portfolio } = useGetPortfoliosQuery(undefined, {
    selectFromResult: ({ data }) => ({ data: data?.find(p => p.id === portfolioId) }),
  });

  // Header-level subscription — drives initial loading/error states, provides refetch for the
  // manual refresh button, and shares the cache entry with PortfolioStats + HoldingsTable
  // (RTK Query deduplication: zero extra network cost).
  const { data: headerData, isLoading, error, refetch, fulfilledTimeStamp } =
    useGetPortfolioSummaryQuery(portfolioId);

  const lastFetchedAt = fulfilledTimeStamp ? new Date(fulfilledTimeStamp) : null;

  // Defer low-priority panels (news, AI, benchmark, sector) until after first paint
  const [showSecondary, setShowSecondary] = useState(false);
  const deferRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    deferRef.current = setTimeout(() => setShowSecondary(true), 300);
    return () => { if (deferRef.current) clearTimeout(deferRef.current); };
  }, []);

  if (isLoading) {
    return <div className="center-page"><Spinner size={40} /></div>;
  }

  if (error || !headerData) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load portfolio"
        description={error ? ('error' in error ? String(error.error) : 'Failed to load') : 'Portfolio not found'}
        action={<button className="btn btn-ghost" onClick={() => navigate('/')}>← Back</button>}
      />
    );
  }

  return (
    <div className="dashboard">
      {/* Breadcrumb */}
      <div className="breadcrumb">
        <Link to="/" className="breadcrumb-link">Portfolios</Link>
        <span>›</span>
        <span>{headerData.name}</span>
      </div>

      {/* Header */}
      <div className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            <h1 className="dashboard-title">{headerData.name}</h1>
            <Badge variant={riskColor(headerData.riskTolerance) as BadgeVariant}>
              {headerData.riskTolerance} Risk
            </Badge>
          </div>
        </div>
        <div className="dashboard-actions">
          {lastFetchedAt && (
            <span style={{ fontSize: '0.75rem', color: '#64748b', alignSelf: 'center' }}>
              {isNSEMarketOpen()
                ? `Live · ${lastFetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                : `Closed · ${lastFetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
            </span>
          )}
          <button className="btn btn-ghost" onClick={() => void refetch()} title="Refresh prices">
            ↻ Refresh
          </button>
          {portfolio && (
            <button
              className="btn btn-ghost"
              onClick={() => setIsEditOpen(true)}
              title="Edit portfolio settings"
            >
              ✏ Edit
            </button>
          )}
          <Link to={`/portfolios/${portfolioId}/signals`} className="btn btn-ghost">Signals</Link>
          <Link to={`/portfolios/${portfolioId}/trades`} className="btn btn-ghost">Audit Log</Link>
        </div>
      </div>

      {/* Stats — independent subscription, polls during market hours */}
      <PortfolioStats portfolioId={portfolioId} />

      {/* Performance chart — independent subscription */}
      <PerformanceChart portfolioId={portfolioId} />

      {/* Holdings table — independent subscription, polls during market hours */}
      <HoldingsTable portfolioId={portfolioId} />

      {/* Low-priority panels — deferred 300 ms, static after load */}
      {showSecondary && (
        <div className="two-col-cards">
          <div className="card">
            <h2 className="section-title">vs Market Benchmark</h2>
            <BenchmarkChart portfolioId={portfolioId} />
          </div>
          <div className="card">
            <h2 className="section-title">Sector Allocation</h2>
            <SectorAllocationChart portfolioId={portfolioId} />
          </div>
        </div>
      )}

      {showSecondary && (
        <div className="card">
          <h2 className="section-title">AI Intelligence Engine</h2>
          <AdaptivePanel />
        </div>
      )}

      {showSecondary && (
        <div className="card">
          <NewsFeed compact />
        </div>
      )}

      {portfolio && isEditOpen && (
        <EditPortfolioModal
          portfolio={portfolio}
          onClose={() => setIsEditOpen(false)}
          onSaved={() => setIsEditOpen(false)}
        />
      )}
    </div>
  );
};
