import type { CSSProperties } from 'react';

/** Static style objects for CreatePortfolioModal. Dynamic values (colours) stay inline. */

export const createModalStyles = {
  riskBanner: {
    padding: '10px 14px',
    borderRadius: 8,
    background: 'rgba(255,255,255,0.04)',
    marginBottom: 4,
    // borderColor set inline (dynamic: per risk level)
  } satisfies CSSProperties,

  riskBannerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  } satisfies CSSProperties,

  riskBannerLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
  } satisfies CSSProperties,

  riskBannerExplanation: {
    fontSize: '0.72rem',
    color: 'var(--text-muted)',
    margin: '4px 0 6px',
  } satisfies CSSProperties,

  labelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  } satisfies CSSProperties,

  labelHint: {
    fontSize: '0.72rem',
    color: 'var(--text-muted)',
  } satisfies CSSProperties,

  drawdownSection: {
    marginTop: 10,
  } satisfies CSSProperties,

  drawdownSliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  } satisfies CSSProperties,

  drawdownSlider: {
    flex: 1,
  } satisfies CSSProperties,

  drawdownValue: {
    fontWeight: 600,
    color: 'var(--text-primary)',
    minWidth: 40,
  } satisfies CSSProperties,

  drawdownValueDanger: {
    fontWeight: 600,
    color: '#ef4444',
    minWidth: 40,
  } satisfies CSSProperties,

  drawdownHint: {
    fontSize: '0.72rem',
    color: 'var(--text-muted)',
    marginTop: 4,
  } satisfies CSSProperties,

  capHint: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: 6,
  } satisfies CSSProperties,
} as const;
