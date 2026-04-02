import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  getDefaultPromptVariant,
  getRuntimeConfig,
  listPromptVariants,
  normalizeMessages,
  normalizeProvider,
  readPromptVariant,
  savePromptVariant,
  sendChat,
} from './lib/chatRuntime.js';
import { requireAuth, hashPassword, verifyPassword, signToken, verifyWebhookSignature } from './lib/auth.js';
import { logAudit, ACTIONS } from './lib/auditLog.js';
import { send as channelSend, parseInbound as channelParseInbound, CHANNELS, DELIVERY_STATUS, OPT_OUT_KEYWORDS, normalizeE164, getSmsChannelMode } from './lib/channels/index.js';

const LEAD_SCORE_THRESHOLD = Number(process.env.LEAD_SCORE_THRESHOLD) || 40;
const webhookSecret = process.env.WEBHOOK_SECRET;
const SMS_REPLY_DELAY = (Number(process.env.SMS_REPLY_DELAY_S) || 30) * 1000;
const SMS_REPLY_MAX_WAIT = (Number(process.env.SMS_REPLY_MAX_WAIT_S) || 120) * 1000;
const SMS_SHORT_DEBOUNCE = 10_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);
const distPath = path.join(__dirname, 'dist');
const listingsDir = path.join(__dirname, 'prompts', 'listings');
const promptCache = new Map();

const replyTimers = new Map();

async function initDb() {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS conversations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_name     TEXT,
      property        TEXT,
      unit_hint       TEXT,
      listing_id      TEXT,
      status          TEXT DEFAULT 'ai_managed',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      message_count   INT DEFAULT 0,
      preview         TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      model           TEXT,
      latency_ms      INT,
      metadata        JSONB
    );

    CREATE TABLE IF NOT EXISTS scores (
      id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id          UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      scored_at                TIMESTAMPTZ DEFAULT NOW(),
      overall_score            INT,
      conversion_likelihood    TEXT,
      sub_scores               JSONB,
      red_flags                JSONB,
      recommended_action       TEXT,
      summary                  TEXT,
      message_count_at_scoring INT,
      scoring_status           TEXT DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scores_conversation
      ON scores (conversation_id, scored_at DESC);

    CREATE TABLE IF NOT EXISTS pm_users (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      role            TEXT DEFAULT 'pm',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor           TEXT,
      action          TEXT NOT NULL,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      details         JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created
      ON audit_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_conversation
      ON audit_log (conversation_id) WHERE conversation_id IS NOT NULL;
  `);

  const migrations = [
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS age INT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS move_in_date TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_status TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS intro TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'web'`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS consent_sms BOOLEAN DEFAULT false`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS flow_state TEXT DEFAULT 'lead_ingested'`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS preliminary_score INT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS listing_snapshot JSONB`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auto_reply_paused BOOLEAN DEFAULT false`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'sms'`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web'`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id TEXT`,
    `ALTER TABLE scores ADD COLUMN IF NOT EXISTS score_type TEXT DEFAULT 'conversation'`,
    `DROP INDEX IF EXISTS idx_conversations_phone`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_phone_listing ON conversations (phone, listing_id) WHERE phone IS NOT NULL AND flow_state NOT IN ('lost', 'signed', 'opted_out')`,
  ];
  for (const sql of migrations) {
    await db.query(sql).catch((err) => {
      if (!err.message?.includes('already exists')) {
        console.warn('Migration warning:', err.message);
      }
    });
  }
}

initDb()
  .then(() => {
    app.listen(port, host, () => {
      console.log(`Atelier server listening on http://${host}:${port}`);
    });
  })
  .catch((err) => {
    console.error('Startup init failed:', err);
    process.exit(1);
  });

const corsOriginEnv = process.env.CORS_ORIGIN;
app.use(
  cors({
    origin:
      corsOriginEnv && corsOriginEnv !== '*'
        ? corsOriginEnv.split(',').map((o) => o.trim())
        : true,
    credentials: true,
  }),
);

app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (req.url === '/api/leads/ingest') {
      req.rawBody = buf;
    }
  },
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

// ── Helpers ──

function getHealthPayload() {
  const runtime = getRuntimeConfig();
  return {
    ok: true,
    ...runtime,
    promptVariants: listPromptVariants(__dirname).map(({ absolutePath, ...variant }) => variant),
  };
}

async function loadPromptContent(variantId, provider = null) {
  const runtime = getRuntimeConfig();
  const fallbackProvider = provider || runtime.activeProvider;
  const fallbackVariant = variantId || getDefaultPromptVariant(fallbackProvider);
  const cacheKey = `${fallbackProvider}:${fallbackVariant}`;

  if (promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey);
  }

  const prompt = await readPromptVariant(__dirname, fallbackVariant, fallbackProvider);
  promptCache.set(cacheKey, prompt);
  return prompt;
}

async function persistPromptContent(variantId, provider, content) {
  const runtime = getRuntimeConfig();
  const fallbackProvider = provider || runtime.activeProvider;
  const fallbackVariant = variantId || getDefaultPromptVariant(fallbackProvider);
  const variant = await savePromptVariant(__dirname, fallbackVariant, content, fallbackProvider);
  const cacheEntry = { ...variant, content };
  promptCache.set(`${fallbackProvider}:${variant.id}`, cacheEntry);
  return cacheEntry;
}

async function loadListingData(listingId) {
  if (!listingId || !/^[a-zA-Z0-9_-]+$/.test(listingId)) return null;
  const filePath = path.join(listingsDir, `${listingId}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const fenceMatch = raw.match(/```[\s\S]*?\n([\s\S]*?)```/);
    return fenceMatch ? fenceMatch[1].trim() : raw.trim();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function extractListingMeta(listingText) {
  if (!listingText) return {};
  const meta = {};
  const addressMatch = listingText.match(/Address:\s*(.+)/i);
  if (addressMatch) meta.address = addressMatch[1].trim();
  const titleMatch = listingText.match(/Title:\s*(.+)/i);
  if (titleMatch) meta.title = titleMatch[1].trim();
  const videoMatch = listingText.match(/Video tour:\s*(https?:\/\/\S+)/i);
  if (videoMatch) meta.videoUrl = videoMatch[1].trim();
  return meta;
}

function buildTenantProfile(conversation) {
  const parts = [];
  if (conversation.tenant_name) parts.push(`Name: ${conversation.tenant_name}`);
  if (conversation.age) parts.push(`Age: ${conversation.age}`);
  if (conversation.tenant_status) parts.push(`Status: ${conversation.tenant_status}`);
  if (conversation.gender) parts.push(`Gender: ${conversation.gender}`);
  if (conversation.move_in_date) parts.push(`Move-in: ${conversation.move_in_date}`);
  if (conversation.email) parts.push(`Email: ${conversation.email}`);
  if (conversation.intro) parts.push(`Intro: ${conversation.intro}`);
  return parts.length ? parts.join('\n') : 'No profile data available yet.';
}

async function buildSystemPrompt(listingId, conversation = null) {
  const prompt = await loadPromptContent(null, 'anthropic');

  let listingData = null;
  if (conversation?.listing_snapshot && typeof conversation.listing_snapshot === 'object') {
    const snap = conversation.listing_snapshot;
    if (snap.listing_data) {
      listingData = snap.listing_data;
    }
  }
  if (!listingData) {
    listingData = await loadListingData(listingId);
  }
  if (!listingData) return null;

  let result = prompt.content.replace('{{LISTING_DATA}}', listingData);

  if (conversation) {
    result = result.replace('{{TENANT_PROFILE}}', buildTenantProfile(conversation));
    result = result.replace('{{FLOW_STATE}}', conversation.flow_state || 'first_message_sent');
    result = result.replace('{{CALENDLY_URL}}', CALENDLY_URL);
  } else {
    result = result.replace('{{TENANT_PROFILE}}', 'No profile data available yet.');
    result = result.replace('{{FLOW_STATE}}', 'first_message_sent');
    result = result.replace('{{CALENDLY_URL}}', CALENDLY_URL);
  }

  return result;
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '- ')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2');
}

function truncateSms(text) {
  const maxChars = parseInt(process.env.SMS_MAX_CHARS) || 320;
  if (text.length <= maxChars) return text;

  const lastDot = text.lastIndexOf('.', maxChars - 1);
  const lastQuestion = text.lastIndexOf('?', maxChars - 1);
  const lastExclaim = text.lastIndexOf('!', maxChars - 1);
  const cutPoint = Math.max(lastDot, lastQuestion, lastExclaim);

  let result;
  if (cutPoint > maxChars * 0.5) {
    result = text.slice(0, cutPoint + 1);
  } else {
    result = text.slice(0, maxChars - 3) + '...';
  }
  console.warn('[SMS] Truncation fired: original=%d chars, truncated=%d chars', text.length, result.length);
  return result;
}

function buildChatPayload(chat, promptVariant = null) {
  return {
    message: chat.text,
    responseId: chat.providerResponseId,
    provider: chat.provider,
    model: chat.model,
    promptVariant,
    latencyMs: chat.latencyMs,
    usage: chat.usage,
  };
}

// ── Scoring ──

const scoringPromptPath = path.join(__dirname, 'prompts', 'LeadScoring.md');
const anthropicApiUrl = 'https://api.anthropic.com/v1/messages';
const anthropicApiVersion = '2023-06-01';

const SUB_SCORE_RENAMES = {
  demographic_fit: 'tenant_profile_fit',
  first_impression: 'first_message_quality',
  financial_stability: 'budget_signals',
};

async function loadScoringPrompt() {
  if (promptCache.has('__scoring__')) return promptCache.get('__scoring__');
  const raw = await fs.readFile(scoringPromptPath, 'utf8');
  promptCache.set('__scoring__', raw.trim());
  return raw.trim();
}

function buildTranscript(messages) {
  return messages
    .map((m) => {
      const speaker = m.role === 'assistant' ? 'Oline' : 'Tenant';
      return `${speaker}: "${m.content}"`;
    })
    .join('\n');
}

function renameSubScoreKeys(subScores) {
  if (!subScores || typeof subScores !== 'object') return subScores;
  const renamed = {};
  for (const [key, value] of Object.entries(subScores)) {
    renamed[SUB_SCORE_RENAMES[key] || key] = value;
  }
  return renamed;
}

function parseScoreJson(raw) {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text);
}

async function scoreLead(conversationId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) throw new Error('Missing ANTHROPIC_API_KEY for scoring.');

  const msgs = await db.query(
    'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId],
  );
  if (!msgs.rows.length) throw new Error('No messages to score.');

  const systemPrompt = await loadScoringPrompt();
  const transcript = buildTranscript(msgs.rows);

  const response = await fetch(anthropicApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': anthropicApiVersion,
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_SCORING_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: transcript }],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Anthropic scoring request failed.');
  }

  const rawText =
    payload?.content?.find((b) => b.type === 'text')?.text || '';

  let parsed;
  try {
    parsed = parseScoreJson(rawText);
  } catch {
    const retryResponse = await fetch(anthropicApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': anthropicApiVersion,
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_SCORING_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    if (!retryResponse.ok) {
      throw new Error('Scoring retry request failed.');
    }
    const retryPayload = await retryResponse.json();
    const retryText =
      retryPayload?.content?.find((b) => b.type === 'text')?.text || '';
    parsed = parseScoreJson(retryText);
  }

  if (typeof parsed.overall_score !== 'number' || !parsed.sub_scores) {
    throw new Error('Scoring response missing required fields (overall_score, sub_scores).');
  }

  parsed.overall_score = Math.max(0, Math.min(100, Math.round(parsed.overall_score)));

  if (typeof parsed.sub_scores === 'object' && parsed.sub_scores !== null) {
    for (const [key, val] of Object.entries(parsed.sub_scores)) {
      if (val && typeof val === 'object' && typeof val.score === 'number') {
        val.score = Math.max(1, Math.min(5, Math.round(val.score)));
      }
      if (val && typeof val.reason === 'string') {
        val.reason = val.reason.slice(0, 500);
      }
    }
  }

  if (parsed.summary && typeof parsed.summary === 'string') {
    parsed.summary = parsed.summary.slice(0, 1000);
  }
  if (parsed.recommended_action && typeof parsed.recommended_action === 'string') {
    parsed.recommended_action = parsed.recommended_action.slice(0, 500);
  }

  parsed.sub_scores = renameSubScoreKeys(parsed.sub_scores);
  return parsed;
}

// ── Preliminary Scoring (Form Data) ──

async function scorePreliminary({ name, age, tenantStatus, moveInDate, intro }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) throw new Error('Missing ANTHROPIC_API_KEY for scoring.');

  const profile = [
    name && `Name: ${name}`,
    age && `Age: ${age}`,
    tenantStatus && `Status: ${tenantStatus}`,
    moveInDate && `Move-in date: ${moveInDate}`,
    intro && `Introduction: ${intro}`,
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are a lead scoring model for Stay Management AS, a property management company in Bergen, Norway.

Score this prospective tenant based ONLY on their form submission data. No conversation has happened yet.

Ideal tenant: Age 18-34, university student or young professional, moving to Bergen for studies/work, staying 6 months to 3 years, comfortable with shared furnished apartments.

Score from 0 to 100 where:
- 80-100: Excellent fit, high likelihood
- 60-79: Good fit, worth engaging
- 40-59: Moderate fit, engage with caution
- 20-39: Poor fit, unlikely to convert
- 0-19: Not a fit at all

Output ONLY valid JSON:
{"score": <number 0-100>, "reason": "<one sentence>"}`;

  const response = await fetch(anthropicApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': anthropicApiVersion,
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_SCORING_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: profile }],
    }),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || 'Preliminary scoring failed.');

  const rawText = payload?.content?.find((b) => b.type === 'text')?.text || '';
  try {
    const parsed = parseScoreJson(rawText);
    return { score: Math.max(0, Math.min(100, Math.round(parsed.score))), reason: parsed.reason || '' };
  } catch {
    return { score: 50, reason: 'Could not parse scoring response.' };
  }
}

// ── Milestone Detection ──

const PII_PATTERNS = [
  /\S+@\S+\.\S+/,
  /\b\d{2}\s*(år|years?\s*old)\b/i,
  /(?:jeg heter|my name is|i'm|vi er)\s+\w/i,
];

async function checkScoringMilestones(conversationId, client) {
  const dbClient = client || db;

  const pendingCheck = await dbClient.query(
    "SELECT 1 FROM scores WHERE conversation_id = $1 AND scoring_status = 'pending' LIMIT 1",
    [conversationId],
  );
  if (pendingCheck.rows.length) return false;

  const convo = await dbClient.query(
    'SELECT message_count, updated_at FROM conversations WHERE id = $1',
    [conversationId],
  );
  if (!convo.rows.length) return false;

  const { message_count, updated_at } = convo.rows[0];

  const tenantCount = await dbClient.query(
    "SELECT COUNT(*)::int AS cnt FROM messages WHERE conversation_id = $1 AND role = 'tenant'",
    [conversationId],
  );
  const tenantMsgCount = tenantCount.rows[0].cnt;

  const lastScore = await dbClient.query(
    "SELECT message_count_at_scoring FROM scores WHERE conversation_id = $1 AND scoring_status = 'complete' ORDER BY scored_at DESC LIMIT 1",
    [conversationId],
  );
  const lastScoredAt = lastScore.rows.length ? lastScore.rows[0].message_count_at_scoring : 0;

  if (message_count <= lastScoredAt) return false;

  if (tenantMsgCount >= 3) return true;

  const recentMsgs = await dbClient.query(
    "SELECT content FROM messages WHERE conversation_id = $1 AND role = 'tenant' ORDER BY created_at DESC LIMIT 3",
    [conversationId],
  );
  for (const msg of recentMsgs.rows) {
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(msg.content)) return true;
    }
  }

  const idleMinutes = (Date.now() - new Date(updated_at).getTime()) / 60000;
  if (idleMinutes >= 10 && tenantMsgCount >= 1) return true;

  return false;
}

async function executeScoring(conversationId, scoreId) {
  try {
    const result = await scoreLead(conversationId);

    const redFlags = result.sub_scores?.red_flags || { score: 0, flags: [] };

    await db.query(
      `UPDATE scores SET
        overall_score = $2,
        conversion_likelihood = $3,
        sub_scores = $4,
        red_flags = $5,
        recommended_action = $6,
        summary = $7,
        scoring_status = 'complete',
        scored_at = NOW()
      WHERE id = $1`,
      [
        scoreId,
        result.overall_score,
        result.conversion_likelihood,
        JSON.stringify(result.sub_scores),
        JSON.stringify(redFlags),
        result.recommended_action,
        result.summary,
      ],
    );

    const newStatus =
      result.overall_score >= 50 && (!redFlags.score || redFlags.score === 0)
        ? 'ai_managed'
        : 'requires_attention';

    await db.query('UPDATE conversations SET status = $2 WHERE id = $1', [
      conversationId,
      newStatus,
    ]);
  } catch (err) {
    console.error(`Scoring failed for conversation ${conversationId}:`, err.message);
    await db.query(
      "UPDATE scores SET scoring_status = 'error' WHERE id = $1",
      [scoreId],
    );
  }
}

// ── Auth routes (before other API routes) ──

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    if (process.env.ALLOW_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Registration is disabled.' });
    }
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    const existing = await db.query('SELECT id FROM pm_users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      res.status(409).json({ error: 'User already exists.' });
      return;
    }

    const hash = await hashPassword(password);
    const result = await db.query(
      'INSERT INTO pm_users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role',
      [email.toLowerCase(), hash],
    );

    const user = result.rows[0];
    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    await logAudit(db, { actor: user.email, action: ACTIONS.PM_REGISTERED });

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const result = await db.query(
      'SELECT id, email, password_hash, role FROM pm_users WHERE email = $1',
      [email.toLowerCase()],
    );

    if (!result.rows.length) {
      await logAudit(db, { actor: email, action: ACTIONS.PM_LOGIN_FAILED, details: { reason: 'user_not_found' } });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await logAudit(db, { actor: email, action: ACTIONS.PM_LOGIN_FAILED, details: { reason: 'wrong_password' } });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    await logAudit(db, { actor: user.email, action: ACTIONS.PM_LOGIN });

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await logAudit(db, { actor: req.user.email, action: ACTIONS.PM_LOGOUT });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── Routes ──

app.get('/api/health', (_req, res) => {
  res.json(getHealthPayload());
});

app.get('/api/system-prompt', requireAuth, async (req, res, next) => {
  try {
    const provider = normalizeProvider(req.query.provider) || null;
    const prompt = await loadPromptContent(
      typeof req.query.variant === 'string' ? req.query.variant : null,
      provider,
    );
    const { absolutePath, ...meta } = prompt;
    res.json({ content: prompt.content, variant: prompt.id, promptVariant: prompt.id, meta });
  } catch (error) {
    next(error);
  }
});

app.put('/api/system-prompt', requireAuth, async (req, res, next) => {
  try {
    const { content } = req.body ?? {};
    const provider = normalizeProvider(req.body?.provider) || null;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Expected "content" to be a string.' });
      return;
    }
    const prompt = await persistPromptContent(
      typeof req.body?.variant === 'string' ? req.body.variant : null,
      provider,
      content,
    );
    res.json({ ok: true, variant: prompt.id, promptVariant: prompt.id });
  } catch (error) {
    next(error);
  }
});

// ── Listings ──

app.get('/api/listings', requireAuth, async (_req, res, next) => {
  try {
    const files = await fs.readdir(listingsDir);
    const listings = files
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const id = path.basename(f, '.md');
        const name = id.replace(/_/g, ' ');
        return { id, name, file: f };
      });
    res.json(listings);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json([]);
      return;
    }
    next(error);
  }
});

// ── First Message Templates ──

const CALENDLY_URL = process.env.CALENDLY_URL || 'https://calendly.com/leasing-stay/15min';
const VIDEO_TOUR_URL = process.env.VIDEO_TOUR_URL || '';

async function loadFirstMessageTemplates() {
  if (promptCache.has('__first_msg__')) return promptCache.get('__first_msg__');
  const raw = await fs.readFile(path.join(__dirname, 'prompts', 'templates', 'first_message.json'), 'utf8');
  const templates = JSON.parse(raw);
  promptCache.set('__first_msg__', templates);
  return templates;
}

function detectLanguage(text) {
  if (!text) return 'no';
  const norPatterns = /\b(hei|jeg|er|og|vil|har|fra|til|min|det|kan|som|med|for)\b/i;
  return norPatterns.test(text) ? 'no' : 'en';
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

function resolveVideoUrl(conversation) {
  let videoUrl = VIDEO_TOUR_URL || '';
  if (!videoUrl && conversation.listing_snapshot) {
    const snap = typeof conversation.listing_snapshot === 'string'
      ? JSON.parse(conversation.listing_snapshot) : conversation.listing_snapshot;
    videoUrl = snap.video_url || '';
    if (!videoUrl && snap.listing_data) {
      const meta = extractListingMeta(snap.listing_data);
      videoUrl = meta.videoUrl || '';
    }
  }
  return videoUrl;
}

async function composeFirstMessages(conversation) {
  const templates = await loadFirstMessageTemplates();
  const lang = detectLanguage(conversation.intro);

  const vars = {
    name: conversation.tenant_name || 'der',
    property: conversation.property || 'boligen',
    video_url: resolveVideoUrl(conversation),
    calendly_url: CALENDLY_URL,
  };

  const greeting = fillTemplate(templates[lang] || templates.no, vars);
  const videoTemplate = templates[`video_${lang}`] || templates.video_no;
  const videoMsg = vars.video_url ? fillTemplate(videoTemplate, vars) : null;

  return { greeting, videoMsg };
}

async function sendFirstMessage(conversationId) {
  const convo = await db.query(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId],
  );
  if (!convo.rows.length) throw new Error('Conversation not found.');
  const conv = convo.rows[0];

  if (conv.flow_state !== 'pending_compose') {
    return { skipped: true, reason: `flow_state is ${conv.flow_state}, not pending_compose` };
  }
  if (!conv.phone) return { skipped: true, reason: 'No phone number' };

  const lockResult = await db.query(
    `UPDATE conversations SET flow_state = 'sending', updated_at = NOW() WHERE id = $1 AND flow_state = 'pending_compose' RETURNING id`,
    [conversationId],
  );
  if (!lockResult.rows.length) {
    return { skipped: true, reason: 'Already being processed (concurrent send)' };
  }

  const { greeting, videoMsg } = await composeFirstMessages(conv);

  let greetingResult;
  try {
    greetingResult = await channelSend(CHANNELS.SMS, conv.phone, greeting, { conversationId });
  } catch (sendErr) {
    await db.query(
      `UPDATE conversations SET flow_state = 'pending_compose', updated_at = NOW() WHERE id = $1`,
      [conversationId],
    );
    throw sendErr;
  }

  if (!greetingResult.success) {
    await db.query(
      `UPDATE conversations SET flow_state = 'pending_compose', updated_at = NOW() WHERE id = $1`,
      [conversationId],
    );
    return { sent: false, error: greetingResult.error };
  }

  await db.query(
    `INSERT INTO messages (conversation_id, role, content, channel, delivery_status, external_id)
     VALUES ($1, 'assistant', $2, 'sms', $3, $4)`,
    [conversationId, greeting, greetingResult.status, greetingResult.externalId],
  );
  await db.query(
    `UPDATE conversations SET message_count = message_count + 1, preview = $2, updated_at = NOW() WHERE id = $1`,
    [conversationId, greeting.slice(0, 200)],
  );

  let totalSegments = greetingResult.segments || 1;

  if (videoMsg) {
    try {
      const videoResult = await channelSend(CHANNELS.SMS, conv.phone, videoMsg, { conversationId });
      if (videoResult.success) {
        await db.query(
          `INSERT INTO messages (conversation_id, role, content, channel, delivery_status, external_id)
           VALUES ($1, 'assistant', $2, 'sms', $3, $4)`,
          [conversationId, videoMsg, videoResult.status, videoResult.externalId],
        );
        await db.query(
          `UPDATE conversations SET message_count = message_count + 1, preview = $2, updated_at = NOW() WHERE id = $1`,
          [conversationId, videoMsg.slice(0, 200)],
        );
        totalSegments += videoResult.segments || 1;
      }
    } catch (videoErr) {
      console.error('Video tour follow-up SMS failed:', videoErr.message);
    }
  }

  await db.query(
    `UPDATE conversations SET flow_state = 'first_message_sent', updated_at = NOW() WHERE id = $1`,
    [conversationId],
  );
  await logAudit(db, {
    actor: 'system',
    action: ACTIONS.MESSAGE_SENT,
    conversationId,
    details: { channel: 'sms', type: 'first_message', segments: totalSegments, parts: videoMsg ? 2 : 1 },
  });
  return { sent: true, segments: totalSegments, externalId: greetingResult.externalId };
}

// ── Lead Ingestion (public, HMAC-verified from Google Apps Script) ──

const webhookAuth = verifyWebhookSignature(webhookSecret);

app.post('/api/leads/ingest', webhookAuth, async (req, res, next) => {
  try {
    const { name, phone, email, age, move_in_date, tenant_status, gender, intro, listing_id, consent_sms, row_id, timestamp } = req.body;

    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
    if (!consent_sms) return res.status(400).json({ error: 'SMS consent is required.' });

    const normalizedPhone = normalizeE164(phone);

    const idempotencyKey = `${row_id || ''}_${timestamp || ''}`;
    if (row_id) {
      const dup = await db.query(
        `SELECT id FROM conversations WHERE source = 'google_form' AND (listing_snapshot->>'idempotency_key') = $1 LIMIT 1`,
        [idempotencyKey],
      );
      if (dup.rows.length) return res.json({ ok: true, duplicate: true, conversationId: dup.rows[0].id });
    }

    const existing = await db.query(
      `SELECT id, flow_state FROM conversations WHERE phone = $1 AND listing_id = $2 AND flow_state NOT IN ('lost', 'signed', 'opted_out') LIMIT 1`,
      [normalizedPhone, listing_id || null],
    );
    if (existing.rows.length) {
      return res.json({ ok: true, duplicate: true, conversationId: existing.rows[0].id });
    }

    const listingData = listing_id ? await loadListingData(listing_id) : null;
    const listingMeta = extractListingMeta(listingData);

    let convo;
    try {
      convo = await db.query(
        `INSERT INTO conversations (tenant_name, phone, email, age, move_in_date, tenant_status, gender, intro, listing_id, property, source, consent_sms, flow_state, listing_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'google_form', true, 'lead_ingested', $11)
         RETURNING id`,
        [
          name || null, normalizedPhone, email || null,
          age ? Number(age) : null, move_in_date || null,
          tenant_status || null, gender || null, intro || null,
          listing_id || null,
          listingMeta.address || null,
          JSON.stringify({
            idempotency_key: idempotencyKey,
            ingested_at: new Date().toISOString(),
            listing_data: listingData || null,
            video_url: listingMeta.videoUrl || null,
          }),
        ],
      );
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        const dup = await db.query(`SELECT id FROM conversations WHERE phone = $1 LIMIT 1`, [normalizedPhone]);
        return res.json({ ok: true, duplicate: true, conversationId: dup.rows[0]?.id });
      }
      throw insertErr;
    }
    const conversationId = convo.rows[0].id;

    await logAudit(db, { actor: 'system', action: ACTIONS.LEAD_INGESTED, conversationId, details: { source: 'google_form', phone: normalizedPhone } });

    let prelimScore = { score: 50, reason: 'Scoring skipped.' };
    try {
      prelimScore = await scorePreliminary({ name, age, tenantStatus: tenant_status, moveInDate: move_in_date, intro });
    } catch (err) {
      console.error('Preliminary scoring error:', err.message);
    }

    const flowState = prelimScore.score >= LEAD_SCORE_THRESHOLD ? 'pending_compose' : 'filtered';

    await db.query(
      `UPDATE conversations SET preliminary_score = $2, flow_state = $3, updated_at = NOW() WHERE id = $1`,
      [conversationId, prelimScore.score, flowState],
    );

    await db.query(
      `INSERT INTO scores (conversation_id, overall_score, summary, scoring_status, score_type)
       VALUES ($1, $2, $3, 'complete', 'preliminary')`,
      [conversationId, prelimScore.score, prelimScore.reason],
    );

    const auditAction = flowState === 'filtered' ? ACTIONS.LEAD_FILTERED : ACTIONS.LEAD_INGESTED;
    await logAudit(db, { actor: 'system', action: auditAction, conversationId, details: { score: prelimScore.score, threshold: LEAD_SCORE_THRESHOLD, flowState, reason: prelimScore.reason } });

    let firstMessageResult = null;
    if (flowState === 'pending_compose') {
      try {
        firstMessageResult = await sendFirstMessage(conversationId);
      } catch (err) {
        console.error('Auto-send first message failed:', err.message);
        firstMessageResult = { sent: false, error: err.message };
      }
    }

    res.json({ ok: true, conversationId, score: prelimScore.score, flowState, firstMessage: firstMessageResult });
  } catch (error) {
    next(error);
  }
});

// ── Compose & Send First Message (PM-triggered or manual override) ──

app.post('/api/leads/:id/send-first', requireAuth, async (req, res, next) => {
  try {
    const result = await sendFirstMessage(req.params.id);
    if (result.skipped) return res.status(400).json({ error: result.reason });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Override Filtered Lead (PM pushes into pipeline) ──

app.post('/api/leads/:id/override', requireAuth, async (req, res, next) => {
  try {
    const convo = await db.query(
      `SELECT id, flow_state FROM conversations WHERE id = $1`,
      [req.params.id],
    );
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });
    if (convo.rows[0].flow_state !== 'filtered') {
      return res.status(400).json({ error: `Lead is not filtered (current: ${convo.rows[0].flow_state}).` });
    }

    await db.query(
      `UPDATE conversations SET flow_state = 'pending_compose', updated_at = NOW() WHERE id = $1`,
      [req.params.id],
    );
    await logAudit(db, {
      actor: req.user?.email || 'unknown',
      action: ACTIONS.LEAD_OVERRIDE,
      conversationId: req.params.id,
    });

    res.json({ ok: true, flowState: 'pending_compose' });
  } catch (error) {
    next(error);
  }
});

// ── Debounce-based SMS Auto-Reply ──

async function generateAndSendAutoReply(conversationId) {
  const entry = replyTimers.get(conversationId);
  if (entry) entry.generating = true;

  try {
    const convo = await db.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    if (!convo.rows.length) return;
    const conversation = convo.rows[0];

    const allMsgs = await db.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId],
    );
    const chatMessages = allMsgs.rows.map((m) => ({
      role: m.role === 'tenant' || m.role === 'admin' ? 'user' : 'assistant',
      content: m.content,
    }));

    let listingId = conversation.listing_id;
    if (!listingId) {
      try {
        const files = await fs.readdir(listingsDir);
        const first = files.find(f => f.endsWith('.md'));
        if (first) listingId = path.basename(first, '.md');
      } catch {}
    }
    const systemPrompt = await buildSystemPrompt(listingId, conversation);
    if (!systemPrompt) {
      console.error('[AUTO-REPLY] No system prompt for conversation', conversationId);
      return;
    }

    const runtime = getRuntimeConfig();
    const provider = runtime.activeProvider;
    const chatModel = process.env.ANTHROPIC_CHAT_MODEL || runtime.providers[provider]?.model;
    const smsMaxTokens = Math.ceil((parseInt(process.env.SMS_MAX_CHARS) || 320) / 4);

    const chat = await sendChat({
      provider,
      model: chatModel,
      systemPrompt,
      messages: chatMessages,
      max_tokens: smsMaxTokens,
    });

    let replyText = stripMarkdown(chat.text);
    replyText = truncateSms(replyText);

    await db.query(
      `INSERT INTO messages (conversation_id, role, content, channel, delivery_status, model, latency_ms, metadata)
       VALUES ($1, 'assistant', $2, 'sms', 'pending', $3, $4, $5)`,
      [conversationId, replyText, chat.model, chat.latencyMs,
       JSON.stringify({ usage: chat.usage, responseId: chat.providerResponseId, auto_reply: true })],
    );

    const sendResult = await channelSend(CHANNELS.SMS, conversation.phone, replyText, { conversationId });

    if (sendResult.success) {
      await db.query(
        `UPDATE messages SET delivery_status = $2, external_id = $3
         WHERE id = (
           SELECT id FROM messages
           WHERE conversation_id = $1 AND role = 'assistant' AND delivery_status = 'pending'
           ORDER BY created_at DESC LIMIT 1
         )`,
        [conversationId, sendResult.status, sendResult.externalId],
      );
      await db.query(
        `UPDATE conversations SET message_count = message_count + 1, preview = $2, updated_at = NOW() WHERE id = $1`,
        [conversationId, replyText.slice(0, 200)],
      );
      console.log('[AUTO-REPLY] Sent reply to conversation %s (%d chars, %d segs)', conversationId, replyText.length, sendResult.segments);
    } else {
      console.error('[AUTO-REPLY] Send failed for conversation %s: %s', conversationId, sendResult.error);
    }

    await logAudit(db, {
      actor: 'system',
      action: ACTIONS.MESSAGE_SENT,
      conversationId,
      details: { channel: 'sms', type: 'auto_reply', success: sendResult.success, segments: sendResult.segments },
    });
  } catch (err) {
    console.error('[AUTO-REPLY] Error for conversation %s:', conversationId, err.message);
  } finally {
    const entry = replyTimers.get(conversationId);
    if (entry) {
      entry.generating = false;

      const newMsgsDuringGen = await db.query(
        `SELECT COUNT(*) AS cnt FROM messages
         WHERE conversation_id = $1 AND role = 'tenant' AND created_at > (
           SELECT COALESCE(MAX(created_at), '1970-01-01') FROM messages WHERE conversation_id = $1 AND role = 'assistant'
         )`,
        [conversationId],
      );
      if (parseInt(newMsgsDuringGen.rows[0]?.cnt || '0') > 0) {
        console.log('[AUTO-REPLY] New messages arrived during generation for %s, re-debouncing (10s)', conversationId);
        scheduleAutoReply(conversationId, SMS_SHORT_DEBOUNCE);
      } else {
        replyTimers.delete(conversationId);
      }
    }
  }
}

function scheduleAutoReply(conversationId, delayMs = SMS_REPLY_DELAY) {
  const existing = replyTimers.get(conversationId);

  if (existing?.generating) return;

  if (existing?.timer) clearTimeout(existing.timer);

  const firstMessageAt = existing?.firstMessageAt || Date.now();
  const elapsed = Date.now() - firstMessageAt;

  let effectiveDelay = delayMs;
  if (elapsed + delayMs > SMS_REPLY_MAX_WAIT) {
    effectiveDelay = Math.max(0, SMS_REPLY_MAX_WAIT - elapsed);
  }

  const timer = setTimeout(() => {
    generateAndSendAutoReply(conversationId).catch((err) => {
      console.error('[AUTO-REPLY] Unhandled error:', err.message);
      replyTimers.delete(conversationId);
    });
  }, effectiveDelay);

  replyTimers.set(conversationId, { timer, firstMessageAt, generating: false });
}

// ── SMS Inbound Webhook (public, verified by Basic Auth from Pling) ──

app.post('/api/channels/sms/inbound', (req, res, next) => {
  const simSecret = process.env.SIMULATOR_SECRET;
  const simHeader = req.headers['x-simulator-secret'];
  if (simSecret && simHeader && simHeader === simSecret) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const plingAuth = req.headers['x-pling-auth'];
  const expectedUser = process.env.PLING_USERNAME;
  const expectedPass = process.env.PLING_PASSWORD;
  if (expectedUser && expectedPass) {
    const expectedBasic = 'Basic ' + Buffer.from(`${expectedUser}:${expectedPass}`).toString('base64');
    const expectedHeader = `${expectedUser}:${expectedPass}`;
    const okBasic = authHeader === expectedBasic;
    const okPlingHeader = plingAuth === expectedHeader;
    if (!okBasic && !okPlingHeader) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }
  next();
}, async (req, res, next) => {
  try {
    const parsed = channelParseInbound(CHANNELS.SMS, req.body);
    if (!parsed.from || !parsed.text) {
      return res.status(400).json({ error: 'Missing phone or text.' });
    }

    const phone = normalizeE164(parsed.from);
    const text = parsed.text.trim();

    if (parsed.externalId) {
      const dup = await db.query(
        `SELECT 1 FROM messages WHERE external_id = $1 AND channel = 'sms' LIMIT 1`,
        [parsed.externalId],
      );
      if (dup.rows.length) return res.json({ ok: true, duplicate: true });
    }

    const isOptOut = OPT_OUT_KEYWORDS.some((kw) => text.toLowerCase() === kw);

    const convo = await db.query(
      `SELECT id, flow_state, auto_reply_paused FROM conversations WHERE phone = $1 LIMIT 1`,
      [phone],
    );

    if (!convo.rows.length) {
      await logAudit(db, {
        actor: 'system',
        action: 'sms_inbound_unknown',
        details: { phone, text: text.slice(0, 100) },
      });
      return res.json({ ok: true, matched: false });
    }

    const conversationId = convo.rows[0].id;

    if (isOptOut) {
      await db.query(
        `UPDATE conversations SET flow_state = 'opted_out', consent_sms = false, updated_at = NOW() WHERE id = $1`,
        [conversationId],
      );
      await logAudit(db, {
        actor: 'system',
        action: 'opt_out',
        conversationId,
        details: { keyword: text },
      });
      return res.json({ ok: true, opted_out: true });
    }

    await db.query(
      `INSERT INTO messages (conversation_id, role, content, channel, delivery_status, external_id)
       VALUES ($1, 'tenant', $2, 'sms', 'delivered', $3)`,
      [conversationId, text, parsed.externalId || null],
    );
    await db.query(
      `UPDATE conversations SET message_count = message_count + 1, preview = $2, updated_at = NOW() WHERE id = $1`,
      [conversationId, text.slice(0, 200)],
    );

    await logAudit(db, {
      actor: 'system',
      action: 'sms_inbound',
      conversationId,
      details: { from: phone, text: text.slice(0, 100) },
    });

    const autoReplyEnabled = (process.env.SIMULATOR_AUTO_REPLY || 'true').toLowerCase() === 'true';
    const convData = convo.rows[0];
    const isPaused = convData.auto_reply_paused === true;

    if (autoReplyEnabled && !isPaused && !isOptOut) {
      scheduleAutoReply(conversationId);
    }

    res.json({ ok: true, conversationId });
  } catch (error) {
    next(error);
  }
});

// ── SMS Send (PM or system triggered, requires auth) ──

app.post('/api/channels/sms/send', requireAuth, async (req, res, next) => {
  try {
    const { conversationId, text } = req.body;
    if (!conversationId || !text?.trim()) {
      return res.status(400).json({ error: 'conversationId and text are required.' });
    }

    const convo = await db.query(
      `SELECT id, phone, flow_state, consent_sms FROM conversations WHERE id = $1`,
      [conversationId],
    );
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const { phone, consent_sms, flow_state } = convo.rows[0];
    if (!phone) return res.status(400).json({ error: 'No phone number on this conversation.' });
    if (flow_state === 'opted_out') return res.status(400).json({ error: 'Tenant has opted out.' });
    if (!consent_sms) return res.status(400).json({ error: 'No SMS consent on file for this tenant.' });

    const result = await channelSend(CHANNELS.SMS, phone, text.trim());

    await db.query(
      `INSERT INTO messages (conversation_id, role, content, channel, delivery_status, external_id)
       VALUES ($1, 'assistant', $2, 'sms', $3, $4)`,
      [conversationId, text.trim(), result.status, result.externalId],
    );
    await db.query(
      `UPDATE conversations SET message_count = message_count + 1, preview = $2, updated_at = NOW() WHERE id = $1`,
      [conversationId, text.trim().slice(0, 200)],
    );

    await logAudit(db, {
      actor: req.user?.email || 'system',
      action: ACTIONS.MESSAGE_SENT,
      conversationId,
      details: { channel: 'sms', segments: result.segments, status: result.status },
    });

    res.json({ ok: result.success, ...result });
  } catch (error) {
    next(error);
  }
});

// ── Conversations ──

app.get('/api/conversations', requireAuth, async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT c.*,
        s.overall_score AS latest_score,
        s.conversion_likelihood AS latest_likelihood,
        s.scoring_status AS latest_scoring_status
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT overall_score, conversion_likelihood, scoring_status
        FROM scores
        WHERE conversation_id = c.id
        ORDER BY scored_at DESC
        LIMIT 1
      ) s ON true
      ORDER BY c.updated_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const convo = await db.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const msgs = await db.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id],
    );

    const latestConvoScore = await db.query(
      "SELECT * FROM scores WHERE conversation_id = $1 AND score_type = 'conversation' ORDER BY scored_at DESC LIMIT 1",
      [req.params.id],
    );
    const prelimScore = await db.query(
      "SELECT * FROM scores WHERE conversation_id = $1 AND score_type = 'preliminary' ORDER BY scored_at DESC LIMIT 1",
      [req.params.id],
    );

    res.json({
      ...convo.rows[0],
      messages: msgs.rows,
      latestScore: latestConvoScore.rows[0] || null,
      preliminaryScore: prelimScore.rows[0] || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const { tenant_name, property, unit_hint, listing_id } = req.body ?? {};

    if (!listing_id) {
      res.status(400).json({ error: 'listing_id is required.' });
      return;
    }

    const listingData = await loadListingData(listing_id);
    if (!listingData) {
      res.status(400).json({ error: `Listing "${listing_id}" not found.` });
      return;
    }

    const result = await db.query(
      `INSERT INTO conversations (tenant_name, property, unit_hint, listing_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenant_name || null, property || null, unit_hint || null, listing_id],
    );

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
  const client = await db.connect();
  try {
    const { content, role } = req.body ?? {};
    const messageRole = role === 'admin' ? 'admin' : 'tenant';

    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Message content is required.' });
      return;
    }

    await client.query('BEGIN');

    const convo = await client.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const conversation = convo.rows[0];

    await client.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
      [req.params.id, messageRole, content.trim()],
    );

    const allMsgs = await client.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id],
    );

    const chatMessages = allMsgs.rows.map((m) => ({
      role: m.role === 'tenant' || m.role === 'admin' ? 'user' : 'assistant',
      content: m.content,
    }));

    const systemPrompt = await buildSystemPrompt(conversation.listing_id, conversation);
    if (!systemPrompt) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: `Listing "${conversation.listing_id}" not found.` });
      return;
    }

    const runtime = getRuntimeConfig();
    const provider = runtime.activeProvider;
    const isSmsConversation = conversation.channel === 'sms';
    const smsMaxTokens = isSmsConversation ? Math.ceil((parseInt(process.env.SMS_MAX_CHARS) || 320) / 4) : undefined;

    const chat = await sendChat({
      provider,
      model: runtime.providers[provider].model,
      systemPrompt,
      messages: chatMessages,
      ...(smsMaxTokens ? { max_tokens: smsMaxTokens } : {}),
    });

    let cleanedText = stripMarkdown(chat.text);
    if (isSmsConversation) cleanedText = truncateSms(cleanedText);

    await client.query(
      `INSERT INTO messages (conversation_id, role, content, model, latency_ms, metadata)
       VALUES ($1, 'assistant', $2, $3, $4, $5)`,
      [
        req.params.id,
        cleanedText,
        chat.model,
        chat.latencyMs,
        JSON.stringify({ usage: chat.usage, responseId: chat.providerResponseId }),
      ],
    );

    const preview = cleanedText.slice(0, 120);
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW(),
           message_count = message_count + 2,
           preview = $2
       WHERE id = $1`,
      [req.params.id, preview],
    );

    await client.query('COMMIT');

    let autoScoreTriggered = false;
    let scoreId = null;

    try {
      const shouldScore = await checkScoringMilestones(req.params.id);
      if (shouldScore) {
        const scoreResult = await db.query(
          `INSERT INTO scores (conversation_id, message_count_at_scoring, scoring_status)
           VALUES ($1, (SELECT message_count FROM conversations WHERE id = $1), 'pending')
           RETURNING id`,
          [req.params.id],
        );
        scoreId = scoreResult.rows[0].id;
        autoScoreTriggered = true;

        executeScoring(req.params.id, scoreId).catch((err) =>
          console.error('Auto-scoring error:', err.message),
        );
      }
    } catch (err) {
      console.error('Milestone check error:', err.message);
    }

    res.json({
      tenantMessage: { role: messageRole, content: content.trim() },
      aiResponse: { ...buildChatPayload(chat), message: cleanedText },
      autoScoreTriggered,
      scoreId,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

const ALLOWED_FLOW_STATES = new Set([
  'lead_ingested', 'filtered', 'pending_compose', 'sending', 'first_message_sent',
  'has_questions', 'booked_calendly', 'call_completed', 'wants_to_rent',
  'soft_commitment', 'confirmed', 'unit_held', 'credit_check', 'contract_sent',
  'signed', 'wants_physical', 'manual_intervention', 'pm_takeover', 'lost', 'opted_out',
]);

app.patch('/api/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const { flow_state, auto_reply_paused } = req.body;

    if (typeof auto_reply_paused === 'boolean' && !flow_state) {
      await db.query(
        `UPDATE conversations SET auto_reply_paused = $2, updated_at = NOW() WHERE id = $1`,
        [req.params.id, auto_reply_paused],
      );
      await logAudit(db, {
        actor: req.user?.email || 'unknown',
        action: 'auto_reply_toggled',
        conversationId: req.params.id,
        details: { paused: auto_reply_paused },
      });
      if (auto_reply_paused) {
        const entry = replyTimers.get(req.params.id);
        if (entry?.timer) clearTimeout(entry.timer);
        replyTimers.delete(req.params.id);
      }
      return res.json({ ok: true, auto_reply_paused });
    }

    if (!flow_state) return res.status(400).json({ error: 'flow_state is required.' });
    if (!ALLOWED_FLOW_STATES.has(flow_state)) {
      return res.status(400).json({ error: `Invalid flow_state: ${flow_state}` });
    }

    const convo = await db.query('SELECT id, flow_state FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const updates = ['flow_state = $2', 'updated_at = NOW()'];
    const params = [req.params.id, flow_state];
    if (typeof auto_reply_paused === 'boolean') {
      updates.push(`auto_reply_paused = $${params.length + 1}`);
      params.push(auto_reply_paused);
    }

    await db.query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    const action = flow_state === 'pm_takeover' ? ACTIONS.PM_TAKEOVER : ACTIONS.FLOW_STATE_CHANGED;
    await logAudit(db, {
      actor: req.user?.email || 'unknown',
      action,
      conversationId: req.params.id,
      details: { from: convo.rows[0].flow_state, to: flow_state },
    });

    const RESCORE_STATES = new Set(['wants_to_rent', 'confirmed', 'booked_calendly', 'call_completed', 'soft_commitment']);
    if (RESCORE_STATES.has(flow_state)) {
      const msgCount = await db.query(
        "SELECT COUNT(*)::int AS cnt FROM messages WHERE conversation_id = $1 AND role = 'tenant'",
        [req.params.id],
      );
      const pendingCheck = await db.query(
        "SELECT 1 FROM scores WHERE conversation_id = $1 AND scoring_status = 'pending' LIMIT 1",
        [req.params.id],
      );
      if (!pendingCheck.rows.length && msgCount.rows[0].cnt > 0) {
        const scoreResult = await db.query(
          `INSERT INTO scores (conversation_id, message_count_at_scoring, scoring_status)
           VALUES ($1, $2, 'pending') RETURNING id`,
          [req.params.id, msgCount.rows[0].cnt],
        );
        executeScoring(req.params.id, scoreResult.rows[0].id).catch((err) =>
          console.error('Auto-rescore error:', err.message),
        );
      }
    }

    res.json({ ok: true, flowState: flow_state });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM conversations WHERE id = $1', [req.params.id]);
    if (!result.rowCount) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Scoring ──

app.post('/api/conversations/:id/score', requireAuth, async (req, res, next) => {
  try {
    const convo = await db.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const pendingCheck = await db.query(
      "SELECT id FROM scores WHERE conversation_id = $1 AND scoring_status = 'pending' LIMIT 1",
      [req.params.id],
    );
    if (pendingCheck.rows.length) {
      res.json({ status: 'pending', score_id: pendingCheck.rows[0].id });
      return;
    }

    const msgCount = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM messages WHERE conversation_id = $1 AND role = 'tenant'",
      [req.params.id],
    );

    const result = await db.query(
      `INSERT INTO scores (conversation_id, message_count_at_scoring, scoring_status)
       VALUES ($1, $2, 'pending')
       RETURNING id, scoring_status`,
      [req.params.id, msgCount.rows[0].cnt],
    );

    const scoreId = result.rows[0].id;
    const conversationId = req.params.id;

    executeScoring(conversationId, scoreId).catch((err) =>
      console.error('Background scoring error:', err.message),
    );

    res.json({ status: 'pending', score_id: scoreId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/scores', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT * FROM scores WHERE conversation_id = $1 ORDER BY scored_at DESC',
      [req.params.id],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/score/:scoreId', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT * FROM scores WHERE id = $1 AND conversation_id = $2',
      [req.params.scoreId, req.params.id],
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Score not found.' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/score-ab', requireAuth, async (req, res, next) => {
  try {
    const convo = await db.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const msgs = await db.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id],
    );
    if (!msgs.rows.length) return res.status(400).json({ error: 'No messages to score.' });

    const systemPrompt = await loadScoringPrompt();
    const transcript = buildTranscript(msgs.rows);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey?.trim()) return res.status(500).json({ error: 'Missing API key.' });

    const models = {
      sonnet: process.env.ANTHROPIC_SCORING_MODEL || 'claude-sonnet-4-20250514',
      haiku: process.env.ANTHROPIC_CHAT_MODEL || 'claude-haiku-4-5-20251001',
    };

    const results = {};
    for (const [label, model] of Object.entries(models)) {
      const startedAt = Date.now();
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: 'user', content: transcript }],
        }),
      });
      const payload = await response.json();
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        results[label] = { error: payload?.error?.message || 'Failed', model, latencyMs };
        continue;
      }
      const rawText = payload?.content?.find((b) => b.type === 'text')?.text || '';
      try {
        const parsed = parseScoreJson(rawText);
        parsed.overall_score = Math.max(0, Math.min(100, Math.round(parsed.overall_score)));
        results[label] = {
          model,
          latencyMs,
          overall_score: parsed.overall_score,
          conversion_likelihood: parsed.conversion_likelihood,
          sub_scores: parsed.sub_scores,
          summary: parsed.summary,
          recommended_action: parsed.recommended_action,
          usage: {
            inputTokens: payload?.usage?.input_tokens,
            outputTokens: payload?.usage?.output_tokens,
          },
        };
      } catch {
        results[label] = { error: 'Parse failed', model, latencyMs, raw: rawText.slice(0, 500) };
      }
    }

    const scoreDiff = (results.sonnet?.overall_score != null && results.haiku?.overall_score != null)
      ? Math.abs(results.sonnet.overall_score - results.haiku.overall_score)
      : null;

    res.json({ conversationId: req.params.id, scoreDiff, results });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/refresh-snapshot', requireAuth, async (req, res, next) => {
  try {
    const convo = await db.query('SELECT id, listing_id, listing_snapshot FROM conversations WHERE id = $1', [req.params.id]);
    if (!convo.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

    const { listing_id } = convo.rows[0];
    if (!listing_id) return res.status(400).json({ error: 'No listing_id on this conversation.' });

    const listingData = await loadListingData(listing_id);
    if (!listingData) return res.status(400).json({ error: `Listing "${listing_id}" not found.` });

    const snapshot = {
      ...(convo.rows[0].listing_snapshot || {}),
      listing_data: listingData,
      refreshed_at: new Date().toISOString(),
    };

    await db.query(
      'UPDATE conversations SET listing_snapshot = $2, updated_at = NOW() WHERE id = $1',
      [req.params.id, JSON.stringify(snapshot)],
    );

    await logAudit(db, {
      actor: req.user?.email || 'system',
      action: 'listing_snapshot_refreshed',
      conversationId: req.params.id,
    });

    res.json({ ok: true, snapshot });
  } catch (error) {
    next(error);
  }
});

// ── Legacy chat endpoint (kept for backward compatibility) ──

app.post('/api/chat', requireAuth, async (req, res, next) => {
  try {
    const runtime = getRuntimeConfig();
    const requestedProvider = req.body?.provider;
    const normalizedProvider = normalizeProvider(requestedProvider);

    if (requestedProvider && !normalizedProvider) {
      res.status(400).json({
        error: `Unsupported provider "${requestedProvider}". Use "openai" or "anthropic".`,
      });
      return;
    }

    const provider = normalizedProvider || runtime.activeProvider;
    const messages = normalizeMessages(req.body?.messages);

    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      res.status(400).json({ error: 'Send at least one user message before calling /api/chat.' });
      return;
    }

    const promptVariant =
      typeof req.body?.promptVariant === 'string' && req.body.promptVariant.trim()
        ? req.body.promptVariant.trim()
        : getDefaultPromptVariant(provider);

    const promptCandidate =
      typeof req.body?.systemPrompt === 'string'
        ? req.body.systemPrompt
        : (await loadPromptContent(promptVariant, provider)).content;

    const chat = await sendChat({
      provider,
      model: runtime.providers[provider].model,
      systemPrompt: promptCandidate,
      messages,
    });

    res.json(buildChatPayload(chat, promptVariant));
  } catch (error) {
    next(error);
  }
});

// ── Static serving ──

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  const message =
    error?.error?.message || error?.message || 'Something went wrong while handling the request.';
  res.status(500).json({ error: message });
});
