/**
 * Compact virtual ledger status card shown on the Portfolio Dashboard.
 * Links to /portfolios/:id/virtual-reconciliation for full detail.
 */
import { Link } from 'react-router-dom';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import VerifiedIcon from '@mui/icons-material/Verified';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useGetVirtualReconciliationQuery, useGetExecutionQualityQuery } from '../../../../store/portfolios/portfolios.api.ts';
import type { VirtualReconciliationStatus } from '../../../../store/portfolios/portfolios.api.ts';

const statusConfig: Record<VirtualReconciliationStatus, { color: string; icon: React.ReactNode; label: string }> = {
  HEALTHY: { color: '#10b981', icon: <VerifiedIcon sx={{ fontSize: '1rem' }} />, label: 'Healthy' },
  WARNING: { color: '#f59e0b', icon: <WarningAmberIcon sx={{ fontSize: '1rem' }} />, label: 'Warning' },
  MISMATCH: { color: '#ef4444', icon: <ErrorOutlineIcon sx={{ fontSize: '1rem' }} />, label: 'Mismatch' },
  FAILED: { color: '#6b7280', icon: <BlockIcon sx={{ fontSize: '1rem' }} />, label: 'Failed' },
};

const timeAgo = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return diffHr < 24 ? `${diffHr}h ago` : `${Math.floor(diffHr / 24)}d ago`;
};

const scoreColor = (score: number) =>
  score >= 85 ? '#10b981' : score >= 70 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';

export const VirtualLedgerStatusCard = ({ portfolioId }: { portfolioId: number }) => {
  const { data: recon, isLoading: reconLoading } = useGetVirtualReconciliationQuery(portfolioId);
  const { data: quality, isLoading: qualityLoading } = useGetExecutionQualityQuery({ id: portfolioId, range: '30D' });

  if (reconLoading || qualityLoading) {
    return (
      <Paper elevation={0} sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">Checking virtual ledger…</Typography>
      </Paper>
    );
  }

  if (!recon) return null;

  const cfg = statusConfig[recon.status];

  return (
    <Paper
      elevation={0}
      sx={{
        p: 1.5,
        mb: 1.5,
        border: '1px solid',
        borderColor: recon.status === 'HEALTHY' ? 'divider' : cfg.color,
        borderRadius: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap',
        justifyContent: 'space-between',
      }}
    >
      {/* Ledger status */}
      <Box display="flex" alignItems="center" gap={1}>
        <Box sx={{ color: cfg.color, display: 'flex' }}>{cfg.icon}</Box>
        <Box>
          <Box display="flex" alignItems="center" gap={0.75}>
            <Typography variant="body2" fontWeight={700}>Virtual Ledger</Typography>
            <Chip
              label={cfg.label}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.65rem',
                fontWeight: 700,
                backgroundColor: `${cfg.color}22`,
                color: cfg.color,
                border: `1px solid ${cfg.color}44`,
              }}
            />
            {recon.newBuysBlocked && (
              <Chip
                label="BUYs blocked"
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  backgroundColor: '#ef444422',
                  color: '#ef4444',
                  border: '1px solid #ef444444',
                }}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.disabled">
            Checked {timeAgo(recon.lastCheckedAt)}
            {recon.mismatchCount > 0 && ` · ${recon.criticalMismatchCount} critical`}
          </Typography>
        </Box>
      </Box>

      {/* Execution quality */}
      {quality && (
        <Box>
          <Typography variant="caption" color="text.disabled" display="block">Execution Quality</Typography>
          <Typography variant="body2" fontWeight={700} sx={{ color: scoreColor(quality.executionScore) }}>
            {quality.executionScore}/100
          </Typography>
        </Box>
      )}

      {/* Slippage */}
      {quality && (
        <Box>
          <Typography variant="caption" color="text.disabled" display="block">Avg Slippage</Typography>
          <Typography variant="body2" fontWeight={700}>
            {quality.averageSlippagePct.toFixed(2)}%
          </Typography>
        </Box>
      )}

      {/* CTA */}
      <Button
        size="small"
        variant="outlined"
        endIcon={<ArrowForwardIcon sx={{ fontSize: '0.85rem !important' }} />}
        component={Link}
        to={`/portfolios/${portfolioId}/virtual-reconciliation`}
        sx={{ whiteSpace: 'nowrap' }}
      >
        Ledger Details
      </Button>
    </Paper>
  );
};
