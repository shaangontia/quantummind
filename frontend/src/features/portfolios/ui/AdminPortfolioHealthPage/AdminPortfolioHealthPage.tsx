/**
 * Admin — System-wide Portfolio Health Overview.
 * Route: /admin/portfolio-health
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningIcon from '@mui/icons-material/Warning';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import {
  useGetAdminHealthOverviewQuery,
  useRecalculateAllHealthMutation,
} from '../../../../store/admin/index.ts';
import type { HealthDistribution } from '../../../../store/admin/admin.api.ts';

const GRADE_CONFIG = {
  EXCELLENT: {
    color: '#10b981',
    icon: <CheckCircleIcon sx={{ fontSize: '1.1rem' }} />,
    scoreRange: '85 – 100',
    description: 'All signals healthy. Strong momentum, low risk, on track for goal.',
  },
  GOOD: {
    color: '#3b82f6',
    icon: <CheckCircleIcon sx={{ fontSize: '1.1rem' }} />,
    scoreRange: '70 – 84',
    description: 'Minor concerns within acceptable range. No intervention needed.',
  },
  WARNING: {
    color: '#f59e0b',
    icon: <WarningIcon sx={{ fontSize: '1.1rem' }} />,
    scoreRange: '50 – 69',
    description: 'Degraded signals. Review recommended — goal probability dropping.',
  },
  CRITICAL: {
    color: '#ef4444',
    icon: <ErrorIcon sx={{ fontSize: '1.1rem' }} />,
    scoreRange: '0 – 49',
    description: 'Multiple risk factors triggered. Immediate attention required.',
  },
} as const;

const GradeCard = ({ grade, count, total }: { grade: keyof HealthDistribution; count: number; total: number }) => {
  const { color, icon, scoreRange, description } = GRADE_CONFIG[grade];
  const pct = total > 0 ? ((count / total) * 100).toFixed(0) : '0';
  return (
    <Paper elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
      <Box display="flex" alignItems="center" justifyContent="center" gap={0.75} sx={{ color }}>
        {icon}
        <Typography variant="caption" fontWeight={700} sx={{ color }}>{grade}</Typography>
      </Box>
      <Typography variant="caption" sx={{ color, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
        Score {scoreRange}
      </Typography>
      <Typography variant="h4" fontWeight={800} sx={{ color, my: 0.5 }}>{count}</Typography>
      <Typography variant="caption" color="text.disabled" display="block">{pct}% of portfolios</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, lineHeight: 1.4, maxWidth: 160 }}>
        {description}
      </Typography>
    </Paper>
  );
};

export const AdminPortfolioHealthPage = () => {
  const navigate = useNavigate();
  const [snack, setSnack] = useState(false);

  const { data, isLoading, refetch } = useGetAdminHealthOverviewQuery();
  const [recalcAll, { isLoading: isRecalcLoading }] = useRecalculateAllHealthMutation();

  const handleRecalcAll = async () => {
    try {
      await recalcAll().unwrap();
      setSnack(true);
    } catch {
      /* error handled by RTK Query */
    }
  };

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')} sx={{ color: 'text.secondary' }}>
          Portfolios
        </Button>
      </Box>

      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2} flexWrap="wrap">
        <Box>
          <Typography variant="h4" fontWeight={700}>Portfolio Health Overview</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            Admin — system-wide health distribution and top risk reasons
          </Typography>
        </Box>
        <Box display="flex" gap={1}>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />}
            onClick={() => void refetch()} disabled={isLoading}>
            Refresh
          </Button>
          <Button size="small" variant="outlined" component={Link} to="/admin/portfolio-health/at-risk">
            At-Risk Portfolios
          </Button>
          <Button size="small" variant="outlined" component={Link} to="/admin/portfolio-health/config">
            Score Config
          </Button>
          <Button
            size="small" variant="contained"
            startIcon={isRecalcLoading ? <CircularProgress size={12} color="inherit" /> : <RefreshIcon />}
            onClick={() => void handleRecalcAll()}
            disabled={isRecalcLoading}
          >
            Recalculate All
          </Button>
        </Box>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : !data ? (
        <Alert severity="warning">No health data available yet.</Alert>
      ) : (
        <>
          {/* Summary */}
          <Box display="flex" alignItems="center" gap={2} mb={3} flexWrap="wrap">
            <Paper elevation={0} sx={{ px: 2.5, py: 1.5, border: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.disabled" display="block">Total portfolios</Typography>
              <Typography variant="h5" fontWeight={700}>{data.totalPortfolios}</Typography>
            </Paper>
            <Paper elevation={0} sx={{ px: 2.5, py: 1.5, border: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.disabled" display="block">Average health score</Typography>
              <Typography variant="h5" fontWeight={700}>{data.averageHealthScore.toFixed(0)} / 100</Typography>
            </Paper>
          </Box>

          {/* Grade distribution */}
          <Grid container spacing={2} mb={3}>
            {(['EXCELLENT', 'GOOD', 'WARNING', 'CRITICAL'] as const).map(grade => (
              <Grid item xs={6} sm={3} key={grade}>
                <GradeCard
                  grade={grade}
                  count={data.healthDistribution[grade]}
                  total={data.totalPortfolios}
                />
              </Grid>
            ))}
          </Grid>

          {/* Top risk reasons */}
          {data.topRiskReasons.length > 0 && (
            <Paper elevation={0} sx={{ p: 2.5 }}>
              <Typography variant="subtitle2" fontWeight={700} mb={1.5}>Top Risk Reasons System-wide</Typography>
              <Box display="flex" gap={0.75} flexWrap="wrap">
                {data.topRiskReasons.map((r, i) => (
                  <Chip
                    key={r}
                    label={`#${i + 1}  ${r}`}
                    size="small"
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: '0.68rem',
                      height: 24,
                      bgcolor: i === 0 ? 'rgba(239,68,68,0.12)' : i === 1 ? 'rgba(245,158,11,0.12)' : 'rgba(100,116,139,0.12)',
                      color: i === 0 ? 'error.light' : i === 1 ? '#f59e0b' : 'text.secondary',
                    }}
                  />
                ))}
              </Box>
            </Paper>
          )}
        </>
      )}

      <Snackbar
        open={snack}
        autoHideDuration={4000}
        onClose={() => setSnack(false)}
        message="Recalculation queued for all portfolios (async)"
      />
    </Box>
  );
};
