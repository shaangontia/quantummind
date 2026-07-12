/**
 * Admin — Virtual Reconciliation Mismatches.
 * Route: /admin/virtual-reconciliation/mismatches
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  useGetAdminVirtualMismatchesQuery,
  useResolveVirtualMismatchMutation,
  useRetryVirtualReconciliationMutation,
} from '../../../../store/admin/index.ts';
import type { MismatchStatus, MismatchSeverity, VirtualMismatch } from '../../../../store/admin/admin.api.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';

const severityColor: Record<MismatchSeverity, string> = {
  INFO: '#3b82f6',
  WARNING: '#f59e0b',
  CRITICAL: '#ef4444',
};

const statusColor: Record<MismatchStatus, string> = {
  OPEN: '#f59e0b',
  AUTO_RESOLVED: '#10b981',
  MANUALLY_RESOLVED: '#10b981',
  IGNORED: '#6b7280',
};

const fmtTs = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export const AdminVirtualMismatchesPage = () => {
  const [statusFilter, setStatusFilter] = useState<MismatchStatus | ''>('OPEN');
  const [severityFilter, setSeverityFilter] = useState<MismatchSeverity | ''>('');
  const [resolveTarget, setResolveTarget] = useState<VirtualMismatch | null>(null);
  const [resolveNotes, setResolveNotes] = useState('');

  const { data: mismatches = [], isLoading, refetch } = useGetAdminVirtualMismatchesQuery({
    status: statusFilter || undefined,
    severity: severityFilter || undefined,
  });

  const [resolveVirtualMismatch, { isLoading: resolving }] = useResolveVirtualMismatchMutation();
  const [retryVirtualReconciliation] = useRetryVirtualReconciliationMutation();

  const handleResolve = async () => {
    if (!resolveTarget) return;
    await resolveVirtualMismatch({
      id: resolveTarget.id,
      body: { resolution: 'MANUALLY_RESOLVED', notes: resolveNotes },
    });
    setResolveTarget(null);
    setResolveNotes('');
  };

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2.5} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Virtual Mismatches</Typography>
          <Typography variant="body2" color="text.secondary">
            {mismatches.length} mismatch{mismatches.length !== 1 ? 'es' : ''} found
          </Typography>
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>Status</InputLabel>
            <Select
              value={statusFilter}
              label="Status"
              onChange={e => setStatusFilter(e.target.value as MismatchStatus | '')}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="OPEN">Open</MenuItem>
              <MenuItem value="AUTO_RESOLVED">Auto Resolved</MenuItem>
              <MenuItem value="MANUALLY_RESOLVED">Manually Resolved</MenuItem>
              <MenuItem value="IGNORED">Ignored</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>Severity</InputLabel>
            <Select
              value={severityFilter}
              label="Severity"
              onChange={e => setSeverityFilter(e.target.value as MismatchSeverity | '')}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="CRITICAL">Critical</MenuItem>
              <MenuItem value="WARNING">Warning</MenuItem>
              <MenuItem value="INFO">Info</MenuItem>
            </Select>
          </FormControl>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => void refetch()}>
            Refresh
          </Button>
        </Box>
      </Box>

      <Paper elevation={0} sx={{ overflow: 'hidden' }}>
        {isLoading ? (
          <Box display="flex" justifyContent="center" py={6}><Spinner size={32} /></Box>
        ) : mismatches.length === 0 ? (
          <Box py={6} textAlign="center">
            <Typography variant="body2" color="text.secondary">No mismatches match the current filters.</Typography>
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Portfolio</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Severity</TableCell>
                  <TableCell>Symbol</TableCell>
                  <TableCell>Expected</TableCell>
                  <TableCell>Actual</TableCell>
                  <TableCell>Blocks BUY</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mismatches.map(m => (
                  <TableRow key={m.id} hover>
                    <TableCell>{m.portfolioId}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                      {m.mismatchType.replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={m.severity}
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          backgroundColor: `${severityColor[m.severity]}22`,
                          color: severityColor[m.severity],
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{m.symbol ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{m.expectedValue ?? '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{m.actualValue ?? '—'}</TableCell>
                    <TableCell>
                      {m.blocksNewBuys
                        ? <Chip label="Yes" size="small" color="error" sx={{ height: 18, fontSize: '0.65rem' }} />
                        : <Typography variant="caption" color="text.disabled">No</Typography>}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={m.status.replace(/_/g, ' ')}
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          backgroundColor: `${statusColor[m.status]}22`,
                          color: statusColor[m.status],
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{fmtTs(m.createdAt)}</TableCell>
                    <TableCell>
                      <Box display="flex" gap={0.5}>
                        {m.status === 'OPEN' && (
                          <Button
                            size="small"
                            variant="outlined"
                            sx={{ fontSize: '0.7rem', py: 0.25 }}
                            onClick={() => setResolveTarget(m)}
                          >
                            Resolve
                          </Button>
                        )}
                        {m.status === 'OPEN' && (
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            sx={{ fontSize: '0.7rem', py: 0.25 }}
                            onClick={() => void retryVirtualReconciliation(m.portfolioId)}
                          >
                            Retry
                          </Button>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Resolve dialog */}
      <Dialog open={Boolean(resolveTarget)} onClose={() => setResolveTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Resolve Mismatch #{resolveTarget?.id}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>
            {resolveTarget?.mismatchType} — {resolveTarget?.symbol ?? 'system-level'}
          </Typography>
          <TextField
            label="Resolution notes"
            multiline
            rows={3}
            fullWidth
            value={resolveNotes}
            onChange={e => setResolveNotes(e.target.value)}
            placeholder="Describe what was corrected or why this is being resolved…"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolveTarget(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void handleResolve()}
            disabled={resolving}
            startIcon={resolving ? <CircularProgress size={14} /> : undefined}
          >
            Mark Resolved
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
