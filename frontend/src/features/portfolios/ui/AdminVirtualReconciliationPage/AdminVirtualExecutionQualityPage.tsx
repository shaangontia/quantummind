/**
 * Admin — System-wide Virtual Execution Quality.
 * Route: /admin/virtual-execution-quality
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import CircularProgress from '@mui/material/CircularProgress';
import { useGetAdminVirtualExecutionQualityQuery } from '../../../../store/admin/index.ts';

const scoreColor = (s: number) =>
  s >= 85 ? '#10b981' : s >= 70 ? '#3b82f6' : s >= 50 ? '#f59e0b' : '#ef4444';

const StatCard = ({ label, value, color }: { label: string; value: string | number; color?: string }) => (
  <Paper elevation={0} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}>
    <Typography variant="caption" color="text.disabled" display="block" mb={0.5}>{label}</Typography>
    <Typography variant="h5" fontWeight={800} sx={{ color: color ?? 'text.primary' }}>{value}</Typography>
  </Paper>
);

export const AdminVirtualExecutionQualityPage = () => {
  const [range, setRange] = useState<'7D' | '30D' | '90D'>('30D');
  const { data, isLoading } = useGetAdminVirtualExecutionQualityQuery({ range });

  return (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2.5} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Virtual Execution Quality</Typography>
          <Typography variant="body2" color="text.secondary">System-wide simulated fill quality and slippage</Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>Range</InputLabel>
          <Select value={range} label="Range" onChange={e => setRange(e.target.value as '7D' | '30D' | '90D')}>
            <MenuItem value="7D">7D</MenuItem>
            <MenuItem value="30D">30D</MenuItem>
            <MenuItem value="90D">90D</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={8}><CircularProgress size={32} /></Box>
      )}

      {data && (
        <>
          <Grid container spacing={2} mb={3}>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="System score"
                value={`${data.systemExecutionScore}/100`}
                color={scoreColor(data.systemExecutionScore)}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Avg slippage" value={`${data.averageSlippagePct.toFixed(2)}%`} />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="Rejected orders"
                value={data.rejectedOrders}
                color={data.rejectedOrders > 0 ? '#ef4444' : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard
                label="Failed orders"
                value={data.failedOrders}
                color={data.failedOrders > 0 ? '#ef4444' : undefined}
              />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Partial fills" value={data.partialFills} />
            </Grid>
            <Grid item xs={6} sm={4} md={2}>
              <StatCard label="Total orders" value={data.totalOrders} />
            </Grid>
          </Grid>

          {data.worstSymbolsBySlippage.length > 0 && (
            <Paper elevation={0} sx={{ p: 2.5 }}>
              <Typography variant="subtitle2" fontWeight={700} mb={2}>Worst Symbols by Slippage</Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Symbol</TableCell>
                    <TableCell align="right">Average Slippage</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.worstSymbolsBySlippage.map(s => (
                    <TableRow key={s.symbol} hover>
                      <TableCell sx={{ fontWeight: 600, fontFamily: 'monospace' }}>{s.symbol}</TableCell>
                      <TableCell
                        align="right"
                        sx={{ color: s.averageSlippagePct > 0.5 ? '#ef4444' : s.averageSlippagePct > 0.25 ? '#f59e0b' : 'text.primary', fontWeight: 700 }}
                      >
                        {s.averageSlippagePct.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
};
