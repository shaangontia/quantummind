/**
 * /portfolios/:id/virtual-reconciliation
 * Shows virtual ledger status, mismatch details, and recent execution events.
 */
import { Link, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import VerifiedIcon from '@mui/icons-material/Verified';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import {
  useGetVirtualReconciliationQuery,
  useGetExecutionQualityQuery,
  useGetExecutionEventsQuery,
} from '../../../../store/portfolios/portfolios.api.ts';
import type { VirtualReconciliationStatus, FillStatus } from '../../../../store/portfolios/portfolios.api.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';

const statusConfig: Record<VirtualReconciliationStatus, { color: string; icon: React.ReactNode; label: string }> = {
  HEALTHY:  { color: '#10b981', icon: <VerifiedIcon />,      label: 'Healthy' },
  WARNING:  { color: '#f59e0b', icon: <WarningAmberIcon />,  label: 'Warning' },
  MISMATCH: { color: '#ef4444', icon: <ErrorOutlineIcon />,  label: 'Mismatch' },
  FAILED:   { color: '#6b7280', icon: <BlockIcon />,         label: 'Failed' },
};

const fillColor: Record<FillStatus, string> = {
  FULL:      '#10b981',
  PARTIAL:   '#f59e0b',
  REJECTED:  '#ef4444',
  CANCELLED: '#6b7280',
  FAILED:    '#ef4444',
  EXPIRED:   '#6b7280',
};

const scoreColor = (s: number) =>
  s >= 85 ? '#10b981' : s >= 70 ? '#3b82f6' : s >= 50 ? '#f59e0b' : '#ef4444';

const fmt = (n: number | null, digits = 2) =>
  n == null ? '—' : n.toFixed(digits);

const fmtTs = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const VirtualReconciliationPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const { data: recon, isLoading: reconLoading } = useGetVirtualReconciliationQuery(portfolioId);
  const { data: quality } = useGetExecutionQualityQuery({ id: portfolioId, range: '30D' });
  const { data: events = [], isLoading: eventsLoading } = useGetExecutionEventsQuery({ id: portfolioId, limit: 30 });

  if (reconLoading) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" minHeight="50vh">
        <Spinner size={36} />
      </Box>
    );
  }

  const cfg = recon ? statusConfig[recon.status] : statusConfig.FAILED;

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
          Portfolios
        </Box>
        <Box component={Link} to={`/portfolios/${portfolioId}`} sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
          Portfolio
        </Box>
        <Typography variant="body2" color="text.primary">Virtual Ledger</Typography>
      </Breadcrumbs>

      <Typography variant="h5" fontWeight={700} mb={2.5}>Virtual Ledger Reconciliation</Typography>

      {/* Status summary */}
      {recon && (
        <Paper elevation={0} sx={{ p: 2.5, mb: 2, border: '1px solid', borderColor: recon.status === 'HEALTHY' ? 'divider' : cfg.color }}>
          <Box display="flex" alignItems="center" gap={1.5} mb={1.5} flexWrap="wrap">
            <Box sx={{ color: cfg.color, display: 'flex', fontSize: '1.75rem' }}>{cfg.icon}</Box>
            <Box>
              <Box display="flex" alignItems="center" gap={1}>
                <Typography variant="h6" fontWeight={700}>Ledger Status</Typography>
                <Chip
                  label={cfg.label}
                  size="small"
                  sx={{ fontWeight: 700, backgroundColor: `${cfg.color}22`, color: cfg.color, border: `1px solid ${cfg.color}44` }}
                />
                {recon.newBuysBlocked && (
                  <Chip label="New BUYs Blocked" size="small" color="error" />
                )}
                {recon.onlyRiskReducingSells && (
                  <Chip label="Risk-Reducing SELLs Only" size="small" sx={{ backgroundColor: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44' }} />
                )}
              </Box>
              <Typography variant="caption" color="text.disabled">
                Last checked: {fmtTs(recon.lastCheckedAt)}
              </Typography>
            </Box>
          </Box>

          <Typography variant="body2" color="text.secondary" mb={1.5}>{recon.reason}</Typography>

          <Box display="flex" gap={3} flexWrap="wrap">
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Total mismatches</Typography>
              <Typography variant="body1" fontWeight={700}>{recon.mismatchCount}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Critical mismatches</Typography>
              <Typography variant="body1" fontWeight={700} color={recon.criticalMismatchCount > 0 ? 'error.main' : 'text.primary'}>
                {recon.criticalMismatchCount}
              </Typography>
            </Box>
          </Box>
        </Paper>
      )}

      {/* Execution quality */}
      {quality && (
        <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
          <Typography variant="h6" fontWeight={700} mb={2}>Execution Quality (30D)</Typography>
          <Box display="flex" gap={3} flexWrap="wrap" mb={1.5}>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Execution Score</Typography>
              <Typography variant="h6" fontWeight={700} sx={{ color: scoreColor(quality.executionScore) }}>
                {quality.executionScore}/100
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Avg Slippage</Typography>
              <Typography variant="body1" fontWeight={700}>{fmt(quality.averageSlippagePct)}%</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Rejected Orders</Typography>
              <Typography variant="body1" fontWeight={700} color={quality.rejectedOrders > 0 ? 'error.main' : 'text.primary'}>
                {quality.rejectedOrders}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Partial Fills</Typography>
              <Typography variant="body1" fontWeight={700}>{quality.partialFills}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Avg Latency</Typography>
              <Typography variant="body1" fontWeight={700}>{fmt(quality.averageSimulatedLatencyMs, 0)} ms</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block">Total Orders</Typography>
              <Typography variant="body1" fontWeight={700}>{quality.totalOrders}</Typography>
            </Box>
          </Box>
          <Typography variant="body2" color="text.secondary">{quality.summary}</Typography>
        </Paper>
      )}

      {/* Recent execution events */}
      <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="h6" fontWeight={700} mb={2}>Recent Virtual Execution Events</Typography>
        {eventsLoading ? (
          <Box display="flex" justifyContent="center" py={3}><Spinner size={28} /></Box>
        ) : events.length === 0 ? (
          <Typography variant="body2" color="text.secondary">No execution events yet.</Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Symbol</TableCell>
                  <TableCell>Side</TableCell>
                  <TableCell>Fill</TableCell>
                  <TableCell align="right">Qty Filled</TableCell>
                  <TableCell align="right">Fill Price</TableCell>
                  <TableCell align="right">Slippage</TableCell>
                  <TableCell align="right">Charges</TableCell>
                  <TableCell align="right">Score</TableCell>
                  <TableCell>Filled At</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {events.map(ev => (
                  <TableRow key={ev.id} hover>
                    <TableCell sx={{ fontWeight: 600, fontFamily: 'monospace' }}>{ev.symbol}</TableCell>
                    <TableCell>
                      <Chip
                        label={ev.side}
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          backgroundColor: ev.side === 'BUY' ? '#10b98122' : '#ef444422',
                          color: ev.side === 'BUY' ? '#10b981' : '#ef4444',
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={ev.fillStatus}
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          backgroundColor: `${fillColor[ev.fillStatus]}22`,
                          color: fillColor[ev.fillStatus],
                        }}
                      />
                    </TableCell>
                    <TableCell align="right">{ev.quantityFilled}/{ev.quantityRequested}</TableCell>
                    <TableCell align="right">₹{fmt(ev.simulatedFillPrice)}</TableCell>
                    <TableCell align="right" sx={{ color: (ev.slippagePct ?? 0) > 0.25 ? '#ef4444' : 'text.primary' }}>
                      {fmt(ev.slippagePct)}%
                    </TableCell>
                    <TableCell align="right">₹{fmt(ev.totalCharges)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: scoreColor(ev.executionScore ?? 0) }}>
                      {ev.executionScore ?? '—'}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}>
                      {fmtTs(ev.orderFilledAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  );
};
