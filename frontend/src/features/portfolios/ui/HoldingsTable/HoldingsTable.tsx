import { memo } from 'react';
import { useGetPortfolioSummaryQuery } from '../../../../store/portfolios/index.ts';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { formatINR, formatPct } from '../../model/portfolios.utils.ts';
import { useMarketPolling } from '../../hooks/useMarketPolling.ts';
import type { SummaryHolding } from '../../../../api/portfolio.api.types.ts';
import type { HoldingsTableProps } from './HoldingsTable.types.ts';

/**
 * Owns its own RTK Query subscription — shares the same cache entry as
 * PortfolioStats (RTK Query deduplicates the network request) but only
 * re-renders when the holdings slice changes.
 * Polls during NSE market hours only.
 */
/**
 * Memoized — re-renders only when the holdings slice of the summary cache changes.
 * Parent (PortfolioDashboard) re-renders do not propagate here.
 */
export const HoldingsTable = memo(({ portfolioId }: HoldingsTableProps) => {
  const pollingInterval = useMarketPolling();

  const { data: holdings, isLoading } = useGetPortfolioSummaryQuery(portfolioId, {
    pollingInterval,
    selectFromResult: ({ data, isLoading: loading }) => ({
      isLoading: loading,
      data: data?.holdings,
    }),
  });

  if (isLoading) {
    return (
      <div className="card">
        <h2 className="section-title">Current Holdings</h2>
        <SkeletonBlock height={200} borderRadius={8} />
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="section-title">Current Holdings</h2>
      {!holdings || holdings.length === 0 ? (
        <EmptyState
          icon="💼"
          title="No holdings yet"
          description="The AI will build positions on the next trading cycle."
        />
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Company</th>
                <th>Sector</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Avg Buy Price</th>
                <th className="text-right">Current Price</th>
                <th className="text-right">Value</th>
                <th className="text-right">P&L</th>
                <th className="text-right">Return</th>
                <th>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h: SummaryHolding) => (
                <tr key={h.symbol}>
                  <td><strong>{h.symbol}</strong></td>
                  <td>{h.companyName}</td>
                  <td>—</td>
                  <td className="text-right">{h.quantity}</td>
                  <td className="text-right">{formatINR(h.avgBuyPrice)}</td>
                  <td className="text-right">
                    {formatINR(h.currentPrice)}
                    {h.priceStatus === 'STALE' && (
                      <span
                        title="Price data is stale — not used for trade execution"
                        style={{ marginLeft: 4, color: '#f59e0b', fontSize: '0.75rem' }}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="text-right">{formatINR(h.currentValue)}</td>
                  <td
                    className="text-right"
                    style={{ color: h.pnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}
                  >
                    {h.pnl >= 0 ? '+' : ''}{formatINR(h.pnl)}
                  </td>
                  <td
                    className="text-right"
                    style={{ color: h.pnlPct >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}
                  >
                    {h.pnlPct >= 0 ? '+' : ''}{formatPct(h.pnlPct)}
                  </td>
                  <td className="text-muted">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

HoldingsTable.displayName = 'HoldingsTable';
