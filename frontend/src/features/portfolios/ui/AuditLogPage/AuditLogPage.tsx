import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
import type { Trade, ApiResponse } from '../../../../api/portfolio.api.types.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { formatINR, formatDate } from '../../model/portfolios.utils.ts';
import './AuditLogPage.css';

export const AuditLogPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setIsLoading(true);
    portfolioApi.trades(portfolioId, page, 50)
      .then((res: ApiResponse<Trade[]>) => {
        setTrades(res.data);
        if (res.pagination) {
          setTotalPages(res.pagination.pages);
          setTotal(res.pagination.total);
        }
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [portfolioId, page]);

  return (
    <div className="audit-page">
      <div className="breadcrumb">
        <Link to="/" className="breadcrumb-link">Portfolios</Link>
        <span>›</span>
        <Link to={`/portfolios/${portfolioId}`} className="breadcrumb-link">Dashboard</Link>
        <span>›</span>
        <span>Audit Log</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">Trade Audit Log</h1>
          <p className="page-subtitle">{total} total transactions recorded</p>
        </div>
      </div>

      {isLoading ? (
        <div className="loading-center"><Spinner size={32} /></div>
      ) : trades.length === 0 ? (
        <EmptyState
          icon="📋"
          title="No trades yet"
          description="Trades will appear here once the AI starts executing virtual trades."
        />
      ) : (
        <>
          <div className="card">
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Date & Time</th>
                    <th>Action</th>
                    <th>Symbol</th>
                    <th>Company</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">Brokerage</th>
                    <th className="text-right">Net Amount</th>
                    <th className="text-right">Realized P&L</th>
                    <th>Reason</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td className="text-muted">{t.id}</td>
                      <td className="text-muted">{formatDate(t.trade_time)}</td>
                      <td>
                        <Badge variant={t.action === 'BUY' ? 'green' : 'red'}>
                          {t.action}
                        </Badge>
                      </td>
                      <td><strong>{t.symbol}</strong></td>
                      <td>{t.company_name ?? '—'}</td>
                      <td className="text-right">{t.quantity}</td>
                      <td className="text-right">{formatINR(t.price)}</td>
                      <td className="text-right">{formatINR(t.amount)}</td>
                      <td className="text-right text-muted">{formatINR(t.brokerage)}</td>
                      <td className={`text-right ${t.action === 'BUY' ? 'tag-negative' : 'tag-positive'}`}>
                        {formatINR(t.net_amount)}
                      </td>
                      <td className="text-right" style={{
                        fontWeight: 600,
                        color: t.realized_pnl == null ? '#64748b'
                          : t.realized_pnl >= 0 ? '#10b981' : '#ef4444'
                      }}>
                        {t.action !== 'SELL' ? '—'
                          : t.realized_pnl == null ? 'Pending'
                          : (t.realized_pnl >= 0 ? '+' : '') + formatINR(t.realized_pnl)}
                      </td>
                      <td className="reason-cell">{t.signal_reason ?? '—'}</td>
                      <td>
                        <Badge variant={t.status === 'EXECUTED' ? 'green' : t.status === 'FAILED' ? 'red' : 'gray'}>
                          {t.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-ghost"
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
              >
                ← Prev
              </button>
              <span className="page-info">Page {page} of {totalPages}</span>
              <button
                className="btn btn-ghost"
                disabled={page === totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
