import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import { useGetModelGovernanceQuery } from '../../../../store/portfolios/portfolios.api.ts';
import type { ModelStage } from '../../../../store/portfolios/portfolios.api.ts';

interface ModelGovernanceBannerProps { portfolioId: number; }

const STAGE_CONFIG: Record<ModelStage, {
  label: string; color: 'default' | 'warning' | 'info' | 'success'; description: string;
}> = {
  CANDIDATE: { label: 'Cold Start',  color: 'default', description: 'Learning phase — position sizes capped at 1% NAV until enough trade data accumulates.' },
  SHADOW:    { label: 'Shadow',      color: 'warning', description: 'Shadow model active — ML predictions logged but not yet influencing trade decisions.' },
  ADVISORY:  { label: 'Advisory',    color: 'info',    description: 'ML model in advisory mode — influencing position sizing but not blocking trades.' },
  PRODUCTION:{ label: 'ML Active',   color: 'success', description: 'Fully promoted ML model — gating and sizing trades based on validated probability model.' },
};

const STAGE_ORDER: ModelStage[] = ['CANDIDATE', 'SHADOW', 'ADVISORY', 'PRODUCTION'];

// Thresholds that match the backend promotion rules
const LABEL_THRESHOLDS: Record<ModelStage, number> = {
  CANDIDATE: 0, SHADOW: 200, ADVISORY: 500, PRODUCTION: 1000,
};

export const ModelGovernanceBanner = ({ portfolioId }: ModelGovernanceBannerProps) => {
  const { data: gov } = useGetModelGovernanceQuery(portfolioId);
  if (!gov) return null;

  const cfg          = STAGE_CONFIG[gov.stage];
  const stageIdx     = STAGE_ORDER.indexOf(gov.stage);
  const nextStage    = STAGE_ORDER[stageIdx + 1] as ModelStage | undefined;
  const nextThreshold = nextStage ? LABEL_THRESHOLDS[nextStage] : null;
  const progressPct  = nextThreshold ? Math.min((gov.trueLabelCount / nextThreshold) * 100, 100) : 100;

  return (
    <Box
      sx={{
        p: 1.25, mb: 2, borderRadius: 1.5,
        bgcolor: gov.isColdStart ? 'rgba(251,191,36,0.06)' : 'rgba(16,185,129,0.06)',
        border: `1px solid ${gov.isColdStart ? 'rgba(251,191,36,0.2)' : 'rgba(16,185,129,0.2)'}`,
      }}
      role="status"
      aria-label={`ML model stage: ${gov.stage}`}
    >
      <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
        <Tooltip title={cfg.description} placement="bottom-start">
          <Chip
            label={`🤖 ${cfg.label}`}
            size="small" color={cfg.color}
            sx={{ fontWeight: 700, fontSize: '0.7rem', cursor: 'help' }}
          />
        </Tooltip>

        {/* Constraints (only in cold-start) */}
        {gov.isColdStart && (
          <>
            <Chip label={`Max ${gov.maxPositionPctOverride}% NAV/trade`} size="small" variant="outlined"
              sx={{ fontSize: '0.65rem', height: 20 }} />
            <Chip label={`≤${gov.maxTradesPerDayOverride} trades/day`} size="small" variant="outlined"
              sx={{ fontSize: '0.65rem', height: 20 }} />
            <Chip label={`≤${gov.maxOpenPositionsOverride} positions`} size="small" variant="outlined"
              sx={{ fontSize: '0.65rem', height: 20 }} />
          </>
        )}

        {/* WF windows count */}
        <Typography variant="caption" color="text.secondary" ml="auto">
          {gov.trueLabelCount} labels · {gov.positiveWFWindows} WF windows ✅
        </Typography>
      </Box>

      {/* Progress toward next stage */}
      {nextStage && nextThreshold != null && (
        <Box mt={1}>
          <Box display="flex" justifyContent="space-between" mb={0.4}>
            <Typography variant="caption" color="text.secondary">
              → {STAGE_CONFIG[nextStage].label} in {Math.max(0, nextThreshold - gov.trueLabelCount)} more labels
            </Typography>
            <Typography variant="caption" color="text.secondary">{gov.trueLabelCount} / {nextThreshold}</Typography>
          </Box>
          <LinearProgress
            variant="determinate" value={progressPct}
            sx={{ height: 3, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.08)',
              '& .MuiLinearProgress-bar': { bgcolor: gov.isColdStart ? '#f59e0b' : '#10b981' } }}
          />
        </Box>
      )}
    </Box>
  );
};
