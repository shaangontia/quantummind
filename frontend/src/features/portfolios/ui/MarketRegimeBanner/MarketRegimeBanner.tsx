import { getBannerStyles, dmaChipStyle, niftyPriceStyle } from './MarketRegimeBanner.styles.ts';
import type { MarketRegimeBannerProps } from './MarketRegimeBanner.types.ts';

const REGIME_ICON: Record<string, string> = { BULLISH: '📈', NEUTRAL: '➡️', BEARISH: '📉' };

/**
 * Displays the current NIFTY market regime (BULLISH/NEUTRAL/BEARISH) with
 * 50 DMA and 200 DMA positioning. Renders nothing if regime data is absent
 * (safe during Phase 13 rollout before backend ships the field).
 */
export const MarketRegimeBanner = ({ regime }: MarketRegimeBannerProps) => {
  if (!regime) return null;

  const { label, niftyVs50Dma, niftyVs200Dma, nifty50Close } = regime;
  const styles = getBannerStyles(label);

  return (
    <div style={styles.banner} role="status" aria-label={`Market regime: ${label}`}>
      <span style={styles.dot} aria-hidden="true" />
      <span style={styles.label}>{REGIME_ICON[label]} {label}</span>
      <span style={dmaChipStyle}>50 DMA {niftyVs50Dma}</span>
      <span style={dmaChipStyle}>200 DMA {niftyVs200Dma}</span>
      {nifty50Close > 0 && (
        <span style={niftyPriceStyle}>
          NIFTY 50 ₹{nifty50Close.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
        </span>
      )}
    </div>
  );
};
