import { useCallback, useEffect, useState } from 'react';
import { newsApi } from '../../../api/news.api.ts';
import type { NewsItem } from '../../../api/news.api.types.ts';

export const useNewsFeed = (highSignalOnly = false) => {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = highSignalOnly ? await newsApi.highSignal() : await newsApi.all();
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load news');
    } finally {
      setIsLoading(false);
    }
  }, [highSignalOnly]);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh every 5 min
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { items, isLoading, error };
};
