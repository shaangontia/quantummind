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
 * Calls GET /api/risk/classify with debounce (400ms) and returns the
 * derived risk level + explanation. Falls back to null while loading.
 */
export const useRiskClassifier = (params: RiskClassifyParams): RiskClassification | null => {
  const [result, setResult] = useState<RiskClassification | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const { targetReturnPct, investmentHorizonMonths, maxDrawdownPct, volatilityPreference } = params;
      const qs = new URLSearchParams({
        targetReturnPct: String(targetReturnPct),
        investmentHorizonMonths: String(investmentHorizonMonths),
        ...(maxDrawdownPct != null ? { maxDrawdownPct: String(maxDrawdownPct) } : {}),
        ...(volatilityPreference ? { volatilityPreference } : {}),
      });

      try {
        const res = await fetch(`/api/risk/classify?${qs.toString()}`, { credentials: 'include' });
        if (res.ok) {
          const json = await res.json() as { data?: RiskClassification };
          if (json.data) setResult(json.data);
        }
      } catch {
        // silently ignore — fallback is no classification shown
      }
    }, 400);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    params.targetReturnPct,
    params.investmentHorizonMonths,
    params.maxDrawdownPct,
    params.volatilityPreference,
  ]);

  return result;
};
