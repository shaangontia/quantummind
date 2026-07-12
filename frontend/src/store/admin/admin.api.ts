/**
 * Admin Decision Replay API — Phase 20.
 * All endpoints require CRON_SECRET — handled server-side via cookie/header.
 * These hooks are only used within RequireAdmin-gated pages.
 */
import { baseApi } from '../api/baseApi.ts';
import type { DecisionType } from '../portfolios/portfolios.api.ts';

// ─── Admin Decision List ──────────────────────────────────────────────────────

export interface AdminDecisionEvent {
  decisionId: string;
  portfolioId: number;
  symbol: string;
  decision: DecisionType;
  title: string;
  decisionTime: string;
}

export interface AdminDecisionsParams {
  portfolioId?: number;
  symbol?: string;
  decision_type?: DecisionType;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

// ─── Admin Decision Replay (full trace) ──────────────────────────────────────

export interface FeatureSnapshot {
  rsiValue: number | null;
  volumeRatio: number | null;
  macdHistogram: number | null;
  emaAbove50d: boolean | null;
  fundamentalScore: number | null;
  mlWinProbability: number | null;
  regimeLabel: string | null;
  strategyType: string | null;
}

export interface ModelTraceEntry {
  component: string;
  score: number;
  weight: number;
  contribution: number;
  detail: string | null;
}

export interface RuleTraceEntry {
  rule: string;
  passed: boolean;
  value: string | null;
  threshold: string | null;
}

export interface AdminDecisionReplay {
  decisionId: string;
  // User-visible explanation block
  userExplanation: {
    title: string;
    summary: string;
    reasonCodes: Array<{ code: string; label: string; detail?: string }>;
    portfolioContext: {
      navAtDecision: number | null;
      cashPct: number | null;
      openPositions: number | null;
      regimeLabel: string | null;
      policyType: string | null;
    };
    tradeResult: {
      tradeId: number | null;
      quantity: number | null;
      price: number | null;
      amount: number | null;
    } | null;
  };
  // Full admin trace
  adminTrace: {
    featureSnapshot: FeatureSnapshot;
    modelTrace: ModelTraceEntry[];
    ruleTrace: RuleTraceEntry[];
    riskTrace: RuleTraceEntry[];
    llmTrace: {
      geminiVerdict: string | null;
      geminiConfidence: number | null;
      geminiRiskLevel: string | null;
      geminiRedFlags: string[];
      groqSentimentScore: number | null;
    };
    executionTrace: {
      signalScore: number | null;
      utilityScore: number | null;
      finalDecision: DecisionType;
      executedAt: string | null;
      rejectedBy: string | null;
    };
  };
}

// ─── Failed Decisions ─────────────────────────────────────────────────────────

export interface FailedDecisionSummary {
  totalFailed: number;
  vetoCount: number;
  skipCount: number;
  topReasons: Array<{ reasonCode: string; label: string; count: number; pct: number }>;
  recentDecisions: AdminDecisionEvent[];
}

// ─── Candidate Trace ──────────────────────────────────────────────────────────

export interface CandidateTraceEntry {
  candidateId: number;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  strategyType: string | null;
  signalScore: number | null;
  utilityScore: number | null;
  actionTaken: 'EXECUTED' | 'SKIPPED' | 'VETOED' | 'WEAK';
  filtersBlocked: string[];
  filtersPassed: string[];
  mlWinProbability: number | null;
  fundamentalScore: number | null;
}

export interface CandidateTraceResponse {
  portfolioId: number;
  date: string;
  totalCandidates: number;
  candidates: CandidateTraceEntry[];
}

// ─── Replay Simulator ─────────────────────────────────────────────────────────

export interface SimulateReplayPayload {
  policyVersion?: string;
  modelVersion?: string;
}

export interface SimulateReplayResult {
  decisionId: string;
  originalDecision: DecisionType;
  simulatedDecision: DecisionType;
  changed: boolean;
  simulatedScore: number | null;
  simulatedReasonCodes: Array<{ code: string; label: string }>;
  policyVersion: string | null;
  modelVersion: string | null;
  simulatedAt: string;
}

// ─── Phase 21: Admin Health types ───────────────────────────────────────────────────

import type { HealthGrade } from '../portfolios/portfolios.api.ts';

export interface HealthDistribution {
  EXCELLENT: number;
  GOOD: number;
  WARNING: number;
  CRITICAL: number;
}

export interface AdminHealthOverview {
  totalPortfolios: number;
  healthDistribution: HealthDistribution;
  averageHealthScore: number;
  topRiskReasons: string[];
}

export interface AtRiskPortfolio {
  portfolioId: number;
  portfolioName: string;
  healthScore: number;
  healthGrade: HealthGrade;
  goalProbabilityPct: number | null;
  topRisks: string[];
  lastUpdated: string;
}

export interface HealthConfigVersion {
  id: number;
  configVersion: string;
  isActive: boolean;
  weightsJson: string;
  thresholdsJson: string;
  goalProbabilityAssumptionsJson: string;
  createdAt: string;
}

export interface CreateHealthConfigPayload {
  weights_json: string;
  thresholds_json: string;
  goal_probability_assumptions_json: string;
}

// ─── RTK Query Endpoints ──────────────────────────────────────────────────────

export const adminApi = baseApi.injectEndpoints({
  endpoints: builder => ({

    getAdminDecisions: builder.query<AdminDecisionEvent[], AdminDecisionsParams>({
      query: (params) => ({
        url: '/admin/decisions',
        params,
        method: 'GET',
      }),
      keepUnusedDataFor: 60,
    }),

    getAdminDecisionReplay: builder.query<AdminDecisionReplay, string>({
      query: (decisionId) => ({
        url: `/admin/decisions/${decisionId}/replay`,
        method: 'GET',
      }),
      keepUnusedDataFor: 300,
    }),

    getAdminFailedDecisions: builder.query<FailedDecisionSummary, { limit?: number }>({
      query: ({ limit = 100 } = {}) => ({
        url: '/admin/decisions/failed',
        params: { limit },
        method: 'GET',
      }),
      keepUnusedDataFor: 60,
    }),

    getAdminCandidateTrace: builder.query<CandidateTraceResponse, { portfolioId: number; date?: string }>({
      query: ({ portfolioId, date }) => ({
        url: `/admin/candidates/${portfolioId}/trace`,
        params: date ? { date } : undefined,
        method: 'GET',
      }),
      keepUnusedDataFor: 120,
    }),

    // ─── Phase 21: Admin Health endpoints ──────────────────────────────────────────────

    getAdminHealthOverview: builder.query<AdminHealthOverview, void>({
      query: () => ({ url: '/admin/portfolio-health/overview', method: 'GET' }),
      keepUnusedDataFor: 120,
    }),

    getAdminAtRiskPortfolios: builder.query<AtRiskPortfolio[], void>({
      query: () => ({ url: '/admin/portfolio-health/at-risk', method: 'GET' }),
      keepUnusedDataFor: 60,
    }),

    getAdminHealthConfigs: builder.query<HealthConfigVersion[], void>({
      query: () => ({ url: '/admin/portfolio-health/config', method: 'GET' }),
      keepUnusedDataFor: 300,
      providesTags: ['HealthConfig'],
    }),

    createAdminHealthConfig: builder.mutation<HealthConfigVersion, CreateHealthConfigPayload>({
      query: body => ({ url: '/admin/portfolio-health/config', method: 'POST', body }),
      invalidatesTags: ['HealthConfig'],
    }),

    recalculatePortfolioHealth: builder.mutation<{ success: boolean }, { portfolioId: number }>({
      query: body => ({ url: '/admin/portfolio-health/recalculate', method: 'POST', body }),
    }),

    recalculateAllHealth: builder.mutation<{ accepted: boolean }, void>({
      query: () => ({ url: '/admin/portfolio-health/recalculate-all', method: 'POST' }),
    }),

    simulateDecisionReplay: builder.mutation<SimulateReplayResult, { decisionId: string; body: SimulateReplayPayload }>({
      query: ({ decisionId, body }) => ({
        url: `/admin/decisions/${decisionId}/replay/simulate`,
        method: 'POST',
        body,
      }),
    }),

  }),
  overrideExisting: false,
});

export const {
  useGetAdminDecisionsQuery,
  useGetAdminDecisionReplayQuery,
  useGetAdminFailedDecisionsQuery,
  useGetAdminCandidateTraceQuery,
  useSimulateDecisionReplayMutation,
  useGetAdminHealthOverviewQuery,
  useGetAdminAtRiskPortfoliosQuery,
  useGetAdminHealthConfigsQuery,
  useCreateAdminHealthConfigMutation,
  useRecalculatePortfolioHealthMutation,
  useRecalculateAllHealthMutation,
} = adminApi;
