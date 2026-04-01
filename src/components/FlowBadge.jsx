const STATE_LABELS = {
  lead_ingested: 'Ingested',
  filtered: 'Filtered',
  pending_compose: 'Pending SMS',
  sending: 'Sending...',
  first_message_sent: 'Awaiting Reply',
  has_questions: 'Has Questions',
  booked_calendly: 'Calendly Booked',
  call_completed: 'Call Done',
  wants_to_rent: 'Wants to Rent',
  soft_commitment: 'Soft Commit',
  confirmed: 'Confirmed',
  unit_held: 'Unit Held',
  credit_check: 'Credit Check',
  contract_sent: 'Contract Sent',
  signed: 'Signed',
  wants_physical: 'Wants Physical',
  manual_intervention: 'Manual Needed',
  pm_takeover: 'PM Takeover',
  lost: 'Lost',
  opted_out: 'Opted Out',
};

const STATE_COLORS = {
  filtered: 'badge-muted',
  pending_compose: 'badge-amber',
  sending: 'badge-amber',
  first_message_sent: 'badge-blue',
  has_questions: 'badge-blue',
  booked_calendly: 'badge-green',
  call_completed: 'badge-green',
  wants_to_rent: 'badge-green',
  soft_commitment: 'badge-green',
  confirmed: 'badge-accent',
  unit_held: 'badge-accent',
  signed: 'badge-accent',
  wants_physical: 'badge-amber',
  manual_intervention: 'badge-red',
  pm_takeover: 'badge-red',
  lost: 'badge-muted',
  opted_out: 'badge-muted',
};

export default function FlowBadge({ state }) {
  const label = STATE_LABELS[state] || state;
  const color = STATE_COLORS[state] || '';
  return <span className={`flow-badge ${color}`}>{label}</span>;
}
