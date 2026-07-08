import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
import type { Portfolio, UpdatePortfolioPayload, RiskTolerance, RebalanceFrequency } from '../../../../api/portfolio.api.types.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import '../../ui/CreatePortfolioModal/CreatePortfolioModal.css';

interface EditPortfolioModalProps {
  portfolio: Portfolio;
  /** True when the portfolio has active holdings — triggers a strategy-change warning */
  hasActiveHoldings?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const SECTORS = [
  'IT', 'Banking', 'Pharma', 'Auto', 'FMCG',
  'Energy', 'Infra', 'Telecom', 'Metals', 'Realty',
];

const parseJsonArray = (raw: string | string[] | null | undefined): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as string[]; } catch { return []; }
};

const toFormState = (p: Portfolio): Required<UpdatePortfolioPayload> => ({
  name: p.name,
  description: p.description ?? '',
  initialCapital: p.initial_capital,
  riskTolerance: p.risk_tolerance,
  investmentHorizonMonths: p.investment_horizon_months,
  targetReturnPct: p.target_return_pct,
  rebalanceFrequency: (p.rebalance_frequency ?? 'Monthly') as RebalanceFrequency,
  preferredSectors: parseJsonArray(p.preferred_sectors as string),
  preferredCaps: parseJsonArray(p.preferred_caps as string),
  volatilityPreference: (p.volatility_preference ?? 'medium') as 'low' | 'medium' | 'high',
  investmentGoal: (p.investment_goal ?? 'growth') as 'growth' | 'income' | 'retirement',
  maxDrawdownPct: p.max_drawdown_pct ?? 20,
});

export const EditPortfolioModal = ({ portfolio, hasActiveHoldings = false, onClose, onSaved }: EditPortfolioModalProps) => {
  const qc = useQueryClient();
  const [form, setForm] = useState<Required<UpdatePortfolioPayload>>(toFormState(portfolio));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleSector = (sector: string) =>
    setForm(f => ({
      ...f,
      preferredSectors: f.preferredSectors?.includes(sector)
        ? f.preferredSectors.filter(s => s !== sector)
        : [...(f.preferredSectors ?? []), sector],
    }));

  const toggleCap = (cap: string) =>
    setForm(f => ({
      ...f,
      preferredCaps: f.preferredCaps?.includes(cap)
        ? f.preferredCaps.filter(c => c !== cap)
        : [...(f.preferredCaps ?? []), cap],
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Portfolio name is required'); return; }
    setIsLoading(true);
    setError(null);
    try {
      await portfolioApi.update(portfolio.id, form);
      await qc.invalidateQueries({ queryKey: ['portfolios'] });
      await qc.invalidateQueries({ queryKey: ['portfolio', portfolio.id] });
      await qc.invalidateQueries({ queryKey: ['portfolioSummary', portfolio.id] });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes');
      setIsLoading(false);
    }
  };

  const capitalDelta = form.initialCapital - portfolio.initial_capital;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Edit Portfolio</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          {hasActiveHoldings && (
            <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: '#f59e0b' }}>
              ⚠ This portfolio has active holdings. Strategy changes (sectors, risk, caps) will take effect at the next rebalance cycle — existing positions are not force-liquidated.
            </div>
          )}

          {/* Name & Description */}
          <div className="form-group">
            <label htmlFor="ep-name">Portfolio Name *</label>
            <input
              id="ep-name"
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="ep-desc">Description</label>
            <input
              id="ep-desc"
              type="text"
              value={form.description ?? ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
              className="form-input"
            />
          </div>

          {/* Capital & Target Return */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ep-capital">Capital (₹)</label>
              <input
                id="ep-capital"
                type="number"
                min={10000}
                step={10000}
                value={form.initialCapital}
                onChange={e => setForm(f => ({ ...f, initialCapital: Number(e.target.value) }))}
                className="form-input"
              />
              {capitalDelta !== 0 && (
                <p style={{ fontSize: '0.72rem', color: capitalDelta > 0 ? 'var(--accent-green)' : 'var(--accent-red)', marginTop: 4 }}>
                  {capitalDelta > 0 ? `+${capitalDelta.toLocaleString('en-IN')} will be added to cash` : `${capitalDelta.toLocaleString('en-IN')} capital reduction`}
                </p>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="ep-target">Target Return (%)</label>
              <input
                id="ep-target"
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={form.targetReturnPct}
                onChange={e => setForm(f => ({ ...f, targetReturnPct: Number(e.target.value) }))}
                className="form-input"
              />
            </div>
          </div>

          {/* Risk & Horizon */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ep-risk">Risk Tolerance</label>
              <select
                id="ep-risk"
                value={form.riskTolerance}
                onChange={e => setForm(f => ({ ...f, riskTolerance: e.target.value as RiskTolerance }))}
                className="form-input"
              >
                <option value="Low">Low (Conservative)</option>
                <option value="Medium">Medium (Balanced)</option>
                <option value="High">High (Aggressive)</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="ep-horizon">Investment Horizon (months)</label>
              <input
                id="ep-horizon"
                type="number"
                min={1}
                max={120}
                value={form.investmentHorizonMonths}
                onChange={e => setForm(f => ({ ...f, investmentHorizonMonths: Number(e.target.value) }))}
                className="form-input"
              />
            </div>
          </div>

          {/* Rebalance */}
          <div className="form-group">
            <label htmlFor="ep-rebalance">Rebalance Frequency</label>
            <select
              id="ep-rebalance"
              value={form.rebalanceFrequency}
              onChange={e => setForm(f => ({ ...f, rebalanceFrequency: e.target.value as RebalanceFrequency }))}
              className="form-input"
            >
              <option value="Weekly">Weekly</option>
              <option value="Monthly">Monthly</option>
              <option value="Quarterly">Quarterly</option>
            </select>
          </div>

          {/* Market Cap */}
          <div className="form-group">
            <label>Market Cap Focus</label>
            <div className="sectors-grid">
              {['Small Cap', 'Mid Cap', 'Large Cap'].map(cap => (
                <button
                  key={cap}
                  type="button"
                  className={`sector-chip ${form.preferredCaps?.includes(cap) ? 'selected' : ''}`}
                  onClick={() => toggleCap(cap)}
                >
                  {cap}
                </button>
              ))}
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
              {form.preferredCaps && form.preferredCaps.length > 0
                ? `AI will allocate ~50% to ${form.preferredCaps.join(' + ')}`
                : 'No restriction — AI invests across all market caps freely'}
            </p>
          </div>

          {/* Sectors */}
          <div className="form-group">
            <label>Preferred Sectors</label>
            <div className="sectors-grid">
              {SECTORS.map(sector => (
                <button
                  key={sector}
                  type="button"
                  className={`sector-chip ${form.preferredSectors?.includes(sector) ? 'selected' : ''}`}
                  onClick={() => toggleSector(sector)}
                >
                  {sector}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced Risk */}
          <div className="form-group">
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Advanced Risk Settings</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>AI uses these to tune signal thresholds</span>
            </label>
            <div className="two-col-form">
              <div>
                <label className="sublabel">Volatility Preference</label>
                <select
                  className="form-input"
                  value={form.volatilityPreference}
                  onChange={e => setForm(f => ({ ...f, volatilityPreference: e.target.value as 'low' | 'medium' | 'high' }))}
                >
                  <option value="low">Low — Capital preservation</option>
                  <option value="medium">Medium — Balanced</option>
                  <option value="high">High — Aggressive growth</option>
                </select>
              </div>
              <div>
                <label className="sublabel">Investment Goal</label>
                <select
                  className="form-input"
                  value={form.investmentGoal}
                  onChange={e => setForm(f => ({ ...f, investmentGoal: e.target.value as 'growth' | 'income' | 'retirement' }))}
                >
                  <option value="growth">Growth — Maximize returns</option>
                  <option value="income">Income — Dividend focus</option>
                  <option value="retirement">Retirement — Long-term stable</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <label className="sublabel">Max Drawdown Tolerance (%)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={form.maxDrawdownPct}
                  onChange={e => setForm(f => ({ ...f, maxDrawdownPct: Number(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontWeight: 600, color: (form.maxDrawdownPct ?? 20) > 30 ? '#ef4444' : 'var(--text-primary)', minWidth: 40 }}>
                  {form.maxDrawdownPct ?? 20}%
                </span>
              </div>
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                AI pauses trading if portfolio drops more than {form.maxDrawdownPct ?? 20}% from its peak
              </p>
            </div>
          </div>

          {error && <div className="form-error">⚠ {error}</div>}

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isLoading}>
              {isLoading ? <Spinner size={16} /> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
