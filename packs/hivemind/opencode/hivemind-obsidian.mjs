// Slice D: native V2 plugin providing a read-only `obsidian_status` tool.
//
// The installed plugin lives under `opencode/plugins/hivemind-obsidian.js`, so it
// must not use relative imports. The service and graph modules are loaded from an
// absolute file URL resolved from HIVEMIND_HOME (or ~/.config/hivemind).
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_ID = 'hivemind.obsidian';
const TOOL_NAME = 'obsidian_status';
const DEFAULT_INTENT = 'general';
const MAX_ID_LENGTH = 96;
const MAX_NAME_LENGTH = 48;
const MAX_NAMES = 12;
const MAX_COLLECTED_NAMES = 64;
const MAX_OUTPUT_CHARS = 24000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export function resolveHivemindHome(env = process.env) {
  const configured = env && typeof env.HIVEMIND_HOME === 'string'
    ? env.HIVEMIND_HOME.trim()
    : '';
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.config', 'hivemind');
}

export async function loadModules(home = resolveHivemindHome()) {
  const base = path.join(home, 'obsidian');
  const moduleUrl = (name) => pathToFileURL(path.join(base, `${name}.mjs`)).href;
  const [contracts, service, graph] = await Promise.all([
    import(moduleUrl('contracts')),
    import(moduleUrl('service')),
    import(moduleUrl('graph')),
  ]);

  if (!contracts || !Array.isArray(contracts.INTENTS) || contracts.INTENTS.length === 0) {
    throw new Error(`hivemind obsidian: ${path.join(base, 'contracts.mjs')} does not export INTENTS`);
  }
  if (!service || typeof service.inspectProject !== 'function') {
    throw new Error(`hivemind obsidian: ${path.join(base, 'service.mjs')} does not export inspectProject`);
  }
  if (!graph || typeof graph.renderStatus !== 'function') {
    throw new Error(`hivemind obsidian: ${path.join(base, 'graph.mjs')} does not export renderStatus`);
  }
  return { contracts, service, graph };
}

function invalid(message) {
  throw new Error(`${TOOL_NAME}: ${message}`);
}

function sanitizeAscii(value, maximum) {
  let text;
  try {
    text = String(value);
  } catch {
    return '';
  }
  text = text
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[^\x20-\x7e]/gu, '?')
    .replace(/ {2,}/gu, ' ')
    .trim();
  if (maximum !== undefined && text.length > maximum) {
    const keep = Math.max(0, maximum - 3);
    text = `${text.slice(0, keep)}...`;
  }
  return text;
}

function stripControl(text) {
  return String(text)
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/[\u2028\u2029]/gu, '\n');
}

function boundOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const marker = '\n[output truncated]\n';
  return `${text.slice(0, MAX_OUTPUT_CHARS - marker.length)}${marker}`;
}

function normalizeInput(input, intents) {
  if (input === undefined) input = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'intent') {
      invalid(`unsupported input field: ${sanitizeAscii(key, 32) || '(unnamed)'}`);
    }
  }
  const intent = Object.hasOwn(input, 'intent') ? input.intent : DEFAULT_INTENT;
  if (typeof intent !== 'string' || !intents.includes(intent)) {
    invalid(`intent must be one of: ${intents.join(', ')}`);
  }
  return { intent };
}

function requireContextString(context, field) {
  const value = context && typeof context === 'object' ? context[field] : undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    invalid(`tool context is missing a valid ${field}`);
  }
  return value;
}

function normalizeToolContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    invalid('tool context must be an object');
  }
  return {
    sessionID: requireContextString(context, 'sessionID'),
    agent: requireContextString(context, 'agent'),
    messageID: requireContextString(context, 'messageID'),
    id: requireContextString(context, 'id'),
  };
}

function sessionDirectory(session) {
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    invalid('session lookup did not return a session object');
  }
  const location = session.location;
  if (location === null || typeof location !== 'object' || Array.isArray(location)) {
    invalid('session has no location');
  }
  const directory = location.directory;
  if (typeof directory !== 'string' || directory.trim() === '' || directory.includes('\0')) {
    invalid('session location has no valid project directory');
  }
  return directory;
}

function collectName(names, value, state) {
  if (typeof value !== 'string') return;
  const name = sanitizeAscii(value, MAX_NAME_LENGTH);
  if (!name) return;
  if (names.has(name)) return;
  if (names.size >= MAX_COLLECTED_NAMES) {
    state.overflow = true;
    return;
  }
  names.add(name);
}

function revisionFor(identity) {
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 16);
}

function summarizeContext(messages) {
  if (!Array.isArray(messages)) {
    invalid('session context is not an array');
  }

  let users = 0;
  let assistants = 0;
  let lastUserID = '';
  const identity = [];
  const toolNames = new Set();
  const agentNames = new Set();
  const toolState = { overflow: false };
  const agentState = { overflow: false };

  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      // Keep the revision sensitive to every admitted entry, even malformed ones.
      identity.push(['', 'invalid']);
      continue;
    }
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    const id = typeof message.id === 'string' ? message.id : '';
    identity.push([id, type]);

    if (type === 'user') {
      users += 1;
      lastUserID = id;
      continue;
    }
    if (type !== 'assistant') continue;

    assistants += 1;
    collectName(agentNames, message.agent, agentState);
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
      if (part.type === 'tool') collectName(toolNames, part.name, toolState);
    }
  }

  return {
    users,
    assistants,
    lastUserID,
    revision: revisionFor(identity),
    toolNames,
    toolOverflow: toolState.overflow,
    agentNames,
    agentOverflow: agentState.overflow,
  };
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderNames(names, overflow) {
  if (names.size === 0) return 'none';
  const sorted = [...names].sort(compareNames);
  const shown = sorted.slice(0, MAX_NAMES);
  let text = shown.join(', ');
  if (overflow || sorted.length > shown.length) text += ', ...';
  return text;
}

function renderObservedContext(summary) {
  const lastUser = summary.users === 0
    ? '(none)'
    : summary.lastUserID
      ? sanitizeAscii(summary.lastUserID, MAX_ID_LENGTH)
      : '(missing)';

  return [
    '',
    'OBSERVED CURRENT SESSION (current context only; not persisted)',
    'notes      counts reflect the current session context; compaction can reduce them',
    'notes      prompt, reasoning, and tool content are excluded; no activity timestamp is claimed',
    `counts     user ${summary.users} / assistant ${summary.assistants}`,
    `last user  ${lastUser}`,
    `revision   ${summary.revision}`,
    `agents     ${renderNames(summary.agentNames, summary.agentOverflow)}`,
    `tools      ${renderNames(summary.toolNames, summary.toolOverflow)}`,
    '',
  ].join('\n');
}

function createStatusTool(ctx, modules) {
  const intents = [...modules.contracts.INTENTS];

  return {
    name: TOOL_NAME,
    description:
      'Read-only status for the project attached to the invoking session, not the plugin installation directory. '
      + 'Shows managed Obsidian framework state, suggested swarm traversal branches, and current-session context counts, '
      + 'revision, agent names, and tool names. Never writes files and never reveals prompt, reasoning, or tool content.',
    input: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: intents,
          description: 'Suggested swarm traversal intent. Defaults to general.',
        },
      },
      additionalProperties: false,
    },
    options: { codemode: true },
    execute: async (input, context) => {
      const { intent } = normalizeInput(input, intents);
      const toolContext = normalizeToolContext(context);

      // Resolve the project from the invoking session, never from ctx.location.
      const session = await ctx.session.get({ sessionID: toolContext.sessionID });
      const directory = sessionDirectory(session);

      // Read permission is checked before any project scan or context read.
      await ctx.permission.assert({
        sessionID: toolContext.sessionID,
        agent: toolContext.agent,
        source: {
          type: 'tool',
          messageID: toolContext.messageID,
          id: toolContext.id,
        },
        action: 'read',
        resources: [directory],
      });

      const snapshot = await modules.service.inspectProject(directory);
      const messages = await ctx.session.context({ sessionID: toolContext.sessionID });
      const summary = summarizeContext(messages);

      const status = modules.graph.renderStatus(snapshot, { intent });
      const observed = renderObservedContext(summary);
      return { content: boundOutput(stripControl(`${status}\n${observed}`)) };
    },
  };
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const modules = await loadModules();
    await ctx.tool.transform((editor) => {
      editor.add(createStatusTool(ctx, modules));
    });
  },
};
