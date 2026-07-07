import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { portfolioApi } from '../../../../api/portfolio.api.ts';
import type { MarketSignal } from '../../../../api/portfolio.api.types.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { formatDate, signalColor } from '../../model/portfolios.utils.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './SignalsPage.css';

const strengthVariant = (s?: string): BadgeVariant => {
  if (s === 'STRONG') return 'green';
  if (s === 'MODERATE') return 'yellow';
  if (s === 'WEAK') return 'gray';
  return 'gray';
};

export const SignalsPage = () => {
  const { id } = useParams<{ id: string }>();
  const portfolioId = Number(id);

  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    portfolioApi.signals(portfolioId)
      .then(setSignals)
      .catch(console.error)
      .finally(() => setIsLoading(false));

    // Auto-refresh every 30s
    const timer = setInterval(() => {
      portfolioApi.signals(portfolioId).then(setSignals).catch(console.error);
    }, 30_000);

    return () => clearInterval(timer);
  }, [portfolioId]);

  return (
    <div className="signals-page">
      <div className="breadcrumb">
        <Link to="/" className="breadcrumb-link">Portfolios</Link>
        <span>›</span>
        <Link to={`/portfolios/${portfolioId}`} className="breadcrumb-link">Dashboard</Link>
        <span>›</span>
        <span>Market Signals</span>
      </div>

      <div className="page-header">
        <div>
          <h1 className="page-title">Market Signals</h1>
          <p className="page-subtitle">AI-generated buy/sell signals — auto-refreshes every 30s</p>
        </div>
        <div className="live-indicator">
          <span className="status-dot" />
          <span>Live</span>
        </div>
      </div>

      {isLoading ? (
        <div className="loading-center"><Spinner size={32} /></div>
      ) : signals.length === 0 ? (
        <EmptyState
          icon="📡"
          title="No signals yet"
          description="The AI is monitoring the market. Signals will appear as it identifies opportunities."
        />
      ) : (
        <div className="signals-list card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Signal</th>
                <th>Strength</th>
                <th>Price</th>
                <th>Reason</th>
                <th>Acted</th>
              </tr>
            </thead>
            <tbody>
              {signals.map(s => (
                <tr key={s.id} className={s.acted_upon ? 'acted-row' : ''}>
                  <td className="text-muted">{formatDate(s.signal_time)}</td>
                  <td><strong>{s.symbol}</strong></td>
                  <td>
                    <Badge variant={signalColor(s.signal_type) as BadgeVariant}>
                      {s.signal_type}
                    </Badge>
                  </td>
                  <td>
                    {s.strength && (
                      <Badge variant={strengthVariant(s.strength)}>
                        {s.strength}
                      </Badge>
                    )}
                  </td>
                  <td className="text-right">
                    {s.price_at_signal != null ? `₹${s.price_at_signal.toLocaleString('en-IN')}` : '—'}
                  </td>
                  <td className="reason-cell">{s.reason ?? '—'}</td>
                  <td>
                    <span className={s.acted_upon ? 'acted-yes' : 'acted-no'}>
                      {s.acted_upon ? '✓' : '○'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
