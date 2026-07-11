import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Grid from '@mui/material/Grid';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import EditIcon from '@mui/icons-material/Edit';
import { useGetPortfolioSummaryQuery, useGetPortfoliosQuery } from '../../../../store/portfolios/index.ts';
import { EditPortfolioModal } from '../EditPortfolioModal/EditPortfolioModal.tsx';
import { PortfolioStats } from '../PortfolioStats/index.ts';
import { HoldingsTable } from '../HoldingsTable/index.ts';
import { PerformanceChart } from '../PerformanceChart/index.ts';
import { SectorAllocationChart } from '../SectorAllocationChart/SectorAllocationChart.tsx';
import { BenchmarkChart } from '../BenchmarkChart/BenchmarkChart.tsx';
import { NewsFeed } from '../../../news/ui/NewsFeed/NewsFeed.tsx';
import { AdaptivePanel } from '../../../intelligence/ui/AdaptivePanel/AdaptivePanel.tsx';
import { MarketRegimeBanner } from '../MarketRegimeBanner/index.ts';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { useGetCurrentUserQuery } from '../../../../store/auth/index.ts';
import { riskColor } from '../../model/portfolios.utils.ts';
import { isNSEMarketOpen } from '../../model/portfolios.marketHours.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

export const PortfolioDashboard = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);
  const navigate = useNavigate();

  const [isEditOpen, setIsEditOpen] = useState(false);
  const { data: currentUser } = useGetCurrentUserQuery();

  const { data: portfolio } = useGetPortfoliosQuery(undefined, {
    selectFromResult: ({ data }) => ({ data: data?.find(p => p.id === portfolioId) }),
  });

  const { data: headerData, isLoading, error, refetch, fulfilledTimeStamp } =
    useGetPortfolioSummaryQuery(portfolioId);

  const lastFetchedAt = fulfilledTimeStamp ? new Date(fulfilledTimeStamp) : null;

  const [showSecondary, setShowSecondary] = useState(false);
  const deferRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    deferRef.current = setTimeout(() => setShowSecondary(true), 300);
    return () => { if (deferRef.current) clearTimeout(deferRef.current); };
  }, []);

  if (isLoading) {
    return <Box display="flex" alignItems="center" justifyContent="center" minHeight="60vh"><Spinner size={40} /></Box>;
  }

  if (error || !headerData) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load portfolio"
        description={error ? ('error' in error ? String(error.error) : 'Failed to load') : 'Portfolio not found'}
        action={<Button variant="outlined" onClick={() => navigate('/')}>← Back</Button>}
      />
    );
  }

  const canEdit = portfolio && currentUser && (currentUser.isAdmin || portfolio.owner_id === currentUser.id);
  const isLocked = Boolean(portfolio?.trade_count);

  return (
    <Box>
      {/* Breadcrumbs */}
      <Breadcrumbs sx={{ mb: 2, fontSize: '0.8rem' }}>
        <Box component={Link} to="/" sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
          Portfolios
        </Box>
        <Typography variant="body2" color="text.primary">{headerData.name}</Typography>
      </Breadcrumbs>

      {/* Dashboard header */}
      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={2.5} gap={2} flexWrap="wrap">
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          <Typography variant="h5" fontWeight={700}>{headerData.name}</Typography>
          <Badge variant={riskColor(headerData.riskTolerance) as BadgeVariant}>
            {headerData.riskTolerance} Risk
          </Badge>
        </Box>
        <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
          {lastFetchedAt && (
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              {isNSEMarketOpen()
                ? `Live · ${lastFetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                : `Closed · ${lastFetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
            </Typography>
          )}
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => void refetch()}>
            Refresh
          </Button>
          {canEdit && (
            <Button
              size="small" variant="outlined"
              startIcon={isLocked ? <LockIcon sx={{ fontSize: '0.9rem !important' }} /> : <EditIcon sx={{ fontSize: '0.9rem !important' }} />}
              onClick={() => setIsEditOpen(true)}
              title={isLocked ? 'Strategy locked — only name & description editable' : 'Edit portfolio settings'}
            >
              Edit
            </Button>
          )}
          <Button size="small" variant="outlined" component={Link} to={`/portfolios/${portfolioId}/signals`}>
            Signals
          </Button>
          <Button size="small" variant="outlined" component={Link} to={`/portfolios/${portfolioId}/trades`}>
            Audit Log
          </Button>
        </Box>
      </Box>

      {/* Market regime banner — Phase 13, self-hides if backend hasn't shipped field */}
      <MarketRegimeBanner regime={headerData.marketRegime} />

      {/* Stats */}
      <PortfolioStats portfolioId={portfolioId} />

      {/* Performance chart */}
      <PerformanceChart portfolioId={portfolioId} />

      {/* Holdings table */}
      <HoldingsTable portfolioId={portfolioId} />

      {/* Secondary panels — deferred */}
      {showSecondary && (
        <Grid container spacing={2} mb={2}>
          <Grid item xs={12} lg={7}>
            <Paper elevation={0} sx={{ p: 2.5 }}>
              <Typography variant="h6" fontWeight={700} mb={2}>vs Market Benchmark</Typography>
              <BenchmarkChart portfolioId={portfolioId} />
            </Paper>
          </Grid>
          <Grid item xs={12} lg={5}>
            <Paper elevation={0} sx={{ p: 2.5 }}>
              <Typography variant="h6" fontWeight={700} mb={2}>Sector Allocation</Typography>
              <SectorAllocationChart portfolioId={portfolioId} />
            </Paper>
          </Grid>
        </Grid>
      )}

      {showSecondary && (
        <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
          <Typography variant="h6" fontWeight={700} mb={2}>AI Intelligence Engine</Typography>
          <AdaptivePanel portfolioId={portfolioId} />
        </Paper>
      )}

      {showSecondary && (
        <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
          <NewsFeed compact />
        </Paper>
      )}

      {portfolio && isEditOpen && (
        <EditPortfolioModal
          portfolio={portfolio}
          onClose={() => setIsEditOpen(false)}
          onSaved={() => setIsEditOpen(false)}
        />
      )}
    </Box>
  );
};
