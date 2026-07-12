/**
 * Admin — Failed Decisions: VETO + SKIP aggregate analysis.
 * Route: /admin/failed-decisions
 */
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import LinearProgress from '@mui/material/LinearProgress';
import Grid from '@mui/material/Grid';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import BlockIcon from '@mui/icons-material/Block';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import { useGetAdminFailedDecisionsQuery } from '../../../../store/admin/index.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import type { DecisionType } from '../../../../store/portfolios/portfolios.api.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const DECISION_VARIANT: Record<DecisionType, BadgeVariant> = {
  BUY: 'green', SELL: 'red', SKIP: 'yellow', VETO: 'gray',
};

const fmt = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export const AdminFailedDecisionsPage = () => {
  const navigate = useNavigate();
  const { data, isLoading } = useGetAdminFailedDecisionsQuery({});

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')} sx={{ color: 'text.secondary' }}>
          Portfolios
        </Button>
      </Box>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Failed Decisions</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Admin — VETO and SKIP decisions with top reason code aggregates
        </Typography>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : !data ? (
        <EmptyState icon="✅" title="No failed decisions" description="No VETO or SKIP decisions recorded yet." />
      ) : (
        <>
          {/* Summary cards */}
          <Grid container spacing={2} mb={3}>
            {[
              { icon: <BlockIcon sx={{ color: 'error.main' }} />, label: 'Total Failed', value: data.totalFailed },
              { icon: <BlockIcon sx={{ color: '#94a3b8' }} />, label: 'VETOs', value: data.vetoCount },
              { icon: <SkipNextIcon sx={{ color: '#f59e0b' }} />, label: 'SKIPs', value: data.skipCount },
            ].map(({ icon, label, value }) => (
              <Grid item xs={12} sm={4} key={label}>
                <Paper elevation={0} sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  {icon}
                  <Box>
                    <Typography variant="caption" color="text.secondary">{label}</Typography>
                    <Typography variant="h5" fontWeight={700}>{value.toLocaleString()}</Typography>
                  </Box>
                </Paper>
              </Grid>
            ))}
          </Grid>

          {/* Top reasons */}
          <Paper elevation={0} sx={{ p: 2.5, mb: 3 }}>
            <Typography variant="h6" fontWeight={700} mb={2}>Top Rejection Reasons</Typography>
            {data.topReasons.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No reason data yet.</Typography>
            ) : (
              data.topReasons.map(r => (
                <Box key={r.reasonCode} mb={2}>
                  <Box display="flex" justifyContent="space-between" mb={0.5}>
                    <Box>
                      <Typography variant="body2" fontWeight={600} component="span">{r.label}</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ ml: 1, fontFamily: 'monospace' }}>{r.reasonCode}</Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">{r.count} ({r.pct.toFixed(1)}%)</Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={r.pct}
                    sx={{
                      height: 6, borderRadius: 3,
                      bgcolor: 'rgba(255,255,255,0.06)',
                      '& .MuiLinearProgress-bar': { bgcolor: '#8b5cf6' },
                    }}
                  />
                </Box>
              ))
            )}
          </Paper>

          {/* Recent failed decisions */}
          {data.recentDecisions.length > 0 && (
            <Paper elevation={0}>
              <Box sx={{ px: 2.5, pt: 2.5, pb: 1 }}>
                <Typography variant="h6" fontWeight={700}>Recent Failed Decisions</Typography>
              </Box>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Time</TableCell>
                      <TableCell>Portfolio</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell>Symbol</TableCell>
                      <TableCell>Title</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.recentDecisions.map(d => (
                      <TableRow key={d.decisionId} hover>
                        <TableCell><Typography variant="caption" color="text.secondary" noWrap>{fmt(d.decisionTime)}</Typography></TableCell>
                        <TableCell><Typography variant="caption" color="text.secondary">#{d.portfolioId}</Typography></TableCell>
                        <TableCell><Badge variant={DECISION_VARIANT[d.decision]}>{d.decision}</Badge></TableCell>
                        <TableCell><Typography variant="body2" fontWeight={700}>{d.symbol}</Typography></TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary"
                            sx={{ maxWidth: 280, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {d.title}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
};
