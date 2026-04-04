import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/auth.js';
import FlowBadge from '../components/FlowBadge.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

export default function ConversationView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [convo, setConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [scoring, setScoring] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', variant: 'default', onConfirm: null });
  const threadRef = useRef(null);

  const closeDialog = useCallback(() => setConfirmDialog((d) => ({ ...d, open: false })), []);

  useEffect(() => { loadConvo(); }, [id]);
  useEffect(() => {
    if (!id) return;
    const interval = setInterval(loadConvo, 8000);
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  async function loadConvo() {
    try {
      const res = await apiFetch(`/api/conversations/${id}`);
      if (!res.ok) { setLoadError(true); return; }
      const data = await res.json();
      setConvo(data);
      setMessages(data.messages || []);
      setLoadError(false);
      setLastUpdated(new Date());
    } catch { setLoadError(true); }
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await apiFetch(`/api/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: draft, role: 'admin' }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to send.');
      }
      setDraft('');
      await loadConvo();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleSmsSend() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await apiFetch('/api/channels/sms/send', {
        method: 'POST',
        body: JSON.stringify({ conversationId: id, text: draft }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'SMS send failed.');
      setDraft('');
      await loadConvo();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function handleTakeover() {
    setConfirmDialog({
      open: true,
      title: 'Take over conversation?',
      message: 'AI will be paused. You will reply directly as PM.',
      variant: 'danger',
      onConfirm: async () => {
        closeDialog();
        try {
          const res = await apiFetch(`/api/conversations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ flow_state: 'pm_takeover' }),
          });
          if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Takeover failed.'); return; }
          await loadConvo();
        } catch (err) { setError(err.message); }
      },
    });
  }

  function handleRelease() {
    setConfirmDialog({
      open: true,
      title: 'Re-enable AI?',
      message: 'AI will resume handling this conversation automatically.',
      variant: 'default',
      onConfirm: async () => {
        closeDialog();
        try {
          const res = await apiFetch(`/api/conversations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ flow_state: 'has_questions' }),
          });
          if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Release failed.'); return; }
          await loadConvo();
        } catch (err) { setError(err.message); }
      },
    });
  }

  async function handleScoreNow() {
    setScoring(true);
    try {
      const res = await apiFetch(`/api/conversations/${id}/score`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Scoring failed.'); return; }
      await loadConvo();
    } catch (err) { setError(err.message); } finally {
      setScoring(false);
    }
  }

  if (loadError) return <div className="dash-empty">Failed to load conversation. <button className="override-btn" onClick={loadConvo}>Retry</button></div>;
  if (!convo) return <div className="dash-empty">Loading conversation...</div>;

  const isPmMode = convo.flow_state === 'pm_takeover' || convo.flow_state === 'manual_intervention';
  const charCount = draft.length;
  const segmentCount = charCount <= 160 ? 1 : Math.ceil(charCount / 153);

  return (
    <div className="convo-view">
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        confirmLabel={confirmDialog.variant === 'danger' ? 'Take Over' : 'Confirm'}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeDialog}
      />

      <button className="convo-back" onClick={() => navigate(-1)}>&larr; Back</button>

      <div className="convo-layout">
        <div className="convo-thread-col">
          {isPmMode && (
            <div className="takeover-banner">
              You are replying as PM. AI is paused.
              <button className="takeover-release" onClick={handleRelease}>Re-enable AI</button>
            </div>
          )}

          {lastUpdated && (
            <div className="stale-indicator" style={{ marginBottom: 8, alignSelf: 'flex-end' }}>
              Updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}

          <div className="convo-thread" ref={threadRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="empty-state-icon">💬</span>
                <p className="empty-state-text">No messages yet. Compose the first message below.</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`msg-bubble msg-${msg.role === 'tenant' ? 'tenant' : 'ai'}`}>
                  <div className="msg-meta">
                    <span className="msg-role">{msg.role === 'tenant' ? 'Tenant' : msg.role === 'admin' ? 'PM' : 'Oline'}</span>
                    {msg.channel === 'sms' && <span className="msg-channel">SMS</span>}
                    {msg.delivery_status && <span className={`msg-delivery msg-delivery-${msg.delivery_status}`}>{msg.delivery_status}</span>}
                    <span className="msg-time">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="msg-text">{msg.content}</div>
                </div>
              ))
            )}
          </div>

          <form className="convo-composer" onSubmit={handleSend}>
            <p className="composer-hint">
              {isPmMode
                ? 'Your message will be sent directly as PM.'
                : 'Messages sent via AI are processed by Oline. SMS goes directly to the tenant\u2019s phone.'}
            </p>
            <textarea
              className="composer-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={isPmMode ? 'Type a message as PM...' : 'Type a message (sent via AI)...'}
              rows={2}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
            />
            <div className="composer-actions">
              <span className="composer-count">{charCount} chars / {segmentCount} SMS segment{segmentCount !== 1 ? 's' : ''}</span>
              {error && <span className="composer-error">{error}</span>}
              <div className="composer-btns">
                <button type="submit" className="composer-btn" disabled={sending || !draft.trim()}>
                  {sending ? 'Sending...' : 'Send via AI'}
                </button>
                {convo.phone && (
                  <button type="button" className="composer-btn composer-btn-sms" onClick={handleSmsSend} disabled={sending || !draft.trim()}>
                    Send SMS
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>

        <div className="convo-sidebar">
          <div className="profile-card">
            <h3 className="profile-heading">Tenant Profile</h3>
            <div className="profile-field"><span className="profile-label">Name</span>{convo.tenant_name || '—'}</div>
            <div className="profile-field"><span className="profile-label">Phone</span>{convo.phone || '—'}</div>
            <div className="profile-field"><span className="profile-label">Email</span>{convo.email || '—'}</div>
            <div className="profile-field"><span className="profile-label">Age</span>{convo.age || '—'}</div>
            <div className="profile-field"><span className="profile-label">Status</span>{convo.tenant_status || '—'}</div>
            {convo.gender && <div className="profile-field"><span className="profile-label">Gender</span>{convo.gender}</div>}
            <div className="profile-field"><span className="profile-label">Move-in</span>{convo.move_in_date || '—'}</div>
            {convo.intro && <div className="profile-intro">{convo.intro}</div>}
          </div>

          <div className="profile-card">
            <h3 className="profile-heading">Flow State</h3>
            <FlowBadge state={convo.flow_state} />
            {convo.preliminary_score != null && (
              <div className="profile-field" style={{ marginTop: 8 }}>
                <span className="profile-label">Form Score</span>{convo.preliminary_score}/100
              </div>
            )}
            {convo.latestScore && (
              <div className="profile-field">
                <span className="profile-label">Conv. Score</span>
                <span className={`score-value score-${convo.latestScore.overall_score >= 70 ? 'high' : convo.latestScore.overall_score >= 40 ? 'mid' : 'low'}`}>
                  {convo.latestScore.overall_score}/100
                </span>
              </div>
            )}
            {convo.latestScore?.conversion_likelihood && (
              <div className="profile-field">
                <span className="profile-label">Likelihood</span>{convo.latestScore.conversion_likelihood}
              </div>
            )}
            {convo.latestScore?.summary && (
              <div className="profile-intro" style={{ marginTop: 4, fontSize: '0.82rem', opacity: 0.85 }}>{convo.latestScore.summary}</div>
            )}

            <button className="override-btn" style={{ marginTop: 12, width: '100%' }} onClick={handleScoreNow} disabled={scoring}>
              {scoring ? 'Scoring...' : 'Score Now'}
            </button>

            {!isPmMode && (
              <button className="takeover-btn" onClick={handleTakeover}>Take Over</button>
            )}
          </div>

          <div className="profile-card">
            <h3 className="profile-heading">Details</h3>
            <div className="profile-field"><span className="profile-label">Source</span>{convo.source || 'web'}</div>
            <div className="profile-field"><span className="profile-label">Messages</span>{convo.message_count || 0}</div>
            <div className="profile-field"><span className="profile-label">Created</span>{new Date(convo.created_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
