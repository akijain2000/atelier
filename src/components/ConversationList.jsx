function getScoreBadge(convo) {
  const score = convo.latest_score;
  const status = convo.status;

  if (score != null && convo.latest_scoring_status === 'complete') {
    if (score >= 70) return { className: 'ready', label: 'HIGH', showScore: true };
    if (score >= 50) return { className: 'warning-amber', label: 'MEDIUM', showScore: true };
    return { className: 'warning', label: 'LOW', showScore: true };
  }

  if (convo.latest_scoring_status === 'pending') {
    return { className: 'neutral', label: 'SCORING…', showScore: false };
  }

  if (status === 'requires_attention') {
    return { className: 'warning', label: 'ATTENTION', showScore: false };
  }

  return { className: 'ready', label: 'AI MANAGED', showScore: false };
}

export default function ConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
}) {
  return (
    <aside className="conversation-sidebar">
      <div className="conversation-sidebar-header">
        <h3>Conversations</h3>
        <span className="status-pill small neutral">
          ACTIVE ({conversations.filter((c) => c.status !== 'closed').length})
        </span>
      </div>

      <button className="new-conversation-btn" type="button" onClick={onCreate}>
        + New Conversation
      </button>

      <div className="conversation-list">
        {conversations.map((convo) => {
          const isActive = convo.id === activeId;
          const badge = getScoreBadge(convo);

          return (
            <button
              key={convo.id}
              type="button"
              className={`conversation-card ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(convo.id)}
            >
              <div className="conversation-card-header">
                <span className="conversation-name">
                  {convo.tenant_name || 'New inquiry'}
                </span>
                <span className="conversation-time">
                  {new Date(convo.updated_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="conversation-card-badges">
                <span className={`status-pill small ${badge.className}`}>{badge.label}</span>
                {badge.showScore && (
                  <span className={`conversation-score score-tier-${convo.latest_score >= 70 ? 'high' : convo.latest_score >= 50 ? 'medium' : 'low'}`}>
                    {convo.latest_score}
                  </span>
                )}
              </div>
              {convo.preview && (
                <p className="conversation-preview">{convo.preview}</p>
              )}
            </button>
          );
        })}

        {!conversations.length && (
          <div className="conversation-empty">
            <p>No conversations yet. Create one to get started.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
