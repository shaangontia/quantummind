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
  CANDIDATE: { label: 'Cold Start',  color: 'default', description: 'Learning phase — position sizes capped while trade data accumulates. No ML gate active.' },
  SHADOW:    { label: 'Shadow',      color: 'warning', description: 'Shadow ML model active — predictions logged but not yet influencing trade decisions.' },
  ADVISORY:  { label: 'Advisory',    color: 'info',    description: 'ML model in advisory mode — influencing position sizing but not hard-blocking trades.' },
  PRODUCTION:{ label: 'ML Active',   color: 'success', description: 'Fully promoted ML model — validated gate + sizing on every trade decision.' },
};

export const ModelGovernanceBanner = ({ portfolioId }: ModelGovernanceBannerProps) => {
  const { data: gov } = useGetModelGovernanceQuery(portfolioId);
  if (!gov) return null;

  const cfg   = STAGE_CONFIG[gov.stage];
  const gaps  = gov.promotionGaps;
  const cal   = gov.calibration;
  const res   = gov.activeRestrictions;

  // Progress toward next stage using promotionGaps (preferred) or legacy fields
  const totalLabelsNeeded = gaps?.labelsNeeded != null
    ? gov.trueLabelCount + gaps.labelsNeeded
    : undefined;
  const progressPct = totalLabelsNeeded
    ? Math.min((gov.trueLabelCount / totalLabelsNeeded) * 100, 100)
    : undefined;

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
          <Chip label={`🤖 ${cfg.label}`} size="small" color={cfg.color}
            sx={{ fontWeight: 700, fontSize: '0.7rem', cursor: 'help' }} />
        </Tooltip>

        {/* Active trading restrictions */}
        {gov.isColdStart && (
          <>
            <Chip label={`Max ${res?.maxPositionPct ?? gov.maxPositionPctOverride}% NAV/trade`}
              size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
            <Chip label={`≤${res?.maxTradesPerDay ?? gov.maxTradesPerDayOverride} trades/day`}
              size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
            <Chip label={`≤${res?.maxOpenPositions ?? gov.maxOpenPositionsOverride} positions`}
              size="small" variant="outlined" sx={{ fontSize: '0.65rem', height: 20 }} />
            {gaps?.weakSignalsBlocked && (
              <Chip label="WEAK blocked" size="small" color="error" variant="outlined"
                sx={{ fontSize: '0.65rem', height: 20 }} />
            )}
          </>
        )}

        {/* Calibration status */}
        {cal?.available && (
          <Tooltip title={`Calibration error: ${cal.maxErrorPct?.toFixed(1) ?? '?'}% across ${cal.activeBuckets} P(win) buckets`}>
            <Chip
              label={`Cal ${cal.maxErrorPct != null && cal.maxErrorPct > 15 ? '⚠' : '✅'} ${cal.maxErrorPct?.toFixed(0) ?? '?'}%`}
              size="small" variant="outlined"
              color={cal.maxErrorPct != null && cal.maxErrorPct > 15 ? 'warning' : 'success'}
              sx={{ fontSize: '0.65rem', height: 20, cursor: 'help' }}
            />
          </Tooltip>
        )}

        <Typography variant="caption" color="text.secondary" ml="auto">
          {gov.trueLabelCount} labels · {gov.positiveWFWindows} WF ✅
        </Typography>
      </Box>

      {/* Progress toward next stage */}
      {gaps && (
        <Box mt={1}>
          <Box display="flex" justifyContent="space-between" mb={0.4}>
            <Typography variant="caption" color="text.secondary">
              → {STAGE_CONFIG[gaps.nextStage].label}: {gaps.labelsNeeded} labels + {gaps.wfWindowsNeeded} WF windows needed
            </Typography>
            {progressPct != null && totalLabelsNeeded != null && (
              <Typography variant="caption" color="text.secondary">
                {gov.trueLabelCount} / {totalLabelsNeeded}
              </Typography>
            )}
          </Box>
          {progressPct != null && (
            <LinearProgress
              variant="determinate" value={progressPct}
              sx={{ height: 3, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.08)',
                '& .MuiLinearProgress-bar': { bgcolor: gov.isColdStart ? '#f59e0b' : '#10b981' } }}
            />
          )}
        </Box>
      )}
    </Box>
  );
};
