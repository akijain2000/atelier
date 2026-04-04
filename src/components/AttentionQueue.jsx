import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/auth.js';
import FlowBadge from './FlowBadge.jsx';

const ATTENTION_STATES = [
  'pending_compose', 'first_message_sent', 'has_questions',
  'wants_to_rent', 'soft_commitment', 'confirmed',
  'wants_physical', 'manual_intervention',
];

export default function AttentionQueue() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const navigate = useNavigate();
  const hasData = useRef(false);

  useEffect(() => {
    loadLeads();
    const interval = setInterval(loadLeads, 15000);
    return () => clearInterval(interval);
  }, []);

  async function loadLeads() {
    try {
      const res = await apiFetch('/api/conversations');
      if (!res.ok) { if (hasData.current) { setStale(true); } return; }
      const data = await res.json();
      const filtered = (Array.isArray(data) ? data : [])
        .filter((c) => ATTENTION_STATES.includes(c.flow_state))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      setLeads(filtered);
      setStale(false);
      setLastUpdated(new Date());
      hasData.current = true;
    } catch {
      if (hasData.current) setStale(true);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="dash-empty">Loading...</div>;
  if (!hasData.current && leads.length === 0) return <div className="dash-empty">Failed to load. <button className="override-btn" onClick={loadLeads}>Retry</button></div>;

  if (!leads.length) return (
    <div className="lead-list">
      <h2 className="dash-heading">Attention Queue</h2>
      <div className="empty-state">
        <span className="empty-state-icon">✅</span>
        <p className="empty-state-text">No leads need attention right now. All caught up!</p>
      </div>
    </div>
  );

  return (
    <div className="lead-list">
      <h2 className="dash-heading">Attention Queue</h2>
      <p className="dash-subheading">
        {leads.length} lead{leads.length !== 1 ? 's' : ''} need attention
        {lastUpdated && <span style={{ marginLeft: 12, opacity: 0.7 }}>· updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        {stale && <span className="stale-indicator" style={{ marginLeft: 12 }}>Connection issue</span>}
      </p>

      <div className="lead-table lead-table-6col">
        <div className="lead-row lead-header">
          <span>Tenant</span>
          <span>Phone</span>
          <span>Status</span>
          <span>Form</span>
          <span>Conv.</span>
          <span>Updated</span>
        </div>

        {leads.map((lead) => (
          <div key={lead.id} className="lead-row" role="button" tabIndex={0} onClick={() => navigate(`/conversation/${lead.id}`)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/conversation/${lead.id}`); }}>
            <span className="lead-name">
              {lead.tenant_name || 'Unknown'}
              {lead.tenant_status && <span className="lead-status-tag">{lead.tenant_status}</span>}
            </span>
            <span className="lead-phone">{lead.phone || '—'}</span>
            <span><FlowBadge state={lead.flow_state} /></span>
            <span className="lead-score">{lead.preliminary_score ?? '—'}</span>
            <span className={`lead-score ${lead.latest_score != null ? (lead.latest_score >= 70 ? 'score-high' : lead.latest_score >= 40 ? 'score-mid' : 'score-low') : ''}`}>{lead.latest_score ?? '—'}</span>
            <span className="lead-time">{timeAgo(lead.updated_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
