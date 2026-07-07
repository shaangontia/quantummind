import { useEffect, useState } from 'react';
import type { AdaptiveReport } from '../../../api/adaptive.api.types.ts';

export const useAdaptiveReport = () => {
  const [report, setReport] = useState<AdaptiveReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/adaptive/report');
        const json = await res.json();
        if (json.success) setReport(json.data);
        else setError(json.error ?? 'Failed');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);

  return { report, isLoading, error };
};
