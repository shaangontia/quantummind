import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import './AppLayout.css';

export const AppLayout = () => {
  const navigate = useNavigate();

  return (
    <div className="app-layout">
      <header className="app-header">
        <button className="app-logo" onClick={() => navigate('/')}>
          <span className="logo-icon">⚛</span>
          <span className="logo-text">QuantumMind</span>
          <span className="logo-badge">AI TRADER</span>
        </button>
        <nav className="app-nav">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            Portfolios
          </NavLink>
        </nav>
        <div className="app-header-right">
          <span className="status-dot" />
          <span className="status-text">Live</span>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
};
