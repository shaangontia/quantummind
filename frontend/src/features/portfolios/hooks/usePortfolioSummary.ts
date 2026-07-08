import { useQuery, useQueryClient } from '@tanstack/react-query';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { PortfolioSummary } from '../../../api/portfolio.api.types.ts';

export const summaryKey = (id: number) => ['portfolio-summary', id] as const;

export const usePortfolioSummary = (id: number) => {
  const qc = useQueryClient();
  const { data, isLoading, error, dataUpdatedAt } = useQuery<PortfolioSummary, Error>({
    queryKey: summaryKey(id),
    queryFn: () => portfolioApi.summary(id),
    staleTime: 30_000,           // fresh for 30s — matches backend cache TTL
    refetchInterval: 30_000,     // auto-poll every 30s
  });

  const refresh = () => qc.invalidateQueries({ queryKey: summaryKey(id) });
  const lastFetchedAt = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  return {
    summary: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh,
    lastFetchedAt,
  };
};
