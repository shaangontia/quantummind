import { useQuery } from '@tanstack/react-query';
import type { AdaptiveReport } from '../../../api/adaptive.api.types.ts';

export const ADAPTIVE_REPORT_KEY = ['adaptive-report'] as const;

const fetchAdaptiveReport = async (): Promise<AdaptiveReport> => {
  const res = await fetch('/api/adaptive/report');
  const json = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Failed to load adaptive report');
  return json.data as AdaptiveReport;
};

export const useAdaptiveReport = () => {
  const { data, isLoading, error } = useQuery<AdaptiveReport, Error>({
    queryKey: ADAPTIVE_REPORT_KEY,
    queryFn: fetchAdaptiveReport,
    staleTime: 5 * 60_000,       // adaptive weights change slowly
    refetchInterval: 5 * 60_000,
  });

  return {
    report: data ?? null,
    isLoading,
    error: error?.message ?? null,
  };
};
