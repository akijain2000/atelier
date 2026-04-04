import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/auth.js';
import ConfirmDialog from './ConfirmDialog.jsx';

export default function FilteredLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [overriding, setOverriding] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { loadLeads(); }, []);

  async function loadLeads() {
    try {
      const res = await apiFetch('/api/conversations');
      if (!res.ok) { setFetchError(true); return; }
      const data = await res.json();
      const filtered = (Array.isArray(data) ? data : [])
        .filter((c) => c.flow_state === 'filtered')
        .sort((a, b) => (b.preliminary_score ?? 0) - (a.preliminary_score ?? 0));
      setLeads(filtered);
      setFetchError(false);
    } catch { setFetchError(true); } finally {
      setLoading(false);
    }
  }

  async function handleOverride(id) {
    setOverriding(id);
    try {
      const res = await apiFetch(`/api/leads/${id}/override`, { method: 'POST' });
      if (res.ok) await loadLeads();
    } catch {} finally {
      setOverriding(null);
    }
  }

  function groupByMonth(items) {
    const groups = {};
    for (const item of items) {
      const d = new Date(item.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
      if (!groups[key]) groups[key] = { label, items: [] };
      groups[key].items.push(item);
    }
    return Object.values(groups).sort((a, b) => b.label.localeCompare(a.label));
  }

  if (loading) return <div className="dash-empty">Loading...</div>;
  if (fetchError) return <div className="dash-empty">Failed to load. <button className="override-btn" onClick={loadLeads}>Retry</button></div>;

  if (!leads.length) return (
    <div className="lead-list">
      <h2 className="dash-heading">Filtered Leads</h2>
      <div className="empty-state">
        <span className="empty-state-icon">📋</span>
        <p className="empty-state-text">No filtered leads. All incoming leads passed the scoring threshold.</p>
      </div>
    </div>
  );

  const groups = groupByMonth(leads);

  return (
    <div className="lead-list">
      <ConfirmDialog
        open={confirmTarget !== null}
        title="Push to pipeline?"
        message="This lead will be moved into the active pipeline for follow-up."
        confirmLabel="Push to Pipeline"
        variant="default"
        onConfirm={() => { const id = confirmTarget; setConfirmTarget(null); handleOverride(id); }}
        onCancel={() => setConfirmTarget(null)}
      />

      <h2 className="dash-heading">Filtered Leads</h2>
      <p className="dash-subheading">{leads.length} lead{leads.length !== 1 ? 's' : ''} below scoring threshold</p>

      {groups.map((group) => (
        <div key={group.label} className="filtered-month-group">
          <h3 className="filtered-month-label">{group.label}</h3>

          <div className="lead-table">
            <div className="lead-row lead-header">
              <span>Tenant</span>
              <span>Score</span>
              <span>Status</span>
              <span>Move-in</span>
              <span>Intro</span>
              <span></span>
            </div>

            {group.items.map((lead) => (
              <div key={lead.id} className="lead-row" role="button" tabIndex={0} onClick={() => navigate(`/conversation/${lead.id}`)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/conversation/${lead.id}`); }}>
                <span className="lead-name">{lead.tenant_name || 'Unknown'}</span>
                <span className="lead-score">{lead.preliminary_score ?? '—'}</span>
                <span>{lead.tenant_status || '—'}</span>
                <span>{lead.move_in_date || '—'}</span>
                <span className="lead-intro">{(lead.intro || '').slice(0, 60)}{lead.intro?.length > 60 ? '...' : ''}</span>
                <span>
                  <button
                    className="override-btn"
                    onClick={(e) => { e.stopPropagation(); setConfirmTarget(lead.id); }}
                    disabled={overriding === lead.id}
                  >
                    {overriding === lead.id ? 'Sending...' : 'Push to Pipeline'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
