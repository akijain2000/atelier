import { DELIVERY_STATUS } from './types.js';
import { isGsm0338, segmentCount } from './sms.js';

export async function sendSimulated(to, body, opts = {}) {
  const webhookUrl = process.env.SIMULATOR_WEBHOOK_URL;
  const secret = process.env.SIMULATOR_SECRET;

  if (!webhookUrl) {
    throw new Error('SIMULATOR_WEBHOOK_URL not configured.');
  }

  const segments = segmentCount(body);
  const messageId = `atl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const payload = {
    from: 'Atelier',
    to,
    body,
    conversationId: opts.conversationId || null,
    messageId,
    segments,
    timestamp: new Date().toISOString(),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Simulator-Secret'] = secret;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return {
      success: false,
      status: DELIVERY_STATUS.FAILED,
      externalId: null,
      segments,
      error: `Simulator returned ${response.status}: ${errText}`,
    };
  }

  return {
    success: true,
    status: DELIVERY_STATUS.SENT,
    externalId: messageId,
    segments,
    error: null,
  };
}

export function parseSimulatorInbound(body) {
  return {
    from: body?.from || '',
    text: String(body?.body || body?.text || ''),
    externalId: String(body?.messageId || body?.id || ''),
    conversationId: body?.conversationId || null,
    raw: body,
  };
}
