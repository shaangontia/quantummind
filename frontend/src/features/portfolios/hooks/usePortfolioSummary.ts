import { useCallback, useEffect, useState } from 'react';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { PortfolioSummary } from '../../../api/portfolio.api.types.ts';

export const usePortfolioSummary = (id: number) => {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await portfolioApi.summary(id);
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load summary');
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh every 60s
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { summary, isLoading, error, refresh: load };
};
