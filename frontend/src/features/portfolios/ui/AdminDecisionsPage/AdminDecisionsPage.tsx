/**
 * Admin — cross-portfolio decision list with filters + full-trace replay drawer.
 * Route: /admin/decisions
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import Drawer from '@mui/material/Drawer';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import { useGetAdminDecisionsQuery, useGetAdminDecisionReplayQuery } from '../../../../store/admin/index.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import type { DecisionType } from '../../../../store/portfolios/portfolios.api.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import type { AdminDecisionsParams } from '../../../../store/admin/admin.api.ts';

const DECISION_VARIANT: Record<DecisionType, BadgeVariant> = {
  BUY: 'green', SELL: 'red', SKIP: 'yellow', VETO: 'gray',
};

const fmt = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// ─── Admin Replay Drawer (full trace — adminTrace exposed) ──────────────────

const TraceRow = ({ label, value, passed }: { label: string; value: string; passed?: boolean }) => (
  <Box display="flex" alignItems="baseline" gap={1} py={0.4} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
    <Typography variant="caption" color="text.disabled" sx={{ minWidth: 140 }}>{label}</Typography>
    <Typography variant="caption" fontWeight={600} color={
      passed === undefined ? 'text.secondary' : passed ? 'success.main' : 'error.main'
    }>{value}</Typography>
  </Box>
);

const AdminReplayDrawer = ({ decisionId, onClose }: { decisionId: string | null; onClose: () => void }) => {
  const { data, isLoading, error } = useGetAdminDecisionReplayQuery(decisionId ?? '', { skip: !decisionId });

  return (
    <Drawer anchor="right" open={Boolean(decisionId)} onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 640 }, p: 0 } }}
    >
      <Box display="flex" alignItems="center" justifyContent="space-between"
        sx={{ px: 2.5, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box>
          <Typography variant="h6" fontWeight={700}>Full Decision Trace</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{decisionId}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      <Box sx={{ px: 2.5, py: 2.5, overflowY: 'auto', height: '100%' }}>
        {isLoading && <Box display="flex" justifyContent="center" py={6}><CircularProgress size={28} /></Box>}
        {error && <Alert severity="error">Failed to load trace.</Alert>}
        {data && (
          <Alert severity="info" sx={{ mb: 2, fontSize: '0.75rem' }}>
            Sections showing — indicate data not captured at decision time (pre-trace or LLM not called).
          </Alert>
        )}
        {data && (
          <>
            {/* User explanation */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2 }}>User Explanation</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2, lineHeight: 1.7 }}>{data.userExplanation.summary}</Typography>

            <Divider sx={{ mb: 2 }} />

            {/* Feature snapshot */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>Feature Snapshot</Typography>
            {Object.entries(data.adminTrace.featureSnapshot ?? {}).map(([k, v]) => (
              <TraceRow key={k} label={k} value={v == null ? '—' : String(v)} />
            ))}

            <Divider sx={{ my: 2 }} />

            {/* Model trace */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>Model Score Breakdown</Typography>
            {(Array.isArray(data.adminTrace.modelTrace) ? data.adminTrace.modelTrace : []).map((m, i) => (
              <TraceRow key={i} label={m.component} value={
                m.score != null && m.contribution != null
                  ? `${m.score.toFixed(3)} × w${(m.weight ?? 1).toFixed(2)} = ${m.contribution.toFixed(3)}${m.detail ? ` · ${m.detail}` : ''}`
                  : (m.detail ?? '—')
              } />
            ))}

            <Divider sx={{ my: 2 }} />

            {/* Rule trace */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>Rules</Typography>
            {(Array.isArray(data.adminTrace.ruleTrace) ? data.adminTrace.ruleTrace : []).map((r, i) => (
              <TraceRow key={i} label={r.rule} value={`${r.value ?? '—'} (threshold: ${r.threshold ?? '—'})`} passed={r.passed} />
            ))}

            <Divider sx={{ my: 2 }} />

            {/* Risk trace */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>Risk Gates</Typography>
            {(Array.isArray(data.adminTrace.riskTrace) ? data.adminTrace.riskTrace : []).map((r, i) => (
              <TraceRow key={i} label={r.rule} value={`${r.value ?? '—'} (threshold: ${r.threshold ?? '—'})`} passed={r.passed} />
            ))}

            <Divider sx={{ my: 2 }} />

            {/* LLM trace */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>LLM Trace</Typography>
            <TraceRow label="Gemini Verdict" value={data.adminTrace.llmTrace.geminiVerdict ?? '—'} />
            <TraceRow label="Gemini Confidence" value={data.adminTrace.llmTrace.geminiConfidence != null ? `${(data.adminTrace.llmTrace.geminiConfidence * 100).toFixed(0)}%` : '—'} />
            <TraceRow label="Risk Level" value={data.adminTrace.llmTrace.geminiRiskLevel ?? '—'} />
            <TraceRow label="Groq Sentiment" value={data.adminTrace.llmTrace.groqSentimentScore != null ? String(data.adminTrace.llmTrace.groqSentimentScore) : '—'} />
            {(data.adminTrace.llmTrace.geminiRedFlags ?? []).length > 0 && (
              <Box mt={1}>
                <Typography variant="caption" color="text.disabled">Red flags:</Typography>
                <Box display="flex" gap={0.5} flexWrap="wrap" mt={0.5}>
                  {(data.adminTrace.llmTrace.geminiRedFlags ?? []).map(f => (
                    <Chip key={f} label={f} size="small" sx={{ fontSize: '0.65rem', height: 18, bgcolor: 'rgba(239,68,68,0.12)', color: 'error.light' }} />
                  ))}
                </Box>
              </Box>
            )}

            <Divider sx={{ my: 2 }} />

            {/* Execution trace */}
            <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>Execution</Typography>
            <TraceRow label="Signal Score" value={data.adminTrace.executionTrace.signalScore?.toFixed(3) ?? '—'} />
            <TraceRow label="Utility Score" value={data.adminTrace.executionTrace.utilityScore?.toFixed(3) ?? '—'} />
            <TraceRow label="Final Decision" value={data.adminTrace.executionTrace.finalDecision} />
            <TraceRow label="Rejected By" value={data.adminTrace.executionTrace.rejectedBy ?? '—'} />
            <TraceRow label="Executed At" value={data.adminTrace.executionTrace.executedAt ?? '—'} />
          </>
        )}
      </Box>
    </Drawer>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export const AdminDecisionsPage = () => {
  const navigate = useNavigate();

  const [filters, setFilters] = useState<AdminDecisionsParams>({ limit: 100, offset: 0 });
  const [applied, setApplied] = useState<AdminDecisionsParams>({ limit: 100, offset: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: decisionsRaw, isLoading, isFetching } = useGetAdminDecisionsQuery(applied);
  const decisions = Array.isArray(decisionsRaw) ? decisionsRaw : [];

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')} sx={{ color: 'text.secondary' }}>
          Portfolios
        </Button>
      </Box>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Decision Log</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Admin — cross-portfolio decision audit with full trace replay
        </Typography>
      </Box>

      {/* Filters */}
      <Paper elevation={0} sx={{ p: 2, mb: 2 }}>
        <Box display="flex" gap={2} flexWrap="wrap" alignItems="flex-end">
          <TextField
            label="Portfolio ID" size="small" sx={{ width: 130 }} type="number"
            value={filters.portfolioId ?? ''}
            onChange={e => setFilters(f => ({ ...f, portfolioId: e.target.value ? Number(e.target.value) : undefined }))}
          />
          <TextField
            label="Symbol" size="small" sx={{ width: 110 }}
            value={filters.symbol ?? ''}
            onChange={e => setFilters(f => ({ ...f, symbol: e.target.value || undefined }))}
          />
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>Decision type</InputLabel>
            <Select
              label="Decision type"
              value={filters.decision_type ?? ''}
              onChange={e => setFilters(f => ({ ...f, decision_type: (e.target.value as DecisionType) || undefined }))}
            >
              <MenuItem value="">All</MenuItem>
              {(['BUY', 'SELL', 'SKIP', 'VETO'] as DecisionType[]).map(d => (
                <MenuItem key={d} value={d}>{d}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField label="From date" size="small" type="date" sx={{ width: 160 }}
            InputLabelProps={{ shrink: true }}
            value={filters.dateFrom ?? ''}
            onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value || undefined }))}
          />
          <TextField label="To date" size="small" type="date" sx={{ width: 160 }}
            InputLabelProps={{ shrink: true }}
            value={filters.dateTo ?? ''}
            onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value || undefined }))}
          />
          <Button variant="contained" size="small" onClick={() => setApplied({ ...filters })} disabled={isFetching}>
            Apply
          </Button>
          <Button variant="outlined" size="small" onClick={() => { setFilters({ limit: 100, offset: 0 }); setApplied({ limit: 100, offset: 0 }); }}>
            Clear
          </Button>
        </Box>
      </Paper>

      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : decisions.length === 0 ? (
        <EmptyState icon="🔍" title="No decisions found" description="Try adjusting the filters." />
      ) : (
        <Paper elevation={0}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Portfolio</TableCell>
                  <TableCell>Decision</TableCell>
                  <TableCell>Symbol</TableCell>
                  <TableCell>Title</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {decisions.map(d => (
                  <TableRow key={d.decisionId} hover sx={{ cursor: 'pointer' }}
                    onClick={() => setSelectedId(d.decisionId)}>
                    <TableCell><Typography variant="caption" color="text.secondary" noWrap>{fmt(d.decisionTime)}</Typography></TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary">#{d.portfolioId}</Typography></TableCell>
                    <TableCell><Badge variant={DECISION_VARIANT[d.decision]}>{d.decision}</Badge></TableCell>
                    <TableCell><Typography variant="body2" fontWeight={700}>{d.symbol}</Typography></TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary"
                        sx={{ maxWidth: 300, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.title}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <AdminReplayDrawer decisionId={selectedId} onClose={() => setSelectedId(null)} />
    </Box>
  );
};
