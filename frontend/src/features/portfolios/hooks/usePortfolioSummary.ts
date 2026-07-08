import { useGetPortfolioSummaryQuery } from '../../../store/portfolios/index.ts';

/** Kept for backward compat — summaryKey no longer needed externally (use RTK tag invalidation) */
export const summaryKey = (id: number) => ['portfolio-summary', id] as const;

export const usePortfolioSummary = (id: number) => {
  const { data, isLoading, error, refetch, fulfilledTimeStamp } = useGetPortfolioSummaryQuery(id, {
    pollingInterval: 30_000,
  });

  const lastFetchedAt = fulfilledTimeStamp ? new Date(fulfilledTimeStamp) : null;

  return {
    summary: data ?? null,
    isLoading,
    error: error ? ('error' in error ? String(error.error) : 'Failed to load summary') : null,
    refresh: refetch,
    lastFetchedAt,
  };
};
