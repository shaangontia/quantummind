import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { usePortfolios } from '../../hooks/usePortfolios.ts';
import { useAppDispatch, useAppSelector } from '../../../../store/hooks.ts';
import {
  openEditModal, closeEditModal, openCreateModal, closeCreateModal,
  selectIsCreateOpen, selectEditingPortfolio,
} from '../../../../store/portfolios/index.ts';
import { CreatePortfolioModal } from '../CreatePortfolioModal/CreatePortfolioModal.tsx';
import { PortfolioPolicyBadge } from '../PortfolioPolicyBadge/index.ts';
import { PortfolioOverlapPanel } from '../PortfolioOverlapPanel/index.ts';
import { EditPortfolioModal } from '../EditPortfolioModal/EditPortfolioModal.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { OnboardingModal } from '../../../../shared/ui/OnboardingModal/index.ts';
import { formatINR, formatPct, riskColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

export const PortfoliosPage = () => {
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem('qm_onboarding_seen') !== '1',
  );
  const { portfolios, isLoading, error, refresh } = usePortfolios();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  const isCreateOpen     = useAppSelector(selectIsCreateOpen);
  const editingPortfolio = useAppSelector(selectEditingPortfolio);

  return (
    <Box>
      {showOnboarding && <OnboardingModal onClose={() => setShowOnboarding(false)} />}

      {/* Page header */}
      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2} flexWrap="wrap">
        <Box>
          <Typography variant="h4" fontWeight={700}>Portfolios</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5} maxWidth={600}>
            Fully autonomous AI portfolio manager — adaptive signals, real-time fundamental analysis, and self-learning intelligence that evolves with every trade
          </Typography>
        </Box>
        <Box display="flex" alignItems="center" gap={1}>
          <Tooltip title="How to use QuantumMind">
            <IconButton size="small" onClick={() => setShowOnboarding(true)} sx={{ border: '1px solid', borderColor: 'divider' }}>
              <HelpOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => dispatch(openCreateModal())}>
            New Portfolio
          </Button>
        </Box>
      </Box>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={6}>
          <CircularProgress size={36} />
        </Box>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>⚠ {error}</Alert>}

      {!isLoading && !error && portfolios.length === 0 && (
        <EmptyState
          icon="📊"
          title="No portfolios yet"
          description="Create your first AI-managed virtual portfolio to get started."
          action={
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => dispatch(openCreateModal())}>
              Create Portfolio
            </Button>
          }
        />
      )}

      {!isLoading && portfolios.length > 1 && (
        <Box mb={3}>
          <PortfolioOverlapPanel
            portfolios={portfolios.map(p => ({ id: p.id, name: p.name }))}
          />
        </Box>
      )}

      {!isLoading && portfolios.length > 0 && (
        <Grid container spacing={2}>
          {portfolios.map(p => {
            const returnPct = (p as { return_pct?: number }).return_pct ?? 0;
            const isPositive = returnPct >= 0;
            return (
              <Grid item xs={12} sm={6} lg={4} key={p.id}>
                <Paper
                  elevation={0}
                  sx={{
                    p: 2.5, height: '100%', cursor: 'pointer',
                    transition: 'border-color 0.15s, background 0.15s',
                    '&:hover': { borderColor: 'primary.main', bgcolor: 'rgba(59,130,246,0.04)' },
                  }}
                  onClick={() => navigate(`/portfolios/${p.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && navigate(`/portfolios/${p.id}`)}
                >
                  {/* Card header */}
                  <Box display="flex" alignItems="center" justifyContent="space-between" mb={1} gap={1} flexWrap="wrap">
                    <Typography fontWeight={700} noWrap flex={1}>{p.name}</Typography>
                    <Box display="flex" gap={0.75} alignItems="center">
                      <PortfolioPolicyBadge policyType={(p as any).policyType} />
                      <Badge variant={riskColor(p.risk_tolerance) as BadgeVariant}>
                        {p.risk_tolerance} Risk
                      </Badge>
                    </Box>
                  </Box>

                  {p.description && (
                    <Typography variant="caption" color="text.secondary" display="block" mb={1.5} sx={{ lineHeight: 1.4 }}>
                      {p.description}
                    </Typography>
                  )}

                  {/* Stats */}
                  <Grid container spacing={1} mb={2}>
                    {[
                      { label: 'Capital',         value: formatINR(p.initial_capital) },
                      { label: 'Current Value',   value: formatINR((p as any).current_nav ?? p.initial_capital), bold: true },
                      { label: 'Target',          value: `${p.target_return_pct}%`, color: '#10b981' },
                      { label: 'Return',          value: formatPct(returnPct), color: isPositive ? '#10b981' : '#ef4444', bold: true },
                      { label: 'Horizon',         value: `${p.investment_horizon_months}m` },
                    ].map(({ label, value, color, bold }) => (
                      <Grid item xs={6} key={label}>
                        <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                        <Typography variant="body2" fontWeight={bold ? 700 : 400} sx={{ color: color ?? 'text.primary' }}>{value}</Typography>
                      </Grid>
                    ))}
                  </Grid>

                  {/* Footer */}
                  <Box display="flex" alignItems="center" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">{p.rebalance_frequency} rebalance</Typography>
                    <Box display="flex" alignItems="center" gap={0.5}>
                      <Button
                        size="small" variant="text" startIcon={<EditIcon sx={{ fontSize: '0.75rem !important' }} />}
                        onClick={e => { e.stopPropagation(); dispatch(openEditModal(p.id)); }}
                        sx={{ fontSize: '0.72rem', minWidth: 0, px: 1 }}
                      >
                        Edit
                      </Button>
                      <ArrowForwardIcon sx={{ fontSize: '1rem', color: 'text.secondary' }} />
                    </Box>
                  </Box>
                </Paper>
              </Grid>
            );
          })}
        </Grid>
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
    </Box>
  );
};
