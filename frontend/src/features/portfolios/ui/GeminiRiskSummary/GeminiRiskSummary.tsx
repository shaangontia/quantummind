import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import type { GeminiRiskSummaryProps, GeminiRiskLevel } from './GeminiRiskSummary.types.ts';

const RISK_CONFIG: Record<GeminiRiskLevel, { icon: string; color: 'success' | 'warning' | 'error' }> = {
  low:    { icon: '✅', color: 'success' },
  medium: { icon: '⚠️', color: 'warning' },
  high:   { icon: '🚨', color: 'error'   },
};

/**
 * Structured Gemini risk analysis display using MUI components.
 * Renders nothing if no Gemini data is present.
 */
export const GeminiRiskSummary = ({ riskLevel, redFlags, newsEventType, confidence }: GeminiRiskSummaryProps) => {
  if (!riskLevel) return null;

  const cfg      = RISK_CONFIG[riskLevel];
  const hasFlags = redFlags && redFlags.length > 0;
  const hasEvent = newsEventType && newsEventType !== 'none';

  return (
    <Paper elevation={0} sx={{
      p: 1, mt: 0.75, display: 'flex', flexDirection: 'column', gap: 0.5,
      bgcolor: riskLevel === 'high' ? 'rgba(239,68,68,0.05)' : riskLevel === 'medium' ? 'rgba(245,158,11,0.05)' : 'rgba(16,185,129,0.05)',
      border: `1px solid ${riskLevel === 'high' ? 'rgba(239,68,68,0.2)' : riskLevel === 'medium' ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)'}`,
    }} aria-label={`Gemini risk: ${riskLevel}`}>
      <Box display="flex" alignItems="center" gap={0.75}>
        <Chip
          label={`${cfg.icon} Gemini: ${riskLevel} risk`}
          size="small" color={cfg.color} variant="outlined"
          sx={{ fontSize: '0.65rem', height: 20, fontWeight: 700, '& .MuiChip-label': { px: 0.75 } }}
        />
        {confidence != null && (
          <Typography variant="caption" color="text.secondary">({confidence}% confidence)</Typography>
        )}
      </Box>
      {hasFlags && (
        <Box display="flex" flexWrap="wrap" gap={0.5}>
          {redFlags.map(flag => (
            <Chip key={flag} label={flag} size="small"
              sx={{ fontSize: '0.62rem', height: 18, bgcolor: 'rgba(239,68,68,0.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.2)', '& .MuiChip-label': { px: 0.5 } }} />
          ))}
        </Box>
      )}
      {hasEvent && (
        <Typography variant="caption" color="text.secondary">📅 Event: {newsEventType}</Typography>
      )}
    </Paper>
  );
};
