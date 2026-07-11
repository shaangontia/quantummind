/**
 * PortfolioPolicyBadge — Phase 19
 * Displays the derived policy type as a chip in the portfolio header.
 * Self-hides when policyType field is absent (backend pre-Phase 19).
 */
import { Chip, Tooltip } from '@mui/material';

export type PolicyType =
  | 'LOW_RISK_24M'
  | 'MEDIUM_RISK_12M'
  | 'HIGH_RISK_3M'
  | 'VALUE_LONG'
  | 'MOMENTUM_SWING'
  | 'AGGRESSIVE_SHORT';

const POLICY_META: Record<PolicyType, { label: string; color: string; tip: string }> = {
  LOW_RISK_24M:     { label: 'Low Risk 24m', color: '#10b981', tip: 'Conservative · Value/Quality focus · 120-day labels' },
  MEDIUM_RISK_12M:  { label: 'Medium 12m',   color: '#3b82f6', tip: 'Balanced · Momentum + Value · 60-day labels' },
  HIGH_RISK_3M:     { label: 'High Risk 3m', color: '#f59e0b', tip: 'Aggressive · Momentum/News · 30-day labels' },
  VALUE_LONG:       { label: 'Value Long',   color: '#8b5cf6', tip: 'Fundamental quality · Long-horizon · 120-day labels' },
  MOMENTUM_SWING:   { label: 'Momentum',     color: '#06b6d4', tip: 'Swing/Momentum · 60-day labels' },
  AGGRESSIVE_SHORT: { label: 'Aggressive',   color: '#ef4444', tip: 'Very high target · Short horizon · 15-day labels' },
};

interface Props {
  policyType?: PolicyType | string | null;
}

export const PortfolioPolicyBadge = ({ policyType }: Props) => {
  const meta = policyType ? POLICY_META[policyType as PolicyType] : null;
  if (!meta) return null;

  return (
    <Tooltip title={meta.tip} placement="bottom" arrow>
      <Chip
        label={meta.label}
        size="small"
        sx={{
          height: 20,
          fontSize: '0.65rem',
          fontWeight: 700,
          letterSpacing: '0.02em',
          bgcolor: `${meta.color}18`,
          color: meta.color,
          border: `1px solid ${meta.color}40`,
          cursor: 'default',
          '& .MuiChip-label': { px: 1 },
        }}
      />
    </Tooltip>
  );
};
