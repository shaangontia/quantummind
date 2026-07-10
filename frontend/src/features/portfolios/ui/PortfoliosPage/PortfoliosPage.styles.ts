import type { CSSProperties } from 'react';

export const portfoliosPageStyles = {
  headerActions: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  } satisfies CSSProperties,

  helpBtn: {
    fontSize: '1rem',
    padding: '6px 10px',
  } satisfies CSSProperties,

  statValueBold: {
    fontWeight: 700,
  } satisfies CSSProperties,
} as const;
