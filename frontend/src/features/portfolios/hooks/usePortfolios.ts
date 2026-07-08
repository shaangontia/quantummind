import { useGetPortfoliosQuery } from '../../../store/portfolios/index.ts';

export const PORTFOLIOS_KEY = ['portfolios'] as const;

/** Wrapper around RTK Query hook — provides portfolios list with loading/error state */
export const usePortfolios = () => {
  const { data, isLoading, error, refetch } = useGetPortfoliosQuery();

  return {
    portfolios: data ?? [],
    isLoading,
    error: error ? ('error' in error ? String(error.error) : 'Failed to load portfolios') : null,
    refresh: refetch,
  };
};
