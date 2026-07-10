import { useState } from 'react';
import './OnboardingModal.css';

interface Step {
  icon: string;
  title: string;
  body: string;
  tip?: string;
}

const STEPS: Step[] = [
  {
    icon: '📊',
    title: 'Create a Portfolio',
    body: 'Click "New Portfolio" to define your investment goal. Set your target return, time horizon, and risk preferences. The AI will automatically classify your portfolio\'s risk level based on these inputs.',
    tip: 'Example: 15% return over 24 months with medium volatility → classified as Medium Risk.',
  },
  {
    icon: '🤖',
    title: 'AI Analyses Every Stock',
    body: 'Before buying any stock, the engine analyses technical signals (RSI, momentum), fundamental health (revenue growth, debt-to-equity, cash flow quality), and recent news sentiment via Gemini AI.',
    tip: 'Stocks with earnings collapse or excessive debt are hard-blocked — the system never buys them regardless of technicals.',
  },
  {
    icon: '📈',
    title: 'Adaptive Trading — Goal-Driven',
    body: 'The engine actively trades to chase your return goal. It books profits at risk-tier thresholds (15–40%), frees up capital, and redeploys into the next opportunity. No stock is held indefinitely waiting to hit your annual target.',
    tip: 'A 100% target portfolio trades aggressively with larger positions — capital rotation + compounding is how aggressive goals are reached.',
  },
  {
    icon: '🛡️',
    title: 'Risk Controls & Auto-Lock',
    body: 'Stop-loss triggers automatically if a position drops beyond your drawdown tolerance. Once trading begins, strategy parameters are locked — only portfolio name and description remain editable.',
    tip: 'This protects the integrity of your AI\'s calibrated thesis. The system learns from every trade and improves over time.',
  },
  {
    icon: '📋',
    title: 'Monitor & Audit',
    body: 'Track real-time P&L, holdings, sector allocation, and benchmark performance on the portfolio dashboard. Every trade is logged in the Audit Log with the full reasoning behind it.',
    tip: 'Hit Refresh during market hours (9:15 AM – 3:30 PM IST) to get live price updates.',
  },
];

interface OnboardingModalProps {
  onClose: () => void;
}

export const OnboardingModal = ({ onClose }: OnboardingModalProps) => {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  const handleDone = () => {
    localStorage.setItem('qm_onboarding_seen', '1');
    onClose();
  };

  return (
    <div className="modal-overlay onboarding-overlay">
      <div className="onboarding-box">
        {/* Progress dots */}
        <div className="onboarding-dots">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`onboarding-dot ${i === step ? 'active' : i < step ? 'done' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="onboarding-icon">{current.icon}</div>
        <h2 className="onboarding-title">{current.title}</h2>
        <p className="onboarding-body">{current.body}</p>

        {current.tip && (
          <div className="onboarding-tip">
            <span className="onboarding-tip-label">💡 Tip</span>
            {current.tip}
          </div>
        )}

        {/* Footer */}
        <div className="onboarding-footer">
          <button
            className="btn btn-ghost"
            onClick={handleDone}
          >
            Skip
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button className="btn btn-ghost" onClick={() => setStep(s => s - 1)}>
                ← Back
              </button>
            )}
            {isLast ? (
              <button className="btn btn-primary" onClick={handleDone}>
                Get Started 🚀
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setStep(s => s + 1)}>
                Next →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
