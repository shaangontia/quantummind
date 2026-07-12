import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { PortfolioHealth } from '../../../../store/portfolios/portfolios.api.ts';

const probColor = (pct: number | null) => {
  if (pct == null) return '#94a3b8';
  if (pct >= 70) return '#10b981';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
};

interface GoalProbabilityCardProps {
  health: PortfolioHealth;
}

const StatItem = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <Box>
    <Typography variant="caption" color="text.disabled" display="block">{label}</Typography>
    <Typography variant="body1" fontWeight={700}>{value}</Typography>
    {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
  </Box>
);

export const GoalProbabilityCard = ({ health }: GoalProbabilityCardProps) => {
  const { goalProbabilityPct, goalImpossible, goalImpossibilityReason,
    targetReturnPct, requiredMonthlyReturnPct, currentReturnPct,
    daysRemaining, horizonDays } = health;

  const color = probColor(goalProbabilityPct);

  return (
    <Paper elevation={0} sx={{ p: 2.5, height: '100%' }}>
      <Box display="flex" alignItems="center" gap={1} mb={2}>
        <Typography variant="subtitle2" fontWeight={700}>Goal Probability</Typography>
        <Tooltip title="Probability of reaching the target return by the end of the investment horizon, based on current trajectory.">
          <InfoOutlinedIcon sx={{ fontSize: '1rem', color: 'text.disabled', cursor: 'help' }} />
        </Tooltip>
      </Box>

      {goalImpossible ? (
        <Box display="flex" alignItems="flex-start" gap={1.5} p={1.5}
          sx={{ bgcolor: 'rgba(239,68,68,0.06)', borderRadius: 1.5, border: '1px solid rgba(239,68,68,0.2)', mb: 2 }}>
          <WarningAmberIcon sx={{ color: 'error.main', mt: 0.1, fontSize: '1.1rem' }} />
          <Box>
            <Typography variant="body2" fontWeight={700} color="error.main">Target not achievable</Typography>
            <Typography variant="caption" color="text.secondary">
              {goalImpossibilityReason === 'TARGET_NOT_ACHIEVABLE_WITHIN_RISK_LIMITS'
                ? 'The target return exceeds what is achievable within the configured risk limits and time horizon.'
                : goalImpossibilityReason ?? 'Target return is not achievable with current settings.'}
            </Typography>
          </Box>
        </Box>
      ) : (
        <Box display="flex" alignItems="baseline" gap={1} mb={2}>
          <Typography variant="h3" fontWeight={800} sx={{ color, lineHeight: 1 }}>
            {goalProbabilityPct != null ? `${goalProbabilityPct.toFixed(0)}%` : '—'}
          </Typography>
          <Typography variant="body2" color="text.secondary">chance of reaching target</Typography>
        </Box>
      )}

      <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1.5}>
        <StatItem
          label="Target return"
          value={targetReturnPct != null ? `${targetReturnPct.toFixed(1)}%` : '—'}
        />
        <StatItem
          label="Current return"
          value={currentReturnPct != null ? `${currentReturnPct >= 0 ? '+' : ''}${currentReturnPct.toFixed(2)}%` : '—'}
          sub={currentReturnPct != null && targetReturnPct != null
            ? `${((currentReturnPct / targetReturnPct) * 100).toFixed(0)}% of target`
            : undefined}
        />
        <StatItem
          label="Required monthly"
          value={requiredMonthlyReturnPct != null ? `${requiredMonthlyReturnPct.toFixed(2)}%` : '—'}
        />
        <StatItem
          label="Days remaining"
          value={daysRemaining != null ? `${daysRemaining}d` : '—'}
          sub={horizonDays != null && daysRemaining != null
            ? `of ${horizonDays}d horizon`
            : undefined}
        />
      </Box>
    </Paper>
  );
};
