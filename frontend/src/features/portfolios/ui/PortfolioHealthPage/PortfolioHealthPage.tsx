import { Link, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import { useGetPortfolioHealthQuery } from '../../../../store/portfolios/portfolios.api.ts';
import { HealthGradeChip } from './HealthGradeChip.tsx';
import { GoalProbabilityCard } from './GoalProbabilityCard.tsx';
import { HealthComponentBreakdown } from './HealthComponentBreakdown.tsx';
import { HealthTrendChart } from './HealthTrendChart.tsx';
import { HealthRecommendationsPanel } from './HealthRecommendationsPanel.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

const MetricTile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <Box sx={{ p: 1.5, bgcolor: 'rgba(255,255,255,0.02)', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
    <Typography variant="caption" color="text.disabled" display="block">{label}</Typography>
    <Typography variant="body1" fontWeight={700} mt={0.25}>{value}</Typography>
    {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
  </Box>
);

const timeAgo = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
};

export const PortfolioHealthPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const { data, isLoading, error } = useGetPortfolioHealthQuery(portfolioId);

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Portfolios</Box>
        <Box component={Link} to={`/portfolios/${portfolioId}`} sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>Dashboard</Box>
        <Typography variant="body2" color="text.primary">Health</Typography>
      </Breadcrumbs>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Portfolio Health</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Explainable health snapshot — goal probability, risk factors, and recommendations
        </Typography>
      </Box>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={8}><CircularProgress size={32} /></Box>
      )}

      {error && (
        <Alert severity="error">Failed to load health data. Please try again.</Alert>
      )}

      {data && (
        <>
          {/* Hero row: score + grade + key metrics */}
          <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
            <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2} mb={2}>
              <Box display="flex" alignItems="center" gap={2}>
                <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                  <CircularProgress
                    variant="determinate"
                    value={data.healthScore}
                    size={72}
                    thickness={4}
                    sx={{
                      color: data.healthScore >= 85 ? '#10b981' : data.healthScore >= 70 ? '#3b82f6' : data.healthScore >= 50 ? '#f59e0b' : '#ef4444',
                      '& .MuiCircularProgress-circle': { strokeLinecap: 'round' },
                    }}
                  />
                  <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Typography variant="h6" fontWeight={800}>{data.healthScore}</Typography>
                  </Box>
                </Box>
                <Box>
                  <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                    <Typography variant="h5" fontWeight={700}>Health Score</Typography>
                    <HealthGradeChip grade={data.healthGrade} size="medium" />
                  </Box>
                  <Typography variant="caption" color="text.disabled">
                    Last updated: {timeAgo(data.lastUpdated)}
                  </Typography>
                </Box>
              </Box>
            </Box>

            <Grid container spacing={1.5}>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile label="Cash" value={data.cashPct != null ? `${data.cashPct.toFixed(1)}%` : '—'} />
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile label="Invested" value={data.investedPct != null ? `${data.investedPct.toFixed(1)}%` : '—'} />
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile label="Positions" value={data.openPositionsCount?.toString() ?? '—'} />
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile
                  label="Current return"
                  value={data.currentReturnPct != null ? `${data.currentReturnPct >= 0 ? '+' : ''}${data.currentReturnPct.toFixed(2)}%` : '—'}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile
                  label="Drawdown"
                  value={data.currentDrawdownPct != null ? `${data.currentDrawdownPct.toFixed(2)}%` : '—'}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2}>
                <MetricTile label="Required monthly" value={data.requiredMonthlyReturnPct != null ? `${data.requiredMonthlyReturnPct.toFixed(2)}%` : '—'} />
              </Grid>
            </Grid>
          </Paper>

          {/* Goal probability + component breakdown */}
          <Grid container spacing={2} mb={2}>
            <Grid item xs={12} md={5}>
              <GoalProbabilityCard health={data} />
            </Grid>
            <Grid item xs={12} md={7}>
              <Paper elevation={0} sx={{ p: 2.5, height: '100%' }}>
                <Typography variant="subtitle2" fontWeight={700} mb={2}>Component Breakdown</Typography>
                <HealthComponentBreakdown components={data.components} />
              </Paper>
            </Grid>
          </Grid>

          {/* Recommendations */}
          {(data.recommendations.length > 0 || data.topRisks.length > 0) && (
            <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
              <Typography variant="subtitle2" fontWeight={700} mb={2}>Risks & Recommendations</Typography>
              <HealthRecommendationsPanel recommendations={data.recommendations} topRisks={data.topRisks} />
            </Paper>
          )}

          <Divider sx={{ my: 0 }} />

          {/* Health trend chart */}
          <Paper elevation={0} sx={{ p: 2.5, mt: 2 }}>
            <HealthTrendChart portfolioId={portfolioId} />
          </Paper>
        </>
      )}

      {!isLoading && !error && !data && (
        <EmptyState
          icon="🏥"
          title="Health data not yet available"
          description="Health will be calculated on the next market cycle or after the first trade."
        />
      )}
    </Box>
  );
};
