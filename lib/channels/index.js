import { CHANNELS } from './types.js';
import { sendSMS, parseInbound as parseSmsInbound, normalizeE164 } from './sms.js';
import { sendSimulated, parseSimulatorInbound } from './simulator.js';

function getSmsChannelMode() {
  return (process.env.SMS_CHANNEL_MODE || 'pling').toLowerCase();
}

const adapters = {
  [CHANNELS.SMS]: {
    send: (to, body, opts) => {
      const mode = getSmsChannelMode();
      if (mode === 'pling') return sendSMS(to, body, opts);
      return sendSimulated(to, body, opts);
    },
    parseInbound: (rawBody) => {
      const mode = getSmsChannelMode();
      if (mode === 'pling') return parseSmsInbound(rawBody);
      return parseSimulatorInbound(rawBody);
    },
  },
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
export { getSmsChannelMode };
