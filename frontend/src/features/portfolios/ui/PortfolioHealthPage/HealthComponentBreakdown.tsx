import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import type { HealthComponents } from '../../../../store/portfolios/portfolios.api.ts';

const COMPONENTS: Array<{ key: keyof HealthComponents; label: string; weight: string; tooltip: string }> = [
  { key: 'drawdown',        label: 'Drawdown',         weight: '20%', tooltip: 'How close current drawdown is to the max allowed threshold' },
  { key: 'diversification', label: 'Diversification',  weight: '15%', tooltip: 'Sector spread, single-stock concentration, and position count' },
  { key: 'goalProgress',    label: 'Goal Progress',    weight: '15%', tooltip: 'Current return vs expected progress toward the target return' },
  { key: 'strategyBalance', label: 'Strategy Balance', weight: '10%', tooltip: 'Distribution across MEAN_REVERSION, MOMENTUM, VALUE, NEWS_CATALYST' },
  { key: 'cashDeployment',  label: 'Cash Deployment',  weight: '10%', tooltip: 'Cash % relative to market regime and portfolio policy' },
  { key: 'executionQuality',label: 'Execution Quality',weight: '10%', tooltip: 'Order fill quality, slippage, and broker errors (scaffolded for Phase 22)' },
  { key: 'modelConfidence', label: 'Model Confidence', weight: '10%', tooltip: 'ML model lifecycle stage: CANDIDATE→30, SHADOW→45, ADVISORY→70, PRODUCTION→90' },
  { key: 'riskControl',     label: 'Risk Control',     weight: '10%', tooltip: 'Kill-switch state — circuit breaker, staleness halt, drawdown protection' },
];

const scoreColor = (v: number) =>
  v >= 70 ? '#10b981' : v >= 50 ? '#f59e0b' : '#ef4444';

export const HealthComponentBreakdown = ({ components }: { components: HealthComponents }) => (
  <Box>
    {COMPONENTS.map(({ key, label, weight, tooltip }) => {
      const value = components[key];
      const color = scoreColor(value);
      return (
        <Box key={key} mb={1.5}>
          <Box display="flex" justifyContent="space-between" mb={0.5}>
            <Tooltip title={tooltip} placement="right">
              <Box display="flex" alignItems="center" gap={0.75} sx={{ cursor: 'help' }}>
                <Typography variant="body2">{label}</Typography>
                <Typography variant="caption" color="text.disabled">({weight})</Typography>
              </Box>
            </Tooltip>
            <Typography variant="body2" fontWeight={700} sx={{ color }}>{value}</Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={value}
            sx={{
              height: 6,
              borderRadius: 3,
              bgcolor: 'rgba(255,255,255,0.06)',
              '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 3 },
            }}
          />
        </Box>
      );
    })}
  </Box>
);
