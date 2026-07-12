import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import type { HealthRecommendation } from '../../../../store/portfolios/portfolios.api.ts';

const SEVERITY_MAP = {
  CRITICAL: 'error',
  WARNING:  'warning',
  INFO:     'info',
} as const;

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };

interface HealthRecommendationsPanelProps {
  recommendations: HealthRecommendation[];
  topRisks: string[];
}

export const HealthRecommendationsPanel = ({ recommendations, topRisks }: HealthRecommendationsPanelProps) => {
  const sorted = [...recommendations].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  if (recommendations.length === 0 && topRisks.length === 0) {
    return (
      <Alert severity="success" sx={{ fontSize: '0.85rem' }}>
        No active risks detected. Portfolio is operating normally.
      </Alert>
    );
  }

  return (
    <Box>
      {topRisks.length > 0 && (
        <Box display="flex" gap={0.75} flexWrap="wrap" mb={sorted.length > 0 ? 2 : 0}>
          {topRisks.map(r => (
            <Box key={r} sx={{
              px: 1, py: 0.35,
              bgcolor: 'rgba(245,158,11,0.1)',
              border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 1,
            }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color: '#f59e0b', fontSize: '0.68rem' }}>
                {r}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      {sorted.map((rec, i) => (
        <Alert
          key={`${rec.code}-${i}`}
          severity={SEVERITY_MAP[rec.severity]}
          sx={{ mb: 1, fontSize: '0.82rem', '& .MuiAlert-message': { py: 0.5 } }}
        >
          {rec.message}
        </Alert>
      ))}
    </Box>
  );
};
