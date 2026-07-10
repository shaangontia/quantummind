import type { CSSProperties } from 'react';

/** Reusable layout style objects — import by name, never repeat inline. */

export const flexRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
};

export const flexRowGap8: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
};

export const flexRowBetween: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

export const flexRowEnd: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
};

export const textMuted: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
};

export const textXsMuted: CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--text-muted)',
};

export const textXsMutedBlock: CSSProperties = {
  ...textXsMuted,
  marginTop: 4,
};

export const fontBold: CSSProperties = {
  fontWeight: 700,
};

export const lockedContainer: CSSProperties = {
  opacity: 0.45,
  pointerEvents: 'none',
};
