import { useState, useEffect, useRef } from 'react';
import type { RiskTolerance } from '../../../api/portfolio.api.types.ts';

interface RiskClassifyParams {
  targetReturnPct: number;
  investmentHorizonMonths: number;
  maxDrawdownPct?: number;
  volatilityPreference?: string;
}

interface RiskClassification {
  level: RiskTolerance;
  score: number;
  explanation: string;
}

/**
 * Calls GET /api/risk/classify ONCE and returns the derived risk level + explanation.
 * Once a classification is received it is frozen — no further API calls are made.
 * This keeps the risk label stable while the user finishes filling the form.
 */
export const useRiskClassifier = (params: RiskClassifyParams): RiskClassification | null => {
  const [result, setResult] = useState<RiskClassification | null>(null);
  const classifiedRef = useRef(false);

  useEffect(() => {
    // Once classified, never recalculate
    if (classifiedRef.current) return;

    const { targetReturnPct, investmentHorizonMonths, maxDrawdownPct, volatilityPreference } = params;
    const qs = new URLSearchParams({
      targetReturnPct: String(targetReturnPct),
      investmentHorizonMonths: String(investmentHorizonMonths),
      ...(maxDrawdownPct != null ? { maxDrawdownPct: String(maxDrawdownPct) } : {}),
      ...(volatilityPreference ? { volatilityPreference } : {}),
    });

    void fetch(`/api/risk/classify?${qs.toString()}`, { credentials: 'include' })
      .then(res => res.ok ? res.json() as Promise<{ data?: RiskClassification }> : null)
      .then(json => {
        if (json?.data) {
          setResult(json.data);
          classifiedRef.current = true; // lock — no further calls
        }
      })
      .catch(() => { /* silently ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return result;
};
