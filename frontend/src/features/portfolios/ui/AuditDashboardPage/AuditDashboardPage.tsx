/**
 * Performance / Audit Dashboard — a read-only surface over data the trading
 * engine already computes and persists elsewhere (model_calibration_buckets,
 * ml_model_weights, cold_start_state, decision_replay_events, trades).
 *
 * Deliberate design choice: every number here is either a raw persisted
 * value or a simple sum/cumulative-sum of persisted values — nothing is
 * re-derived through a rosier lens. Holdout metrics only, never in-sample.
 * This is meant to be the honest, chronological track record referenced
 * before connecting real money or a broker account to the model.
 *
 * Route: /admin/audit-dashboard
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine, BarChart, Bar,
} from 'recharts';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import {
  useGetAuditDashboardQuery,
  useGetMlTrainingStatusQuery,
  useRunMlTrainingMutation,
} from '../../../../store/admin/index.ts';
import type { ModelStage, CalibrationBucketPoint, MlTrainingRunResult } from '../../../../store/admin/index.ts';
import { StatCard } from '../../../../shared/ui/StatCard/StatCard.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

const STAGE_COLOR: Record<ModelStage, { bg: string; fg: string }> = {
  CANDIDATE: { bg: 'rgba(100,116,139,0.15)', fg: '#94a3b8' },
  SHADOW:    { bg: 'rgba(59,130,246,0.15)',  fg: '#60a5fa' },
  ADVISORY:  { bg: 'rgba(139,92,246,0.15)',  fg: '#a78bfa' },
  PRODUCTION:{ bg: 'rgba(16,185,129,0.15)',  fg: '#34d399' },
  RETIRED:   { bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
};

const StageChip = ({ stage }: { stage: ModelStage }) => {
  const c = STAGE_COLOR[stage] ?? STAGE_COLOR.CANDIDATE;
  return (
    <Chip label={stage} size="small"
      sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 700, fontSize: '0.7rem' }} />
  );
};

const fmtPct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;

const fmtInr = (v: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);

export const AuditDashboardPage = () => {
  const { data, isLoading, refetch } = useGetAuditDashboardQuery();
  const { data: mlStatus, refetch: refetchMlStatus } = useGetMlTrainingStatusQuery();
  const [runMlTraining, { isLoading: isTraining }] = useRunMlTrainingMutation();
  const [lastTrainResult, setLastTrainResult] = useState<MlTrainingRunResult | null>(null);

  const handleTrainNow = async () => {
    try {
      const result = await runMlTraining().unwrap();
      setLastTrainResult(result);
      void refetch();          // reload dashboard so new training row appears
      void refetchMlStatus();  // refresh status counts
    } catch (err) {
      setLastTrainResult({
        trained: false,
        durationMs: 0,
        reason: 'INSUFFICIENT_DATA',
        message: `Request failed: ${String(err)}`,
        availableSamples: 0,
        minTrainSamples: 30,
      });
    }
  };

  const timeline = data?.performanceTimeline ?? [];
  const totalRealizedPnl = timeline.length > 0 ? timeline[timeline.length - 1].cumulativeRealizedPnl : 0;
  const totalTrades = timeline.reduce((s, t) => s + t.tradesCount, 0);
  const totalWins = timeline.reduce((s, t) => s + t.winCount, 0);
  const totalLosses = timeline.reduce((s, t) => s + t.lossCount, 0);
  const winRate = (totalWins + totalLosses) > 0 ? totalWins / (totalWins + totalLosses) : null;

  const trainingHistory = data?.modelTrainingHistory ?? [];
  const latestRun = trainingHistory[trainingHistory.length - 1];

  // All three metrics scaled to 0–100 so they share one Y-axis.
  // AUC ×100, Accuracy ×100, Brier ×100 (lower is better; 25 = random baseline).
  const trainingChartData = trainingHistory.map((r, i) => ({
    run: `#${i + 1}`,
    trainedAt: new Date(r.trainedAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
    holdoutAuc:      r.holdoutAuc      !== null ? Number((r.holdoutAuc      * 100).toFixed(1)) : null,
    holdoutAccuracy: r.holdoutAccuracy !== null ? Number((r.holdoutAccuracy * 100).toFixed(1)) : null,
    holdoutBrier:    r.holdoutBrier    !== null ? Number((r.holdoutBrier    * 100).toFixed(2)) : null,
  }));

  const pnlChartData = timeline.map(t => ({
    date: new Date(t.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
    cumulativePnl: Math.round(t.cumulativeRealizedPnl),
  }));

  // Latest evaluation per calibration bucket (buckets list is chronological ASC)
  const latestCalibByBucket = new Map<string, CalibrationBucketPoint>();
  for (const b of data?.calibrationBuckets ?? []) {
    latestCalibByBucket.set(`${b.bucketLow}-${b.bucketHigh}`, b);
  }
  const calibrationRows = Array.from(latestCalibByBucket.values()).sort((a, b) => a.bucketLow - b.bucketLow);

  const decisionSummary = data?.decisionSummary ?? [];

  return (
    <Box>
      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2} flexWrap="wrap">
        <Box>
          <Typography variant="h4" fontWeight={700}>Performance &amp; Audit Dashboard</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5} maxWidth={640}>
            A chronological, honest track record — every number below is a raw persisted value or a
            simple running total of one. Holdout metrics only, never in-sample.
          </Typography>
        </Box>
        <Button size="small" variant="outlined" onClick={() => void refetch()}>Refresh</Button>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : !data ? (
        <EmptyState icon="📊" title="No data yet" description="Data will appear once the system has resolved trades and trained the model." />
      ) : (
        <>
          <Grid container spacing={2} mb={3}>
            <Grid item xs={6} sm={3}>
              <StatCard label="Cumulative realized P&L" value={fmtInr(totalRealizedPnl)}
                accent={totalRealizedPnl >= 0 ? '#10b981' : undefined}
                trend={totalRealizedPnl >= 0 ? 'up' : 'down'} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard label="Resolved SELL trades" value={String(totalTrades)}
                sub={winRate !== null ? `${fmtPct(winRate)} win rate` : undefined}
                trend={winRate !== null && winRate >= 0.5 ? 'up' : winRate !== null ? 'down' : 'neutral'} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard label="Latest holdout AUC" value={latestRun?.holdoutAuc !== null && latestRun?.holdoutAuc !== undefined ? latestRun.holdoutAuc.toFixed(3) : '—'}
                sub={latestRun ? (latestRun.holdoutAuc === null ? '⚠️ single-class holdout — N/A' : `n=${latestRun.holdoutCount} holdout rows`) : undefined} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <StatCard label="Latest holdout Brier" value={latestRun?.holdoutBrier !== null && latestRun?.holdoutBrier !== undefined ? latestRun.holdoutBrier.toFixed(3) : '—'}
                sub="0 = perfect, 0.25 = chance" />
            </Grid>
          </Grid>

          <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
            <Typography variant="h6" fontWeight={700} mb={2}>Cumulative Realized P&amp;L</Typography>
            {pnlChartData.length === 0 ? (
              <EmptyState icon="📈" title="No resolved trades yet" description="Cumulative P&L appears once SELL trades with a realized P&L exist." />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={pnlChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                  <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ background: '#1a2035', border: '1px solid #2d3748', borderRadius: 8 }}
                    labelStyle={{ color: '#94a3b8' }} formatter={(v: number) => [fmtInr(v), 'Cumulative P&L']} />
                  <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="cumulativePnl" name="Cumulative realized P&L" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Paper>

          <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
            <Box display="flex" alignItems="center" justifyContent="space-between" mb={2} flexWrap="wrap" gap={1}>
              <Typography variant="h6" fontWeight={700}>Model Training History (holdout metrics only)</Typography>
              {mlStatus && (
                <Button
                  size="small"
                  variant="contained"
                  disabled={isTraining}
                  onClick={() => void handleTrainNow()}
                  title={!mlStatus.canTrain ? `Runs resolve + label pipeline. Training needs ${mlStatus.minTrainSamples - mlStatus.availableSamples} more resolved samples.` : undefined}
                >
                  {isTraining ? 'Training…' : 'Train now'}
                </Button>
              )}
            </Box>

            {lastTrainResult && (
              <Alert
                severity={
                  lastTrainResult.trained ? 'success'
                  : lastTrainResult.reason === 'SINGLE_CLASS' ? 'warning'
                  : 'info'
                }
                sx={{ mb: 2 }}
                onClose={() => setLastTrainResult(null)}
              >
                {lastTrainResult.trained
                  ? `Model trained on ${lastTrainResult.sampleCount} samples in ${(lastTrainResult.durationMs / 1000).toFixed(1)}s — holdout AUC ${
                      lastTrainResult.holdoutAuc != null ? lastTrainResult.holdoutAuc.toFixed(3) : (lastTrainResult.holdoutAucWarning ?? '—')
                    }, Brier ${lastTrainResult.holdoutBrier != null ? lastTrainResult.holdoutBrier.toFixed(3) : '—'}.`
                  : lastTrainResult.message}
              </Alert>
            )}

            {trainingChartData.length === 0 ? (
              mlStatus ? (
                <Box sx={{ py: 2 }}>
                  <Typography variant="body2" color="text.secondary" mb={1.5}>
                    Model has not been trained yet. The nightly training job never fires on the serverless deployment —
                    use the button above to run it manually once enough resolved samples exist.
                  </Typography>
                  <Stack spacing={1.5}>
                    <Box>
                      <Box display="flex" justifyContent="space-between" mb={0.5}>
                        <Typography variant="caption" color="text.secondary">
                          Resolved samples available
                        </Typography>
                        <Typography variant="caption" color={mlStatus.canTrain ? 'success.main' : 'text.primary'} fontWeight={700}>
                          {mlStatus.availableSamples} / {mlStatus.minTrainSamples}
                        </Typography>
                      </Box>
                      <LinearProgress
                        variant="determinate"
                        value={Math.min(100, (mlStatus.availableSamples / mlStatus.minTrainSamples) * 100)}
                        color={mlStatus.canTrain ? 'success' : 'primary'}
                        sx={{ height: 6, borderRadius: 3 }}
                      />
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Data sources:
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block">
                        • trade_candidates (FINAL labels): {mlStatus.sources.candidatesReady} ready, {mlStatus.sources.candidatesPending} pending
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block">
                        • signal_patterns (resolved BUY): {mlStatus.sources.signalPatternsResolved} ready, {mlStatus.sources.signalPatternsPending} pending
                      </Typography>
                    </Box>
                    {mlStatus.classDistribution && (
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block">
                          Class distribution (resolved labels):
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          • WIN (target hit): {mlStatus.classDistribution.wins}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          • LOSS (stop-loss hit): {mlStatus.classDistribution.losses}
                        </Typography>
                        {(mlStatus.classDistribution.wins === 0 || mlStatus.classDistribution.losses === 0) && (
                          <Alert severity="warning" sx={{ mt: 0.5 }}>
                            All resolved samples share the same outcome — model needs at least one WIN and one LOSS to learn meaningful patterns.
                          </Alert>
                        )}
                      </Box>
                    )}
                    {mlStatus.blockingReason && (
                      <Alert severity="info" sx={{ mt: 1 }}>{mlStatus.blockingReason}</Alert>
                    )}
                  </Stack>
                </Box>
              ) : (
                <EmptyState icon="🧠" title="No training runs yet" description="No ML training status available yet." />
              )
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={trainingChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                  <XAxis dataKey="trainedAt" stroke="#64748b" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 12 }} domain={[0, 100]}
                    label={{ value: '% (all ×100)', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: '#1a2035', border: '1px solid #2d3748', borderRadius: 8 }}
                    labelStyle={{ color: '#94a3b8' }}
                    formatter={(v: number, name: string) => [`${v.toFixed(1)}`, name]}
                  />
                  <Legend />
                  <ReferenceLine y={25} stroke="#64748b" strokeDasharray="4 4"
                    label={{ value: 'Brier baseline (random)', position: 'right', fill: '#64748b', fontSize: 10 }} />
                  <ReferenceLine y={50} stroke="#374151" strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="holdoutAuc" name="Holdout AUC ×100" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="holdoutAccuracy" name="Holdout Accuracy %" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="holdoutBrier" name="Holdout Brier ×100 (↓ better)" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="2 2" dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Paper>

          <Grid container spacing={2} mb={2}>
            <Grid item xs={12} md={7}>
              <Paper elevation={0} sx={{ p: 2.5, height: '100%' }}>
                <Typography variant="h6" fontWeight={700} mb={0.5}>Portfolio Model Governance</Typography>
                <Typography variant="body2" color="text.secondary" mb={2}>
                  Every portfolio starts as CANDIDATE (paper trades only, no live signals). It promotes to
                  SHADOW → ADVISORY → PRODUCTION as the model accumulates evidence that its predictions actually
                  correspond to real market outcomes. All four columns below measure that evidence — zeros
                  everywhere mean the model has not yet closed enough BUY trades to be evaluated.
                </Typography>

                {(() => {
                  const zeros = data.portfolios.length > 0 && data.portfolios.every(p =>
                    p.trueLabelCount === 0 && p.positiveWFWindows === 0 && !p.calibration?.available
                  );
                  return zeros ? (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      Every portfolio shows 0 because no BUY trade has yet run its full label horizon
                      (typically 10 trading days after entry). Labels are generated by the nightly training
                      job, which promotes a candidate to SHADOW after 200 resolved labels + ≥2 positive
                      walk-forward windows. Trigger it manually with the "Train now" button above once BUYs
                      have been open long enough.
                    </Alert>
                  ) : null;
                })()}

                {data.portfolios.length === 0 ? (
                  <EmptyState icon="📁" title="No active portfolios" description="" />
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Portfolio</TableCell>
                          <TableCell align="center" title="Current lifecycle stage. CANDIDATE = paper only (default); SHADOW = model runs but no live weighting; ADVISORY = model influences ranking with reduced weight; PRODUCTION = full model weight applied; RETIRED = disabled after negative walk-forward evidence.">
                            Stage
                          </TableCell>
                          <TableCell align="right" title="Number of BUY trades this portfolio has closed AND had labelled with a TARGET_BEFORE_STOP outcome (i.e. we know whether the model's win-probability prediction was correct). Generated nightly from resolved trade candidates.">
                            Labels
                          </TableCell>
                          <TableCell align="right" title="Walk-forward validation windows in which the model's predictions had positive expectancy on out-of-sample data. Promotion to SHADOW requires ≥2 positive windows. Runs nightly.">
                            +WF windows
                          </TableCell>
                          <TableCell align="right" title="Largest gap between predicted win-probability and actual win-rate across probability buckets. Lower is better calibrated. — means no calibration data yet (needs ≥25 resolved labels per bucket).">
                            Calib. max err
                          </TableCell>
                          <TableCell title="What this portfolio needs before it can be promoted to the next stage.">
                            Next stage needs
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {data.portfolios.map(p => (
                          <TableRow key={p.portfolioId} hover>
                            <TableCell>
                              <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                              <Typography variant="caption" color="text.disabled">#{p.portfolioId}</Typography>
                            </TableCell>
                            <TableCell align="center"><StageChip stage={p.stage} /></TableCell>
                            <TableCell align="right">{p.trueLabelCount}</TableCell>
                            <TableCell align="right">{p.positiveWFWindows}</TableCell>
                            <TableCell align="right">
                              {p.calibration?.available ? fmtPct((p.calibration.maxErrorPct ?? 0) / 100) : '—'}
                            </TableCell>
                            <TableCell>
                              {p.promotionGaps ? (
                                <Typography variant="caption" color="text.secondary">
                                  {p.promotionGaps.labelsNeeded > 0
                                    ? `${p.promotionGaps.labelsNeeded} labels → ${p.promotionGaps.nextStage}`
                                    : p.promotionGaps.wfWindowsNeeded > 0
                                      ? `${p.promotionGaps.wfWindowsNeeded} WF windows → ${p.promotionGaps.nextStage}`
                                      : `Gates met → ${p.promotionGaps.nextStage}`}
                                </Typography>
                              ) : '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Paper>
            </Grid>

            <Grid item xs={12} md={5}>
              <Paper elevation={0} sx={{ p: 2.5, height: '100%' }}>
                <Typography variant="h6" fontWeight={700} mb={2}>Decision Breakdown (all-time)</Typography>
                {decisionSummary.length === 0 ? (
                  <EmptyState icon="🗂️" title="No decisions logged yet" description="" />
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={decisionSummary} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                      <XAxis dataKey="decisionType" stroke="#64748b" tick={{ fontSize: 12 }} />
                      <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                      <Tooltip contentStyle={{ background: '#1a2035', border: '1px solid #2d3748', borderRadius: 8 }}
                        labelStyle={{ color: '#94a3b8' }} />
                      <Bar dataKey="count" name="Count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Paper>
            </Grid>
          </Grid>

          <Paper elevation={0} sx={{ p: 2.5 }}>
            <Typography variant="h6" fontWeight={700} mb={1}>Calibration — Predicted vs Actual (latest evaluation per bucket)</Typography>
            <Typography variant="body2" color="text.secondary" mb={2}>
              A well-calibrated model's "predicted" and "actual" columns should be close. Large gaps mean the
              model's confidence doesn't match reality in that probability band.
            </Typography>
            {calibrationRows.length === 0 ? (
              <EmptyState icon="🎯" title="No calibration data yet" description="Appears once enough executed trades resolve in each probability band (min 5 per bucket)." />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Predicted P(win) band</TableCell>
                      <TableCell align="right">Samples</TableCell>
                      <TableCell align="right">Predicted avg</TableCell>
                      <TableCell align="right">Actual win rate</TableCell>
                      <TableCell align="right">Error</TableCell>
                      <TableCell align="right">Expectancy</TableCell>
                      <TableCell align="right">Profit factor</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {calibrationRows.map((b) => (
                      <TableRow key={`${b.bucketLow}-${b.bucketHigh}`} hover>
                        <TableCell>{fmtPct(b.bucketLow)} – {fmtPct(b.bucketHigh)}</TableCell>
                        <TableCell align="right">{b.sampleCount}</TableCell>
                        <TableCell align="right">{fmtPct(b.predictedAvg)}</TableCell>
                        <TableCell align="right">{fmtPct(b.actualWinRate)}</TableCell>
                        <TableCell align="right">
                          <Typography component="span" color={b.calibrationError > 0.15 ? 'error.main' : 'text.primary'} fontWeight={b.calibrationError > 0.15 ? 700 : 400}>
                            {fmtPct(b.calibrationError)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">{b.expectancyPct.toFixed(2)}%</TableCell>
                        <TableCell align="right">{b.profitFactor !== null ? b.profitFactor.toFixed(2) : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </>
      )}
    </Box>
  );
};
