import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useGetPortfolioModeQuery } from '../../../../store/portfolios/portfolios.api.ts';
import type { PortfolioModeValue } from '../../../../store/portfolios/portfolios.api.ts';

interface PortfolioModeChipProps { portfolioId: number; }

const MODE_CONFIG: Record<PortfolioModeValue, { label: string; color: string; bg: string; icon: string }> = {
  NORMAL:      { label: 'Normal',      color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: '✅' },
  COLD_START:  { label: 'Cold start',  color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  icon: '🧊' },
  PROTECTION:  { label: 'Protection',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '🛡' },
  HALTED:      { label: 'Halted',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '🛑' },
  LIQUIDATION: { label: 'Liquidating', color: '#dc2626', bg: 'rgba(220,38,38,0.15)',   icon: '🚨' },
};

export const PortfolioModeChip = ({ portfolioId }: PortfolioModeChipProps) => {
  const { data: pm, isError } = useGetPortfolioModeQuery(portfolioId, { pollingInterval: 60_000 });

  if (isError || !pm) return null;

  const cfg = MODE_CONFIG[pm.mode];
  const tooltipContent = (
    <Box sx={{ p: 0.5, maxWidth: 260 }}>
      <Typography variant="caption" fontWeight={700} display="block" mb={0.5}>{cfg.icon} {cfg.label}</Typography>
      {pm.primaryReasonCode && (
        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
          Reason: {pm.primaryReasonCode}
        </Typography>
      )}
      {pm.blockedActions.length > 0 && (
        <Typography variant="caption" color="error.light" display="block">
          Blocked: {pm.blockedActions.join(', ')}
        </Typography>
      )}
      {pm.allowedActions.length > 0 && (
        <Typography variant="caption" color="success.light" display="block">
          Allowed: {pm.allowedActions.join(', ')}
        </Typography>
      )}
      {pm.requiresManualIntervention && (
        <Typography variant="caption" color="error.main" display="block" mt={0.5} fontWeight={700}>
          ⚠ Requires manual intervention
        </Typography>
      )}
      {pm.activeSince && (
        <Typography variant="caption" color="text.disabled" display="block" mt={0.5}>
          Since {new Date(pm.activeSince).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
        </Typography>
      )}
    </Box>
  );

  return (
    <Tooltip title={tooltipContent} arrow>
      <Chip
        label={`${cfg.icon} ${cfg.label}`}
        size="small"
        sx={{
          fontSize: '0.7rem', fontWeight: 700, height: 22, cursor: 'default',
          bgcolor: cfg.bg, color: cfg.color,
          border: `1px solid ${cfg.color}44`,
          '& .MuiChip-label': { px: 0.75 },
          ...(pm.mode === 'LIQUIDATION' && {
            animation: 'pulse-chip 1.5s infinite',
            '@keyframes pulse-chip': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.6 } },
          }),
        }}
      />
    </Tooltip>
  );
};
