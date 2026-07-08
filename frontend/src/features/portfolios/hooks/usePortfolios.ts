import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { portfolioApi } from '../../../api/portfolio.api.ts';
import type { Portfolio } from '../../../api/portfolio.api.types.ts';
import { useAppDispatch, useAppSelector } from '../../../store/hooks.ts';
import { setPortfolios, selectPortfolios } from '../../../store/portfolios/index.ts';

export const PORTFOLIOS_KEY = ['portfolios'] as const;

export const usePortfolios = () => {
  const dispatch = useAppDispatch();
  const localPortfolios = useAppSelector(selectPortfolios);

  const { data, isLoading, error, refetch } = useQuery<Portfolio[], Error>({
    queryKey: PORTFOLIOS_KEY,
    queryFn: () => portfolioApi.list(),
    staleTime: 30_000,
  });

  // Sync fetched data into Redux store
  useEffect(() => {
    if (data) dispatch(setPortfolios(data));
  }, [data, dispatch]);

  return {
    // Prefer Redux store (immediately reflects optimistic updates from edit/create)
    portfolios: localPortfolios.length > 0 ? localPortfolios : (data ?? []),
    isLoading,
    error: error?.message ?? null,
    refresh: refetch,
  };
};
