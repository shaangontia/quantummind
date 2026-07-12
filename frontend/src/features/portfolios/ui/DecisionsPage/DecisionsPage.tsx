import { useState } from 'react';
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
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import ReplayIcon from '@mui/icons-material/Replay';
import { useGetPortfolioDecisionsQuery } from '../../../../store/portfolios/portfolios.api.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { DecisionReplayDrawer } from './DecisionReplayDrawer.tsx';
import type { DecisionType } from '../../../../store/portfolios/portfolios.api.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const DECISION_VARIANT: Record<DecisionType, BadgeVariant> = {
  BUY:  'green',
  SELL: 'red',
  SKIP: 'yellow',
  VETO: 'gray',
};

const DECISION_ICON: Record<DecisionType, string> = {
  BUY:  '📈',
  SELL: '📉',
  SKIP: '⏭',
  VETO: '🚫',
};

const formatDecisionTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const DecisionsPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTitle, setSelectedTitle] = useState('');

  const limit = 50;
  const { data: decisions = [], isLoading, isFetching } = useGetPortfolioDecisionsQuery(
    { portfolioId, limit, offset: page * limit },
    { pollingInterval: 0 },
  );

  const openReplay = (decisionId: string, title: string) => {
    setSelectedId(decisionId);
    setSelectedTitle(title);
  };

  const hasMore = decisions.length === limit;

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Portfolios</Box>
        <Box component={Link} to={`/portfolios/${portfolioId}`} sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Dashboard</Box>
        <Typography variant="body2" color="text.primary">Decisions</Typography>
      </Breadcrumbs>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Decision Activity</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Every BUY, SELL, SKIP and VETO decision made by the engine for this portfolio
        </Typography>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : decisions.length === 0 ? (
        <EmptyState
          icon="🧠"
          title="No decisions yet"
          description="Decisions will appear here once the engine starts evaluating candidates."
        />
      ) : (
        <>
          <Paper elevation={0}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Time</TableCell>
                    <TableCell>Decision</TableCell>
                    <TableCell>Symbol</TableCell>
                    <TableCell>Title</TableCell>
                    <TableCell padding="checkbox" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {decisions.map(d => (
                    <TableRow
                      key={d.decisionId}
                      hover
                      onClick={() => openReplay(d.decisionId, d.title)}
                      sx={{ cursor: 'pointer', userSelect: 'none' }}
                    >
                      <TableCell>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {formatDecisionTime(d.decisionTime)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Badge variant={DECISION_VARIANT[d.decision]}>
                          {DECISION_ICON[d.decision]} {d.decision}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>{d.symbol}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 300, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.title}
                        </Typography>
                      </TableCell>
                      <TableCell padding="checkbox">
                        <Tooltip title="View replay">
                          <ReplayIcon sx={{ fontSize: '1rem', color: 'text.disabled' }} />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>

          {/* Pagination */}
          <Box display="flex" alignItems="center" justifyContent="center" gap={2} mt={2}>
            <Button variant="outlined" size="small" disabled={page === 0 || isFetching} onClick={() => setPage(p => p - 1)}>
              ← Prev
            </Button>
            <Typography variant="body2" color="text.secondary">Page {page + 1}</Typography>
            <Button variant="outlined" size="small" disabled={!hasMore || isFetching} onClick={() => setPage(p => p + 1)}>
              Next →
            </Button>
          </Box>
        </>
      )}

      {/* Replay drawer — only exposes user-safe fields */}
      <DecisionReplayDrawer
        portfolioId={portfolioId}
        decisionId={selectedId}
        decisionTitle={selectedTitle}
        onClose={() => setSelectedId(null)}
      />
    </Box>
  );
};
