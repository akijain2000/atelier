/**
 * Audit logging for PM actions and system events.
 * Writes to the audit_log table in Postgres.
 */

export async function logAudit(db, { actor, action, conversationId = null, details = null }) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor, action, conversation_id, details)
       VALUES ($1, $2, $3, $4)`,
      [actor, action, conversationId, details ? JSON.stringify(details) : null],
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

export const ACTIONS = {
  PM_LOGIN: 'pm_login',
  PM_LOGOUT: 'pm_logout',
  PM_LOGIN_FAILED: 'pm_login_failed',
  PM_REGISTERED: 'pm_registered',
  CONVERSATION_CREATED: 'conversation_created',
  CONVERSATION_DELETED: 'conversation_deleted',
  MESSAGE_SENT: 'message_sent',
  SCORE_TRIGGERED: 'score_triggered',
  LEAD_INGESTED: 'lead_ingested',
  LEAD_FILTERED: 'lead_filtered',
  LEAD_OVERRIDE: 'lead_override',
  PM_TAKEOVER: 'pm_takeover',
  PM_RELEASE: 'pm_release',
  FLOW_STATE_CHANGED: 'flow_state_changed',
  SYSTEM_PROMPT_UPDATED: 'system_prompt_updated',
};
