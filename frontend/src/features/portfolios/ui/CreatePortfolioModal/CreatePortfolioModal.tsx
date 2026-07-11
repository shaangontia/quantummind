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
import Slider from '@mui/material/Slider';
import Paper from '@mui/material/Paper';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useCreatePortfolioMutation } from '../../../../store/portfolios/index.ts';
import type { CreatePortfolioPayload, RebalanceFrequency } from '../../../../api/portfolio.api.types.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { useRiskClassifier } from '../../hooks/useRiskClassifier.ts';

interface CreatePortfolioModalProps {
  onClose: () => void;
  onCreated: () => void;
}

const SECTORS = ['IT', 'Banking', 'Pharma', 'Auto', 'FMCG', 'Energy', 'Infra', 'Telecom', 'Metals', 'Realty'];
const CAPS    = ['Small Cap', 'Mid Cap', 'Large Cap'];

const RISK_COLORS: Record<string, string> = {
  'Low': '#22c55e', 'Medium': '#f59e0b', 'High': '#ef4444', 'Very High': '#a855f7',
};

const DEFAULT_FORM: CreatePortfolioPayload = {
  name: '', description: '', initialCapital: 5_000_000,
  investmentHorizonMonths: 24, targetReturnPct: 15,
  rebalanceFrequency: 'Monthly', preferredSectors: [], preferredCaps: [],
  volatilityPreference: 'medium', investmentGoal: 'growth', maxDrawdownPct: 20,
};

export const CreatePortfolioModal = ({ onClose, onCreated }: CreatePortfolioModalProps) => {
  const [form, setForm] = useState<CreatePortfolioPayload>(DEFAULT_FORM);
  const [createPortfolio, { isLoading }] = useCreatePortfolioMutation();
  const [error, setError] = useState<string | null>(null);

  const derivedRisk = useRiskClassifier({
    targetReturnPct:        form.targetReturnPct,
    investmentHorizonMonths: form.investmentHorizonMonths,
    maxDrawdownPct:         form.maxDrawdownPct,
    volatilityPreference:   form.volatilityPreference,
  });
  const effectiveRisk = derivedRisk?.level ?? null;

  const toggleTag = (field: 'preferredCaps' | 'preferredSectors', value: string) =>
    setForm(f => ({
      ...f,
      [field]: f[field]?.includes(value)
        ? f[field]!.filter(v => v !== value)
        : [...(f[field] ?? []), value],
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Portfolio name is required'); return; }
    setError(null);
    try {
      await createPortfolio({ ...form, ...(effectiveRisk ? { riskTolerance: effectiveRisk } : {}) }).unwrap();
      onCreated();
    } catch (err: unknown) {
      setError((err as { error?: string })?.error ?? (err instanceof Error ? err.message : 'Failed to create portfolio'));
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ component: 'form', onSubmit: handleSubmit }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Create Portfolio
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 2.5 }}>
        <TextField label="Portfolio Name *" required fullWidth
          value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Aggressive Growth 2025" />

        <TextField label="Description" fullWidth
          value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="Optional description" />

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField label="Initial Capital (₹)" fullWidth
              value={form.initialCapital || ''}
              onChange={e => {
                const digits = e.target.value.replace(/\D/g, '');
                setForm(f => ({ ...f, initialCapital: digits ? parseInt(digits, 10) : 0 }));
              }}
              onFocus={e => e.target.select()}
              inputProps={{ inputMode: 'numeric' }}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField label="Target Return (%)" type="number" fullWidth
              inputProps={{ min: 1, step: 0.5 }}
              value={form.targetReturnPct}
              onChange={e => setForm(f => ({ ...f, targetReturnPct: Number(e.target.value) }))}
            />
          </Grid>
        </Grid>

        {/* Derived risk banner */}
        {derivedRisk && (
          <Paper elevation={0} sx={{
            p: 1.5, border: `1px solid ${RISK_COLORS[derivedRisk.level] ?? '#666'}44`,
            bgcolor: `${RISK_COLORS[derivedRisk.level] ?? '#666'}0a`,
          }}>
            <Box display="flex" justifyContent="space-between" mb={0.5}>
              <Typography variant="caption" color="text.secondary">AI-classified risk</Typography>
              <Typography variant="caption" fontWeight={700} sx={{ color: RISK_COLORS[effectiveRisk ?? derivedRisk.level] }}>
                {derivedRisk.level}
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">{derivedRisk.explanation}</Typography>
          </Paper>
        )}

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField label="Investment Horizon (months)" type="number" fullWidth
              inputProps={{ min: 1, max: 120 }}
              value={form.investmentHorizonMonths}
              onChange={e => setForm(f => ({ ...f, investmentHorizonMonths: Number(e.target.value) }))}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <FormControl fullWidth>
              <InputLabel>Rebalance Frequency</InputLabel>
              <Select label="Rebalance Frequency" value={form.rebalanceFrequency}
                onChange={e => setForm(f => ({ ...f, rebalanceFrequency: e.target.value as RebalanceFrequency }))}>
                <MenuItem value="Weekly">Weekly</MenuItem>
                <MenuItem value="Monthly">Monthly</MenuItem>
                <MenuItem value="Quarterly">Quarterly</MenuItem>
              </Select>
            </FormControl>
          </Grid>
        </Grid>

        {/* Market cap selection */}
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" mb={1}>
            Market Cap Focus (optional)
          </Typography>
          <Box display="flex" gap={1} flexWrap="wrap">
            {CAPS.map(cap => (
              <Chip key={cap} label={cap} size="small" clickable
                color={form.preferredCaps?.includes(cap) ? 'primary' : 'default'}
                variant={form.preferredCaps?.includes(cap) ? 'filled' : 'outlined'}
                onClick={() => toggleTag('preferredCaps', cap)}
              />
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
            {form.preferredCaps && form.preferredCaps.length > 0
              ? `AI will allocate ~50% to ${form.preferredCaps.join(' + ')}, rest across other caps`
              : 'No restriction — AI invests across all market caps freely'}
          </Typography>
        </Box>

        {/* Sector selection */}
        <Box>
          <Typography variant="caption" color="text.secondary" display="block" mb={1}>
            Preferred Sectors (optional)
          </Typography>
          <Box display="flex" gap={1} flexWrap="wrap">
            {SECTORS.map(sector => (
              <Chip key={sector} label={sector} size="small" clickable
                color={form.preferredSectors?.includes(sector) ? 'primary' : 'default'}
                variant={form.preferredSectors?.includes(sector) ? 'filled' : 'outlined'}
                onClick={() => toggleTag('preferredSectors', sector)}
              />
            ))}
          </Box>
        </Box>

        {/* Advanced risk settings */}
        <Box>
          <Typography variant="subtitle2" fontWeight={600} mb={1.5}>Advanced Risk Settings</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth size="small">
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
              <FormControl fullWidth size="small">
                <InputLabel>Investment Goal</InputLabel>
                <Select label="Investment Goal" value={form.investmentGoal}
                  onChange={e => setForm(f => ({ ...f, investmentGoal: e.target.value as 'growth' | 'income' | 'retirement' }))}>
                  <MenuItem value="growth">Growth — Maximize returns</MenuItem>
                  <MenuItem value="income">Income — Dividend focus</MenuItem>
                  <MenuItem value="retirement">Retirement — Long-term stable</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </Grid>
          <Box mt={2}>
            <Typography variant="caption" color="text.secondary" display="block" mb={1}>
              Max Drawdown Tolerance: <strong style={{ color: (form.maxDrawdownPct ?? 20) > 30 ? '#ef4444' : '#e2e8f0' }}>{form.maxDrawdownPct ?? 20}%</strong>
            </Typography>
            <Slider min={5} max={50} step={5}
              value={form.maxDrawdownPct ?? 20}
              onChange={(_, v) => setForm(f => ({ ...f, maxDrawdownPct: v as number }))}
              marks valueLabelDisplay="auto"
              sx={{ color: (form.maxDrawdownPct ?? 20) > 30 ? 'error.main' : 'primary.main' }}
            />
            <Typography variant="caption" color="text.secondary">
              AI pauses trading if portfolio drops more than {form.maxDrawdownPct ?? 20}% from its peak
            </Typography>
          </Box>
        </Box>

        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button variant="outlined" onClick={onClose} disabled={isLoading}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={isLoading} startIcon={isLoading ? <Spinner size={16} /> : undefined}>
          {isLoading ? 'Creating…' : 'Create Portfolio'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
