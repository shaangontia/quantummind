import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import { useAdaptiveReport } from '../../hooks/useAdaptiveReport.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import type { MarketRegime } from '../../../../api/adaptive.api.types.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';

const regimeVariant = (r: MarketRegime): BadgeVariant => {
  if (r === 'BULL') return 'green';
  if (r === 'BEAR') return 'red';
  return 'yellow';
};

const regimeIcon = (r: MarketRegime) => r === 'BULL' ? '🐂' : r === 'BEAR' ? '🐻' : '↔';

export const AdaptivePanel = () => {
  const { report, isLoading, error } = useAdaptiveReport();

  if (isLoading) return <Box display="flex" justifyContent="center" py={3}><Spinner /></Box>;
  if (error || !report) return null;

  const { regime, signalWeights } = report;
  const maxWeight = Math.max(...signalWeights.map(s => s.weight), 1);

  return (
    <Grid container spacing={3}>
      {/* Market Regime */}
      <Grid item xs={12} md={5}>
        <Box>
          <Typography variant="subtitle2" fontWeight={700} mb={1.5}>Market Regime</Typography>
          <Box display="flex" alignItems="center" gap={1} mb={1}>
            <Typography fontSize="1.25rem">{regimeIcon(regime.regime)}</Typography>
            <Badge variant={regimeVariant(regime.regime)}>{regime.regime}</Badge>
          </Box>
          <Typography variant="body2" color="text.secondary" mb={2}>{regime.notes}</Typography>
          <Grid container spacing={1}>
            {[
              { label: 'RSI Buy',   value: `<${regime.rsiBuy}` },
              { label: 'RSI Sell',  value: `>${regime.rsiSell}` },
              { label: 'Stop-Loss', value: `${(regime.stopLoss * 100).toFixed(0)}%`, color: '#ef4444' },
              { label: 'Nifty RSI', value: String(regime.nifty50Rsi) },
            ].map(({ label, value, color }) => (
              <Grid item xs={6} key={label}>
                <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                <Typography variant="body2" fontWeight={700} sx={{ color: color ?? 'text.primary' }}>{value}</Typography>
              </Grid>
            ))}
          </Grid>
        </Box>
      </Grid>

      {/* Signal Weights */}
      <Grid item xs={12} md={7}>
        <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Signal Weights (Self-Learning)</Typography>
        <Typography variant="caption" color="text.secondary" display="block" mb={2}>
          Weights adjust automatically based on signal win rates over time
        </Typography>
        <Box display="flex" flexDirection="column" gap={1.5}>
          {signalWeights.map(sw => {
            const barPct  = (sw.weight / maxWeight) * 100;
            const isStrong = sw.weight > 1.2;
            const isWeak   = sw.weight < 0.8;
            const barColor = isStrong ? '#10b981' : isWeak ? '#ef4444' : '#3b82f6';
            return (
              <Box key={sw.source}>
                <Box display="flex" justifyContent="space-between" mb={0.5}>
                  <Typography variant="caption">{sw.source.replace(/_/g, ' ')}</Typography>
                  <Box display="flex" gap={1} alignItems="center">
                    <Typography variant="caption" color="text.secondary">
                      {sw.totalSignals} signals · {(sw.winRate * 100).toFixed(0)}% win rate
                    </Typography>
                    <Typography variant="caption" fontWeight={700} sx={{ color: barColor }}>
                      {sw.weight.toFixed(2)}×
                    </Typography>
                  </Box>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={barPct}
                  sx={{ height: 6, borderRadius: 3, '& .MuiLinearProgress-bar': { bgcolor: barColor } }}
                />
              </Box>
            );
          })}
        </Box>
        {signalWeights.every(sw => sw.totalSignals === 0) && (
          <Typography variant="caption" color="text.secondary" mt={2} display="block">
            ⏳ Weights will diverge after 2–3 weeks of live signals
          </Typography>
        )}
      </Grid>
    </Grid>
  );
};
