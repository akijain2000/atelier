import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/auth.js';
import FlowBadge from './FlowBadge.jsx';

export default function AllConversations() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 15000);
    return () => clearInterval(interval);
  }, []);

  async function loadAll() {
    try {
      const res = await apiFetch('/api/conversations');
      if (!res.ok) { setFetchError(true); return; }
      const data = await res.json();
      setConversations(
        (Array.isArray(data) ? data : [])
          .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)),
      );
      setFetchError(false);
    } catch { setFetchError(true); } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="dash-empty">Loading...</div>;
  if (fetchError) return <div className="dash-empty">Failed to load. <button className="override-btn" onClick={loadAll}>Retry</button></div>;
  if (!conversations.length) return <div className="dash-empty">No conversations yet.</div>;

  return (
    <div className="lead-list">
      <h2 className="dash-heading">All Conversations</h2>
      <p className="dash-subheading">{conversations.length} total</p>

      <div className="lead-table lead-table-6col">
        <div className="lead-row lead-header">
          <span>Tenant</span>
          <span>Phone</span>
          <span>Status</span>
          <span>Score</span>
          <span>Messages</span>
          <span>Updated</span>
        </div>

        {conversations.map((c) => (
          <div key={c.id} className="lead-row" role="button" tabIndex={0} onClick={() => navigate(`/conversation/${c.id}`)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/conversation/${c.id}`); }}>
            <span className="lead-name">{c.tenant_name || 'Unknown'}</span>
            <span className="lead-phone">{c.phone || '—'}</span>
            <span><FlowBadge state={c.flow_state} /></span>
            <span className={`lead-score ${c.latest_score != null ? (c.latest_score >= 70 ? 'score-high' : c.latest_score >= 40 ? 'score-mid' : 'score-low') : ''}`}>{c.latest_score ?? c.preliminary_score ?? '—'}</span>
            <span>{c.message_count || 0}</span>
            <span className="lead-time">{c.updated_at ? new Date(c.updated_at).toLocaleDateString() : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
