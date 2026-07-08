import { createApi } from '@reduxjs/toolkit/query/react';
import { zodBaseQuery } from './zodBaseQuery.ts';

export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: zodBaseQuery,
  tagTypes: ['Portfolio', 'PortfolioSummary', 'PortfolioEditState', 'Performance', 'Holdings', 'Signals', 'Benchmark'],
  endpoints: () => ({}),
});
