/**
 * Supabase auth + REST helpers for the MCP server.
 * Authenticates fresh on each server startup; token is reused for the session.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.STAYPORTAL_EMAIL;
const PASSWORD = process.env.STAYPORTAL_PASSWORD;

if (!SUPABASE_URL || !ANON_KEY || !EMAIL || !PASSWORD) {
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'STAYPORTAL_EMAIL', 'STAYPORTAL_PASSWORD']
    .filter((k) => !process.env[k]);
  process.stderr.write(`[supabase] Missing required env vars: ${missing.join(', ')}\n`);
}

let _accessToken = null;

function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, module: 'supabase', msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export async function authenticate() {
  log('info', 'Authenticating with Supabase', { email: EMAIL });
  const t0 = Date.now();

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!res.ok) {
    const err = await res.text();
    log('error', 'Supabase auth failed', { status: res.status, body: err });
    throw new Error(`Supabase auth failed: ${err}`);
  }

  const data = await res.json();
  _accessToken = data.access_token;
  log('info', 'Supabase auth successful', { ms: Date.now() - t0, expires_in: data.expires_in });
  return data;
}

function headers() {
  if (!_accessToken) throw new Error('Not authenticated. Call authenticate() first.');
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${_accessToken}`,
    'Content-Type': 'application/json',
  };
}

export async function query(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  log('debug', 'Supabase query', { table, params });
  const t0 = Date.now();

  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    const err = await res.text();
    log('error', 'Supabase query failed', { table, status: res.status, body: err });
    throw new Error(`Supabase query failed (${table}): ${err}`);
  }

  const data = await res.json();
  const rows = Array.isArray(data) ? data : [data];
  log('debug', 'Supabase query done', { table, rows: rows.length, ms: Date.now() - t0 });
  return rows;
}

export async function ensureAuth() {
  if (!_accessToken) {
    log('info', 'No active token — triggering authenticate()');
    await authenticate();
  } else {
    log('debug', 'Auth token already present, skipping re-auth');
  }
}
