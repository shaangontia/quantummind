import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useGetCurrentUserQuery } from '../../../store/auth/index.ts';
import { Spinner } from '../Spinner/Spinner.tsx';

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Guards all routes that need an authenticated user.
 * - While the /auth/me check is in-flight → shows spinner (avoids flash-of-login-redirect)
 * - 401 / error → redirects to /login
 * - Authenticated → renders children
 */
export const RequireAuth = ({ children }: RequireAuthProps) => {
  const { data: user, isLoading, error } = useGetCurrentUserQuery();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size={40} />
      </div>
    );
  }

  if (error || !user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};
