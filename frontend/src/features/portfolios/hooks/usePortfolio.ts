import { useQuery } from '@tanstack/react-query';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { Portfolio } from '../../../api/portfolio.api.types.ts';

export const portfolioKey = (id: number) => ['portfolios', id] as const;

/** Fetches the full Portfolio record (all strategy fields) for a single portfolio. */
export const usePortfolio = (id: number) => {
  const { data, isLoading, error } = useQuery<Portfolio[], Error>({
    queryKey: ['portfolios'],
    queryFn: () => portfolioApi.list(),
    staleTime: 30_000,
  });

  const portfolio = data?.find(p => p.id === id) ?? null;

  return { portfolio, isLoading, error: error?.message ?? null };
};
