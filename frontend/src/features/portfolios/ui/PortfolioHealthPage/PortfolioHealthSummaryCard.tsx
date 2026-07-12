/**
 * Compact health card shown on the Portfolio Dashboard.
 * Links to /portfolios/:id/health for full detail.
 */
import { Link } from 'react-router-dom';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useGetPortfolioHealthQuery } from '../../../../store/portfolios/portfolios.api.ts';
import { HealthGradeChip } from './HealthGradeChip.tsx';

const timeAgo = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
};

const scoreColor = (score: number) =>
  score >= 85 ? '#10b981' : score >= 70 ? '#3b82f6' : score >= 50 ? '#f59e0b' : '#ef4444';

export const PortfolioHealthSummaryCard = ({ portfolioId }: { portfolioId: number }) => {
  const { data, isLoading } = useGetPortfolioHealthQuery(portfolioId, { pollingInterval: 0 });

  if (isLoading) {
    return (
      <Paper elevation={0} sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">Calculating health…</Typography>
      </Paper>
    );
  }

  if (!data) return null;

  const color = scoreColor(data.healthScore);
  const topRisk = data.topRisks[0];

  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        mb: 2,
        border: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexWrap: 'wrap',
        justifyContent: 'space-between',
      }}
    >
      {/* Score + grade */}
      <Box display="flex" alignItems="center" gap={1.5}>
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <CircularProgress
            variant="determinate"
            value={data.healthScore}
            size={48}
            thickness={4}
            sx={{ color, '& .MuiCircularProgress-circle': { strokeLinecap: 'round' } }}
          />
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography variant="caption" fontWeight={700} sx={{ fontSize: '0.7rem' }}>{data.healthScore}</Typography>
          </Box>
        </Box>
        <Box>
          <Box display="flex" alignItems="center" gap={0.75}>
            <Typography variant="body2" fontWeight={700}>Portfolio Health</Typography>
            <HealthGradeChip grade={data.healthGrade} />
          </Box>
          <Typography variant="caption" color="text.disabled">
            Updated {timeAgo(data.lastUpdated)}
          </Typography>
        </Box>
      </Box>

      {/* Goal prob */}
      <Box>
        <Typography variant="caption" color="text.disabled" display="block">Goal probability</Typography>
        <Typography variant="body2" fontWeight={700}>
          {data.goalImpossible
            ? '— Target not achievable'
            : data.goalProbabilityPct != null
              ? `${data.goalProbabilityPct.toFixed(0)}%`
              : '—'}
        </Typography>
      </Box>

      {/* Required monthly return */}
      <Box>
        <Typography variant="caption" color="text.disabled" display="block">Required monthly</Typography>
        <Typography variant="body2" fontWeight={700}>
          {data.requiredMonthlyReturnPct != null ? `${data.requiredMonthlyReturnPct.toFixed(2)}%` : '—'}
        </Typography>
      </Box>

      {/* Top risk */}
      {topRisk && (
        <Box>
          <Typography variant="caption" color="text.disabled" display="block">Top risk</Typography>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#f59e0b', fontSize: '0.7rem' }}>
            {topRisk}
          </Typography>
        </Box>
      )}

      {/* CTA */}
      <Button
        size="small"
        variant="outlined"
        endIcon={<ArrowForwardIcon sx={{ fontSize: '0.85rem !important' }} />}
        component={Link}
        to={`/portfolios/${portfolioId}/health`}
      >
        View Health Details
      </Button>
    </Paper>
  );
};
