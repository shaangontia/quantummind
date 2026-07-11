import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import type { MarketRegimeBannerProps, MarketRegimeLabel } from './MarketRegimeBanner.types.ts';

const REGIME_CONFIG: Record<MarketRegimeLabel, { icon: string; color: 'success' | 'warning' | 'error'; dotColor: string }> = {
  BULLISH: { icon: '📈', color: 'success', dotColor: '#10b981' },
  NEUTRAL: { icon: '➡️', color: 'warning', dotColor: '#f59e0b' },
  BEARISH: { icon: '📉', color: 'error',   dotColor: '#ef4444' },
};

/**
 * Displays the current NIFTY market regime with DMA positioning.
 * Renders nothing if regime data is absent (safe during Phase 13 rollout).
 */
export const MarketRegimeBanner = ({ regime }: MarketRegimeBannerProps) => {
  if (!regime) return null;

  const { label, niftyVs50Dma, niftyVs200Dma, nifty50Close } = regime;
  const cfg = REGIME_CONFIG[label];

  return (
    <Box
      display="flex" alignItems="center" gap={1.5} flexWrap="wrap" mb={2}
      sx={{
        p: 1.25, borderRadius: 2,
        bgcolor: `${cfg.color === 'success' ? 'rgba(16,185,129,0.07)' : cfg.color === 'warning' ? 'rgba(245,158,11,0.07)' : 'rgba(239,68,68,0.07)'}`,
        border: `1px solid ${cfg.color === 'success' ? 'rgba(16,185,129,0.2)' : cfg.color === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)'}`,
      }}
      role="status"
      aria-label={`Market regime: ${label}`}
    >
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: cfg.dotColor, flexShrink: 0 }} aria-hidden="true" />
      <Chip
        label={`${cfg.icon} ${label}`}
        size="small"
        color={cfg.color}
        sx={{ fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.04em' }}
      />
      <Chip label={`50 DMA ${niftyVs50Dma}`}   size="small" variant="outlined" sx={{ fontSize: '0.68rem', height: 22 }} />
      <Chip label={`200 DMA ${niftyVs200Dma}`} size="small" variant="outlined" sx={{ fontSize: '0.68rem', height: 22 }} />
      {nifty50Close > 0 && (
        <Typography variant="caption" color="text.secondary" ml="auto">
          NIFTY 50 ₹{nifty50Close.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
        </Typography>
      )}
    </Box>
  );
};
