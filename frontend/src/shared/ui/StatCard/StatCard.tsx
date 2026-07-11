import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down' | 'neutral';
  accent?: string;
}

const TREND_COLOR: Record<string, string> = {
  up:      '#10b981',
  down:    '#ef4444',
  neutral: '#64748b',
};

export const StatCard = ({ label, value, sub, trend = 'neutral', accent }: StatCardProps) => (
  <Paper elevation={0} sx={{ p: 2, height: '100%' }}>
    <Typography variant="caption" color="text.secondary" fontWeight={600} letterSpacing="0.04em" textTransform="uppercase">
      {label}
    </Typography>
    <Typography
      variant="h5"
      fontWeight={700}
      mt={0.5}
      sx={{ color: accent ?? 'text.primary' }}
    >
      {value}
    </Typography>
    {sub && (
      <Box
        mt={0.5}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: TREND_COLOR[trend],
          bgcolor: `${TREND_COLOR[trend]}1a`,
          px: 0.75,
          py: 0.25,
          borderRadius: 1,
        }}
      >
        {sub}
      </Box>
    )}
  </Paper>
);
