import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { TarsChat } from '../TarsChat/TarsChat.tsx';
import { useGetCurrentUserQuery, useLogoutMutation } from '../../../store/auth/index.ts';
import { isNSEMarketOpen } from '../../../features/portfolios/model/portfolios.marketHours.ts';
import './AppLayout.css';

export const AppLayout = () => {
  const navigate = useNavigate();
  const { data: user } = useGetCurrentUserQuery();
  const [logout] = useLogoutMutation();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const marketOpen = isNSEMarketOpen();

  return (
    <div className="app-layout">
      <header className="app-header">
        <button className="app-logo" onClick={() => navigate('/')}>
          <span className="logo-icon">⛛</span>
          <span className="logo-text">QuantumMind</span>
          <span className="logo-badge">AI TRADER</span>
        </button>
        <nav className="app-nav">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Portfolios
          </NavLink>
        </nav>
        <div className="app-header-right">
          <span
            className="status-dot"
            style={{ background: marketOpen ? 'var(--accent-green)' : 'var(--text-muted)' }}
            title={marketOpen ? 'NSE market open' : 'NSE market closed'}
          />
          <span className="status-text" style={{ color: marketOpen ? 'var(--accent-green)' : 'var(--text-muted)' }}>
            {marketOpen ? 'Market Open' : 'Market Closed'}
          </span>
          {user && (
            <>
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name ?? user.email}
                  className="user-avatar"
                  title={user.name ?? user.email}
                />
              ) : null}
              <span className="user-email" title={user.email}>
                {user.name ?? user.email}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void handleLogout()}
                title="Sign out"
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <TarsChat />
    </div>
  );
};
