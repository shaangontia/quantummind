import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
import type { Trade, ApiResponse } from '../../../../api/portfolio.api.types.ts';

const API_BASE = '/api';

const TradeExplanation = ({ tradeId, portfolioId }: { tradeId: number; portfolioId: number }) => {
  const { data, isLoading, error } = useQuery<{ explanation: string }>({
    queryKey: ['trade-explanation', portfolioId, tradeId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/portfolios/${portfolioId}/trades/${tradeId}/explanation`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load explanation');
      return { explanation: json.explanation, context: json.context };
    },
    staleTime: 10 * 60_000, // explanations don't change
  });

  if (isLoading) return <div style={{ padding: '12px 16px', color: '#94a3b8', fontSize: '0.82rem' }}>⏳ Generating AI explanation…</div>;
  if (error) return <div style={{ padding: '12px 16px', color: '#ef4444', fontSize: '0.82rem' }}>⚠ {error.message}</div>;
  return (
    <div style={{ padding: '14px 20px', background: 'var(--bg-surface)', borderTop: '1px solid var(--border-color)', fontSize: '0.84rem', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
      <span style={{ color: 'var(--accent-purple)', fontWeight: 600, marginRight: 8 }}>🤖 TARS:</span>
      {data?.explanation ?? '—'}
    </div>
  );
};
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { formatINR, formatDate } from '../../model/portfolios.utils.ts';
import './AuditLogPage.css';

export const AuditLogPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const [page, setPage] = useState(1);
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);

  const toggleExpand = (id: number) =>
    setExpandedTradeId(prev => (prev === id ? null : id));

  const { data, isLoading } = useQuery<ApiResponse<Trade[]>>({
    queryKey: ['trades', portfolioId, page],
    queryFn: () => portfolioApi.trades(portfolioId, page, 50),
    staleTime: 30_000,
    placeholderData: prev => prev, // keep prev page visible while next loads
  });

  const trades = data?.data ?? [];
  const totalPages = data?.pagination?.pages ?? 1;
  const total = data?.pagination?.total ?? 0;

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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => {
                    const isExpanded = expandedTradeId === t.id;
                    return (
                    <React.Fragment key={t.id}>
                    <tr
                      onClick={() => toggleExpand(t.id)}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title="Click to see AI explanation"
                    >
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
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>
                        {isExpanded ? '▲' : '▼'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={14} style={{ padding: 0, border: 0 }}>
                          <TradeExplanation tradeId={t.id} portfolioId={portfolioId} />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })}
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
