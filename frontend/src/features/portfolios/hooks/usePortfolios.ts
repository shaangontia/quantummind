import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { Portfolio } from '../../../api/portfolio.api.types.ts';

export const PORTFOLIOS_KEY = ['portfolios'] as const;

export const usePortfolios = () => {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<Portfolio[], Error>({
    queryKey: PORTFOLIOS_KEY,
    queryFn: () => portfolioApi.list(),
    staleTime: 30_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: PORTFOLIOS_KEY });

  return {
    portfolios: data ?? [],
    isLoading,
    error: error?.message ?? null,
    refresh,
  };
};
