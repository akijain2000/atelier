import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Outlet, NavLink } from 'react-router-dom';
import { apiFetch, clearToken } from '../lib/auth.js';
import Toast from '../components/Toast.jsx';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [toast, setToast] = useState({ message: '', type: 'info', visible: false });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();

  const dismissToast = useCallback(() => setToast((t) => ({ ...t, visible: false })), []);

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => setUser(d))
      .catch(() => navigate('/login'));
  }, [navigate]);

  useEffect(() => {
    function onSessionExpired() {
      setToast({ message: 'Session expired. Please log in again.', type: 'error', visible: true });
      setTimeout(() => navigate('/login'), 2000);
    }
    window.addEventListener('atelier:session-expired', onSessionExpired);
    return () => window.removeEventListener('atelier:session-expired', onSessionExpired);
  }, [navigate]);

  function handleLogout() {
    apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearToken();
    navigate('/login');
  }

  if (!user) return <div className="dash-empty">Loading...</div>;

  return (
    <div className="dash-frame">
      <Toast message={toast.message} type={toast.type} visible={toast.visible} onDismiss={dismissToast} />

      <button className="dash-hamburger" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle navigation">
        ☰
      </button>

      <nav className={`dash-sidebar ${sidebarOpen ? 'dash-sidebar-open' : ''}`}>
        <div className="dash-brand">
          <span className="brand-badge">A</span>
          <div>
            <span className="brand-title">Atelier</span>
            <p className="dash-role">{user.email}</p>
          </div>
        </div>

        <div className="dash-nav-links">
          <NavLink to="/" end className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`} onClick={() => setSidebarOpen(false)}>
            Attention Queue
          </NavLink>
          <NavLink to="/filtered" className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`} onClick={() => setSidebarOpen(false)}>
            Filtered Leads
          </NavLink>
          <NavLink to="/all" className={({ isActive }) => `dash-nav-link ${isActive ? 'active' : ''}`} onClick={() => setSidebarOpen(false)}>
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
