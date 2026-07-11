import { useParams, Link } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useGetPortfolioSignalsQuery } from '../../../../store/portfolios/index.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { StrategyTypeBadge } from '../StrategyTypeBadge/index.ts';
import { GeminiRiskSummary } from '../GeminiRiskSummary/index.ts';
import { formatDate, signalColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const strengthVariant = (s?: string): BadgeVariant => {
  if (s === 'STRONG') return 'green';
  if (s === 'MODERATE') return 'yellow';
  return 'gray';
};

export const SignalsPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const { data: signals = [], isLoading } = useGetPortfolioSignalsQuery(portfolioId, { pollingInterval: 30_000 });

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Portfolios</Box>
        <Box component={Link} to={`/portfolios/${portfolioId}`} sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Dashboard</Box>
        <Typography variant="body2" color="text.primary">Market Signals</Typography>
      </Breadcrumbs>

      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2}>
        <Box>
          <Typography variant="h4" fontWeight={700}>Market Signals</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>AI-generated buy/sell signals — auto-refreshes every 30s</Typography>
        </Box>
        <Box display="flex" alignItems="center" gap={1}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', animation: 'pulse 2s infinite', '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.5 } } }} />
          <Typography variant="caption" color="success.main" fontWeight={600}>Live</Typography>
        </Box>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : signals.length === 0 ? (
        <EmptyState icon="📡" title="No signals yet" description="The AI is monitoring the market. Signals will appear as it identifies opportunities." />
      ) : (
        <Paper elevation={0}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Symbol</TableCell>
                  <TableCell>Signal</TableCell>
                  <TableCell>Strength</TableCell>
                  <TableCell>Strategy</TableCell>
                  <TableCell align="right">Price</TableCell>
                  <TableCell>Reason / Risk</TableCell>
                  <TableCell align="center">Acted</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {signals.map(s => (
                  <TableRow key={s.id} sx={s.acted_upon ? { bgcolor: 'rgba(59,130,246,0.04)' } : {}}>
                    <TableCell><Typography variant="caption" color="text.secondary" noWrap>{formatDate(s.signal_time)}</Typography></TableCell>
                    <TableCell><Typography fontWeight={700} variant="body2">{s.symbol}</Typography></TableCell>
                    <TableCell><Badge variant={signalColor(s.signal_type) as BadgeVariant}>{s.signal_type}</Badge></TableCell>
                    <TableCell>{s.strength && <Badge variant={strengthVariant(s.strength)}>{s.strength}</Badge>}</TableCell>
                    <TableCell><StrategyTypeBadge strategy={s.strategyType} /></TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{s.price_at_signal != null ? `₹${s.price_at_signal.toLocaleString('en-IN')}` : '—'}</Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 260 }}>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.reason ?? '—'}
                      </Typography>
                      <GeminiRiskSummary
                        riskLevel={s.geminiRiskLevel}
                        redFlags={s.geminiRedFlags}
                        newsEventType={s.geminiNewsEventType}
                      />
                    </TableCell>
                    <TableCell align="center">
                      {s.acted_upon
                        ? <CheckCircleIcon sx={{ fontSize: '1rem', color: 'success.main' }} />
                        : <RadioButtonUncheckedIcon sx={{ fontSize: '1rem', color: 'text.disabled' }} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}
    </Box>
  );
};
