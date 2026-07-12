/**
 * Admin — Candidate Trace: full candidate universe for a portfolio + date.
 * Route: /admin/candidate-trace
 */
import { useState } from 'react';
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
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useGetAdminCandidateTraceQuery } from '../../../../store/admin/index.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const ACTION_VARIANT: Record<string, BadgeVariant> = {
  EXECUTED: 'green',
  SKIPPED:  'yellow',
  VETOED:   'gray',
  WEAK:     'red',
};

const pct = (v: number | null) => v != null ? `${(v * 100).toFixed(1)}%` : '—';
const score = (v: number | null) => v != null ? v.toFixed(3) : '—';

export const AdminCandidateTracePage = () => {
  const navigate = useNavigate();

  const [portfolioId, setPortfolioId] = useState('');
  const [date, setDate] = useState('');
  const [query, setQuery] = useState<{ portfolioId: number; date?: string } | null>(null);

  const { data, isLoading, isFetching } = useGetAdminCandidateTraceQuery(
    query ?? { portfolioId: 0 },
    { skip: !query },
  );

  const handleSearch = () => {
    if (!portfolioId) return;
    setQuery({ portfolioId: Number(portfolioId), date: date || undefined });
  };

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')} sx={{ color: 'text.secondary' }}>
          Portfolios
        </Button>
      </Box>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Candidate Trace</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Admin — full candidate universe evaluated by the engine for a given portfolio and date
        </Typography>
      </Box>

      {/* Search bar */}
      <Paper elevation={0} sx={{ p: 2, mb: 2 }}>
        <Box display="flex" gap={2} alignItems="flex-end" flexWrap="wrap">
          <TextField
            label="Portfolio ID" size="small" sx={{ width: 140 }} type="number"
            value={portfolioId}
            onChange={e => setPortfolioId(e.target.value)}
          />
          <TextField
            label="Date (optional)" size="small" type="date" sx={{ width: 180 }}
            InputLabelProps={{ shrink: true }}
            value={date}
            onChange={e => setDate(e.target.value)}
          />
          <Button variant="contained" size="small" onClick={handleSearch} disabled={!portfolioId || isFetching}>
            {isFetching ? 'Loading…' : 'Fetch trace'}
          </Button>
        </Box>
      </Paper>

      {!query && (
        <EmptyState icon="🔬" title="Enter a portfolio ID" description="Select a portfolio and optional date to load the full candidate trace." />
      )}

      {query && isLoading && (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      )}

      {data && (
        <>
          <Box display="flex" alignItems="center" gap={2} mb={2}>
            <Typography variant="body2" color="text.secondary">
              <Box component="span" fontWeight={700}>{data.totalCandidates}</Box> candidates · Portfolio #{data.portfolioId} · {data.date}
            </Typography>
            <Box display="flex" gap={1}>
              {(['EXECUTED', 'SKIPPED', 'VETOED', 'WEAK'] as const).map(a => {
                const count = data.candidates.filter(c => c.actionTaken === a).length;
                return count > 0 ? (
                  <Badge key={a} variant={ACTION_VARIANT[a]}>{a}: {count}</Badge>
                ) : null;
              })}
            </Box>
          </Box>

          <Paper elevation={0}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Symbol</TableCell>
                    <TableCell>Sector</TableCell>
                    <TableCell>Strategy</TableCell>
                    <TableCell align="right">Signal</TableCell>
                    <TableCell align="right">Utility</TableCell>
                    <TableCell align="right">P(win)</TableCell>
                    <TableCell align="right">Fund. score</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Blocked by</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.candidates.map(c => (
                    <TableRow key={c.candidateId} hover>
                      <TableCell>
                        <Box>
                          <Typography variant="body2" fontWeight={700}>{c.symbol}</Typography>
                          {c.companyName && (
                            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 120, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {c.companyName}
                            </Typography>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell><Typography variant="caption" color="text.secondary">{c.sector ?? '—'}</Typography></TableCell>
                      <TableCell><Typography variant="caption" color="text.secondary">{c.strategyType ?? '—'}</Typography></TableCell>
                      <TableCell align="right"><Typography variant="body2">{score(c.signalScore)}</Typography></TableCell>
                      <TableCell align="right"><Typography variant="body2">{score(c.utilityScore)}</Typography></TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color={
                          c.mlWinProbability == null ? 'text.disabled' :
                          c.mlWinProbability >= 0.55 ? 'success.main' : 'warning.main'
                        }>
                          {pct(c.mlWinProbability)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color={
                          c.fundamentalScore == null ? 'text.disabled' :
                          c.fundamentalScore >= 60 ? 'success.main' :
                          c.fundamentalScore < 40 ? 'error.main' : 'text.secondary'
                        }>
                          {c.fundamentalScore != null ? c.fundamentalScore : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell><Badge variant={ACTION_VARIANT[c.actionTaken]}>{c.actionTaken}</Badge></TableCell>
                      <TableCell>
                        {c.filtersBlocked.length > 0 ? (
                          <Tooltip title={c.filtersBlocked.join(', ')}>
                            <Box display="flex" gap={0.5} flexWrap="wrap" maxWidth={200}>
                              {c.filtersBlocked.slice(0, 2).map(f => (
                                <Chip key={f} label={f} size="small"
                                  sx={{ fontSize: '0.6rem', height: 16, bgcolor: 'rgba(239,68,68,0.1)', color: 'error.light' }} />
                              ))}
                              {c.filtersBlocked.length > 2 && (
                                <Typography variant="caption" color="text.disabled">+{c.filtersBlocked.length - 2}</Typography>
                              )}
                            </Box>
                          </Tooltip>
                        ) : (
                          <Typography variant="caption" color="success.main">✓ passed</Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}
    </Box>
  );
};
