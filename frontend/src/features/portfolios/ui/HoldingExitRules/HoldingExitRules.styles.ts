import type { CSSProperties } from 'react';

export const containerStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 4,
};

export const chipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  fontSize: '0.68rem',
  padding: '1px 6px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: 'var(--text-muted, #64748b)',
  whiteSpace: 'nowrap' as CSSProperties['whiteSpace'],
};

export const stopChipStyle: CSSProperties = {
  ...chipStyle,
  borderColor: 'rgba(239,68,68,0.25)',
  color: '#ef4444',
};

export const trailingChipStyle: CSSProperties = {
  ...chipStyle,
  borderColor: 'rgba(245,158,11,0.25)',
  color: '#f59e0b',
};

export const riskChipStyle: CSSProperties = {
  ...chipStyle,
  borderColor: 'rgba(139,92,246,0.25)',
  color: '#a78bfa',
};
