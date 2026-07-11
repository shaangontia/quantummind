import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import MobileStepper from '@mui/material/MobileStepper';
import Paper from '@mui/material/Paper';

interface Step { icon: string; title: string; body: string; tip?: string; }

const STEPS: Step[] = [
  {
    icon: '📊', title: 'Create a Portfolio',
    body: 'Click "New Portfolio" to define your investment goal. Set your target return, time horizon, and risk preferences. The AI will automatically classify your portfolio\'s risk level based on these inputs.',
    tip: 'Example: 15% return over 24 months with medium volatility → classified as Medium Risk.',
  },
  {
    icon: '🤖', title: 'AI Analyses Every Stock',
    body: 'Before buying any stock, the engine analyses technical signals (RSI, momentum), fundamental health (revenue growth, debt-to-equity, cash flow quality), and recent news sentiment via Gemini AI.',
    tip: 'Stocks with earnings collapse or excessive debt are hard-blocked — the system never buys them regardless of technicals.',
  },
  {
    icon: '📈', title: 'Adaptive Trading — Goal-Driven',
    body: 'The engine actively trades to chase your return goal. It books profits at risk-tier thresholds (15–40%), frees up capital, and redeploys into the next opportunity. No stock is held indefinitely waiting to hit your annual target.',
    tip: 'A 100% target portfolio trades aggressively with larger positions — capital rotation + compounding is how aggressive goals are reached.',
  },
  {
    icon: '🛡️', title: 'Risk Controls & Auto-Lock',
    body: 'Stop-loss triggers automatically if a position drops beyond your drawdown tolerance. Once trading begins, strategy parameters are locked — only portfolio name and description remain editable.',
    tip: 'This protects the integrity of your AI\'s calibrated thesis. The system learns from every trade and improves over time.',
  },
  {
    icon: '📋', title: 'Monitor & Audit',
    body: 'Track real-time P&L, holdings, sector allocation, and benchmark performance on the portfolio dashboard. Every trade is logged in the Audit Log with the full reasoning behind it.',
    tip: 'Hit Refresh during market hours (9:15 AM – 3:30 PM IST) to get live price updates.',
  },
];

interface OnboardingModalProps { onClose: () => void; }

export const OnboardingModal = ({ onClose }: OnboardingModalProps) => {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  const handleDone = () => {
    localStorage.setItem('qm_onboarding_seen', '1');
    onClose();
  };

  return (
    <Dialog open maxWidth="sm" fullWidth>
      <DialogContent sx={{ textAlign: 'center', pt: 4, pb: 2, px: 4 }}>
        {/* Progress stepper */}
        <MobileStepper
          variant="dots"
          steps={STEPS.length}
          position="static"
          activeStep={step}
          nextButton={<Box />}
          backButton={<Box />}
          sx={{ justifyContent: 'center', bgcolor: 'transparent', mb: 3 }}
        />

        <Typography fontSize="3rem" lineHeight={1} mb={2}>{current.icon}</Typography>
        <Typography variant="h5" fontWeight={700} mb={1.5}>{current.title}</Typography>
        <Typography variant="body2" color="text.secondary" lineHeight={1.7}>{current.body}</Typography>

        {current.tip && (
          <Paper elevation={0} sx={{ mt: 2, p: 1.5, bgcolor: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', textAlign: 'left' }}>
            <Typography variant="caption" color="primary.light" fontWeight={700} display="block" mb={0.5}>💡 Tip</Typography>
            <Typography variant="caption" color="text.secondary">{current.tip}</Typography>
          </Paper>
        )}
      </DialogContent>

      <DialogActions sx={{ justifyContent: 'space-between', px: 4, pb: 3 }}>
        <Button variant="text" size="small" onClick={handleDone}>Skip</Button>
        <Box display="flex" gap={1}>
          {step > 0 && (
            <Button variant="outlined" size="small" onClick={() => setStep(s => s - 1)}>← Back</Button>
          )}
          {isLast ? (
            <Button variant="contained" onClick={handleDone}>Get Started 🚀</Button>
          ) : (
            <Button variant="contained" onClick={() => setStep(s => s + 1)}>Next →</Button>
          )}
        </Box>
      </DialogActions>
    </Dialog>
  );
};
