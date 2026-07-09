import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './shared/ui/AppLayout/AppLayout.tsx';
import { RequireAuth } from './shared/ui/RequireAuth/RequireAuth.tsx';
import { LoginPage } from './features/auth/ui/LoginPage/index.ts';
import { RegisterPage } from './features/auth/ui/RegisterPage/index.ts';
import { PortfoliosPage } from './features/portfolios/ui/PortfoliosPage/PortfoliosPage.tsx';
import { PortfolioDashboard } from './features/portfolios/ui/PortfolioDashboard/PortfolioDashboard.tsx';
import { AuditLogPage } from './features/portfolios/ui/AuditLogPage/AuditLogPage.tsx';
import { SignalsPage } from './features/portfolios/ui/SignalsPage/SignalsPage.tsx';

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
    ],
  },

  // ─── Catch-all ────────────────────────────────────────────────────────────
  { path: '*', element: <Navigate to="/" replace /> },
]);
