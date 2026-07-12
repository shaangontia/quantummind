import Drawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import { useGetDecisionReplayQuery } from '../../../../store/portfolios/portfolios.api.ts';
import { formatINR } from '../../model/portfolios.utils.ts';

interface DecisionReplayDrawerProps {
  portfolioId: number;
  decisionId: string | null;
  decisionTitle: string;
  onClose: () => void;
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="overline" sx={{ fontSize: '0.65rem', color: 'text.disabled', letterSpacing: 1.2, display: 'block', mb: 1 }}>
    {children}
  </Typography>
);

const ReasonCodeChip = ({ code, label, detail }: { code: string; label: string; detail?: string }) => (
  <Box sx={{ mb: 1 }}>
    <Box display="flex" alignItems="center" gap={1}>
      <Chip
        label={code}
        size="small"
        sx={{ fontFamily: 'monospace', fontSize: '0.65rem', height: 20, bgcolor: 'rgba(139,92,246,0.12)', color: 'secondary.light' }}
      />
      <Typography variant="body2" fontWeight={600}>{label}</Typography>
    </Box>
    {detail && (
      <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5, display: 'block', mt: 0.25 }}>
        {detail}
      </Typography>
    )}
  </Box>
);

export const DecisionReplayDrawer = ({ portfolioId, decisionId, decisionTitle, onClose }: DecisionReplayDrawerProps) => {
  const isOpen = Boolean(decisionId);

  const { data, isLoading, error } = useGetDecisionReplayQuery(
    { portfolioId, decisionId: decisionId ?? '' },
    { skip: !decisionId },
  );

  return (
    <Drawer
      anchor="right"
      open={isOpen}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 480 }, p: 0 } }}
    >
      {/* Header */}
      <Box
        display="flex"
        alignItems="flex-start"
        justifyContent="space-between"
        sx={{ px: 2.5, py: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}
      >
        <Box>
          <Typography variant="h6" fontWeight={700} lineHeight={1.2}>{decisionTitle}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {decisionId}
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose} sx={{ mt: 0.25 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body */}
      <Box sx={{ px: 2.5, py: 2.5, overflowY: 'auto', height: '100%' }}>
        {isLoading && (
          <Box display="flex" alignItems="center" justifyContent="center" py={8}>
            <CircularProgress size={28} />
          </Box>
        )}

        {error && (
          <Alert severity="error">Failed to load decision replay. Please try again.</Alert>
        )}

        {data && (
          <>
            {/* Summary */}
            <SectionLabel>What happened</SectionLabel>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5, lineHeight: 1.7 }}>
              {data.summary}
            </Typography>

            {/* Reason codes */}
            {data.reasonCodes.length > 0 && (
              <>
                <SectionLabel>Decision signals</SectionLabel>
                <Box sx={{ mb: 2.5 }}>
                  {data.reasonCodes.map(rc => (
                    <ReasonCodeChip key={rc.code} {...rc} />
                  ))}
                </Box>
              </>
            )}

            <Divider sx={{ mb: 2.5 }} />

            {/* Portfolio context */}
            <SectionLabel>Portfolio snapshot at decision</SectionLabel>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 1.5,
                mb: 2.5,
              }}
            >
              {[
                { icon: <AccountBalanceWalletIcon sx={{ fontSize: '1rem' }} />, label: 'NAV', value: data.portfolioContext.navAtDecision != null ? formatINR(data.portfolioContext.navAtDecision) : '—' },
                { icon: null, label: 'Cash', value: data.portfolioContext.cashPct != null ? `${data.portfolioContext.cashPct.toFixed(1)}%` : '—' },
                { icon: null, label: 'Open positions', value: data.portfolioContext.openPositions?.toString() ?? '—' },
                { icon: null, label: 'Regime', value: data.portfolioContext.regimeLabel ?? '—' },
                { icon: null, label: 'Policy', value: data.portfolioContext.policyType ?? '—' },
              ].map(({ label, value }) => (
                <Box key={label} sx={{ p: 1.25, bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                  <Typography variant="caption" color="text.disabled" display="block">{label}</Typography>
                  <Typography variant="body2" fontWeight={600} mt={0.25}>{value}</Typography>
                </Box>
              ))}
            </Box>

            {/* Trade result (BUY/SELL only) */}
            {data.tradeResult && (
              <>
                <Divider sx={{ mb: 2.5 }} />
                <SectionLabel>Trade executed</SectionLabel>
                <Box
                  sx={{
                    p: 2,
                    bgcolor: 'rgba(16,185,129,0.06)',
                    borderRadius: 1.5,
                    border: '1px solid rgba(16,185,129,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                  }}
                >
                  <TrendingUpIcon sx={{ color: 'success.main', fontSize: '1.2rem' }} />
                  <Box>
                    <Typography variant="body2">
                      <Box component="span" fontWeight={700}>{data.tradeResult.quantity ?? '—'} shares</Box>
                      {' @ '}
                      <Box component="span" fontWeight={700}>{data.tradeResult.price != null ? formatINR(data.tradeResult.price) : '—'}</Box>
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Trade #{data.tradeResult.tradeId ?? '—'} · Total {data.tradeResult.amount != null ? formatINR(data.tradeResult.amount) : '—'}
                    </Typography>
                  </Box>
                </Box>
              </>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
};
