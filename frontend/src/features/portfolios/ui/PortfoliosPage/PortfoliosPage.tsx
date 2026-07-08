import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePortfolios } from '../../hooks/usePortfolios.ts';
import { CreatePortfolioModal } from '../CreatePortfolioModal/CreatePortfolioModal.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { formatINR, formatPct, riskColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './PortfoliosPage.css';

export const PortfoliosPage = () => {
  const { portfolios, isLoading, error, refresh } = usePortfolios();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="portfolios-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Portfolios</h1>
          <p className="page-subtitle">AI-managed virtual trading portfolios targeting 15%+ returns</p>
        </div>
        <button className="btn btn-primary" onClick={() => setIsCreateOpen(true)}>
          + New Portfolio
        </button>
      </div>

      {isLoading && (
        <div className="loading-center">
          <Spinner size={32} />
        </div>
      )}

      {error && <div className="error-banner">⚠ {error}</div>}

      {!isLoading && !error && portfolios.length === 0 && (
        <EmptyState
          icon="📊"
          title="No portfolios yet"
          description="Create your first AI-managed virtual portfolio to get started."
          action={
            <button className="btn btn-primary" onClick={() => setIsCreateOpen(true)}>
              Create Portfolio
            </button>
          }
        />
      )}

      {!isLoading && portfolios.length > 0 && (
        <div className="portfolios-grid">
          {portfolios.map(p => {
            const returnPct = (p as any).return_pct ?? 0;
            const isPositive = returnPct >= 0;
            return (
              <div
                key={p.id}
                className="portfolio-card"
                onClick={() => navigate(`/portfolios/${p.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && navigate(`/portfolios/${p.id}`)}
              >
                <div className="portfolio-card-header">
                  <span className="portfolio-name">{p.name}</span>
                  <Badge variant={riskColor(p.risk_tolerance) as BadgeVariant}>
                    {p.risk_tolerance} Risk
                  </Badge>
                </div>

                {p.description && (
                  <p className="portfolio-desc">{p.description}</p>
                )}

                <div className="portfolio-stats">
                  <div className="portfolio-stat">
                    <span className="stat-l">Capital</span>
                    <span className="stat-v">{formatINR(p.initial_capital)}</span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Current Value</span>
                    <span className="stat-v" style={{ fontWeight: 700 }}>{formatINR((p as any).current_nav ?? p.initial_capital)}</span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Target</span>
                    <span className="stat-v tag-positive">{p.target_return_pct}%</span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Current Return</span>
                    <span className={`stat-v ${isPositive ? 'tag-positive' : 'tag-negative'}`} style={{ fontWeight: 700 }}>
                      {isPositive ? '+' : ''}{formatPct(returnPct)}
                    </span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Horizon</span>
                    <span className="stat-v">{p.investment_horizon_months}m</span>
                  </div>
                </div>

                <div className="portfolio-footer">
                  <span className="portfolio-rebalance">{p.rebalance_frequency} rebalance</span>
                  <span className="portfolio-arrow">→</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isCreateOpen && (
        <CreatePortfolioModal
          onClose={() => setIsCreateOpen(false)}
          onCreated={() => { setIsCreateOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
};
