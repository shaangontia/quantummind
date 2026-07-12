import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useGetCurrentUserQuery } from '../../../store/auth/index.ts';
import { Spinner } from '../Spinner/Spinner.tsx';

interface RequireAdminProps {
  children: ReactNode;
}

/** Guards routes that require admin access. Non-admins are redirected to /. */
export const RequireAdmin = ({ children }: RequireAdminProps) => {
  const { data: user, isLoading } = useGetCurrentUserQuery();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spinner size={40} />
      </div>
    );
  }

  if (!user?.isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};
