import { useState } from 'react';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
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
};

export const CreatePortfolioModal = ({ onClose, onCreated }: CreatePortfolioModalProps) => {
  const [form, setForm] = useState<CreatePortfolioPayload>(DEFAULT_FORM);
  const [isLoading, setIsLoading] = useState(false);
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
    setIsLoading(true);
    setError(null);
    try {
      await portfolioApi.create(form);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create portfolio');
      setIsLoading(false);
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
                type="number"
                min={10000}
                step={10000}
                value={form.initialCapital}
                onChange={e => setForm(f => ({ ...f, initialCapital: Number(e.target.value) }))}
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
