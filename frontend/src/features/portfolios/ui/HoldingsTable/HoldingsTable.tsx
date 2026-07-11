import { memo } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useGetPortfolioSummaryQuery } from '../../../../store/portfolios/index.ts';
import { EmptyState } from '../../../../shared/ui/EmptyState/EmptyState.tsx';
import { SkeletonBlock } from '../../../../shared/ui/SkeletonBlock/SkeletonBlock.tsx';
import { StrategyTypeBadge } from '../StrategyTypeBadge/index.ts';
import { HoldingExitRules } from '../HoldingExitRules/index.ts';
import { formatINR, formatPct } from '../../model/portfolios.utils.ts';
import { useMarketPolling } from '../../hooks/useMarketPolling.ts';
import type { SummaryHolding } from '../../../../api/portfolio.api.types.ts';
import type { HoldingsTableProps } from './HoldingsTable.types.ts';

export const HoldingsTable = memo(({ portfolioId }: HoldingsTableProps) => {
  const pollingInterval = useMarketPolling();

  const { data: holdings, isLoading } = useGetPortfolioSummaryQuery(portfolioId, {
    pollingInterval,
    selectFromResult: ({ data, isLoading: loading }) => ({
      isLoading: loading,
      data: data?.holdings,
    }),
  });

  if (isLoading) {
    return (
      <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="h6" fontWeight={700} mb={2}>Current Holdings</Typography>
        <SkeletonBlock height={200} borderRadius={8} />
      </Paper>
    );
  }

  return (
    <Paper elevation={0} sx={{ p: 2.5, mb: 2 }}>
      <Typography variant="h6" fontWeight={700} mb={2}>Current Holdings</Typography>
      {!holdings || holdings.length === 0 ? (
        <EmptyState
          icon="💼"
          title="No holdings yet"
          description="The AI will build positions on the next trading cycle."
        />
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Symbol</TableCell>
                <TableCell>Company</TableCell>
                <TableCell>Strategy</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell align="right">Avg Buy</TableCell>
                <TableCell align="right">Current</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell align="right">P&amp;L</TableCell>
                <TableCell align="right">Return</TableCell>
                <TableCell>Exit Rules</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {holdings.map((h: SummaryHolding) => (
                <TableRow key={h.symbol}>
                  <TableCell><Typography fontWeight={700} variant="body2">{h.symbol}</Typography></TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 160 }}>{h.companyName}</Typography>
                  </TableCell>
                  <TableCell>
                    <Box display="flex" alignItems="center" gap={0.5} flexWrap="wrap">
                      <StrategyTypeBadge strategy={h.strategyType} />
                      {h.asmGsmFlag && (
                        <Tooltip title="ASM/GSM surveillance flag">
                          <Box component="span" sx={{ fontSize: '0.68rem', color: 'error.main', fontWeight: 700 }}>⚠ ASM</Box>
                        </Tooltip>
                      )}
                      {h.liquidityWarning && (
                        <Tooltip title="Low liquidity warning">
                          <WarningAmberIcon sx={{ fontSize: '0.9rem', color: 'warning.main' }} />
                        </Tooltip>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell align="right"><Typography variant="body2">{h.quantity}</Typography></TableCell>
                  <TableCell align="right"><Typography variant="body2">{formatINR(h.avgBuyPrice)}</Typography></TableCell>
                  <TableCell align="right">
                    <Box display="flex" alignItems="center" justifyContent="flex-end" gap={0.5}>
                      <Typography variant="body2">{formatINR(h.currentPrice)}</Typography>
                      {h.priceStatus === 'STALE' && (
                        <Tooltip title="Price data is stale — not used for trade execution">
                          <WarningAmberIcon sx={{ fontSize: '0.85rem', color: 'warning.main' }} />
                        </Tooltip>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell align="right"><Typography variant="body2">{formatINR(h.currentValue)}</Typography></TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" fontWeight={700} color={h.pnl >= 0 ? 'success.main' : 'error.main'}>
                      {h.pnl >= 0 ? '+' : ''}{formatINR(h.pnl)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" fontWeight={700} color={h.pnlPct >= 0 ? 'success.main' : 'error.main'}>
                      {formatPct(h.pnlPct)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <HoldingExitRules
                      atrStopPrice={h.atrStopPrice}
                      trailingStopPrice={h.trailingStopPrice}
                      timeStopDate={h.timeStopDate}
                      riskAmountInr={h.riskAmountInr}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
});

HoldingsTable.displayName = 'HoldingsTable';
