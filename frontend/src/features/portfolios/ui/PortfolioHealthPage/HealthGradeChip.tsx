import Chip from '@mui/material/Chip';
import type { HealthGrade } from '../../../../store/portfolios/portfolios.api.ts';

const GRADE_CONFIG: Record<HealthGrade, { label: string; bg: string; color: string }> = {
  EXCELLENT: { label: 'EXCELLENT', bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
  GOOD:      { label: 'GOOD',      bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
  WARNING:   { label: 'WARNING',   bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
  CRITICAL:  { label: 'CRITICAL',  bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
};

export const HealthGradeChip = ({ grade, size = 'small' }: { grade: HealthGrade; size?: 'small' | 'medium' }) => {
  const { label, bg, color } = GRADE_CONFIG[grade];
  return (
    <Chip
      label={label}
      size={size}
      sx={{
        bgcolor: bg,
        color,
        fontWeight: 700,
        fontSize: size === 'small' ? '0.7rem' : '0.8rem',
        height: size === 'small' ? 22 : 28,
        border: 'none',
        '& .MuiChip-label': { px: 1 },
      }}
    />
  );
};
