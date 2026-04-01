import 'dotenv/config';
import cors from 'cors';
import express from 'express';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);
const distPath = path.join(__dirname, 'dist');
const listingsDir = path.join(__dirname, 'prompts', 'listings');
const promptCache = new Map();

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
  `);
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

app.use(cors());
app.use(express.json({ limit: '1mb' }));

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

async function buildSystemPrompt(listingId) {
  const prompt = await loadPromptContent(null, 'anthropic');
  const listingData = await loadListingData(listingId);
  if (!listingData) return null;
  return prompt.content.replace('{{LISTING_DATA}}', listingData);
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
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
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
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
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

// ── Routes ──

app.get('/api/health', (_req, res) => {
  res.json(getHealthPayload());
});

app.get('/api/system-prompt', async (req, res, next) => {
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

app.put('/api/system-prompt', async (req, res, next) => {
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

app.get('/api/listings', async (_req, res, next) => {
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

// ── Conversations ──

app.get('/api/conversations', async (_req, res, next) => {
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

app.get('/api/conversations/:id', async (req, res, next) => {
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

    const scores = await db.query(
      'SELECT * FROM scores WHERE conversation_id = $1 ORDER BY scored_at DESC LIMIT 1',
      [req.params.id],
    );

    res.json({
      ...convo.rows[0],
      messages: msgs.rows,
      latestScore: scores.rows[0] || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations', async (req, res, next) => {
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

app.post('/api/conversations/:id/messages', async (req, res, next) => {
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

    const systemPrompt = await buildSystemPrompt(conversation.listing_id);
    if (!systemPrompt) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: `Listing "${conversation.listing_id}" not found.` });
      return;
    }

    const runtime = getRuntimeConfig();
    const provider = runtime.activeProvider;
    const chat = await sendChat({
      provider,
      model: runtime.providers[provider].model,
      systemPrompt,
      messages: chatMessages,
    });

    await client.query(
      `INSERT INTO messages (conversation_id, role, content, model, latency_ms, metadata)
       VALUES ($1, 'assistant', $2, $3, $4, $5)`,
      [
        req.params.id,
        chat.text,
        chat.model,
        chat.latencyMs,
        JSON.stringify({ usage: chat.usage, responseId: chat.providerResponseId }),
      ],
    );

    const preview = chat.text.slice(0, 120);
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
      aiResponse: buildChatPayload(chat),
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

app.delete('/api/conversations/:id', async (req, res, next) => {
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

app.post('/api/conversations/:id/score', async (req, res, next) => {
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

app.get('/api/conversations/:id/scores', async (req, res, next) => {
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

app.get('/api/conversations/:id/score/:scoreId', async (req, res, next) => {
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

// ── Legacy chat endpoint (kept for backward compatibility) ──

app.post('/api/chat', async (req, res, next) => {
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
