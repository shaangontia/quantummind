import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CloseIcon from '@mui/icons-material/Close';
import LockIcon from '@mui/icons-material/Lock';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
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

interface EditPortfolioModalProps {
  portfolio: Portfolio;
  onClose: () => void;
  onSaved: (updated: Portfolio) => void;
}

const SECTORS = ['IT', 'Banking', 'Pharma', 'Auto', 'FMCG', 'Energy', 'Infra', 'Telecom', 'Metals', 'Realty'];
const CAPS    = ['Small Cap', 'Mid Cap', 'Large Cap'];

const STATE_BANNER: Record<PortfolioLifecycleState, { color: string; bg: string; border: string; icon: string; label: string }> = {
  VIRGIN:        { color: '#10b981', bg: 'rgba(16,185,129,0.08)',   border: 'rgba(16,185,129,0.3)',   icon: '🌱', label: 'New portfolio — all fields editable' },
  ACTIVE:        { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.3)',   icon: '⚡', label: 'Active — strategy changes queue to next cycle' },
  MATURE:        { color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)',  border: 'rgba(139,92,246,0.3)',   icon: '🔒', label: 'Mature — risk tolerance locked (AI thesis is set)' },
  DRAWDOWN_HALT: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.3)',    icon: '⛔', label: 'Drawdown halt — strategy locked until recovery' },
  ARCHIVED:      { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.3)',  icon: '📦', label: 'Archived — no edits allowed' },
};

const LOCK_REASON: Record<PortfolioLifecycleState, string> = {
  VIRGIN: '', ACTIVE: 'Cannot change while portfolio is active.',
  MATURE: 'Locked — AI calibrated thesis after 20+ trades.',
  DRAWDOWN_HALT: 'Locked during drawdown halt.', ARCHIVED: 'Portfolio is archived.',
};

const parseJsonArray = (raw: string | string[] | null | undefined): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as string[]; } catch { return []; }
};

const toFormState = (p: Portfolio): Required<UpdatePortfolioPayload> => ({
  name: p.name, description: p.description ?? '',
  initialCapital: p.initial_capital, riskTolerance: p.risk_tolerance,
  investmentHorizonMonths: p.investment_horizon_months, targetReturnPct: p.target_return_pct,
  rebalanceFrequency: (p.rebalance_frequency ?? 'Monthly') as RebalanceFrequency,
  preferredSectors: parseJsonArray(p.preferred_sectors as string),
  preferredCaps: parseJsonArray(p.preferred_caps as string),
  volatilityPreference: (p.volatility_preference ?? 'medium') as 'low' | 'medium' | 'high',
  investmentGoal: (p.investment_goal ?? 'growth') as 'growth' | 'income' | 'retirement',
  maxDrawdownPct: p.max_drawdown_pct ?? 20,
});

const useFieldState = (editState: PortfolioEditState | undefined) => {
  const isLocked = (field: EditableField) => editState?.editability.locked.includes(field) ?? false;
  const isWarn   = (field: EditableField) => editState?.editability.warn.includes(field)   ?? false;
  return { isLocked, isWarn };
};

const FieldAdornment = ({ locked, warned, reason }: { locked: boolean; warned: boolean; reason: string }) => (
  <>
    {locked && <Tooltip title={reason}><LockIcon sx={{ fontSize: '0.9rem', color: 'text.disabled', ml: 0.5 }} /></Tooltip>}
    {warned && !locked && <Tooltip title="Changes apply at next cron cycle (≤5 min). Existing positions are not force-liquidated."><WarningAmberIcon sx={{ fontSize: '0.9rem', color: 'warning.main', ml: 0.5 }} /></Tooltip>}
  </>
);

export const EditPortfolioModal = ({ portfolio, onClose, onSaved }: EditPortfolioModalProps) => {
  const pid = portfolio.id;
  const [form,       setForm]       = useState<Required<UpdatePortfolioPayload>>(toFormState(portfolio));
  const [error,      setError]      = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Partial<Record<EditableField, string>>>({});

  const { data: editState, isLoading: stateLoading } = useGetPortfolioEditStateQuery(pid);
  const [updatePortfolio, { isLoading }] = useUpdatePortfolioMutation();

  const { isLocked, isWarn } = useFieldState(editState);
  const lockReason   = LOCK_REASON[editState?.state ?? 'ACTIVE'];
  const capitalFloor = editState?.editability.capitalFloor ?? 0;
  const isArchived   = editState?.state === 'ARCHIVED';
  // Use portfolio.trade_count for immediate lock before editState loads (prevents race condition flash)
  const isStrategyLocked = (portfolio.trade_count ?? 0) > 0 || (editState?.meta.tradeCount ?? 0) > 0;

  const toggleTag = (field: 'preferredCaps' | 'preferredSectors', value: string) => {
    if (isLocked(field as EditableField)) return;
    setForm(f => ({
      ...f,
      [field]: f[field]?.includes(value) ? f[field]!.filter(v => v !== value) : [...(f[field] ?? []), value],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Portfolio name is required'); return; }
    if (form.initialCapital < capitalFloor) {
      setFieldError(prev => ({ ...prev, capitalReduction: `Capital cannot go below ₹${capitalFloor.toLocaleString('en-IN')}` }));
      return;
    }
    setError(null); setFieldError({});
    try {
      const updated = await updatePortfolio({ id: pid, payload: form }).unwrap();
      onSaved(updated);
    } catch (err: unknown) {
      const msg = (err as { error?: string })?.error ?? (err instanceof Error ? err.message : 'Failed to save changes');
      if (msg.includes('CAPITAL_FLOOR_BREACH')) {
        setFieldError(prev => ({ ...prev, capitalReduction: `Capital cannot go below ₹${capitalFloor.toLocaleString('en-IN')}` }));
      } else if (msg.includes('DRAWDOWN_LOCK')) {
        setError(`Changes blocked — portfolio is in drawdown halt (${editState?.meta.drawdownPct.toFixed(1)}% down).`);
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
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ component: 'form', onSubmit: handleSubmit }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Edit Portfolio
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 2.5 }}>
        {/* Lifecycle state banner */}
        {stateLoading && <SkeletonBlock height={44} borderRadius={8} />}
        {banner && (
          <Paper elevation={0} sx={{ p: 1.5, background: banner.bg, border: `1px solid ${banner.border}`, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography>{banner.icon}</Typography>
            <Typography variant="body2" sx={{ color: banner.color, flex: 1 }}>{banner.label}</Typography>
            {editState && editState.meta.tradeCount > 0 && (
              <Typography variant="caption" color="text.secondary">
                {editState.meta.holdingsCount} holdings · {editState.meta.tradeCount} trades
              </Typography>
            )}
          </Paper>
        )}

        {/* Name & Description — always free */}
        <TextField label="Portfolio Name *" required fullWidth
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <TextField label="Description" fullWidth
          value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="Optional" />

        {/* Strategy fields — locked once trading has begun */}
        {isStrategyLocked ? (
          <Alert severity="info" icon={<LockIcon />}>
            Strategy locked — {editState?.meta.tradeCount} trades executed. Only name and description can be changed.
          </Alert>
        ) : (
          <>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Capital (₹)" fullWidth
                  value={form.initialCapital || ''}
                  error={!!fieldError.capitalReduction || form.initialCapital < capitalFloor}
                  helperText={
                    fieldError.capitalReduction
                      ? `⚠ ${fieldError.capitalReduction}`
                      : capitalDelta !== 0
                        ? capitalDelta > 0 ? `+₹${capitalDelta.toLocaleString('en-IN')} added to cash` : `⚠ Floor: ₹${capitalFloor.toLocaleString('en-IN')}`
                        : capitalFloor > 0 ? `Min: ₹${capitalFloor.toLocaleString('en-IN')}` : undefined
                  }
                  onChange={e => {
                    const digits = e.target.value.replace(/\D/g, '');
                    const val = digits ? parseInt(digits, 10) : 0;
                    setForm(f => ({ ...f, initialCapital: val }));
                    if (val >= capitalFloor) setFieldError(prev => ({ ...prev, capitalReduction: undefined }));
                  }}
                  onFocus={e => e.target.select()}
                  inputProps={{ inputMode: 'numeric' }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label={<Box display="flex" alignItems="center">Target Return (%) <FieldAdornment locked={isLocked('targetReturnPct')} warned={isWarn('targetReturnPct')} reason={lockReason} /></Box>}
                  type="number" fullWidth inputProps={{ min: 1, step: 0.5 }}
                  value={form.targetReturnPct}
                  disabled={isLocked('targetReturnPct')}
                  onChange={e => setForm(f => ({ ...f, targetReturnPct: Number(e.target.value) }))}
                />
              </Grid>
            </Grid>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <FormControl fullWidth disabled={isLocked('riskTolerance')}>
                  <InputLabel>Risk Tolerance</InputLabel>
                  <Select label="Risk Tolerance" value={form.riskTolerance}
                    onChange={e => setForm(f => ({ ...f, riskTolerance: e.target.value as RiskTolerance }))}>
                    {['Low', 'Medium', 'High', 'Very High'].map(r => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField label="Horizon (months)" type="number" fullWidth
                  inputProps={{ min: 1, max: 120 }}
                  value={form.investmentHorizonMonths}
                  disabled={isLocked('investmentHorizonMonths')}
                  onChange={e => setForm(f => ({ ...f, investmentHorizonMonths: Number(e.target.value) }))}
                />
              </Grid>
            </Grid>

            <FormControl fullWidth disabled={isLocked('rebalanceFrequency')}>
              <InputLabel>Rebalance Frequency</InputLabel>
              <Select label="Rebalance Frequency" value={form.rebalanceFrequency}
                onChange={e => setForm(f => ({ ...f, rebalanceFrequency: e.target.value as RebalanceFrequency }))}>
                <MenuItem value="Weekly">Weekly</MenuItem>
                <MenuItem value="Monthly">Monthly</MenuItem>
                <MenuItem value="Quarterly">Quarterly</MenuItem>
              </Select>
            </FormControl>

            {/* Market cap */}
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" mb={1}>Market Cap Focus</Typography>
              <Box display="flex" gap={1} flexWrap="wrap" sx={isLocked('preferredCaps') ? { opacity: 0.45, pointerEvents: 'none' } : {}}>
                {CAPS.map(cap => (
                  <Chip key={cap} label={cap} size="small" clickable
                    color={form.preferredCaps?.includes(cap) ? 'primary' : 'default'}
                    variant={form.preferredCaps?.includes(cap) ? 'filled' : 'outlined'}
                    onClick={() => toggleTag('preferredCaps', cap)}
                  />
                ))}
              </Box>
              <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
                {form.preferredCaps?.length ? `~50% allocated to ${form.preferredCaps.join(' + ')}` : 'No restriction'}
              </Typography>
            </Box>

            {/* Sectors */}
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" mb={1}>Preferred Sectors</Typography>
              <Box display="flex" gap={1} flexWrap="wrap" sx={isLocked('preferredSectors') ? { opacity: 0.45, pointerEvents: 'none' } : {}}>
                {SECTORS.map(s => (
                  <Chip key={s} label={s} size="small" clickable
                    color={form.preferredSectors?.includes(s) ? 'primary' : 'default'}
                    variant={form.preferredSectors?.includes(s) ? 'filled' : 'outlined'}
                    onClick={() => toggleTag('preferredSectors', s)}
                  />
                ))}
              </Box>
            </Box>

            {/* Advanced risk */}
            <Box>
              <Typography variant="subtitle2" fontWeight={600} mb={1.5}>Advanced Risk Settings</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <FormControl fullWidth size="small" disabled={isLocked('volatilityPreference')}>
                    <InputLabel>Volatility Preference</InputLabel>
                    <Select label="Volatility Preference" value={form.volatilityPreference}
                      onChange={e => setForm(f => ({ ...f, volatilityPreference: e.target.value as 'low' | 'medium' | 'high' }))}>
                      <MenuItem value="low">Low — Capital preservation</MenuItem>
                      <MenuItem value="medium">Medium — Balanced</MenuItem>
                      <MenuItem value="high">High — Aggressive growth</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <FormControl fullWidth size="small" disabled={isLocked('investmentGoal')}>
                    <InputLabel>Investment Goal</InputLabel>
                    <Select label="Investment Goal" value={form.investmentGoal}
                      onChange={e => setForm(f => ({ ...f, investmentGoal: e.target.value as 'growth' | 'income' | 'retirement' }))}>
                      <MenuItem value="growth">Growth</MenuItem>
                      <MenuItem value="income">Income</MenuItem>
                      <MenuItem value="retirement">Retirement</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
              </Grid>
              <Box mt={2}>
                <Typography variant="caption" color="text.secondary" display="block" mb={1}>
                  Max Drawdown Tolerance: <strong style={{ color: (form.maxDrawdownPct ?? 20) > 30 ? '#ef4444' : '#e2e8f0' }}>{form.maxDrawdownPct ?? 20}%</strong>
                </Typography>
                <Slider min={5} max={50} step={5}
                  disabled={isLocked('maxDrawdownPct')}
                  value={form.maxDrawdownPct ?? 20}
                  onChange={(_, v) => setForm(f => ({ ...f, maxDrawdownPct: v as number }))}
                  marks valueLabelDisplay="auto"
                  sx={{ color: (form.maxDrawdownPct ?? 20) > 30 ? 'error.main' : 'primary.main' }}
                />
                <Typography variant="caption" color="text.secondary">
                  AI pauses if portfolio drops more than {form.maxDrawdownPct ?? 20}% from peak
                </Typography>
              </Box>
            </Box>
          </>
        )}

        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button variant="outlined" onClick={onClose} disabled={isLoading}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={isLoading || isArchived}
          startIcon={isLoading ? <Spinner size={16} /> : undefined}>
          {isLoading ? 'Saving…' : 'Save Changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
