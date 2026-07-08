import { useQuery } from '@tanstack/react-query';
import { newsApi } from '../../../api/news.api.ts';
import type { NewsItem } from '../../../api/news.api.types.ts';

export const NEWS_KEY = ['news'] as const;
export const NEWS_HIGH_SIGNAL_KEY = ['news-high-signal'] as const;

export const useNewsFeed = (highSignalOnly = false) => {
  const { data, isLoading, error } = useQuery<NewsItem[], Error>({
    queryKey: highSignalOnly ? NEWS_HIGH_SIGNAL_KEY : NEWS_KEY,
    queryFn: () => highSignalOnly ? newsApi.highSignal() : newsApi.all(),
    staleTime: 5 * 60_000,       // news stays fresh 5 min — matches backend cache
    refetchInterval: 5 * 60_000, // background poll every 5 min
  });

  return {
    items: data ?? [],
    isLoading,
    error: error?.message ?? null,
  };
};
