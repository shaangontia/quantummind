import Chip from '@mui/material/Chip';

export type BadgeVariant = 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'gray';

const VARIANT_COLORS: Record<BadgeVariant, { bg: string; color: string }> = {
  green:  { bg: 'rgba(16,185,129,0.15)',  color: '#10b981' },
  red:    { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
  yellow: { bg: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
  blue:   { bg: 'rgba(59,130,246,0.15)',  color: '#3b82f6' },
  purple: { bg: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
  gray:   { bg: 'rgba(100,116,139,0.15)', color: '#94a3b8' },
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
}

export const Badge = ({ children, variant = 'gray' }: BadgeProps) => {
  const { bg, color } = VARIANT_COLORS[variant];
  return (
    <Chip
      label={children}
      size="small"
      sx={{
        bgcolor: bg,
        color,
        fontWeight: 700,
        fontSize: '0.7rem',
        height: 22,
        border: 'none',
        '& .MuiChip-label': { px: 1 },
      }}
    />
  );
};
