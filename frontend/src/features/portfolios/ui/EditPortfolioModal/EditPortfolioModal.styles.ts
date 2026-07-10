import type { CSSProperties } from 'react';

/** Static style objects for EditPortfolioModal. Dynamic values (colours) stay inline. */

export const editModalStyles = {
  lifecycleBanner: {
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: '0.82rem',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    // background, border, color set inline (dynamic: per state)
  } satisfies CSSProperties,

  lifecycleBannerMeta: {
    marginLeft: 'auto',
    opacity: 0.8,
    fontSize: '0.78rem',
  } satisfies CSSProperties,

  tradeLockNotice: {
    padding: '12px 16px',
    borderRadius: 8,
    background: 'rgba(239,68,68,0.06)',
    border: '1px solid rgba(239,68,68,0.25)',
    fontSize: '0.82rem',
    color: '#ef4444',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  } satisfies CSSProperties,

  capitalDeltaPositive: {
    fontSize: '0.72rem',
    color: 'var(--accent-green)',
    marginTop: 4,
  } satisfies CSSProperties,

  capitalDeltaNegative: {
    fontSize: '0.72rem',
    color: '#ef4444',
    marginTop: 4,
  } satisfies CSSProperties,

  capitalFloorHint: {
    fontSize: '0.7rem',
    color: 'var(--text-muted)',
    marginTop: 2,
  } satisfies CSSProperties,

  capitalFieldError: {
    fontSize: '0.72rem',
    color: '#ef4444',
    marginTop: 4,
  } satisfies CSSProperties,

  capHint: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: 6,
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

  drawdownSliderDisabled: {
    flex: 1,
    opacity: 0.45,
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

  inputError: {
    borderColor: '#ef4444',
  } satisfies CSSProperties,
} as const;
