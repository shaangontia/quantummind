import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './shared/ui/AppLayout/AppLayout.tsx';
import { RequireAuth } from './shared/ui/RequireAuth/RequireAuth.tsx';
import { RequireAdmin } from './shared/ui/RequireAdmin/RequireAdmin.tsx';
import { LoginPage } from './features/auth/ui/LoginPage/index.ts';
import { RegisterPage } from './features/auth/ui/RegisterPage/index.ts';
import { PortfoliosPage } from './features/portfolios/ui/PortfoliosPage/PortfoliosPage.tsx';
import { PortfolioDashboard } from './features/portfolios/ui/PortfolioDashboard/PortfolioDashboard.tsx';
import { AuditLogPage } from './features/portfolios/ui/AuditLogPage/AuditLogPage.tsx';
import { SignalsPage } from './features/portfolios/ui/SignalsPage/SignalsPage.tsx';
import { AdminOverlapPage } from './features/portfolios/ui/AdminOverlapPage/index.ts';
import { DecisionsPage } from './features/portfolios/ui/DecisionsPage/index.ts';
import { AdminDecisionsPage } from './features/portfolios/ui/AdminDecisionsPage/index.ts';
import { AdminFailedDecisionsPage } from './features/portfolios/ui/AdminFailedDecisionsPage/index.ts';
import { AdminCandidateTracePage } from './features/portfolios/ui/AdminCandidateTracePage/index.ts';
import { AdminReplaySimulatorPage } from './features/portfolios/ui/AdminReplaySimulatorPage/index.ts';
import { PortfolioHealthPage } from './features/portfolios/ui/PortfolioHealthPage/index.ts';
import { AdminPortfolioHealthPage, AdminAtRiskPage, AdminHealthConfigPage } from './features/portfolios/ui/AdminPortfolioHealthPage/index.ts';
import { VirtualReconciliationPage } from './features/portfolios/ui/VirtualReconciliationPage/index.ts';
import {
  AdminVirtualReconciliationPage,
  AdminVirtualMismatchesPage,
  AdminVirtualExecutionQualityPage,
} from './features/portfolios/ui/AdminVirtualReconciliationPage/index.ts';

export const router = createBrowserRouter([
  // ─── Public auth routes ───────────────────────────────────────────────────
  { path: '/login',    element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },

  // ─── Protected app shell ──────────────────────────────────────────────────
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true,                           element: <PortfoliosPage /> },
      { path: 'portfolios/:id',                element: <PortfolioDashboard /> },
      { path: 'portfolios/:id/trades',         element: <AuditLogPage /> },
      { path: 'portfolios/:id/signals',        element: <SignalsPage /> },
      { path: 'portfolios/:id/decisions',       element: <DecisionsPage /> },
      { path: 'portfolios/:id/health',                    element: <PortfolioHealthPage /> },
      { path: 'portfolios/:id/virtual-reconciliation',     element: <VirtualReconciliationPage /> },
      {
        path: 'admin/overlap',
        element: (<RequireAdmin><AdminOverlapPage /></RequireAdmin>),
      },
      {
        path: 'admin/decisions',
        element: (<RequireAdmin><AdminDecisionsPage /></RequireAdmin>),
      },
      {
        path: 'admin/failed-decisions',
        element: (<RequireAdmin><AdminFailedDecisionsPage /></RequireAdmin>),
      },
      {
        path: 'admin/candidate-trace',
        element: (<RequireAdmin><AdminCandidateTracePage /></RequireAdmin>),
      },
      {
        path: 'admin/replay-simulator',
        element: (<RequireAdmin><AdminReplaySimulatorPage /></RequireAdmin>),
      },
      {
        path: 'admin/portfolio-health',
        element: (<RequireAdmin><AdminPortfolioHealthPage /></RequireAdmin>),
      },
      {
        path: 'admin/portfolio-health/at-risk',
        element: (<RequireAdmin><AdminAtRiskPage /></RequireAdmin>),
      },
      {
        path: 'admin/portfolio-health/config',
        element: (<RequireAdmin><AdminHealthConfigPage /></RequireAdmin>),
      },
      {
        path: 'admin/virtual-reconciliation',
        element: (<RequireAdmin><AdminVirtualReconciliationPage /></RequireAdmin>),
      },
      {
        path: 'admin/virtual-reconciliation/mismatches',
        element: (<RequireAdmin><AdminVirtualMismatchesPage /></RequireAdmin>),
      },
      {
        path: 'admin/virtual-execution-quality',
        element: (<RequireAdmin><AdminVirtualExecutionQualityPage /></RequireAdmin>),
      },
    ],
  },

  // ─── Catch-all ────────────────────────────────────────────────────────────
  { path: '*', element: <Navigate to="/" replace /> },
]);
