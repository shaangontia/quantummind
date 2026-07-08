import { useState } from 'react';
import { useCreatePortfolioMutation } from '../../../../store/portfolios/index.ts';
import type { CreatePortfolioPayload, RiskTolerance, RebalanceFrequency } from '../../../../api/portfolio.api.types.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import './CreatePortfolioModal.css';

interface CreatePortfolioModalProps {
  onClose: () => void;
  onCreated: () => void;
}

const SECTORS = [
  'IT', 'Banking', 'Pharma', 'Auto', 'FMCG',
  'Energy', 'Infra', 'Telecom', 'Metals', 'Realty',
];

const DEFAULT_FORM: CreatePortfolioPayload = {
  name: '',
  description: '',
  initialCapital: 5_000_000,
  riskTolerance: 'Medium',
  investmentHorizonMonths: 24,
  targetReturnPct: 15,
  rebalanceFrequency: 'Monthly',
  preferredSectors: [],
  preferredCaps: [],
  volatilityPreference: 'medium',
  investmentGoal: 'growth',
  maxDrawdownPct: 20,
};

export const CreatePortfolioModal = ({ onClose, onCreated }: CreatePortfolioModalProps) => {
  const [form, setForm] = useState<CreatePortfolioPayload>(DEFAULT_FORM);
  const [createPortfolio, { isLoading }] = useCreatePortfolioMutation();
  const [error, setError] = useState<string | null>(null);

  const toggleCap = (cap: string) => {
    setForm(f => ({
      ...f,
      preferredCaps: f.preferredCaps?.includes(cap)
        ? f.preferredCaps.filter(c => c !== cap)
        : [...(f.preferredCaps ?? []), cap],
    }));
  };

  const toggleSector = (sector: string) => {
    setForm(f => ({
      ...f,
      preferredSectors: f.preferredSectors?.includes(sector)
        ? f.preferredSectors.filter(s => s !== sector)
        : [...(f.preferredSectors ?? []), sector],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Portfolio name is required'); return; }
    setError(null);
    try {
      await createPortfolio(form).unwrap();
      onCreated();
    } catch (err: unknown) {
      setError((err as { error?: string })?.error ?? (err instanceof Error ? err.message : 'Failed to create portfolio'));
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Create Portfolio</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="name">Portfolio Name *</label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Aggressive Growth 2025"
              className="form-input"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="description">Description</label>
            <input
              id="description"
              type="text"
              value={form.description ?? ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
              className="form-input"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="capital">Initial Capital (₹)</label>
              <input
                id="capital"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={form.initialCapital || ''}
                onChange={e => {
                  const digits = e.target.value.replace(/\D/g, '');
                  setForm(f => ({ ...f, initialCapital: digits ? parseInt(digits, 10) : 0 }));
                }}
                onFocus={e => e.target.select()}
                className="form-input"
              />
            </div>
            <div className="form-group">
              <label htmlFor="targetReturn">Target Return (%)</label>
              <input
                id="targetReturn"
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

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="risk">Risk Tolerance</label>
              <select
                id="risk"
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
              <label htmlFor="horizon">Investment Horizon (months)</label>
              <input
                id="horizon"
                type="number"
                min={1}
                max={120}
                value={form.investmentHorizonMonths}
                onChange={e => setForm(f => ({ ...f, investmentHorizonMonths: Number(e.target.value) }))}
                className="form-input"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="rebalance">Rebalance Frequency</label>
            <select
              id="rebalance"
              value={form.rebalanceFrequency}
              onChange={e => setForm(f => ({ ...f, rebalanceFrequency: e.target.value as RebalanceFrequency }))}
              className="form-input"
            >
              <option value="Weekly">Weekly</option>
              <option value="Monthly">Monthly</option>
              <option value="Quarterly">Quarterly</option>
            </select>
          </div>

          <div className="form-group">
            <label>Market Cap Focus (optional — AI decides weight based on target &amp; horizon)</label>
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
                ? `AI will allocate ~50% to ${form.preferredCaps.join(' + ')}, rest across other caps`
                : 'No restriction — AI invests across all market caps freely'}
            </p>
          </div>

          <div className="form-group">
            <label>Preferred Sectors (optional — AI will choose if none selected)</label>
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

          {/* Advanced Risk Profiling */}
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
              {isLoading ? <Spinner size={16} /> : 'Create Portfolio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
