/**
 * MCP client — spawns the StayPortal MCP server, lists tools, and
 * provides a callTool() helper used by the Anthropic chat loop.
 *
 * The client is initialised once and reused across requests.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, '..', 'mcp', 'server.js');

let _client = null;
let _tools = null; // cached Anthropic-format tool definitions

async function getClient() {
  if (_client) return _client;

  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    env: { ...process.env },
  });

  _client = new Client({ name: 'rova-chatbot', version: '1.0.0' }, { capabilities: {} });
  await _client.connect(transport);
  return _client;
}

/**
 * Returns tool definitions in Anthropic's format:
 * [{ name, description, input_schema }]
 */
export async function listAnthropicTools() {
  if (_tools) return _tools;

  const client = await getClient();
  const { tools } = await client.listTools();

  _tools = tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {}, required: [] },
  }));

  return _tools;
}

/**
 * Calls a single MCP tool by name with the given input object.
 * Returns the parsed result or throws on error.
 */
export async function callTool(name, input) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: input });

  const textBlock = result.content?.find((c) => c.type === 'text');
  if (!textBlock) throw new Error(`MCP tool "${name}" returned no text content.`);

  const parsed = JSON.parse(textBlock.text);
  if (result.isError || parsed?.error) {
    throw new Error(parsed?.error || 'MCP tool returned an error.');
  }

  return parsed;
}

/**
 * Gracefully close the MCP client connection (call on server shutdown).
 */
export async function closeMCPClient() {
  if (_client) {
    await _client.close();
    _client = null;
    _tools = null;
  }
}
