import { useAdaptiveReport } from '../../hooks/useAdaptiveReport.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import type { MarketRegime } from '../../../../api/adaptive.api.types.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import './AdaptivePanel.css';

const regimeVariant = (r: MarketRegime): BadgeVariant => {
  if (r === 'BULL') return 'green';
  if (r === 'BEAR') return 'red';
  return 'yellow';
};

const regimeIcon = (r: MarketRegime) => {
  if (r === 'BULL') return '🐂';
  if (r === 'BEAR') return '🐻';
  return '↔';
};

export const AdaptivePanel = () => {
  const { report, isLoading, error } = useAdaptiveReport();

  if (isLoading) return <div className="adaptive-loading"><Spinner /></div>;
  if (error || !report) return null;

  const { regime, signalWeights } = report;
  const maxWeight = Math.max(...signalWeights.map(s => s.weight), 1);

  return (
    <div className="adaptive-panel">
      {/* Market Regime */}
      <div className="regime-section">
        <div className="regime-header">
          <h3 className="sub-section-title">Market Regime</h3>
          <div className="regime-badge-row">
            <span className="regime-icon">{regimeIcon(regime.regime)}</span>
            <Badge variant={regimeVariant(regime.regime)}>{regime.regime}</Badge>
          </div>
        </div>
        <p className="regime-notes">{regime.notes}</p>
        <div className="regime-params">
          <div className="param">
            <span className="param-label">RSI Buy</span>
            <span className="param-value">&lt;{regime.rsiBuy}</span>
          </div>
          <div className="param">
            <span className="param-label">RSI Sell</span>
            <span className="param-value">&gt;{regime.rsiSell}</span>
          </div>
          <div className="param">
            <span className="param-label">Stop-Loss</span>
            <span className="param-value tag-negative">{(regime.stopLoss * 100).toFixed(0)}%</span>
          </div>
          <div className="param">
            <span className="param-label">Nifty RSI</span>
            <span className="param-value">{regime.nifty50Rsi}</span>
          </div>
        </div>
      </div>

      {/* Signal Weights */}
      <div className="weights-section">
        <h3 className="sub-section-title">Signal Weights (Self-Learning)</h3>
        <p className="weights-note">Weights adjust automatically based on signal win rates over time</p>
        <div className="weights-list">
          {signalWeights.map(sw => {
            const barPct = (sw.weight / maxWeight) * 100;
            const isStrong = sw.weight > 1.2;
            const isWeak = sw.weight < 0.8;
            return (
              <div key={sw.source} className="weight-row">
                <div className="weight-meta">
                  <span className="weight-source">{sw.source.replace(/_/g, ' ')}</span>
                  <span className={`weight-val ${isStrong ? 'tag-positive' : isWeak ? 'tag-negative' : 'tag-neutral'}`}>
                    {sw.weight.toFixed(2)}×
                  </span>
                </div>
                <div className="weight-bar-track">
                  <div
                    className={`weight-bar ${isStrong ? 'strong' : isWeak ? 'weak' : ''}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <div className="weight-stats">
                  <span className="text-muted">{sw.totalSignals} signals · {(sw.winRate * 100).toFixed(0)}% win rate</span>
                </div>
              </div>
            );
          })}
        </div>
        {signalWeights.every(sw => sw.totalSignals === 0) && (
          <p className="weights-no-data">⏳ Weights will diverge after 2–3 weeks of live signals</p>
        )}
      </div>
    </div>
  );
};
