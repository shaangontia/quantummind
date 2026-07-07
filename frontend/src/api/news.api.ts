import type { ApiResponse } from './portfolio.api.types.ts';
import type { NewsItem } from './news.api.types.ts';

const BASE = '/api';

export const newsApi = {
  all: async (): Promise<NewsItem[]> => {
    const res = await fetch(`${BASE}/news`);
    const json: ApiResponse<NewsItem[]> = await res.json();
    if (!json.success) throw new Error(json.error ?? 'Failed');
    return json.data;
  },
  highSignal: async (): Promise<NewsItem[]> => {
    const res = await fetch(`${BASE}/news/high-signal`);
    const json: ApiResponse<NewsItem[]> = await res.json();
    if (!json.success) throw new Error(json.error ?? 'Failed');
    return json.data;
  },
};
