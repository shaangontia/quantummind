import { useCallback, useEffect, useState } from 'react';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { Portfolio } from '../../../api/portfolio.api.types.ts';

export const usePortfolios = () => {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await portfolioApi.list();
      setPortfolios(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load portfolios');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return { portfolios, isLoading, error, refresh: load };
};
