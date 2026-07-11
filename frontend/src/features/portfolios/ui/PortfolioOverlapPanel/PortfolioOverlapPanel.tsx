/**
 * PortfolioOverlapPanel — Phase 19 P8
 * Shows which stocks are shared across portfolios and why.
 * GLOBAL_CONSENSUS = all policies agree (healthy)
 * POLICY_MATCH     = specific policies only (normal)
 * REGIME_DRIVEN    = regime forced same pick (informational)
 * DIVERSIFICATION_BLOCKED = concentration risk (warning)
 */
import {
  Box, Typography, Chip, Tooltip, Collapse, Alert,
  CircularProgress, Divider, Grid,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useState } from 'react';
import { useGetPortfolioOverlapQuery } from '../../../../store/portfolios/portfolios.api.ts';
import type { OverlapEntry, OverlapType } from '../../../../store/portfolios/portfolios.api.ts';

const OVERLAP_META: Record<OverlapType, { label: string; color: string; tip: string }> = {
  GLOBAL_CONSENSUS:        { label: 'Global Consensus', color: '#10b981', tip: 'All active policies agree this is a strong setup' },
  POLICY_MATCH:            { label: 'Policy Match',     color: '#3b82f6', tip: 'Only specific portfolio policies selected this stock' },
  REGIME_DRIVEN:           { label: 'Regime Driven',    color: '#8b5cf6', tip: 'Market regime pushed this into multiple portfolios' },
  DIVERSIFICATION_BLOCKED: { label: 'Concentration ⚠',  color: '#ef4444', tip: 'Same stock across portfolios may indicate insufficient diversification' },
};

const OverlapRow = ({ entry, portfolios }: { entry: OverlapEntry; portfolios: Array<{ id: number; name: string }> }) => {
  const [open, setOpen] = useState(false);
  const meta = OVERLAP_META[entry.overlapType];

  return (
    <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', py: 1 }}>
      <Box
        display="flex" alignItems="center" gap={1.5} sx={{ cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <Typography variant="body2" fontWeight={700} sx={{ minWidth: 120 }}>
          {entry.symbol.replace('.NS', '')}
        </Typography>
        {entry.sector && (
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 80 }}>
            {entry.sector}
          </Typography>
        )}
        <Tooltip title={meta.tip} arrow>
          <Chip
            label={meta.label}
            size="small"
            sx={{
              height: 18, fontSize: '0.6rem', fontWeight: 700,
              bgcolor: `${meta.color}15`, color: meta.color,
              border: `1px solid ${meta.color}35`,
              '& .MuiChip-label': { px: 0.75 },
            }}
          />
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          {entry.portfolioCount} portfolio{entry.portfolioCount !== 1 ? 's' : ''}
        </Typography>
        {entry.strategyType && (
          <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto', mr: 0.5 }}>
            {entry.strategyType.replace('_', ' ')}
          </Typography>
        )}
        {open ? <ExpandLessIcon sx={{ fontSize: 16, color: 'text.secondary' }} /> : <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
      </Box>

      <Collapse in={open}>
        <Box pl={1} pt={0.75} pb={0.5}>
          <Typography variant="caption" color="text.secondary" display="block" mb={0.75}>
            {entry.explanation}
          </Typography>
          <Box display="flex" gap={0.75} flexWrap="wrap">
            {entry.heldByPortfolioIds.map(pid => {
              const p = portfolios.find(x => x.id === pid);
              const score = entry.utilityScores?.[pid];
              return (
                <Box key={pid} sx={{
                  px: 1, py: 0.25, borderRadius: 0.5,
                  bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid', borderColor: 'divider',
                }}>
                  <Typography variant="caption" color="text.primary" fontWeight={600}>
                    {p?.name ?? `Portfolio ${pid}`}
                  </Typography>
                  {score != null && (
                    <Typography variant="caption" color="text.secondary" ml={0.5}>
                      utility {score.toFixed(2)}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
};

interface Props {
  portfolios: Array<{ id: number; name: string }>;
}

export const PortfolioOverlapPanel = ({ portfolios }: Props) => {
  const { data, isLoading, isError } = useGetPortfolioOverlapQuery();
  const [expanded, setExpanded] = useState(true);

  if (isLoading) {
    return (
      <Box display="flex" alignItems="center" gap={1} py={1.5}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">Loading overlap report…</Typography>
      </Box>
    );
  }

  if (isError || !data) {
    return (
      <Alert severity="warning" sx={{ py: 0.5, fontSize: '0.75rem' }}>
        Overlap report unavailable — portfolio differentiation data not yet generated.
      </Alert>
    );
  }

  const hasOverlap = data.overlaps.length > 0;

  return (
    <Box sx={{
      p: 2, border: '1px solid', borderColor: 'divider',
      borderRadius: 1, bgcolor: 'rgba(255,255,255,0.02)',
    }}>
      {/* Header */}
      <Box display="flex" alignItems="center" gap={1.5} mb={1} sx={{ cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}>
        <Typography variant="subtitle2" fontWeight={700}>Portfolio Overlap</Typography>
        <Typography variant="caption" color="text.secondary">
          {data.overlappingSymbols}/{data.totalHeldSymbols} shared
        </Typography>
        {data.overlapRateWarning && (
          <Tooltip title="High overlap rate — portfolio differentiation may not be effective yet" arrow>
            <Chip
              label={`${(data.overlapRate * 100).toFixed(0)}% overlap ⚠`}
              size="small"
              sx={{ height: 18, fontSize: '0.6rem', fontWeight: 700,
                bgcolor: 'rgba(245,158,11,0.1)', color: '#f59e0b',
                border: '1px solid rgba(245,158,11,0.3)', '& .MuiChip-label': { px: 0.75 } }}
            />
          </Tooltip>
        )}
        {!data.overlapRateWarning && hasOverlap && (
          <Chip
            label={`${(data.overlapRate * 100).toFixed(0)}% overlap`}
            size="small"
            sx={{ height: 18, fontSize: '0.6rem', fontWeight: 700,
              bgcolor: 'rgba(16,185,129,0.08)', color: '#10b981',
              border: '1px solid rgba(16,185,129,0.2)', '& .MuiChip-label': { px: 0.75 } }}
          />
        )}
        <Box ml="auto">
          {expanded ? <ExpandLessIcon sx={{ fontSize: 16, color: 'text.secondary' }} /> : <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />}
        </Box>
      </Box>

      <Collapse in={expanded}>
        {/* Summary row */}
        <Grid container spacing={2} mb={1.5}>
          {[
            { label: 'Total held', value: data.totalHeldSymbols },
            { label: 'Shared', value: data.overlappingSymbols },
            { label: 'Unique', value: data.singlePortfolioSymbols },
            { label: 'Portfolios', value: data.totalPortfolios },
          ].map(({ label, value }) => (
            <Grid item key={label}>
              <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
              <Typography variant="body2" fontWeight={700}>{value}</Typography>
            </Grid>
          ))}
        </Grid>

        <Divider sx={{ mb: 1.5 }} />

        {!hasOverlap ? (
          <Typography variant="caption" color="text.secondary">
            No overlapping positions — portfolios are fully differentiated.
          </Typography>
        ) : (
          <Box>
            {data.overlaps.map(entry => (
              <OverlapRow key={entry.symbol} entry={entry} portfolios={portfolios} />
            ))}
          </Box>
        )}
      </Collapse>
    </Box>
  );
};
