import { DELIVERY_STATUS } from './types.js';

const PLING_API_URL = 'https://secure.pling.as/gw/rs/sendSms';

function normalizeE164(phone) {
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (!cleaned.startsWith('+')) {
    if (/^47\d{8}$/.test(cleaned)) {
      cleaned = '+' + cleaned;
    } else {
      cleaned = '+47' + cleaned;
    }
  }
  return cleaned;
}

function isGsm0338(text) {
  return /^[\x20-\x7E\n\r@£$¥èéùìòÇØøÅåÆæßÉ ÄÖÑÜäöñüà€]*$/.test(text);
}

function segmentCount(text) {
  const gsm = isGsm0338(text);
  const len = text.length;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

export async function sendSMS(to, body, opts = {}) {
  const serviceId = process.env.PLING_SERVICE_ID;
  const username = process.env.PLING_USERNAME;
  const password = process.env.PLING_PASSWORD;

  if (!serviceId || !username || !password) {
    throw new Error('Pling SMS credentials not configured (PLING_SERVICE_ID, PLING_USERNAME, PLING_PASSWORD).');
  }

  const phoneno = normalizeE164(to);
  const useUnicode = !isGsm0338(body);
  const segments = segmentCount(body);

  const payload = {
    serviceid: serviceId,
    phoneno,
    txt: body,
  };
  if (useUnicode) payload.unicode = true;

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const response = await fetch(PLING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      success: false,
      status: DELIVERY_STATUS.FAILED,
      externalId: null,
      segments,
      error: result?.description || result?.error || `HTTP ${response.status}`,
    };
  }

  return {
    success: true,
    status: DELIVERY_STATUS.SENT,
    externalId: String(result?.messageid || result?.id || ''),
    segments,
    error: null,
  };
}

export function parseInbound(body) {
  const rawPhone = body?.phoneno || body?.from || '';
  return {
    from: rawPhone ? normalizeE164(rawPhone) : '',
    text: String(body?.txt || body?.text || body?.message || ''),
    externalId: String(body?.messageid || body?.id || ''),
    raw: body,
  };
}

export { normalizeE164, segmentCount };
