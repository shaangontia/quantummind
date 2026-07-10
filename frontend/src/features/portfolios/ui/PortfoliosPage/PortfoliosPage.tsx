import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePortfolios } from '../../hooks/usePortfolios.ts';
import { useAppDispatch, useAppSelector } from '../../../../store/hooks.ts';
import {
  openEditModal, closeEditModal, openCreateModal, closeCreateModal,
  selectIsCreateOpen, selectEditingPortfolio,
} from '../../../../store/portfolios/index.ts';
import { CreatePortfolioModal } from '../CreatePortfolioModal/CreatePortfolioModal.tsx';
import { EditPortfolioModal } from '../EditPortfolioModal/EditPortfolioModal.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { OnboardingModal } from '../../../../shared/ui/OnboardingModal/index.ts';
import { formatINR, formatPct, riskColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './PortfoliosPage.css';

export const PortfoliosPage = () => {
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem('qm_onboarding_seen') !== '1',
  );
  const { portfolios, isLoading, error, refresh } = usePortfolios();
  const dispatch  = useAppDispatch();
  const navigate  = useNavigate();

  const isCreateOpen     = useAppSelector(selectIsCreateOpen);
  const editingPortfolio = useAppSelector(selectEditingPortfolio);

  return (
    <div className="portfolios-page">
      {showOnboarding && <OnboardingModal onClose={() => setShowOnboarding(false)} />}
      <div className="page-header">
        <div>
          <h1 className="page-title">Portfolios</h1>
          <p className="page-subtitle">Fully autonomous AI portfolio manager — adaptive signals, real-time fundamental analysis, and self-learning intelligence that evolves with every trade</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-ghost"
            onClick={() => setShowOnboarding(true)}
            title="How to use QuantumMind"
            style={{ fontSize: '1rem', padding: '6px 10px' }}
          >
            ?
          </button>
          <button className="btn btn-primary" onClick={() => dispatch(openCreateModal())}>
            + New Portfolio
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="loading-center"><Spinner size={32} /></div>
      )}

      {error && <div className="error-banner">⚠ {error}</div>}

      {!isLoading && !error && portfolios.length === 0 && (
        <EmptyState
          icon="📊"
          title="No portfolios yet"
          description="Create your first AI-managed virtual portfolio to get started."
          action={
            <button className="btn btn-primary" onClick={() => dispatch(openCreateModal())}>
              Create Portfolio
            </button>
          }
        />
      )}

      {!isLoading && portfolios.length > 0 && (
        <div className="portfolios-grid">
          {portfolios.map(p => {
            const returnPct = (p as { return_pct?: number }).return_pct ?? 0;
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
                    <span className="stat-v" style={{ fontWeight: 700 }}>
                      {formatINR((p as any).current_nav ?? p.initial_capital)}
                    </span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Target</span>
                    <span className="stat-v tag-positive">{p.target_return_pct}%</span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Current Return</span>
                    <span className={`stat-v ${isPositive ? 'tag-positive' : 'tag-negative'}`} style={{ fontWeight: 700 }}>
                      {formatPct(returnPct)}
                    </span>
                  </div>
                  <div className="portfolio-stat">
                    <span className="stat-l">Horizon</span>
                    <span className="stat-v">{p.investment_horizon_months}m</span>
                  </div>
                </div>

                {/* Footer: rebalance label | edit button | nav arrow */}
                <div className="portfolio-footer">
                  <span className="portfolio-rebalance">{p.rebalance_frequency} rebalance</span>
                  <button
                    className="btn btn-ghost portfolio-edit-btn"
                    onClick={e => { e.stopPropagation(); dispatch(openEditModal(p.id)); }}
                    title="Edit portfolio"
                  >
                    ✏ Edit
                  </button>
                  <span className="portfolio-arrow">→</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isCreateOpen && (
        <CreatePortfolioModal
          onClose={() => dispatch(closeCreateModal())}
          onCreated={() => { dispatch(closeCreateModal()); void refresh(); }}
        />
      )}

      {editingPortfolio && (
        <EditPortfolioModal
          portfolio={editingPortfolio}
          onClose={() => dispatch(closeEditModal())}
          onSaved={() => dispatch(closeEditModal())}
        />
      )}
    </div>
  );
};
