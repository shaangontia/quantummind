import { baseApi } from '../api/baseApi.ts';
import type {
  Portfolio,
  PortfolioSummary,
  PortfolioEditState,
  UpdatePortfolioPayload,
  CreatePortfolioPayload,
  Holding,
  MarketSignal,
  PerformanceSnapshot,
  Trade,
  ApiResponse,
} from '../../api/portfolio.api.types.ts';

// ─── Local types (benchmark + sector) ─────────────────────────────────────────

interface BenchmarkSeriesPoint { date: string; value: number; }
interface BenchmarkChartPoint  { date: string; portfolioValue: number; }

export interface BenchmarkApiData {
  alpha: number | null;
  portfolioReturnPct: number;
  nifty50ReturnPct: number | null;
  nifty500ReturnPct: number | null;
  chart:          BenchmarkChartPoint[];
  nifty50History: BenchmarkSeriesPoint[];
  nifty500History: BenchmarkSeriesPoint[];
}

export interface BenchmarkData {
  alpha: number;
  data: Array<{ date: string; portfolioReturn: number; nifty50Return: number; nifty500Return: number }>;
}

export interface SectorAllocation {
  sector: string;
  value: number;
  pct: number;
  symbols: string[];
}

// ─── Walk-Forward Types ─────────────────────────────────────────

export interface StrategyBreakdown {
  strategyType: string;
  totalTrades: number;
  winRate: number;
  avgReturn: number;
}

export interface WalkForwardWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  winRate: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalTrades: number;
  strategyBreakdown: StrategyBreakdown[];
}

export const portfoliosApi = baseApi.injectEndpoints({
  endpoints: builder => ({

    // ─── List ─────────────────────────────────────────────────────────────────

    getPortfolios: builder.query<Portfolio[], void>({
      query: () => ({ url: '/portfolios', method: 'GET' }),
      providesTags: result =>
        result
          ? [...result.map(p => ({ type: 'Portfolio' as const, id: p.id })), { type: 'Portfolio', id: 'LIST' }]
          : [{ type: 'Portfolio', id: 'LIST' }],
    }),

    // ─── Create ───────────────────────────────────────────────────────────────

    createPortfolio: builder.mutation<Portfolio, CreatePortfolioPayload>({
      query: body => ({ url: '/portfolios', method: 'POST', body }),
      invalidatesTags: [{ type: 'Portfolio', id: 'LIST' }],
    }),

    // ─── Update ───────────────────────────────────────────────────────────────

    updatePortfolio: builder.mutation<Portfolio, { id: number; payload: UpdatePortfolioPayload }>({
      query: ({ id, payload }) => ({ url: `/portfolios/${id}`, method: 'PATCH', body: payload }),
      // Optimistic cache update — no invalidatesTags needed; updateQueryData patches both
      // list and summary caches in-place to avoid triggering LIST refetch on the portfolio page.
      onQueryStarted: async ({ id }, { dispatch, queryFulfilled }) => {
        try {
          const { data: updated } = await queryFulfilled;
          // Patch list cache in-place
          dispatch(portfoliosApi.util.updateQueryData('getPortfolios', undefined, draft => {
            const idx = draft.findIndex(p => p.id === id);
            if (idx !== -1) draft[idx] = updated;
          }));
          // Patch summary cache in-place (only mutable strategy fields)
          dispatch(portfoliosApi.util.updateQueryData('getPortfolioSummary', id, draft => {
            draft.name                   = updated.name;
            draft.targetReturnPct        = updated.target_return_pct;
            draft.riskTolerance          = updated.risk_tolerance;
            draft.investmentHorizonMonths = updated.investment_horizon_months;
          }));
        } catch { /* handled by RTK Query error state */ }
      },
    }),

    // ─── Deactivate ───────────────────────────────────────────────────────────

    deactivatePortfolio: builder.mutation<void, number>({
      query: id => ({ url: `/portfolios/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Portfolio', id: 'LIST' }],
    }),

    // ─── Summary ──────────────────────────────────────────────────────────────

    getPortfolioSummary: builder.query<PortfolioSummary, number>({
      query: id => ({ url: `/portfolios/${id}/summary`, method: 'GET' }),
      providesTags: (_result, _err, id) => [{ type: 'PortfolioSummary', id }],
    }),

    // ─── Edit State ───────────────────────────────────────────────────────────

    getPortfolioEditState: builder.query<PortfolioEditState, number>({
      query: id => ({ url: `/portfolios/${id}/edit-state`, method: 'GET' }),
      providesTags: (_result, _err, id) => [{ type: 'PortfolioEditState', id }],
    }),

    // ─── Performance ──────────────────────────────────────────────────────────

    getPortfolioPerformance: builder.query<PerformanceSnapshot[], { id: number; days?: number }>({
      query: ({ id, days = 30 }) => ({ url: `/portfolios/${id}/performance`, params: { days }, method: 'GET' }),
      providesTags: (_result, _err, { id }) => [{ type: 'Performance', id }],
    }),

    // ─── Holdings ─────────────────────────────────────────────────────────────

    getPortfolioHoldings: builder.query<Holding[], number>({
      query: id => ({ url: `/portfolios/${id}/holdings`, method: 'GET' }),
      providesTags: (_result, _err, id) => [{ type: 'Holdings', id }],
    }),

    // ─── Signals ──────────────────────────────────────────────────────────────

    getPortfolioSignals: builder.query<MarketSignal[], number>({
      query: id => ({ url: `/portfolios/${id}/signals`, method: 'GET' }),
      providesTags: (_result, _err, id) => [{ type: 'Signals', id }],
    }),

    // ─── Trades ───────────────────────────────────────────────────────────────

    getPortfolioTrades: builder.query<ApiResponse<Trade[]>, { id: number; page?: number; limit?: number }>({
      query: ({ id, page = 1, limit = 50 }) => ({
        url: `/portfolios/${id}/trades`,
        params: { page, limit },
        method: 'GET',
        // Trades endpoint returns the full envelope — bypass unwrap
        responseHandler: (res: Response) => res.json(),
      }),
    }),

    // ─── Benchmark ────────────────────────────────────────────────

    getPortfolioBenchmark: builder.query<BenchmarkData, number>({
      query: id => ({ url: `/portfolios/${id}/benchmark`, method: 'GET' }),
      providesTags: (_result, _err, id) => [{ type: 'Benchmark', id }],
      transformResponse: (raw: BenchmarkApiData): BenchmarkData => {
        const portfolioMap = new Map((raw.chart ?? []).map(p => [p.date, p.portfolioValue]));
        const nifty50Map   = new Map((raw.nifty50History  ?? []).map(p => [p.date, p.value]));
        const nifty500Map  = new Map((raw.nifty500History ?? []).map(p => [p.date, p.value]));
        const allDates = [...new Set([
          ...(raw.nifty50History  ?? []).map(p => p.date),
          ...(raw.nifty500History ?? []).map(p => p.date),
        ])].sort();
        return {
          alpha: raw.alpha ?? 0,
          data: allDates.map(date => ({
            date,
            portfolioReturn: (portfolioMap.get(date) ?? 100) - 100,
            nifty50Return:   (nifty50Map.get(date)   ?? 100) - 100,
            nifty500Return:  (nifty500Map.get(date)  ?? 100) - 100,
          })),
        };
      },
    }),

    // ─── Sector Allocation ─────────────────────────────────────────

    getPortfolioSectors: builder.query<SectorAllocation[], number>({
      query: id => ({ url: `/portfolios/${id}/sector-allocation`, method: 'GET' }),
    }),

    // ─── Walk-Forward Results ──────────────────────────────────────

    getWalkForwardResults: builder.query<WalkForwardWindow[], number>({
      query: id => ({ url: `/portfolios/${id}/walk-forward`, method: 'GET' }),
    }),

  }),
  overrideExisting: false,
});

export const {
  useGetPortfoliosQuery,
  useCreatePortfolioMutation,
  useUpdatePortfolioMutation,
  useDeactivatePortfolioMutation,
  useGetPortfolioSummaryQuery,
  useGetPortfolioEditStateQuery,
  useGetPortfolioPerformanceQuery,
  useGetPortfolioHoldingsQuery,
  useGetPortfolioSignalsQuery,
  useGetPortfolioTradesQuery,
  useGetPortfolioBenchmarkQuery,
  useGetPortfolioSectorsQuery,
  useGetWalkForwardResultsQuery,
} = portfoliosApi;
