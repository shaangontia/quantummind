import type {
  ApiResponse,
  CreatePortfolioPayload,
  UpdatePortfolioPayload,
  Holding,
  MarketSignal,
  PerformanceSnapshot,
  Portfolio,
  PortfolioSummary,
  Trade,
} from './portfolio.api.types.ts';

const BASE = '/api';

const get = async <T>(url: string): Promise<T> => {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Unknown error');
  return json.data;
};

const post = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Unknown error');
  return json.data;
};

const patch = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(`${BASE}${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Unknown error');
  return json.data;
};

const del = async (url: string): Promise<void> => {
  const res = await fetch(`${BASE}${url}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

export const portfolioApi = {
  list: () => get<Portfolio[]>('/portfolios'),
  create: (payload: CreatePortfolioPayload) => post<Portfolio>('/portfolios', payload),
  summary: (id: number) => get<PortfolioSummary>(`/portfolios/${id}/summary`),
  holdings: (id: number) => get<Holding[]>(`/portfolios/${id}/holdings`),
  trades: (id: number, page = 1, limit = 50) =>
    fetch(`${BASE}/portfolios/${id}/trades?page=${page}&limit=${limit}`)
      .then(r => r.json()) as Promise<ApiResponse<Trade[]>>,
  performance: (id: number, days = 30) =>
    get<PerformanceSnapshot[]>(`/portfolios/${id}/performance?days=${days}`),
  signals: (id: number) => get<MarketSignal[]>(`/portfolios/${id}/signals`),
  update: (id: number, payload: UpdatePortfolioPayload) => patch<Portfolio>(`/portfolios/${id}`, payload),
  deactivate: (id: number) => del(`/portfolios/${id}`),
};
