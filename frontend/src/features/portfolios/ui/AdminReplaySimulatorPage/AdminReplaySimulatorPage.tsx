/**
 * Admin — Replay Simulator: dry-run re-evaluation of any past decision.
 * Route: /admin/replay-simulator
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { useSimulateDecisionReplayMutation } from '../../../../store/admin/index.ts';
import { Badge } from '../../../../shared/ui/Badge/Badge.tsx';
import type { DecisionType } from '../../../../store/portfolios/portfolios.api.ts';
import type { BadgeVariant } from '../../../../shared/ui/Badge/Badge.tsx';
import type { SimulateReplayResult } from '../../../../store/admin/admin.api.ts';

const DECISION_VARIANT: Record<DecisionType, BadgeVariant> = {
  BUY: 'green', SELL: 'red', SKIP: 'yellow', VETO: 'gray',
};

const ResultCard = ({ result }: { result: SimulateReplayResult }) => {
  const changed = result.changed;
  return (
    <Paper elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: changed ? 'warning.dark' : 'divider' }}>
      <Box display="flex" alignItems="center" gap={1} mb={2}>
        <CompareArrowsIcon sx={{ color: changed ? 'warning.main' : 'success.main' }} />
        <Typography variant="h6" fontWeight={700}>
          {changed ? '⚠ Decision changed under simulation' : '✓ Same decision under simulation'}
        </Typography>
      </Box>

      <Box display="flex" gap={4} mb={2.5}>
        <Box>
          <Typography variant="caption" color="text.disabled">Original</Typography>
          <Box mt={0.5}><Badge variant={DECISION_VARIANT[result.originalDecision]}>{result.originalDecision}</Badge></Box>
        </Box>
        <Box>
          <Typography variant="caption" color="text.disabled">Simulated</Typography>
          <Box mt={0.5}><Badge variant={DECISION_VARIANT[result.simulatedDecision]}>{result.simulatedDecision}</Badge></Box>
        </Box>
        {result.simulatedScore != null && (
          <Box>
            <Typography variant="caption" color="text.disabled">Simulated score</Typography>
            <Typography variant="body2" fontWeight={700} mt={0.5}>{result.simulatedScore.toFixed(3)}</Typography>
          </Box>
        )}
      </Box>

      {result.simulatedReasonCodes.length > 0 && (
        <>
          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="caption" color="text.disabled" display="block" mb={1}>Reason codes under simulation</Typography>
          <Box display="flex" gap={0.75} flexWrap="wrap">
            {result.simulatedReasonCodes.map(r => (
              <Chip
                key={r.code}
                label={<><Box component="span" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', opacity: 0.7 }}>{r.code}</Box> {r.label}</>}
                size="small"
                sx={{ height: 22, fontSize: '0.72rem', bgcolor: 'rgba(139,92,246,0.1)', color: 'secondary.light' }}
              />
            ))}
          </Box>
        </>
      )}

      <Divider sx={{ my: 1.5 }} />
      <Box display="flex" gap={4}>
        <Box>
          <Typography variant="caption" color="text.disabled">Policy version</Typography>
          <Typography variant="body2" mt={0.25}>{result.policyVersion ?? 'latest'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.disabled">Model version</Typography>
          <Typography variant="body2" mt={0.25}>{result.modelVersion ?? 'latest'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.disabled">Simulated at</Typography>
          <Typography variant="body2" mt={0.25}>
            {new Date(result.simulatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </Typography>
        </Box>
      </Box>
    </Paper>
  );
};

export const AdminReplaySimulatorPage = () => {
  const navigate = useNavigate();

  const [decisionId, setDecisionId] = useState('');
  const [policyVersion, setPolicyVersion] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [result, setResult] = useState<SimulateReplayResult | null>(null);

  const [simulate, { isLoading, error }] = useSimulateDecisionReplayMutation();

  const handleSimulate = async () => {
    if (!decisionId.trim()) return;
    try {
      const res = await simulate({
        decisionId: decisionId.trim(),
        body: {
          policyVersion: policyVersion || undefined,
          modelVersion: modelVersion || undefined,
        },
      }).unwrap();
      setResult(res);
    } catch {
      setResult(null);
    }
  };

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/')} sx={{ color: 'text.secondary' }}>
          Portfolios
        </Button>
      </Box>

      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>Replay Simulator</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          Admin — dry-run re-evaluation of any past decision under a different policy or model version
        </Typography>
      </Box>

      <Paper elevation={0} sx={{ p: 2.5, mb: 3 }}>
        <Typography variant="subtitle2" fontWeight={700} mb={2}>Simulation parameters</Typography>

        <Box display="flex" gap={2} flexWrap="wrap" mb={2}>
          <TextField
            label="Decision ID" size="small" sx={{ width: 340 }}
            placeholder="e.g. decision:123:BUY:RELIANCE:2024-01-15T10:30:00"
            value={decisionId}
            onChange={e => setDecisionId(e.target.value)}
            helperText="Copy from the Decision Log page"
          />
        </Box>

        <Box display="flex" gap={2} flexWrap="wrap" mb={2.5}>
          <TextField
            label="Policy version (optional)" size="small" sx={{ width: 220 }}
            placeholder="e.g. v2.1.0"
            value={policyVersion}
            onChange={e => setPolicyVersion(e.target.value)}
            helperText="Leave blank to use current"
          />
          <TextField
            label="Model version (optional)" size="small" sx={{ width: 220 }}
            placeholder="e.g. ml-model-v3"
            value={modelVersion}
            onChange={e => setModelVersion(e.target.value)}
            helperText="Leave blank to use current"
          />
        </Box>

        <Box display="flex" alignItems="center" gap={1.5}>
          <Button
            variant="contained"
            startIcon={isLoading ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon />}
            onClick={() => void handleSimulate()}
            disabled={!decisionId.trim() || isLoading}
          >
            {isLoading ? 'Simulating…' : 'Run simulation'}
          </Button>
          {result && (
            <Button variant="outlined" size="small" onClick={() => { setResult(null); setDecisionId(''); }}>
              Clear
            </Button>
          )}
        </Box>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            Simulation failed — check the decision ID and try again.
          </Alert>
        )}
      </Paper>

      {/* Simulation result */}
      {result && <ResultCard result={result} />}

      {/* Usage guide */}
      {!result && (
        <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.1)' }}>
          <Typography variant="subtitle2" fontWeight={700} mb={1.5}>How to use</Typography>
          <Box component="ol" sx={{ m: 0, pl: 2.5, '& li': { mb: 1 } }}>
            <Typography component="li" variant="body2" color="text.secondary">
              Go to <strong>Decision Log</strong> (/admin/decisions) and copy a decision ID.
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              Optionally specify a policy version or model version to test counterfactuals.
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              Click <strong>Run simulation</strong>. The engine re-evaluates the candidate with the specified parameters — no trade is executed.
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              Compare original vs simulated decision to validate policy changes before deployment.
            </Typography>
          </Box>
        </Paper>
      )}
    </Box>
  );
};
