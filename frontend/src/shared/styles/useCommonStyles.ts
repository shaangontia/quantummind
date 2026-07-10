import type { CSSProperties } from 'react';
import {
  flexRow, flexRowGap8, flexRowBetween, flexRowEnd,
  textMuted, textXsMuted, textXsMutedBlock,
  fontBold, lockedContainer,
} from './common.styles.ts';

/**
 * Hook that returns shared layout and typography style objects.
 * Prefer this over inline style objects in JSX.
 */
export const useCommonStyles = () => ({
  flexRow,
  flexRowGap8,
  flexRowBetween,
  flexRowEnd,
  textMuted,
  textXsMuted,
  textXsMutedBlock,
  fontBold,
  lockedContainer,
  /** Helper: merge base style with optional overrides */
  merge: (...styles: (CSSProperties | undefined | false)[]): CSSProperties =>
    Object.assign({}, ...styles.filter(Boolean)),
});
