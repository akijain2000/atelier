import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { listAnthropicTools, callTool } from './mcpClient.js';

const defaultPrompt = 'You are a helpful AI assistant.';
const anthropicApiUrl = 'https://api.anthropic.com/v1/messages';
const anthropicApiVersion = '2023-06-01';
const anthropicMaxTokens = 900;

const promptVariants = [
  {
    id: 'prompt',
    label: 'Prompt',
    fileName: 'Prompt.md',
    providerHint: null,
    description: 'Main system prompt.',
  },
];

const promptVariantAliases = new Map(
  promptVariants.flatMap((variant) => {
    const baseName = path.basename(variant.fileName, '.md');
    return [
      [variant.id, variant.id],
      [variant.fileName, variant.id],
      [baseName, variant.id],
    ];
  }),
);

const providerLabels = {
  openai: 'OpenAI',
  anthropic: 'Claude',
};

const defaultPromptVariantByProvider = {
  openai: 'prompt',
  anthropic: 'prompt',
};

const defaultModelByProvider = {
  openai: process.env.OPENAI_MODEL || 'gpt-5.4',
  anthropic: process.env.ANTHROPIC_CHAT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
};

const openaiClient =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

export const supportedProviders = ['openai', 'anthropic'];

export function normalizeProvider(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const provider = value.trim().toLowerCase();
  return supportedProviders.includes(provider) ? provider : null;
}

export function getProviderLabel(provider) {
  return providerLabels[provider] || provider;
}

export function inferProviderFromPromptVariant(variantId) {
  const variant = promptVariants.find((v) => v.id === variantId);
  return variant?.providerHint || 'openai';
}

export function slugifyValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildRoundSlug({ provider, promptVariant, model }) {
  return [provider, promptVariant, model].map(slugifyValue).filter(Boolean).join('--');
}

export function getDefaultPromptVariant(provider) {
  return defaultPromptVariantByProvider[provider] || defaultPromptVariantByProvider.openai;
}

export function getRuntimeConfig() {
  const providers = {
    openai: {
      configured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()),
      model: defaultModelByProvider.openai,
      label: getProviderLabel('openai'),
    },
    anthropic: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()),
      model: defaultModelByProvider.anthropic,
      label: getProviderLabel('anthropic'),
    },
  };

  const requestedProvider = normalizeProvider(process.env.DEFAULT_PROVIDER) || 'openai';
  const activeProvider =
    providers[requestedProvider].configured
      ? requestedProvider
      : supportedProviders.find((provider) => providers[provider].configured) || requestedProvider;

  return {
    activeProvider,
    activeModel: providers[activeProvider].model,
    hasApiKey: providers[activeProvider].configured,
    model: providers[activeProvider].model,
    providers,
    defaultPromptVariants: { ...defaultPromptVariantByProvider },
  };
}

export function listPromptVariants(rootDir) {
  return promptVariants.map((variant) => ({
    ...variant,
    path: `ChatBot/prompts/${variant.fileName}`,
    absolutePath: path.join(rootDir, 'prompts', variant.fileName),
  }));
}

export function resolvePromptVariant(rootDir, variantId, provider = null) {
  const normalizedVariant =
    promptVariantAliases.get(variantId || '') ||
    defaultPromptVariantByProvider[provider || 'openai'] ||
    defaultPromptVariantByProvider.openai;

  const variant = listPromptVariants(rootDir).find((item) => item.id === normalizedVariant);

  if (!variant) {
    throw new Error(`Unknown prompt variant: ${variantId || normalizedVariant}`);
  }

  return variant;
}

export async function readPromptVariant(rootDir, variantId, provider = null) {
  const variant = resolvePromptVariant(rootDir, variantId, provider);

  try {
    const content = await fs.readFile(variant.absolutePath, 'utf8');
    return {
      ...variant,
      content,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(variant.absolutePath, '', 'utf8');
      return {
        ...variant,
        content: '',
      };
    }

    throw error;
  }
}

export async function savePromptVariant(rootDir, variantId, content, provider = null) {
  const variant = resolvePromptVariant(rootDir, variantId, provider);
  await fs.writeFile(variant.absolutePath, content, 'utf8');
  return variant;
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim(),
    )
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));
}

function extractOpenAIText(completion) {
  if (!completion) {
    return '';
  }

  if (typeof completion.output_text === 'string' && completion.output_text.trim()) {
    return completion.output_text.trim();
  }

  if (!Array.isArray(completion.output)) {
    return '';
  }

  const fragments = [];

  for (const outputItem of completion.output) {
    if (!outputItem?.content) {
      continue;
    }

    for (const chunk of outputItem.content) {
      if (typeof chunk === 'string' && chunk.trim()) {
        fragments.push(chunk.trim());
      } else if (typeof chunk?.text === 'string' && chunk.text.trim()) {
        fragments.push(chunk.text.trim());
      }
    }
  }

  return fragments.join('\n\n').trim();
}

function extractAnthropicText(payload) {
  if (!Array.isArray(payload?.content)) {
    return '';
  }

  return payload.content
    .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function buildUsage(provider, payload) {
  if (provider === 'anthropic') {
    return {
      inputTokens: payload?.usage?.input_tokens ?? null,
      outputTokens: payload?.usage?.output_tokens ?? null,
      cacheCreationInputTokens: payload?.usage?.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: payload?.usage?.cache_read_input_tokens ?? null,
    };
  }

  return {
    inputTokens: payload?.usage?.input_tokens ?? null,
    outputTokens: payload?.usage?.output_tokens ?? null,
  };
}

function getProviderModel(provider, requestedModel = null) {
  if (typeof requestedModel === 'string' && requestedModel.trim()) {
    return requestedModel.trim();
  }

  return defaultModelByProvider[provider] || defaultModelByProvider.openai;
}

function getProviderCredentialError(provider) {
  return provider === 'anthropic'
    ? 'Missing ANTHROPIC_API_KEY. Add it to your environment or .env file before sending messages.'
    : 'Missing OPENAI_API_KEY. Add it to your environment or .env file before sending messages.';
}

async function sendOpenAIChat({ model, systemPrompt, messages }) {
  if (!openaiClient) {
    throw new Error(getProviderCredentialError('openai'));
  }

  const completion = await openaiClient.responses.create({
    model,
    instructions: systemPrompt,
    input: messages,
  });

  return {
    text: extractOpenAIText(completion),
    rawResponse: completion,
    usage: buildUsage('openai', completion),
    providerResponseId: completion.id,
    stopReason: completion.status || null,
  };
}

async function sendAnthropicChat({ model, systemPrompt, messages }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    throw new Error(getProviderCredentialError('anthropic'));
  }

  // Load MCP tools (cached after first call)
  let tools = [];
  try {
    tools = await listAnthropicTools();
  } catch {
    // MCP unavailable — proceed without tools
  }

  let currentMessages = [...messages];
  let lastPayload = null;
  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body = {
      model,
      max_tokens: anthropicMaxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: currentMessages,
    };
    if (tools.length > 0) body.tools = tools;

    const response = await fetch(anthropicApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': anthropicApiVersion,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.message ||
          'Anthropic request failed while handling the chat request.',
      );
    }

    lastPayload = payload;

    // If Claude wants to use a tool, execute and loop
    if (payload.stop_reason === 'tool_use') {
      const toolUseBlocks = payload.content.filter((b) => b.type === 'tool_use');

      // Add Claude's tool_use message to history
      currentMessages.push({ role: 'assistant', content: payload.content });

      // Execute each tool and collect results
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          let content;
          try {
            const result = await callTool(block.name, block.input);
            content = JSON.stringify(result);
          } catch (err) {
            content = JSON.stringify({ error: err.message });
          }
          return { type: 'tool_result', tool_use_id: block.id, content };
        }),
      );

      // Add tool results as a user turn
      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Final response — exit loop
    break;
  }

  return {
    text: extractAnthropicText(lastPayload),
    rawResponse: lastPayload,
    usage: buildUsage('anthropic', lastPayload),
    providerResponseId: lastPayload.id,
    stopReason: lastPayload.stop_reason || null,
  };
}

export async function sendChat({ provider, model = null, systemPrompt, messages }) {
  const normalizedProvider = normalizeProvider(provider) || getRuntimeConfig().activeProvider;
  const normalizedMessages = normalizeMessages(messages);

  if (!normalizedMessages.length || normalizedMessages[normalizedMessages.length - 1].role !== 'user') {
    throw new Error('Send at least one user message before calling the chat provider.');
  }

  const effectivePrompt = (systemPrompt || '').trim() || defaultPrompt;
  const effectiveModel = getProviderModel(normalizedProvider, model);
  const startedAt = Date.now();

  const result =
    normalizedProvider === 'anthropic'
      ? await sendAnthropicChat({
          model: effectiveModel,
          systemPrompt: effectivePrompt,
          messages: normalizedMessages,
        })
      : await sendOpenAIChat({
          model: effectiveModel,
          systemPrompt: effectivePrompt,
          messages: normalizedMessages,
        });

  return {
    ...result,
    text: result.text || 'I could not generate a reply.',
    provider: normalizedProvider,
    model: effectiveModel,
    latencyMs: Date.now() - startedAt,
  };
}

function summarizeRoundStats(chats) {
  const totalChats = chats.length;
  const passCount = chats.filter((chat) => chat.verdict === 'pass').length;
  const reviewCount = chats.filter((chat) => chat.verdict === 'needs_review').length;
  const failCount = chats.filter((chat) => chat.verdict === 'fail').length;
  const averageConfidence = totalChats
    ? Math.round(chats.reduce((sum, chat) => sum + (chat.overallConfidence || 0), 0) / totalChats)
    : 0;
  const averageLatencyMs = totalChats
    ? Math.round(
        chats.reduce((sum, chat) => sum + (Number.isFinite(chat.latencyMs) ? chat.latencyMs : 0), 0) /
          totalChats,
      )
    : 0;
  const averageInputTokens = totalChats
    ? Math.round(
        chats.reduce((sum, chat) => sum + (Number.isFinite(chat.usage?.inputTokens) ? chat.usage.inputTokens : 0), 0) /
          totalChats,
      )
    : 0;
  const averageOutputTokens = totalChats
    ? Math.round(
        chats.reduce(
          (sum, chat) => sum + (Number.isFinite(chat.usage?.outputTokens) ? chat.usage.outputTokens : 0),
          0,
        ) / totalChats,
      )
    : 0;

  return {
    totalChats,
    passCount,
    reviewCount,
    failCount,
    averageConfidence,
    passRate: totalChats ? Math.round((passCount / totalChats) * 100) : 0,
    averageLatencyMs,
    averageInputTokens,
    averageOutputTokens,
  };
}

function inferPromptVariantFromRound(round) {
  const fileName = typeof round.promptFile === 'string' ? path.basename(round.promptFile) : '';
  return promptVariantAliases.get(round.promptVariant || '') || promptVariantAliases.get(fileName) || null;
}

function enrichRound(rootDir, round, payloadModel) {
  const promptVariant = inferPromptVariantFromRound(round) || getDefaultPromptVariant('openai');
  const provider = normalizeProvider(round.provider) || inferProviderFromPromptVariant(promptVariant);
  const promptMeta = resolvePromptVariant(rootDir, promptVariant, provider);
  const stats = summarizeRoundStats(round.chats || []);
  const model = round.model || payloadModel || defaultModelByProvider[provider];

  return {
    ...round,
    provider,
    providerLabel: getProviderLabel(provider),
    model,
    promptVariant: promptMeta.id,
    promptLabel: promptMeta.label,
    promptFile: round.promptFile || promptMeta.path,
    routeSlug: buildRoundSlug({
      provider,
      promptVariant: promptMeta.id,
      model,
    }),
    summary: {
      ...round.summary,
      passCount: round.summary?.passCount ?? stats.passCount,
      reviewCount: round.summary?.reviewCount ?? stats.reviewCount,
      failCount: round.summary?.failCount ?? stats.failCount,
      passRate: round.summary?.passRate ?? stats.passRate,
      averageLatencyMs: round.summary?.averageLatencyMs ?? stats.averageLatencyMs,
      averageInputTokens: round.summary?.averageInputTokens ?? stats.averageInputTokens,
      averageOutputTokens: round.summary?.averageOutputTokens ?? stats.averageOutputTokens,
    },
  };
}

function buildComparisons(rounds) {
  const groups = new Map();

  for (const round of rounds) {
    const key = round.compareGroup || round.promptVariant;
    const entry = groups.get(key) || {
      id: key,
      label: round.compareGroupLabel || round.promptLabel || round.promptVariant,
      rounds: [],
    };

    entry.rounds.push(round);
    groups.set(key, entry);
  }

  return [...groups.values()]
    .map((group) => {
      const providerCount = new Set(group.rounds.map((round) => round.provider)).size;

      if (providerCount < 2) {
        return null;
      }

      const ranked = group.rounds
        .map((round) => ({
          roundId: round.id,
          provider: round.provider,
          providerLabel: round.providerLabel,
          model: round.model,
          promptVariant: round.promptVariant,
          averageConfidence:
            typeof round.summary?.averageConfidence === 'number'
              ? round.summary.averageConfidence
              : summarizeRoundStats(round.chats || []).averageConfidence,
          passRate: round.summary?.passRate ?? summarizeRoundStats(round.chats || []).passRate,
          totalChats: round.chats?.length || 0,
        }))
        .sort((left, right) => right.averageConfidence - left.averageConfidence);

      return {
        ...group,
        bestProvider: ranked[0]?.provider || null,
        bestProviderLabel: ranked[0]?.providerLabel || null,
        confidenceSpread:
          ranked.length > 1 ? ranked[0].averageConfidence - ranked[ranked.length - 1].averageConfidence : 0,
        passRateSpread:
          ranked.length > 1 ? ranked[0].passRate - ranked[ranked.length - 1].passRate : 0,
        rounds: ranked,
      };
    })
    .filter(Boolean);
}

export function hydrateEvaluationPayload(rootDir, payload) {
  const rounds = (payload?.rounds || []).map((round) => enrichRound(rootDir, round, payload?.model));
  const totalChats =
    payload?.totalChats || rounds.reduce((sum, round) => sum + (round.chats?.length || 0), 0);
  const providerSet = new Set(rounds.map((round) => round.provider));

  return {
    ...payload,
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    totalChats,
    rounds,
    providers: [...providerSet],
    comparisons: Array.isArray(payload?.comparisons) && payload.comparisons.length ? payload.comparisons : buildComparisons(rounds),
  };
}
