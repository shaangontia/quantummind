import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './shared/ui/AppLayout/AppLayout.tsx';
import { PortfoliosPage } from './features/portfolios/ui/PortfoliosPage/PortfoliosPage.tsx';
import { PortfolioDashboard } from './features/portfolios/ui/PortfolioDashboard/PortfolioDashboard.tsx';
import { AuditLogPage } from './features/portfolios/ui/AuditLogPage/AuditLogPage.tsx';
import { SignalsPage } from './features/portfolios/ui/SignalsPage/SignalsPage.tsx';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <PortfoliosPage /> },
      { path: 'portfolios/:id', element: <PortfolioDashboard /> },
      { path: 'portfolios/:id/trades', element: <AuditLogPage /> },
      { path: 'portfolios/:id/signals', element: <SignalsPage /> },
    ],
  },
]);
