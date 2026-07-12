/**
 * Admin — Health Score Config: view active config + create new version.
 * Route: /admin/portfolio-health/config
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
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import { useGetAdminHealthConfigsQuery, useCreateAdminHealthConfigMutation } from '../../../../store/admin/index.ts';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';

const DEFAULT_WEIGHTS = JSON.stringify({
  diversification: 0.15,
  drawdown: 0.20,
  goalProgress: 0.15,
  strategyBalance: 0.10,
  cashDeployment: 0.10,
  executionQuality: 0.10,
  modelConfidence: 0.10,
  riskControl: 0.10,
}, null, 2);

const DEFAULT_THRESHOLDS = JSON.stringify({
  diversification: { minPositions: 3, maxSingleStockPct: 10, maxSectorPct: 25 },
  drawdown: { maxAllowedPct: 12 },
  goalProgress: { newPortfolioDays: 15 },
}, null, 2);

const DEFAULT_ASSUMPTIONS = JSON.stringify({
  baseProbability: 50,
  monthlyBenchmark: { easy: 0.75, moderate: 1.25, hard: 2.5, impossible: 5.0 },
  regimeAdjustment: { BULLISH: 10, BEARISH: -15, NEUTRAL: 0 },
}, null, 2);

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export const AdminHealthConfigPage = () => {
  const navigate = useNavigate();

  const [showForm, setShowForm] = useState(false);
  const [weightsJson, setWeightsJson] = useState(DEFAULT_WEIGHTS);
  const [thresholdsJson, setThresholdsJson] = useState(DEFAULT_THRESHOLDS);
  const [assumptionsJson, setAssumptionsJson] = useState(DEFAULT_ASSUMPTIONS);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const { data: configs = [], isLoading } = useGetAdminHealthConfigsQuery();
  const [createConfig, { isLoading: isCreating, isSuccess, error }] = useCreateAdminHealthConfigMutation();

  const validate = (): boolean => {
    try {
      const w = JSON.parse(weightsJson);
      const sum = Object.values(w as Record<string, number>).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1.0) > 0.01) {
        setJsonError(`Weights sum to ${sum.toFixed(3)} — must equal 1.0`);
        return false;
      }
      JSON.parse(thresholdsJson);
      JSON.parse(assumptionsJson);
      setJsonError(null);
      return true;
    } catch (e) {
      setJsonError(`Invalid JSON: ${(e as Error).message}`);
      return false;
    }
  };

  const handleCreate = async () => {
    if (!validate()) return;
    await createConfig({
      weights_json: weightsJson,
      thresholds_json: thresholdsJson,
      goal_probability_assumptions_json: assumptionsJson,
    });
    setShowForm(false);
  };

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1.5} mb={3}>
        <Button size="small" variant="text" startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/admin/portfolio-health')} sx={{ color: 'text.secondary' }}>
          Health Overview
        </Button>
      </Box>

      <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={3} gap={2} flexWrap="wrap">
        <Box>
          <Typography variant="h4" fontWeight={700}>Health Score Config</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            Admin — versioned scoring weight configuration. New config takes effect on next health calculation.
          </Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<AddIcon />}
          onClick={() => setShowForm(v => !v)}>
          {showForm ? 'Cancel' : 'New Config Version'}
        </Button>
      </Box>

      {/* Create form */}
      <Collapse in={showForm}>
        <Paper elevation={0} sx={{ p: 2.5, mb: 3, border: '1px solid', borderColor: 'primary.main' }}>
          <Typography variant="subtitle2" fontWeight={700} mb={2}>New Config Version</Typography>

          <Box display="flex" flexDirection="column" gap={2}>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block" mb={0.5}>
                Weights JSON — must sum to exactly 1.0
              </Typography>
              <TextField
                multiline rows={10} fullWidth size="small"
                value={weightsJson}
                onChange={e => setWeightsJson(e.target.value)}
                sx={{ fontFamily: 'monospace', '& textarea': { fontFamily: 'monospace', fontSize: '0.8rem' } }}
              />
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Thresholds JSON</Typography>
              <TextField
                multiline rows={6} fullWidth size="small"
                value={thresholdsJson}
                onChange={e => setThresholdsJson(e.target.value)}
                sx={{ '& textarea': { fontFamily: 'monospace', fontSize: '0.8rem' } }}
              />
            </Box>
            <Box>
              <Typography variant="caption" color="text.disabled" display="block" mb={0.5}>Goal Probability Assumptions JSON</Typography>
              <TextField
                multiline rows={6} fullWidth size="small"
                value={assumptionsJson}
                onChange={e => setAssumptionsJson(e.target.value)}
                sx={{ '& textarea': { fontFamily: 'monospace', fontSize: '0.8rem' } }}
              />
            </Box>
          </Box>

          {jsonError && <Alert severity="error" sx={{ mt: 1.5 }}>{jsonError}</Alert>}
          {error && <Alert severity="error" sx={{ mt: 1.5 }}>Failed to save config — check server logs.</Alert>}
          {isSuccess && <Alert severity="success" sx={{ mt: 1.5 }}>Config saved. It will become active on the next health calculation.</Alert>}

          <Box display="flex" gap={1.5} mt={2}>
            <Button variant="contained" size="small"
              onClick={() => void handleCreate()}
              disabled={isCreating}
              startIcon={isCreating ? <CircularProgress size={12} color="inherit" /> : undefined}>
              {isCreating ? 'Saving…' : 'Save Config'}
            </Button>
            <Button variant="outlined" size="small" onClick={() => setShowForm(false)}>Cancel</Button>
          </Box>
        </Paper>
      </Collapse>

      {/* Config list */}
      {isLoading ? (
        <Box display="flex" justifyContent="center" py={6}><CircularProgress size={32} /></Box>
      ) : configs.length === 0 ? (
        <EmptyState icon="⚙️" title="No configs yet" description="Create the first config version above." />
      ) : (
        <Paper elevation={0}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Version</TableCell>
                  <TableCell align="center">Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Weights summary</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {configs.map(c => {
                  let weights: Record<string, number> = {};
                  try { weights = JSON.parse(c.weightsJson); } catch { /* fallback */ }
                  return (
                    <TableRow key={c.id} hover>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>
                          {c.configVersion}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        <Chip
                          label={c.isActive ? 'ACTIVE' : 'ARCHIVED'}
                          size="small"
                          sx={{
                            height: 20, fontSize: '0.65rem', fontWeight: 700,
                            bgcolor: c.isActive ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.1)',
                            color: c.isActive ? '#10b981' : '#94a3b8',
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">{fmtDate(c.createdAt)}</Typography>
                      </TableCell>
                      <TableCell>
                        <Box display="flex" gap={0.5} flexWrap="wrap">
                          {Object.entries(weights).map(([k, v]) => (
                            <Typography key={k} variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace', fontSize: '0.62rem' }}>
                              {k.slice(0, 3)}:{(v * 100).toFixed(0)}%
                            </Typography>
                          ))}
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}
      <Divider sx={{ mt: 3, mb: 2 }} />
      <Typography variant="caption" color="text.disabled">
        Note: Creating a new config marks it as active. Old snapshot rows retain their original version tag (immutable history).
      </Typography>
    </Box>
  );
};
