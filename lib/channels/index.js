import { CHANNELS } from './types.js';
import { sendSMS, parseInbound as parseSmsInbound, normalizeE164 } from './sms.js';

const adapters = {
  [CHANNELS.SMS]: { send: sendSMS, parseInbound: parseSmsInbound },
};

export async function send(channel, to, body, opts = {}) {
  const adapter = adapters[channel];
  if (!adapter) throw new Error(`Unsupported channel: ${channel}`);
  return adapter.send(to, body, opts);
}

export function parseInbound(channel, rawBody) {
  const adapter = adapters[channel];
  if (!adapter?.parseInbound) throw new Error(`No inbound parser for channel: ${channel}`);
  return adapter.parseInbound(rawBody);
}

export { CHANNELS } from './types.js';
export { DELIVERY_STATUS, OPT_OUT_KEYWORDS } from './types.js';
export { normalizeE164 };
