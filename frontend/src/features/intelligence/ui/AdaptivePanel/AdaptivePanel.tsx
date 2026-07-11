import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import { useAdaptiveReport } from '../../hooks/useAdaptiveReport.ts';
import { useGetWalkForwardResultsQuery, useGetExpectancyReportQuery, useGetStrategyWalkForwardQuery, useGetAuditReportQuery, useGetDriftReportQuery } from '../../../../store/portfolios/portfolios.api.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { Spinner } from '../../../../shared/ui/Spinner/Spinner.tsx';
import type { MarketRegime } from '../../../../api/adaptive.api.types.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import type { WalkForwardWindow } from '../../../../store/portfolios/portfolios.api.ts';

const regimeVariant = (r: MarketRegime): BadgeVariant =>
  r === 'BULL' ? 'green' : r === 'BEAR' ? 'red' : 'yellow';

const regimeIcon = (r: MarketRegime) =>
  r === 'BULL' ? '🐂' : r === 'BEAR' ? '🐻' : '↔';

const fmtPct   = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtDate  = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
const sharpeColor = (s: number) => s >= 1.5 ? '#10b981' : s >= 0.8 ? '#f59e0b' : '#ef4444';

interface AdaptivePanelProps { portfolioId?: number; }

export const AdaptivePanel = ({ portfolioId }: AdaptivePanelProps) => {
  const { report, isLoading, error } = useAdaptiveReport();

  const { data: wfWindows = [], isLoading: wfLoading } =
    useGetWalkForwardResultsQuery(portfolioId!, { skip: portfolioId == null });

  const { data: expectancy } =
    useGetExpectancyReportQuery(portfolioId!, { skip: portfolioId == null });

  const { data: strategyWF = [] } =
    useGetStrategyWalkForwardQuery(portfolioId!, { skip: portfolioId == null });

  const { data: auditReport } =
    useGetAuditReportQuery(portfolioId!, { skip: portfolioId == null });

  const { data: driftReport } =
    useGetDriftReportQuery(portfolioId!, { skip: portfolioId == null });

  if (isLoading) return <Box display="flex" justifyContent="center" py={3}><Spinner /></Box>;
  if (error || !report) return null;

  const { regime, signalWeights = [] } = report;
  const maxWeight = Math.max(...signalWeights.map(s => s.weight), 1);

  return (
    <Grid container spacing={3}>
      {/* Market Regime */}
      <Grid item xs={12} md={5}>
        <Typography variant="subtitle2" fontWeight={700} mb={1.5}>Market Regime</Typography>
        <Box display="flex" alignItems="center" gap={1} mb={1}>
          <Typography fontSize="1.25rem">{regimeIcon(regime.regime)}</Typography>
          <Badge variant={regimeVariant(regime.regime)}>{regime.regime}</Badge>
        </Box>
        <Typography variant="body2" color="text.secondary" mb={2}>{regime.notes}</Typography>
        <Grid container spacing={1}>
          {[
            { label: 'RSI Buy',   value: `<${regime.rsiBuy}` },
            { label: 'RSI Sell',  value: `>${regime.rsiSell}` },
            { label: 'Stop-Loss', value: `${(regime.stopLoss * 100).toFixed(0)}%`, color: '#ef4444' },
            { label: 'Nifty RSI', value: String(regime.nifty50Rsi) },
          ].map(({ label, value, color }) => (
            <Grid item xs={6} key={label}>
              <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
              <Typography variant="body2" fontWeight={700} sx={{ color: color ?? 'text.primary' }}>{value}</Typography>
            </Grid>
          ))}
        </Grid>
      </Grid>

      {/* Signal Weights */}
      <Grid item xs={12} md={7}>
        <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Signal Weights (Self-Learning)</Typography>
        <Typography variant="caption" color="text.secondary" display="block" mb={2}>
          Weights adjust automatically based on signal win rates over time
        </Typography>
        <Box display="flex" flexDirection="column" gap={1.5}>
          {signalWeights.map(sw => {
            const barPct   = (sw.weight / maxWeight) * 100;
            const isStrong = sw.weight > 1.2;
            const isWeak   = sw.weight < 0.8;
            const barColor = isStrong ? '#10b981' : isWeak ? '#ef4444' : '#3b82f6';
            return (
              <Box key={sw.source}>
                <Box display="flex" justifyContent="space-between" mb={0.5}>
                  <Typography variant="caption">{sw.source.replace(/_/g, ' ')}</Typography>
                  <Box display="flex" gap={1} alignItems="center">
                    <Typography variant="caption" color="text.secondary">
                      {sw.totalSignals} signals · {(sw.winRate * 100).toFixed(0)}% win rate
                    </Typography>
                    <Typography variant="caption" fontWeight={700} sx={{ color: barColor }}>
                      {sw.weight.toFixed(2)}×
                    </Typography>
                  </Box>
                </Box>
                <LinearProgress
                  variant="determinate" value={barPct}
                  sx={{ height: 6, borderRadius: 3, '& .MuiLinearProgress-bar': { bgcolor: barColor } }}
                />
              </Box>
            );
          })}
        </Box>
        {signalWeights.every(sw => sw.totalSignals === 0) && (
          <Typography variant="caption" color="text.secondary" mt={2} display="block">
            ⏳ Weights will diverge after 2–3 weeks of live signals
          </Typography>
        )}
      </Grid>

      {/* Strategy-Level Walk-Forward */}
      {portfolioId != null && strategyWF.length > 0 && (
        <Grid item xs={12}>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Strategy Validation</Typography>
          <Typography variant="caption" color="text.secondary" display="block" mb={1.5}>
            Per-strategy expectancy from walk-forward windows. Strategies with 3 consecutive negative windows are auto-disabled.
          </Typography>
          <Box display="flex" gap={1.5} flexWrap="wrap">
            {/* Dedupe: latest window per strategy */}
            {Object.values(
              strategyWF.reduce<Record<string, typeof strategyWF[0]>>((acc, w) => {
                if (!acc[w.strategyType] || w.windowIndex > acc[w.strategyType].windowIndex) acc[w.strategyType] = w;
                return acc;
              }, {})
            ).map(w => (
              <Paper key={w.strategyType} elevation={0} sx={{
                p: 1.25, minWidth: 150, border: '1px solid',
                borderColor: w.autoDisabled ? 'error.dark' : 'divider',
                borderLeft: `3px solid ${w.autoDisabled ? '#ef4444' : w.expectancyPct >= 1 ? '#10b981' : w.expectancyPct >= 0 ? '#f59e0b' : '#ef4444'}`,
                opacity: w.autoDisabled ? 0.6 : 1,
              }}>
                <Box display="flex" alignItems="center" gap={0.75} mb={0.75}>
                  <Typography variant="caption" fontWeight={700} sx={{ textTransform: 'capitalize' }}>
                    {w.strategyType.replace(/_/g, ' ')}
                  </Typography>
                  {w.autoDisabled && (
                    <Tooltip title={`Auto-disabled after ${w.consecutiveNegativeWindows} consecutive negative windows`}>
                      <Chip label="DISABLED" size="small" color="error"
                        sx={{ fontSize: '0.55rem', height: 16, '& .MuiChip-label': { px: 0.5 }, cursor: 'help' }} />
                    </Tooltip>
                  )}
                </Box>
                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={0.5}>
                  {[
                    { label: 'Expectancy', value: `${w.expectancyPct >= 0 ? '+' : ''}${w.expectancyPct.toFixed(2)}%`,
                      color: w.expectancyPct >= 1 ? '#10b981' : w.expectancyPct >= 0 ? '#f59e0b' : '#ef4444' },
                    { label: 'Win',  value: fmtPct(w.winRate),
                      color: w.winRate >= 0.55 ? '#10b981' : w.winRate >= 0.45 ? '#f59e0b' : '#ef4444' },
                    { label: 'PF',   value: w.profitFactor.toFixed(2),
                      color: w.profitFactor >= 1.5 ? '#10b981' : w.profitFactor >= 1 ? '#f59e0b' : '#ef4444' },
                    { label: 'Candidates', value: String(w.candidateCount), color: 'text.secondary' },
                  ].map(({ label, value, color }) => (
                    <Box key={label}>
                      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                      <Typography variant="caption" fontWeight={700} sx={{ color }}>{value}</Typography>
                    </Box>
                  ))}
                </Box>
              </Paper>
            ))}
          </Box>
        </Grid>
      )}

      {/* Walk-Forward Validation */}
      {portfolioId != null && (
        <Grid item xs={12}>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="subtitle2" fontWeight={700} mb={0.5}>Walk-Forward Validation</Typography>
          <Typography variant="caption" color="text.secondary" display="block" mb={2}>
            Out-of-sample performance: 12-month train → 3-month test windows. Runs nightly.
          </Typography>
          {wfLoading && <Box display="flex" justifyContent="center" py={2}><Spinner /></Box>}
          {!wfLoading && wfWindows.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              ⏳ Walk-forward results appear once ≥30 resolved trades exist (Phase 14)
            </Typography>
          )}
          {/* Expectancy summary */}
          {expectancy && expectancy.labelledCandidates >= 1 && (
            <Box display="flex" gap={3} flexWrap="wrap" mb={2} p={1.5}
              sx={{ bgcolor: 'rgba(255,255,255,0.03)', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              {([
                { label: 'Expectancy/trade', value: `${expectancy.expectancyPct >= 0 ? '+' : ''}${expectancy.expectancyPct.toFixed(2)}%`,
                  color: expectancy.expectancyPct >= 1 ? '#10b981' : expectancy.expectancyPct >= 0 ? '#f59e0b' : '#ef4444' },
                { label: 'Win rate',  value: fmtPct(expectancy.winRate), color: expectancy.winRate >= 0.55 ? '#10b981' : '#f59e0b' },
                { label: 'Avg win',   value: `+${expectancy.avgWinPct.toFixed(2)}%`,  color: '#10b981' },
                { label: 'Avg loss',  value: `-${Math.abs(expectancy.avgLossPct).toFixed(2)}%`, color: '#ef4444' },
                { label: 'Profit factor', value: expectancy.profitFactor.toFixed(2),
                  color: expectancy.profitFactor >= 1.5 ? '#10b981' : expectancy.profitFactor >= 1 ? '#f59e0b' : '#ef4444' },
                { label: 'Labelled', value: `${expectancy.labelledCandidates} / ${expectancy.totalCandidates}`, color: 'text.secondary' },
              ] as Array<{ label: string; value: string; color: string }>).map(({ label, value, color }) => (
                <Box key={label}>
                  <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                  <Typography variant="body2" fontWeight={700} sx={{ color }}>{value}</Typography>
                </Box>
              ))}
            </Box>
          )}
          {!wfLoading && wfWindows.length > 0 && (
            <Box sx={{ overflowX: 'auto' }}>
              <Box display="flex" gap={1.5} pb={1} minWidth="max-content">
                {wfWindows.map((w: WalkForwardWindow) => (
                  <Paper key={w.windowIndex} elevation={0} sx={{
                    p: 1.5, minWidth: 160, border: '1px solid', borderColor: 'divider',
                    borderTop: `3px solid ${sharpeColor(w.sharpeRatio)}`,
                  }}>
                    <Typography variant="caption" color="text.secondary" display="block" mb={0.75} noWrap>
                      {fmtDate(w.testStart)} – {fmtDate(w.testEnd)}
                    </Typography>
                    <Box display="grid" gridTemplateColumns="1fr 1fr" gap={0.5} mb={0.5}>
                      <Tooltip title="Win Rate">
                        <Box>
                          <Typography variant="caption" color="text.secondary" display="block">Win</Typography>
                          <Typography variant="body2" fontWeight={700}
                            sx={{ color: w.winRate >= 0.55 ? '#10b981' : w.winRate >= 0.45 ? '#f59e0b' : '#ef4444' }}>
                            {fmtPct(w.winRate)}
                          </Typography>
                        </Box>
                      </Tooltip>
                      <Tooltip title="Sharpe Ratio">
                        <Box>
                          <Typography variant="caption" color="text.secondary" display="block">Sharpe</Typography>
                          <Typography variant="body2" fontWeight={700} sx={{ color: sharpeColor(w.sharpeRatio) }}>
                            {w.sharpeRatio.toFixed(2)}
                          </Typography>
                        </Box>
                      </Tooltip>
                      <Tooltip title="Max Drawdown">
                        <Box>
                          <Typography variant="caption" color="text.secondary" display="block">DD</Typography>
                          <Typography variant="body2" fontWeight={700} color="error.light">
                            -{fmtPct(w.maxDrawdownPct / 100)}
                          </Typography>
                        </Box>
                      </Tooltip>
                      <Tooltip title="Total trades in test window">
                        <Box>
                          <Typography variant="caption" color="text.secondary" display="block">Trades</Typography>
                          <Typography variant="body2" fontWeight={700}>{w.totalTrades}</Typography>
                        </Box>
                      </Tooltip>
                      {w.expectancyPct != null && (
                        <Tooltip title="Expectancy per trade (after costs)">
                          <Box sx={{ gridColumn: 'span 2' }}>
                            <Typography variant="caption" color="text.secondary" display="block">Expectancy</Typography>
                            <Typography variant="body2" fontWeight={700}
                              sx={{ color: w.expectancyPct >= 1 ? '#10b981' : w.expectancyPct >= 0 ? '#f59e0b' : '#ef4444' }}>
                              {w.expectancyPct >= 0 ? '+' : ''}{w.expectancyPct.toFixed(2)}%
                              {w.profitFactor != null && (
                                <Typography component="span" variant="caption" color="text.secondary" ml={0.5}>
                                  (PF {w.profitFactor.toFixed(2)})
                                </Typography>
                              )}
                            </Typography>
                          </Box>
                        </Tooltip>
                      )}
                    </Box>
                    {(w.strategyBreakdown ?? []).length > 0 && (
                      <Box mt={1} display="flex" gap={0.5} flexWrap="wrap">
                        {(w.strategyBreakdown ?? []).slice(0, 3).map(sb => (
                          <Tooltip key={sb.strategyType} title={`${sb.totalTrades} trades · avg ${(sb.avgReturn * 100).toFixed(1)}%`}>
                            <Box sx={{
                              px: 0.5, py: 0.1, borderRadius: 0.5, fontSize: '0.58rem',
                              bgcolor: 'rgba(255,255,255,0.06)', border: '1px solid',
                              borderColor: 'divider', lineHeight: 1.6, cursor: 'default',
                            }}>
                              {sb.strategyType.replace('_', ' ')} {fmtPct(sb.winRate)}
                            </Box>
                          </Tooltip>
                        ))}
                      </Box>
                    )}
                  </Paper>
                ))}
              </Box>
            </Box>
          )}
        </Grid>
      )}

      {/* Today's Audit — Phase 18 */}
      {portfolioId != null && auditReport && (
        <Grid item xs={12}>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="subtitle2" fontWeight={700} mb={1.5}>Today's Activity</Typography>
          <Box display="flex" gap={2} flexWrap="wrap" p={1.5}
            sx={{ bgcolor: 'rgba(255,255,255,0.03)', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            {/* Trades */}
            {([  
              { label: 'Buys',      value: auditReport.trades.buys,             color: '#10b981' },
              { label: 'Sells',     value: auditReport.trades.sells,            color: '#f59e0b' },
              { label: 'Dedup blocked', value: auditReport.trades.dedupBlocked, color: 'text.secondary' },
              { label: 'Emergency sells', value: auditReport.trades.emergencyLiquidations, color: auditReport.trades.emergencyLiquidations > 0 ? '#ef4444' : 'text.secondary' },
              { label: 'Signals evaluated', value: auditReport.signals.evaluated, color: 'text.primary' },
              { label: 'Vetoed',    value: auditReport.signals.vetoed,          color: auditReport.signals.vetoed > 0 ? '#f59e0b' : 'text.secondary' },
              { label: 'Open positions', value: auditReport.openPositions,      color: 'text.primary' },
              { label: 'Missing exit plans', value: auditReport.missingExitPlans, color: auditReport.missingExitPlans > 0 ? '#ef4444' : '#10b981' },
              ...(auditReport.dailyPnlPct != null ? [{ label: 'Daily P&L', value: `${auditReport.dailyPnlPct >= 0 ? '+' : ''}${auditReport.dailyPnlPct.toFixed(2)}%`, color: auditReport.dailyPnlPct >= 0 ? '#10b981' : '#ef4444' }] : []),
            ] as Array<{ label: string; value: number | string; color: string }>).map(({ label, value, color }) => (
              <Box key={label}>
                <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
                <Typography variant="body2" fontWeight={700} sx={{ color }}>{value}</Typography>
              </Box>
            ))}
          </Box>
          {(auditReport.killSwitchEvents ?? []).length > 0 && (
            <Box mt={1} display="flex" gap={0.5} flexWrap="wrap">
              {(auditReport.killSwitchEvents ?? []).map(evt => (
                <Box key={evt} sx={{ px: 0.75, py: 0.2, borderRadius: 0.5, bgcolor: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)', fontSize: '0.65rem', color: '#f87171' }}>
                  {evt}
                </Box>
              ))}
            </Box>
          )}
        </Grid>
      )}

      {/* Live vs Backtest Drift — Phase 18 */}
      {portfolioId != null && driftReport && driftReport.metrics.length > 0 && (
        <Grid item xs={12}>
          <Divider sx={{ mb: 2 }} />
          <Box display="flex" alignItems="center" gap={1.5} mb={1.5}>
            <Typography variant="subtitle2" fontWeight={700}>Live vs Backtest Drift</Typography>
            {driftReport.hasDrift && (
              <Box sx={{ px: 0.75, py: 0.2, borderRadius: 0.5, bgcolor: 'rgba(245,158,11,0.1)',
                border: '1px solid rgba(245,158,11,0.35)', fontSize: '0.65rem', color: '#f59e0b', fontWeight: 700 }}>
                ⚠ Drift detected
              </Box>
            )}
            <Typography variant="caption" color="text.secondary">
              {driftReport.windowMonths}m live vs most recent WF window
            </Typography>
          </Box>
          <Box sx={{ overflowX: 'auto' }}>
            <Box display="flex" gap={1.5} flexWrap="wrap" mb={(driftReport.driftFlags ?? []).length > 0 ? 1 : 0}>
              {(driftReport.metrics ?? []).map(m => (
                <Box key={m.metric} p={1} sx={{
                  minWidth: 120, borderRadius: 1, border: '1px solid',
                  borderColor: m.flagged ? 'rgba(245,158,11,0.4)' : 'divider',
                  bgcolor: m.flagged ? 'rgba(245,158,11,0.05)' : 'rgba(255,255,255,0.02)',
                }}>
                  <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>{m.metric}</Typography>
                  <Box display="flex" gap={1.5} alignItems="baseline">
                    <Tooltip title="Backtest">
                      <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: '0.72rem' }}>
                        BT {m.backtest.toFixed(2)}
                      </Typography>
                    </Tooltip>
                    <Tooltip title="Live">
                      <Typography variant="body2" fontWeight={700} sx={{ fontSize: '0.72rem',
                        color: m.flagged ? '#f59e0b' : m.delta >= 0 ? '#10b981' : '#ef4444' }}>
                        Live {m.live.toFixed(2)}
                      </Typography>
                    </Tooltip>
                  </Box>
                  <Typography variant="caption" sx={{ color: m.flagged ? '#f59e0b' : m.delta >= 0 ? '#10b981' : '#ef4444', fontSize: '0.65rem' }}>
                    {m.delta >= 0 ? '+' : ''}{m.delta.toFixed(2)} {m.flagged ? '⚠' : ''}
                  </Typography>
                </Box>
              ))}
            </Box>
            {(driftReport.driftFlags ?? []).map(flag => (
              <Typography key={flag} variant="caption" color="warning.light" display="block" mt={0.25}>• {flag}</Typography>
            ))}
          </Box>
        </Grid>
      )}
    </Grid>
  );
};
