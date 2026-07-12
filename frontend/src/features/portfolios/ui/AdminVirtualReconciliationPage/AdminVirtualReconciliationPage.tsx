/**
 * Admin — Virtual Reconciliation Overview.
 * Route: /admin/virtual-reconciliation
 */
import { Link } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import VerifiedIcon from '@mui/icons-material/Verified';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import BlockIcon from '@mui/icons-material/Block';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useGetAdminVirtualReconciliationOverviewQuery } from '../../../../store/admin/index.ts';

const StatCard = ({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  color?: string;
}) => (
  <Paper elevation={0} sx={{ p: 2, border: '1px solid', borderColor: color ? `${color}44` : 'divider', borderRadius: 1.5 }}>
    <Box display="flex" alignItems="center" gap={1} mb={0.5}>
      {icon && <Box sx={{ color: color ?? 'text.secondary', display: 'flex' }}>{icon}</Box>}
      <Typography variant="caption" color="text.disabled">{label}</Typography>
    </Box>
    <Typography variant="h5" fontWeight={800} sx={{ color: color ?? 'text.primary' }}>{value}</Typography>
  </Paper>
);

export const AdminVirtualReconciliationPage = () => {
  const { data, isLoading, refetch } = useGetAdminVirtualReconciliationOverviewQuery();

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2.5} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Virtual Reconciliation</Typography>
          <Typography variant="body2" color="text.secondary">System-wide virtual ledger health</Typography>
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Button size="small" variant="outlined" onClick={() => void refetch()}>Refresh</Button>
          <Button
            size="small"
            variant="outlined"
            endIcon={<ArrowForwardIcon sx={{ fontSize: '0.85rem !important' }} />}
            component={Link}
            to="/admin/virtual-reconciliation/mismatches"
          >
            Open Mismatches
          </Button>
          <Button
            size="small"
            variant="outlined"
            endIcon={<ArrowForwardIcon sx={{ fontSize: '0.85rem !important' }} />}
            component={Link}
            to="/admin/virtual-execution-quality"
          >
            Execution Quality
          </Button>
        </Box>
      </Box>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={8}><CircularProgress size={32} /></Box>
      )}

      {data && (
        <>
          <Grid container spacing={2} mb={3}>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="Total portfolios"
                value={data.totalPortfolios}
                icon={<VerifiedIcon sx={{ fontSize: '1.1rem' }} />}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Healthy" value={data.healthy} icon={<VerifiedIcon sx={{ fontSize: '1.1rem' }} />} color="#10b981" />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Warning" value={data.warning} icon={<WarningAmberIcon sx={{ fontSize: '1.1rem' }} />} color="#f59e0b" />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Mismatch" value={data.mismatch} icon={<ErrorOutlineIcon sx={{ fontSize: '1.1rem' }} />} color="#ef4444" />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Failed" value={data.failed} icon={<BlockIcon sx={{ fontSize: '1.1rem' }} />} color="#6b7280" />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="BUYs blocked" value={data.newBuysBlocked} color={data.newBuysBlocked > 0 ? '#ef4444' : undefined} />
            </Grid>
          </Grid>

          {data.topMismatchTypes.length > 0 && (
            <Paper elevation={0} sx={{ p: 2.5 }}>
              <Typography variant="subtitle2" fontWeight={700} mb={1.5}>Top Mismatch Types</Typography>
              <Box display="flex" gap={1} flexWrap="wrap">
                {data.topMismatchTypes.map(t => (
                  <Chip
                    key={t}
                    label={t.replace(/_/g, ' ')}
                    size="small"
                    sx={{ fontFamily: 'monospace', backgroundColor: '#ef444422', color: '#ef4444', fontWeight: 600 }}
                  />
                ))}
              </Box>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
};
