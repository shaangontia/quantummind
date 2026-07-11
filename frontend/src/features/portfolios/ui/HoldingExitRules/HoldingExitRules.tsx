import { containerStyle, stopChipStyle, trailingChipStyle, chipStyle, riskChipStyle } from './HoldingExitRules.styles.ts';
import type { HoldingExitRulesProps } from './HoldingExitRules.types.ts';

const formatINR = (v: number) =>
  `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

/**
 * Inline exit-rule chips for a single holding row.
 * Shows ATR stop, trailing stop, time stop, and ₹ at risk.
 * Renders nothing if no exit fields are present (safe before backend ships).
 */
export const HoldingExitRules = ({
  atrStopPrice,
  trailingStopPrice,
  timeStopDate,
  riskAmountInr,
}: HoldingExitRulesProps) => {
  const hasAny = atrStopPrice != null || trailingStopPrice != null || timeStopDate != null || riskAmountInr != null;
  if (!hasAny) return null;

  return (
    <div style={containerStyle} aria-label="Exit rules">
      {atrStopPrice != null && (
        <span style={stopChipStyle} title="ATR-based hard stop loss">
          🛑 Stop {formatINR(atrStopPrice)}
        </span>
      )}
      {trailingStopPrice != null && (
        <span style={trailingChipStyle} title="Trailing stop price">
          ↕ Trail {formatINR(trailingStopPrice)}
        </span>
      )}
      {timeStopDate != null && (
        <span style={chipStyle} title="Time stop — exit if no positive move by this date">
          ⏱ Exit by {formatDate(timeStopDate)}
        </span>
      )}
      {riskAmountInr != null && (
        <span style={riskChipStyle} title="Max ₹ at risk on this position">
          ⚠ Risk {formatINR(riskAmountInr)}
        </span>
      )}
    </div>
  );
};
