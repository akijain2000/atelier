import { useEffect, useState } from 'react';
import { useNavigate, Outlet, NavLink } from 'react-router-dom';
import { apiFetch, clearToken } from '../lib/auth.js';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => setUser(d))
      .catch(() => navigate('/login'));
  }, [navigate]);

  function handleLogout() {
    apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearToken();
    navigate('/login');
  }

  if (!user) return <div className="dash-empty">Loading...</div>;

  return (
    <div className="dash-frame">
      <nav className="dash-sidebar">
        <div className="dash-brand">
          <span className="brand-badge">A</span>
          <div>
            <span className="brand-title">Atelier</span>
            <p className="dash-role">{user.email}</p>
          </div>
        </div>

        <div className="dash-nav-links">
          <NavLink to="/" end className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`}>
            Attention Queue
          </NavLink>
          <NavLink to="/filtered" className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`}>
            Filtered Leads
          </NavLink>
          <NavLink to="/all" className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`}>
            All Conversations
          </NavLink>
        </div>

        <button className="dash-logout" onClick={handleLogout}>Log out</button>
      </nav>

      <main className="dash-main">
        <Outlet />
      </main>
    </div>
  );
}
