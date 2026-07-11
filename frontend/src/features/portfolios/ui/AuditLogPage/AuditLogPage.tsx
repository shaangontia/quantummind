import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Collapse from '@mui/material/Collapse';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
import type { Trade, ApiResponse } from '../../../../api/portfolio.api.types.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { formatINR, formatDate } from '../../model/portfolios.utils.ts';

const API_BASE = '/api';

const TradeExplanation = ({ tradeId, portfolioId }: { tradeId: number; portfolioId: number }) => {
  const { data, isLoading, error } = useQuery<{ explanation: string }>({
    queryKey: ['trade-explanation', portfolioId, tradeId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/portfolios/${portfolioId}/trades/${tradeId}/explanation`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load explanation');
      return { explanation: json.explanation };
    },
    staleTime: 10 * 60_000,
  });

  if (isLoading) return <Typography variant="caption" color="text.secondary" sx={{ p: 1.5, display: 'block' }}>⏳ Generating AI explanation…</Typography>;
  if (error) return <Alert severity="error" sx={{ m: 1 }}>{(error as Error).message}</Alert>;
  return (
    <Box sx={{ px: 2.5, py: 1.5, bgcolor: 'rgba(139,92,246,0.04)', borderTop: '1px solid rgba(139,92,246,0.15)' }}>
      <Typography variant="body2" color="text.secondary">
        <Box component="span" sx={{ color: 'secondary.light', fontWeight: 700, mr: 1 }}>🤖 TARS:</Box>
        {data?.explanation ?? '—'}
      </Typography>
    </Box>
  );
};

export const AuditLogPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const toggleExpand = (tid: number) => setExpandedId(prev => prev === tid ? null : tid);

  const { data, isLoading } = useQuery<ApiResponse<Trade[]>>({
    queryKey: ['trades', portfolioId, page],
    queryFn: () => portfolioApi.trades(portfolioId, page, 50),
    staleTime: 30_000,
    placeholderData: prev => prev,
  });

  const trades      = data?.data ?? [];
  const totalPages  = data?.pagination?.pages ?? 1;
  const total       = data?.pagination?.total ?? 0;

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Portfolios</Box>
        <Box component={Link} to={`/portfolios/${portfolioId}`} sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Dashboard</Box>
        <Typography variant="body2" color="text.primary">Audit Log</Typography>
      </Breadcrumbs>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Trade Audit Log</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>{total} total transactions recorded</Typography>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : trades.length === 0 ? (
        <EmptyState icon="📋" title="No trades yet" description="Trades will appear here once the AI starts executing virtual trades." />
      ) : (
        <>
          <Paper elevation={0}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell>
                    <TableCell>Date & Time</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Symbol</TableCell>
                    <TableCell>Company</TableCell>
                    <TableCell align="right">Qty</TableCell>
                    <TableCell align="right">Price</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell align="right">Brokerage</TableCell>
                    <TableCell align="right">Net</TableCell>
                    <TableCell align="right">Realized P&amp;L</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {trades.map(t => {
                    const isExpanded = expandedId === t.id;
                    return (
                      <React.Fragment key={t.id}>
                        <TableRow
                          hover
                          onClick={() => toggleExpand(t.id)}
                          sx={{ cursor: 'pointer', userSelect: 'none' }}
                        >
                          <TableCell><Typography variant="caption" color="text.secondary">{t.id}</Typography></TableCell>
                          <TableCell><Typography variant="caption" color="text.secondary" noWrap>{formatDate(t.trade_time)}</Typography></TableCell>
                          <TableCell><Badge variant={t.action === 'BUY' ? 'green' : 'red'}>{t.action}</Badge></TableCell>
                          <TableCell><Typography fontWeight={700} variant="body2">{t.symbol}</Typography></TableCell>
                          <TableCell><Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 120, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.company_name ?? '—'}</Typography></TableCell>
                          <TableCell align="right"><Typography variant="body2">{t.quantity}</Typography></TableCell>
                          <TableCell align="right"><Typography variant="body2">{formatINR(t.price)}</Typography></TableCell>
                          <TableCell align="right"><Typography variant="body2">{formatINR(t.amount)}</Typography></TableCell>
                          <TableCell align="right"><Typography variant="caption" color="text.secondary">{formatINR(t.brokerage)}</Typography></TableCell>
                          <TableCell align="right">
                            <Typography variant="body2" color={t.action === 'BUY' ? 'error.main' : 'success.main'}>{formatINR(t.net_amount)}</Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Typography variant="body2" fontWeight={600} color={t.realized_pnl == null ? 'text.disabled' : t.realized_pnl >= 0 ? 'success.main' : 'error.main'}>
                              {t.action !== 'SELL' ? '—' : t.realized_pnl == null ? 'Pending' : (t.realized_pnl >= 0 ? '+' : '') + formatINR(t.realized_pnl)}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 200, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {t.signal_reason ?? '—'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Badge variant={t.status === 'EXECUTED' ? 'green' : t.status === 'FAILED' ? 'red' : 'gray'}>{t.status}</Badge>
                          </TableCell>
                          <TableCell padding="checkbox">
                            {isExpanded ? <ExpandLessIcon sx={{ fontSize: '1rem', color: 'text.secondary' }} /> : <ExpandMoreIcon sx={{ fontSize: '1rem', color: 'text.secondary' }} />}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell colSpan={14} sx={{ p: 0, border: 0 }}>
                            <Collapse in={isExpanded} unmountOnExit>
                              <TradeExplanation tradeId={t.id} portfolioId={portfolioId} />
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          {totalPages > 1 && (
            <Box display="flex" alignItems="center" justifyContent="center" gap={2} mt={2}>
              <Button variant="outlined" size="small" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</Button>
              <Typography variant="body2" color="text.secondary">Page {page} of {totalPages}</Typography>
              <Button variant="outlined" size="small" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};
