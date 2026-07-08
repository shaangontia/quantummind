import { useState } from 'react';
import { useGetPortfolioEditStateQuery, useUpdatePortfolioMutation } from '../../../../store/portfolios/index.ts';
import type {
  EditableField,
  Portfolio,
  PortfolioEditState,
  PortfolioLifecycleState,
  RiskTolerance,
  RebalanceFrequency,
  UpdatePortfolioPayload,
} from '../../../../api/portfolio.api.types.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import '../../ui/CreatePortfolioModal/CreatePortfolioModal.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EditPortfolioModalProps {
  portfolio: Portfolio;
  onClose: () => void;
  onSaved: (updated: Portfolio) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SECTORS = ['IT', 'Banking', 'Pharma', 'Auto', 'FMCG', 'Energy', 'Infra', 'Telecom', 'Metals', 'Realty'];

const STATE_BANNER: Record<PortfolioLifecycleState, { color: string; bg: string; border: string; icon: string; label: string }> = {
  VIRGIN:        { color: '#10b981', bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.3)',  icon: '🌱', label: 'New portfolio — all fields editable' },
  ACTIVE:        { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)',  icon: '⚡', label: 'Active portfolio — strategy changes queue to next cycle' },
  MATURE:        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.3)',  icon: '🔒', label: 'Mature portfolio — risk tolerance locked (AI thesis is set)' },
  DRAWDOWN_HALT: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.3)',   icon: '⛔', label: 'Drawdown halt — strategy locked until recovery' },
  ARCHIVED:      { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.3)', icon: '📦', label: 'Archived — no edits allowed' },
};

const LOCK_REASON: Record<PortfolioLifecycleState, string> = {
  VIRGIN:        '',
  ACTIVE:        'Cannot change while portfolio is active.',
  MATURE:        'Locked — AI has calibrated its position thesis after 20+ trades.',
  DRAWDOWN_HALT: 'Locked during drawdown halt. Recover the portfolio first.',
  ARCHIVED:      'Portfolio is archived.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Field state helpers ──────────────────────────────────────────────────────

const useFieldState = (editState: PortfolioEditState | undefined) => {
  const isLocked  = (field: EditableField) => editState?.editability.locked.includes(field) ?? false;
  const isWarn    = (field: EditableField) => editState?.editability.warn.includes(field)   ?? false;

  const warnStyle = (field: EditableField): React.CSSProperties =>
    isWarn(field) ? { borderColor: '#f59e0b', boxShadow: '0 0 0 1px rgba(245,158,11,0.4)' } : {};

  const lockedStyle: React.CSSProperties = { opacity: 0.45, cursor: 'not-allowed' };

  const fieldStyle = (field: EditableField): React.CSSProperties =>
    isLocked(field) ? lockedStyle : warnStyle(field);

  return { isLocked, isWarn, fieldStyle };
};

// ─── Subcomponents ────────────────────────────────────────────────────────────

const LockBadge = ({ reason }: { reason: string }) => (
  <span
    title={reason}
    style={{ marginLeft: 6, fontSize: '0.75rem', cursor: 'help', verticalAlign: 'middle' }}
  >
    🔒
  </span>
);

const WarnBadge = () => (
  <span
    title="Strategy changes apply at next cron cycle (≤5 min). Existing positions are not force-liquidated."
    style={{ marginLeft: 6, fontSize: '0.75rem', cursor: 'help', verticalAlign: 'middle' }}
  >
    ⚠️
  </span>
);

// ─── Main component ───────────────────────────────────────────────────────────

export const EditPortfolioModal = ({ portfolio, onClose, onSaved }: EditPortfolioModalProps) => {
  const pid = portfolio.id;

  const [form, setForm]             = useState<Required<UpdatePortfolioPayload>>(toFormState(portfolio));
  const [error, setError]           = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Partial<Record<EditableField, string>>>({});

  // RTK Query — edit-state (drives field locking/warning)
  const { data: editState, isLoading: stateLoading } = useGetPortfolioEditStateQuery(pid);

  // RTK Query — update mutation
  const [updatePortfolio, { isLoading }] = useUpdatePortfolioMutation();

  const { isLocked, isWarn, fieldStyle } = useFieldState(editState);
  const lockReason = LOCK_REASON[editState?.state ?? 'ACTIVE'];
  const capitalFloor = editState?.editability.capitalFloor ?? 0;
  const isArchived = editState?.state === 'ARCHIVED';

  const toggleSector = (sector: string) => {
    if (isLocked('preferredSectors')) return;
    setForm(f => ({
      ...f,
      preferredSectors: f.preferredSectors?.includes(sector)
        ? f.preferredSectors.filter(s => s !== sector)
        : [...(f.preferredSectors ?? []), sector],
    }));
  };

  const toggleCap = (cap: string) => {
    if (isLocked('preferredCaps')) return;
    setForm(f => ({
      ...f,
      preferredCaps: f.preferredCaps?.includes(cap)
        ? f.preferredCaps.filter(c => c !== cap)
        : [...(f.preferredCaps ?? []), cap],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Portfolio name is required'); return; }

    // Client-side capital floor guard
    if (form.initialCapital < capitalFloor) {
      setFieldError(prev => ({ ...prev, capitalReduction: `Capital cannot go below ₹${capitalFloor.toLocaleString('en-IN')} (invested value)` }));
      return;
    }

    setError(null);
    setFieldError({});

    try {
      // RTK Query mutation — handles cache invalidation + optimistic updates via onQueryStarted
      const updated = await updatePortfolio({ id: pid, payload: form }).unwrap();
      onSaved(updated);
    } catch (err: unknown) {
      const msg = (err as { error?: string })?.error ?? (err instanceof Error ? err.message : 'Failed to save changes');
      if (msg.includes('CAPITAL_FLOOR_BREACH')) {
        setFieldError(prev => ({ ...prev, capitalReduction: `Capital cannot go below ₹${capitalFloor.toLocaleString('en-IN')}` }));
      } else if (msg.includes('DRAWDOWN_LOCK')) {
        setError(`Changes blocked — portfolio is in drawdown halt (${editState?.meta.drawdownPct.toFixed(1)}% down). Resolve the drawdown first.`);
      } else if (msg.includes('MATURE_LOCK')) {
        setError('This field is locked after 20+ trade executions.');
      } else {
        setError(msg);
      }
    }
  };

  const capitalDelta = form.initialCapital - portfolio.initial_capital;
  const banner = editState ? STATE_BANNER[editState.state] : null;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Edit Portfolio</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          {/* State banner */}
          {stateLoading && <SkeletonBlock height={40} borderRadius={8} />}
          {banner && (
            <div style={{ background: banner.bg, border: `1px solid ${banner.border}`, borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: banner.color, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{banner.icon}</span>
              <span>{banner.label}</span>
              {editState?.meta.tradeCount !== undefined && editState.meta.tradeCount > 0 && (
                <span style={{ marginLeft: 'auto', opacity: 0.8, fontSize: '0.78rem' }}>
                  {editState.meta.holdingsCount} holdings · {editState.meta.tradeCount} trades
                  {editState.meta.drawdownPct > 0 && ` · ${editState.meta.drawdownPct.toFixed(1)}% drawdown`}
                </span>
              )}
            </div>
          )}

          {/* Name & Description — always free */}
          <div className="form-group">
            <label htmlFor="ep-name">Portfolio Name *</label>
            <input id="ep-name" type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="form-input" required />
          </div>

          <div className="form-group">
            <label htmlFor="ep-desc">Description</label>
            <input id="ep-desc" type="text" value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" className="form-input" />
          </div>

          {/* Capital & Target Return */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ep-capital">
                Capital (₹)
                {isLocked('capitalReduction') && capitalDelta < 0 && <LockBadge reason={lockReason} />}
              </label>
              <input
                id="ep-capital"
                type="number"
                min={capitalFloor || 10000}
                step={10000}
                value={form.initialCapital}
                onChange={e => {
                  const val = Number(e.target.value);
                  setForm(f => ({ ...f, initialCapital: val }));
                  if (val >= capitalFloor) setFieldError(prev => ({ ...prev, capitalReduction: undefined }));
                }}
                className="form-input"
                style={form.initialCapital < capitalFloor ? { borderColor: '#ef4444' } : {}}
              />
              {capitalDelta !== 0 && (
                <p style={{ fontSize: '0.72rem', color: capitalDelta > 0 ? 'var(--accent-green)' : '#ef4444', marginTop: 4 }}>
                  {capitalDelta > 0
                    ? `+₹${capitalDelta.toLocaleString('en-IN')} will be added to available cash`
                    : `⚠ Capital reduction — floor is ₹${capitalFloor.toLocaleString('en-IN')}`}
                </p>
              )}
              {fieldError.capitalReduction && <p style={{ fontSize: '0.72rem', color: '#ef4444', marginTop: 4 }}>⚠ {fieldError.capitalReduction}</p>}
              {capitalFloor > 0 && <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>Min: ₹{capitalFloor.toLocaleString('en-IN')} (invested value)</p>}
            </div>

            <div className="form-group">
              <label htmlFor="ep-target">
                Target Return (%)
                {isWarn('targetReturnPct') && <WarnBadge />}
                {isLocked('targetReturnPct') && <LockBadge reason={lockReason} />}
              </label>
              <input
                id="ep-target"
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={form.targetReturnPct}
                onChange={e => setForm(f => ({ ...f, targetReturnPct: Number(e.target.value) }))}
                className="form-input"
                disabled={isLocked('targetReturnPct')}
                style={fieldStyle('targetReturnPct')}
              />
            </div>
          </div>

          {/* Risk & Horizon */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ep-risk">
                Risk Tolerance
                {isWarn('riskTolerance') && <WarnBadge />}
                {isLocked('riskTolerance') && <LockBadge reason={lockReason} />}
              </label>
              <select
                id="ep-risk"
                value={form.riskTolerance}
                onChange={e => setForm(f => ({ ...f, riskTolerance: e.target.value as RiskTolerance }))}
                className="form-input"
                disabled={isLocked('riskTolerance')}
                style={fieldStyle('riskTolerance')}
              >
                <option value="Low">Low (Conservative)</option>
                <option value="Medium">Medium (Balanced)</option>
                <option value="High">High (Aggressive)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="ep-horizon">
                Investment Horizon (months)
                {isWarn('investmentHorizonMonths') && <WarnBadge />}
                {isLocked('investmentHorizonMonths') && <LockBadge reason={lockReason} />}
              </label>
              <input
                id="ep-horizon"
                type="number"
                min={1}
                max={120}
                value={form.investmentHorizonMonths}
                onChange={e => setForm(f => ({ ...f, investmentHorizonMonths: Number(e.target.value) }))}
                className="form-input"
                disabled={isLocked('investmentHorizonMonths')}
                style={fieldStyle('investmentHorizonMonths')}
              />
            </div>
          </div>

          {/* Rebalance */}
          <div className="form-group">
            <label htmlFor="ep-rebalance">
              Rebalance Frequency
              {isWarn('rebalanceFrequency') && <WarnBadge />}
              {isLocked('rebalanceFrequency') && <LockBadge reason={lockReason} />}
            </label>
            <select
              id="ep-rebalance"
              value={form.rebalanceFrequency}
              onChange={e => setForm(f => ({ ...f, rebalanceFrequency: e.target.value as RebalanceFrequency }))}
              className="form-input"
              disabled={isLocked('rebalanceFrequency')}
              style={fieldStyle('rebalanceFrequency')}
            >
              <option value="Weekly">Weekly</option>
              <option value="Monthly">Monthly</option>
              <option value="Quarterly">Quarterly</option>
            </select>
          </div>

          {/* Market Cap */}
          <div className="form-group">
            <label>
              Market Cap Focus
              {isWarn('preferredCaps') && <WarnBadge />}
              {isLocked('preferredCaps') && <LockBadge reason={lockReason} />}
            </label>
            <div className="sectors-grid" style={isLocked('preferredCaps') ? { opacity: 0.45, pointerEvents: 'none' } : {}}>
              {['Small Cap', 'Mid Cap', 'Large Cap'].map(cap => (
                <button
                  key={cap}
                  type="button"
                  className={`sector-chip ${form.preferredCaps?.includes(cap) ? 'selected' : ''}`}
                  onClick={() => toggleCap(cap)}
                  disabled={isLocked('preferredCaps')}
                >
                  {cap}
                </button>
              ))}
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
              {form.preferredCaps?.length ? `AI will allocate ~50% to ${form.preferredCaps.join(' + ')}` : 'No restriction — AI invests across all market caps freely'}
            </p>
          </div>

          {/* Sectors */}
          <div className="form-group">
            <label>
              Preferred Sectors
              {isWarn('preferredSectors') && <WarnBadge />}
              {isLocked('preferredSectors') && <LockBadge reason={lockReason} />}
            </label>
            <div className="sectors-grid" style={isLocked('preferredSectors') ? { opacity: 0.45, pointerEvents: 'none' } : {}}>
              {SECTORS.map(sector => (
                <button
                  key={sector}
                  type="button"
                  className={`sector-chip ${form.preferredSectors?.includes(sector) ? 'selected' : ''}`}
                  onClick={() => toggleSector(sector)}
                  disabled={isLocked('preferredSectors')}
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
                <label className="sublabel">
                  Volatility Preference
                  {isWarn('volatilityPreference') && <WarnBadge />}
                  {isLocked('volatilityPreference') && <LockBadge reason={lockReason} />}
                </label>
                <select
                  className="form-input"
                  value={form.volatilityPreference}
                  onChange={e => setForm(f => ({ ...f, volatilityPreference: e.target.value as 'low' | 'medium' | 'high' }))}
                  disabled={isLocked('volatilityPreference')}
                  style={fieldStyle('volatilityPreference')}
                >
                  <option value="low">Low — Capital preservation</option>
                  <option value="medium">Medium — Balanced</option>
                  <option value="high">High — Aggressive growth</option>
                </select>
              </div>
              <div>
                <label className="sublabel">
                  Investment Goal
                  {isWarn('investmentGoal') && <WarnBadge />}
                  {isLocked('investmentGoal') && <LockBadge reason={lockReason} />}
                </label>
                <select
                  className="form-input"
                  value={form.investmentGoal}
                  onChange={e => setForm(f => ({ ...f, investmentGoal: e.target.value as 'growth' | 'income' | 'retirement' }))}
                  disabled={isLocked('investmentGoal')}
                  style={fieldStyle('investmentGoal')}
                >
                  <option value="growth">Growth — Maximize returns</option>
                  <option value="income">Income — Dividend focus</option>
                  <option value="retirement">Retirement — Long-term stable</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <label className="sublabel">
                Max Drawdown Tolerance (%)
                {isWarn('maxDrawdownPct') && <WarnBadge />}
                {isLocked('maxDrawdownPct') && <LockBadge reason={lockReason} />}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={form.maxDrawdownPct}
                  onChange={e => setForm(f => ({ ...f, maxDrawdownPct: Number(e.target.value) }))}
                  disabled={isLocked('maxDrawdownPct')}
                  style={{ flex: 1, ...(isLocked('maxDrawdownPct') ? { opacity: 0.45 } : {}) }}
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
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isLoading}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={isLoading || isArchived}>
              {isLoading ? <Spinner size={16} /> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
