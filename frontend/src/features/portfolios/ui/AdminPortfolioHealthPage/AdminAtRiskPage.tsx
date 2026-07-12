/**
 * Admin — At-Risk Portfolios: health < 50 OR goalProb < 30 OR kill-switch in topRisks.
 * Route: /admin/portfolio-health/at-risk
 */
import { useNavigate, Link } from 'react-router-dom';
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
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useGetAdminAtRiskPortfoliosQuery, useRecalculatePortfolioHealthMutation } from '../../../../store/admin/index.ts';
import { HealthGradeChip } from '../PortfolioHealthPage/HealthGradeChip.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

const timeAgo = (iso: string) => {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
};

export const AdminAtRiskPage = () => {
  const navigate = useNavigate();
  const { data: portfolios = [], isLoading, refetch } = useGetAdminAtRiskPortfoliosQuery();
  const [recalculate, { isLoading: isRecalcLoading }] = useRecalculatePortfolioHealthMutation();

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/admin/portfolio-health')} sx={{ color: 'text.secondary' }}>
          Health Overview
        </Button>
      </Box>

      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2} flexWrap="wrap">
        <Box>
          <Typography variant="h4" fontWeight={700}>At-Risk Portfolios</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            Portfolios with health &lt; 50, goal probability &lt; 30%, or active kill-switch
          </Typography>
        </Box>
        <Button size="small" variant="outlined" onClick={() => void refetch()}>Refresh</Button>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : portfolios.length === 0 ? (
        <EmptyState icon="✅" title="No at-risk portfolios" description="All portfolios are currently healthy." />
      ) : (
        <Paper elevation={0}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Portfolio</TableCell>
                  <TableCell align="center">Grade</TableCell>
                  <TableCell align="right">Health</TableCell>
                  <TableCell align="right">Goal Prob</TableCell>
                  <TableCell>Top Risks</TableCell>
                  <TableCell>Last updated</TableCell>
                  <TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {portfolios.map(p => (
                  <TableRow key={p.portfolioId} hover>
                    <TableCell>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          <Box component={Link} to={`/portfolios/${p.portfolioId}/health`}
                            sx={{ color: 'inherit', textDecoration: 'none', '&:hover': { color: 'primary.main' } }}>
                            {p.portfolioName}
                          </Box>
                        </Typography>
                        <Typography variant="caption" color="text.disabled">#{p.portfolioId}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="center">
                      <HealthGradeChip grade={p.healthGrade} />
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" fontWeight={700}
                        color={p.healthScore < 50 ? 'error.main' : 'warning.main'}>
                        {p.healthScore}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2"
                        color={p.goalProbabilityPct != null && p.goalProbabilityPct < 30 ? 'error.main' : 'text.secondary'}>
                        {p.goalProbabilityPct != null ? `${p.goalProbabilityPct.toFixed(0)}%` : '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box display="flex" gap={0.5} flexWrap="wrap" maxWidth={240}>
                        {p.topRisks.slice(0, 3).map(r => (
                          <Chip key={r} label={r} size="small"
                            sx={{ fontFamily: 'monospace', fontSize: '0.6rem', height: 18,
                              bgcolor: 'rgba(239,68,68,0.1)', color: 'error.light' }} />
                        ))}
                        {p.topRisks.length > 3 && (
                          <Typography variant="caption" color="text.disabled">+{p.topRisks.length - 3}</Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">{timeAgo(p.lastUpdated)}</Typography>
                    </TableCell>
                    <TableCell padding="checkbox">
                      <Button size="small" variant="text" sx={{ fontSize: '0.7rem', minWidth: 0, px: 1 }}
                        disabled={isRecalcLoading}
                        onClick={() => void recalculate({ portfolioId: p.portfolioId })}>
                        Recalc
                      </Button>
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
