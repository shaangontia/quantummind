import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import type { HoldingExitRulesProps } from './HoldingExitRules.types.ts';

const formatINR = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

/**
 * Inline exit-rule chips for a holding row using MUI Chip.
 * Renders nothing if no exit fields are present.
 */
export const HoldingExitRules = ({ atrStopPrice, trailingStopPrice, timeStopDate, riskAmountInr }: HoldingExitRulesProps) => {
  const hasAny = atrStopPrice != null || trailingStopPrice != null || timeStopDate != null || riskAmountInr != null;
  if (!hasAny) return null;

  return (
    <Box display="flex" flexWrap="wrap" gap={0.5} aria-label="Exit rules">
      {atrStopPrice != null && (
        <Chip label={`🛑 Stop ${formatINR(atrStopPrice)}`} size="small"
          title="ATR-based hard stop loss"
          sx={{ fontSize: '0.65rem', height: 20, bgcolor: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)', '& .MuiChip-label': { px: 0.75 } }} />
      )}
      {trailingStopPrice != null && (
        <Chip label={`↕ Trail ${formatINR(trailingStopPrice)}`} size="small"
          title="Trailing stop price"
          sx={{ fontSize: '0.65rem', height: 20, bgcolor: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)', '& .MuiChip-label': { px: 0.75 } }} />
      )}
      {timeStopDate != null && (
        <Chip label={`⏱ Exit by ${formatDate(timeStopDate)}`} size="small"
          title="Time stop — exit if no positive move by this date"
          sx={{ fontSize: '0.65rem', height: 20, '& .MuiChip-label': { px: 0.75 } }} variant="outlined" />
      )}
      {riskAmountInr != null && (
        <Chip label={`⚠ Risk ${formatINR(riskAmountInr)}`} size="small"
          title="Max ₹ at risk on this position"
          sx={{ fontSize: '0.65rem', height: 20, bgcolor: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.25)', '& .MuiChip-label': { px: 0.75 } }} />
      )}
    </Box>
  );
};
