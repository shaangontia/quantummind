import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useGetKillSwitchQuery } from '../../../../store/portfolios/portfolios.api.ts';
import type { KillSwitchFlags } from '../../../../store/portfolios/portfolios.api.ts';

interface KillSwitchStatusBarProps { portfolioId: number; }

interface FlagRow { key: keyof KillSwitchFlags; label: string; severity: 'error' | 'warning' | 'info'; }

const FLAG_ROWS: FlagRow[] = [
  { key: 'dailyLossHalted',            label: 'Daily loss >1% NAV — BUYs halted',        severity: 'error'   },
  { key: 'weeklyLossHalted',           label: 'Weekly loss >3% NAV — sizes halved',       severity: 'warning' },
  { key: 'drawdownProtection',         label: 'Drawdown >12% — emergency liquidation',    severity: 'error'   },
  { key: 'drawdownPaused',             label: 'Drawdown >8% — new entries paused',        severity: 'warning' },
  { key: 'circuitBreakerActive',       label: 'Circuit breaker — 3 API failures',         severity: 'error'   },
  { key: 'dataStaleHalted',            label: 'Data stale >10 min — BUYs halted',         severity: 'warning' },
  { key: 'consecutiveLossCooldown',    label: '3 consecutive losses — 24h BUY cooldown',  severity: 'warning' },
  { key: 'emergencyLiquidationTriggered', label: 'Emergency liquidation triggered',        severity: 'error'   },
];

const SEVERITY_COLOR = { error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' } as const;

export const KillSwitchStatusBar = ({ portfolioId }: KillSwitchStatusBarProps) => {
  const [expanded, setExpanded] = useState(false);
  const { data: ks, isError } = useGetKillSwitchQuery(portfolioId, { pollingInterval: 60_000 });

  if (isError) {
    return (
      <Box display="flex" alignItems="center" gap={1} mb={1.5} px={0.5}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: '#f59e0b', flexShrink: 0 }} />
        <Typography variant="caption" color="warning.light">⚠ Kill-switch status unavailable — exercise manual caution</Typography>
      </Box>
    );
  }

  if (!ks) return null;

  const activeFlags = FLAG_ROWS.filter(r => Boolean(ks.flags[r.key]));
  const highestSeverity = activeFlags.find(f => f.severity === 'error')?.severity
    ?? activeFlags.find(f => f.severity === 'warning')?.severity
    ?? (ks.anyHalted ? 'info' : null);

  if (!ks.anyHalted && activeFlags.length === 0) {
    // Show compact green "all clear" pill — no expand needed
    return (
      <Box display="flex" alignItems="center" gap={1} mb={1.5} px={0.5}>
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: '#10b981', flexShrink: 0 }} />
        <Typography variant="caption" color="text.secondary">Kill-switch: All clear</Typography>
      </Box>
    );
  }

  const chipColor = highestSeverity === 'error' ? '#ef4444' : '#f59e0b';
  const bgColor   = highestSeverity === 'error' ? 'rgba(239,68,68,0.07)' : 'rgba(245,158,11,0.07)';
  const border    = highestSeverity === 'error' ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)';

  return (
    <Box mb={1.5} sx={{ borderRadius: 1.5, border: `1px solid ${border}`, bgcolor: bgColor, overflow: 'hidden' }}>
      <Box
        display="flex" alignItems="center" gap={1.5} p={1.25}
        sx={{ cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
        role="button"
        aria-expanded={expanded}
      >
        <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: chipColor, animation: 'pulse 2s infinite', flexShrink: 0,
          '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.4 } } }} />
        <Chip
          label={`⚠ ${ks.reason}`}
          size="small"
          sx={{ fontSize: '0.68rem', fontWeight: 700, height: 20, bgcolor: `${chipColor}22`, color: chipColor,
            border: `1px solid ${chipColor}44`, '& .MuiChip-label': { px: 0.75 } }}
        />
        <Typography variant="caption" color="text.secondary" ml="auto" sx={{ whiteSpace: 'nowrap' }}>
          {ks.flags.consecutiveLosses > 0 && `${ks.flags.consecutiveLosses} consecutive losses · `}
          {ks.flags.dataStaleHalted && `${ks.flags.dataStalenessMinutes}m stale · `}
          {ks.flags.apiFailureCount > 0 && `${ks.flags.apiFailureCount} API failures`}
        </Typography>
        <IconButton size="small" sx={{ p: 0.25 }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <Divider />
        <Box p={1.25} display="flex" flexDirection="column" gap={0.5}>
          {activeFlags.map(f => (
            <Box key={f.key} display="flex" alignItems="center" gap={1}>
              <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: SEVERITY_COLOR[f.severity], flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary">{f.label}</Typography>
              {f.key === 'consecutiveLossCooldown' && ks.flags.cooldownUntil && (
                <Tooltip title={`Cooldown expires: ${new Date(ks.flags.cooldownUntil).toLocaleString('en-IN')}`}>
                  <Typography variant="caption" color="warning.light" ml={0.5} sx={{ cursor: 'help' }}>
                    until {new Date(ks.flags.cooldownUntil).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </Typography>
                </Tooltip>
              )}
            </Box>
          ))}
          <Typography variant="caption" color="text.disabled" mt={0.5}>
            Updated {ks.lastUpdated ? new Date(ks.lastUpdated).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never'}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  );
};
