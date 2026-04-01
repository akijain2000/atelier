const SUB_SCORE_LABELS = {
  tenant_profile_fit: 'Tenant Profile Fit',
  first_message_quality: 'First Message Quality',
  engagement_quality: 'Engagement Quality',
  conversion_intent: 'Conversion Intent',
  stay_duration_fit: 'Stay Duration Fit',
  budget_signals: 'Budget Signals',
};

function SubScoreRow({ label, score, reason }) {
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : 0;
  const barWidth = `${(safeScore / 5) * 100}%`;
  return (
    <div className="sub-score-row">
      <div className="sub-score-head">
        <span className="sub-score-label">{label}</span>
        <span className="sub-score-value">{safeScore}/5</span>
      </div>
      <div className="sub-score-bar-track">
        <div className="sub-score-bar-fill" style={{ width: barWidth }} />
      </div>
      {reason && <p className="sub-score-reason">{reason}</p>}
    </div>
  );
}

function safeParse(val, fallback) {
  if (typeof val !== 'string') return val || fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default function ScoringSidebar({
  conversationId,
  latestScore,
  onScore,
  isScoring,
}) {
  if (!conversationId) {
    return (
      <aside className="scoring-sidebar">
        <div className="scoring-empty">
          <p>Select a conversation to view scoring</p>
        </div>
      </aside>
    );
  }

  const isPending = isScoring || latestScore?.scoring_status === 'pending';
  const hasScore = latestScore && latestScore.overall_score != null && latestScore.scoring_status === 'complete';

  if (!hasScore) {
    return (
      <aside className="scoring-sidebar">
        <div className="scoring-header">
          <span className="eyebrow">Lead Scoring</span>
          {isPending && <span className="status-pill small scoring-loading">SCORING…</span>}
        </div>
        {!isPending && <h3>Not yet scored</h3>}
        {isPending && (
          <div className="scoring-pending-state">
            <div className="scoring-spinner" />
            <p className="scoring-note">Analyzing conversation…</p>
          </div>
        )}
        {!isPending && (
          <>
            <p className="scoring-note">
              Scoring triggers after 3+ tenant messages, when identifying info is shared,
              or when the conversation has been idle for 10+ minutes.
            </p>
            <button
              type="button"
              className="score-now-btn"
              onClick={onScore}
              disabled={isScoring}
            >
              Score now
            </button>
          </>
        )}
      </aside>
    );
  }

  const score = latestScore;
  const tier =
    score.overall_score >= 70 ? 'high' : score.overall_score >= 50 ? 'medium' : 'low';

  const subScores = safeParse(score.sub_scores, {});
  const redFlags = safeParse(score.red_flags, {});

  return (
    <aside className="scoring-sidebar">
      <div className="scoring-header">
        <span className="eyebrow">Lead Scoring</span>
        <span className={`status-pill small ${tier === 'high' ? 'ready' : tier === 'medium' ? 'warning-amber' : 'warning'}`}>
          {score.conversion_likelihood || 'PENDING'}
        </span>
      </div>

      <div className="score-display">
        <span className={`score-number score-tier-${tier}`}>{score.overall_score}</span>
        <span className="score-max">/ 100</span>
      </div>

      {score.summary && <p className="scoring-summary">{score.summary}</p>}

      <div className="sub-scores-section">
        <span className="eyebrow">Sub-Scores</span>
        {Object.entries(SUB_SCORE_LABELS).map(([key, label]) => {
          const sub = subScores[key];
          if (!sub) return null;
          return (
            <SubScoreRow
              key={key}
              label={label}
              score={sub.score}
              reason={sub.reason}
            />
          );
        })}
      </div>

      {redFlags.score > 0 && Array.isArray(redFlags.flags) && redFlags.flags.length > 0 && (
        <div className="scoring-flags">
          <span className="eyebrow">Red Flags ({redFlags.score}/3)</span>
          {redFlags.flags.map((flag, i) => (
            <span key={i} className="status-pill small warning">{flag}</span>
          ))}
        </div>
      )}

      {score.recommended_action && (
        <div className="scoring-action">
          <span className="eyebrow">Recommended</span>
          <p>{score.recommended_action}</p>
        </div>
      )}

      <button
        type="button"
        className="score-now-btn"
        onClick={onScore}
        disabled={isPending}
      >
        {isPending ? 'Scoring…' : 'Re-score'}
      </button>
    </aside>
  );
}
