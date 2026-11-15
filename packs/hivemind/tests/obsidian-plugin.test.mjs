// Slice D plugin tests. The plugin resolves the real service/graph through
// HIVEMIND_HOME, while every project fixture is an isolated mkdtemp directory.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import plugin, { loadModules, resolveHivemindHome } from '../opencode/hivemind-obsidian.mjs';
import {
  FRAMEWORK_RELATIVE,
  INTENTS,
  MANIFEST_NAME,
  MANAGED_NOTES,
} from '../obsidian/contracts.mjs';
import { refreshProject } from '../obsidian/service.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
process.env.HIVEMIND_HOME = ROOT;

const EXEC_CONTEXT = {
  sessionID: 'ses_plugin_fixture',
  agent: 'hivemind-architect',
  messageID: 'msg_plugin_fixture',
  id: 'call_plugin_fixture',
};

// Minimal valid legacy MOC sentinel; scripts/vault.mjs is omitted so the
// detector reports a read-only partial vault without spawning a legacy CLI.
const LEGACY_MOC = [
  '---',
  'id: moc-root',
  'title: MOC Root',
  '---',
  '',
  '# MOC',
  '',
].join('\n');

const roots = new Set();

async function makeRoot(prefix = 'hivemind-obsidian-plugin-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
}

after(async () => {
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})),
  );
});

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function frameworkRoot(root) {
  return path.join(root, ...FRAMEWORK_RELATIVE.split('/'));
}

function managedFiles(root) {
  const framework = frameworkRoot(root);
  return [
    ...MANAGED_NOTES.map((name) => path.join(framework, name)),
    path.join(framework, MANIFEST_NAME),
  ];
}

async function fingerprint(files) {
  const result = {};
  for (const file of files) {
    const stat = await fs.stat(file, { bigint: true });
    result[file] = {
      mtimeNs: stat.mtimeNs.toString(),
      size: stat.size.toString(),
      bytes: (await fs.readFile(file)).toString('base64'),
    };
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function makeContext(options = {}) {
  const pluginDirectory = options.pluginDirectory;
  const sessionDirectory = options.sessionDirectory;
  const calls = {
    sessionGet: [],
    sessionContext: [],
    permission: [],
    transform: 0,
  };
  let messages = options.messages ?? [];
  let permissionError = options.permissionError ?? null;
  let tool = null;

  const ctx = {
    // Deliberately unrelated to the session location.
    location: { directory: pluginDirectory },
    session: {
      async get(input) {
        calls.sessionGet.push(input);
        return {
          id: input.sessionID,
          location: { directory: sessionDirectory },
          time: { created: 0, updated: 0 },
        };
      },
      async context(input) {
        calls.sessionContext.push(input);
        return messages;
      },
    },
    permission: {
      async assert(input) {
        calls.permission.push(input);
        if (permissionError) throw permissionError;
      },
    },
    tool: {
      async transform(callback) {
        calls.transform += 1;
        const editor = {
          add(definition) {
            tool = definition;
          },
        };
        callback(editor);
        return { async dispose() {} };
      },
    },
  };

  return {
    ctx,
    calls,
    get tool() {
      return tool;
    },
    setMessages(next) {
      messages = next;
    },
    setPermissionError(error) {
      permissionError = error;
    },
  };
}

async function installTool(options) {
  const harness = makeContext(options);
  await plugin.setup(harness.ctx);
  assert.equal(harness.calls.transform, 1, 'setup must register exactly one transform');
  assert.ok(harness.tool, 'setup must add the obsidian_status tool');
  return harness;
}

function revisionOf(content) {
  const match = content.match(/^revision\s+([0-9a-f]{16})$/mu);
  assert.ok(match, 'status output must contain a 16-hex-character context revision');
  return match[1];
}

test('plugin exports a plain V2 id/setup and registers read-only obsidian_status', async () => {
  assert.equal(typeof plugin.id, 'string');
  assert.equal(typeof plugin.setup, 'function');

  const root = await makeRoot();
  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: path.join(root, 'session-location'),
    messages: [],
  });
  const tool = harness.tool;

  assert.equal(tool.name, 'obsidian_status');
  assert.equal(typeof tool.description, 'string');
  assert.match(tool.description, /read-only/iu);
  assert.deepEqual(tool.options, { codemode: true });
  assert.equal(tool.input.type, 'object');
  assert.deepEqual(Object.keys(tool.input.properties), ['intent']);
  assert.deepEqual(tool.input.properties.intent.enum, INTENTS);
  assert.equal(tool.input.additionalProperties, false);
  assert.equal(typeof tool.execute, 'function');
});

test('an installed copy outside the repo loads modules through HIVEMIND_HOME', async () => {
  const root = await makeRoot();
  const pluginsDirectory = path.join(root, 'opencode', 'plugins');
  const project = path.join(root, 'project');
  await fs.mkdir(pluginsDirectory, { recursive: true });
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'app.js'), 'export const app = 1;\n');

  // Simulate deployment: the plugin runs from a path with no relative access
  // to obsidian/service.mjs or obsidian/graph.mjs.
  const source = await fs.readFile(path.join(ROOT, 'opencode', 'hivemind-obsidian.mjs'), 'utf8');
  const copyPath = path.join(pluginsDirectory, 'hivemind-obsidian.mjs');
  await fs.writeFile(copyPath, source);
  const copied = await import(pathToFileURL(copyPath).href);

  assert.equal(typeof copied.default.id, 'string');
  assert.equal(typeof copied.default.setup, 'function');
  const harness = makeContext({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: project,
    messages: [],
  });
  await copied.default.setup(harness.ctx);

  const { content } = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  assert.ok(content.includes(`project    ${path.resolve(project)}`));
  assert.match(content, /state      absent/u);
});

test('invalid input is rejected before session lookup, permission, or scan', async () => {
  const root = await makeRoot();
  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: path.join(root, 'missing-project'),
    messages: [],
  });

  const invalidInputs = [
    null,
    [],
    'general',
    42,
    { intent: 'deploy' },
    { intent: 7 },
    { project: root },
    { intent: 'general', extra: true },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      harness.tool.execute(input, EXEC_CONTEXT),
      /obsidian_status/u,
      `must reject ${JSON.stringify(input)}`,
    );
  }

  assert.deepEqual(harness.calls.sessionGet, []);
  assert.deepEqual(harness.calls.permission, []);
  assert.deepEqual(harness.calls.sessionContext, []);
});

test('permission denial propagates before scanning or reading context', async () => {
  const root = await makeRoot();
  const missingProject = path.join(root, 'does-not-exist');
  const denial = Object.assign(new Error('fixture permission denied'), {
    code: 'permission.rejected',
  });
  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: missingProject,
    messages: [],
    permissionError: denial,
  });

  // If the project were scanned first, service.mjs would report a project error
  // instead of propagating this sentinel permission rejection.
  await assert.rejects(
    harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT),
    (error) => error === denial,
  );

  assert.deepEqual(harness.calls.sessionGet, [{ sessionID: EXEC_CONTEXT.sessionID }]);
  assert.equal(harness.calls.permission.length, 1);
  assert.deepEqual(harness.calls.permission[0], {
    sessionID: EXEC_CONTEXT.sessionID,
    agent: EXEC_CONTEXT.agent,
    source: {
      type: 'tool',
      messageID: EXEC_CONTEXT.messageID,
      id: EXEC_CONTEXT.id,
    },
    action: 'read',
    resources: [missingProject],
  });
  assert.deepEqual(harness.calls.sessionContext, []);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('session location drives the scan instead of plugin location; absent and ready are read-only', async () => {
  const root = await makeRoot();
  const pluginDirectory = path.join(root, 'plugin-location');
  const sessionDirectory = path.join(root, 'moved-project');
  await fs.mkdir(pluginDirectory);
  await fs.mkdir(sessionDirectory);
  await fs.writeFile(path.join(pluginDirectory, 'plugin-only.txt'), 'plugin marker\n');
  await fs.writeFile(path.join(sessionDirectory, 'app.js'), 'export const app = 1;\n');

  const harness = await installTool({
    pluginDirectory,
    sessionDirectory,
    messages: [{ id: 'msg_user_a', type: 'user', text: 'fixture prompt', time: { created: 1 } }],
  });

  const absent = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  assert.ok(absent.content.includes(`project    ${path.resolve(sessionDirectory)}`));
  assert.ok(!absent.content.includes(path.resolve(pluginDirectory)));
  assert.match(absent.content, /state      absent \(not initialized; run create --confirm\)/u);
  assert.equal(await exists(path.join(pluginDirectory, '.hivemind')), false);
  assert.equal(await exists(path.join(sessionDirectory, '.hivemind')), false);

  await refreshProject(sessionDirectory, { create: true });
  const before = await fingerprint(managedFiles(sessionDirectory));

  const ready = await harness.tool.execute({ intent: 'feature' }, EXEC_CONTEXT);
  assert.ok(ready.content.includes(`project    ${path.resolve(sessionDirectory)}`));
  assert.ok(!ready.content.includes(path.resolve(pluginDirectory)));
  assert.match(ready.content, /state      ready \(managed framework detected\)/u);

  await harness.tool.execute({ intent: 'bugfix' }, EXEC_CONTEXT);
  await harness.tool.execute({ intent: 'refactor' }, EXEC_CONTEXT);

  const current = await fingerprint(managedFiles(sessionDirectory));
  assert.deepEqual(current, before, 'status must not write managed framework files');
  assert.equal(await exists(path.join(pluginDirectory, '.hivemind')), false);
});

test('native rendered status exposes legacy vault metadata without writes', async () => {
  const root = await makeRoot();
  const vaultDirectory = path.join(root, '.opencode', 'vault');
  await fs.mkdir(vaultDirectory, { recursive: true });
  const moc = path.join(vaultDirectory, '00-MOC.md');
  await fs.writeFile(moc, LEGACY_MOC);
  const before = await fingerprint([moc]);

  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: root,
    messages: [],
  });
  const { content } = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);

  assert.ok(content.includes(`project    ${path.resolve(root)}`));
  assert.match(content, /state      absent/u);
  assert.match(content, /^legacy     present$/mu);
  assert.match(content, /^legacy state partial$/mu);
  assert.ok(content.includes(`legacy path ${path.resolve(vaultDirectory)}`));
  assert.match(content, /^legacy detector vault-detect$/mu);
  assert.match(content, /legacy Obsidian context vault detected/u);
  assert.doesNotMatch(content, /^dual /mu);
  assert.doesNotMatch(content, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);

  assert.deepEqual(await fingerprint([moc]), before, 'status must not modify legacy sentinels');
  assert.equal(await exists(path.join(root, '.hivemind')), false);
  assert.equal(await exists(path.join(root, 'plugin-location', '.hivemind')), false);
});

test('each added user turn changes the context revision with unchanged project files', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'app.js'), 'export const app = 1;\n');
  await refreshProject(root, { create: true });
  const files = managedFiles(root);
  const before = await fingerprint(files);

  const user1 = {
    id: 'msg_user_1',
    type: 'user',
    text: 'PROMPT_SECRET_ONE',
    time: { created: 100 },
  };
  const assistant1 = {
    id: 'msg_assistant_1',
    type: 'assistant',
    agent: 'hivemind-architect',
    content: [
      {
        type: 'tool',
        name: 'read',
        state: { status: 'completed', input: { secret: 'TOOL_SECRET' }, content: [] },
      },
      { type: 'text', text: 'ASSISTANT_SECRET' },
      { type: 'reasoning', text: 'REASONING_SECRET' },
    ],
    time: { created: 101 },
  };

  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: root,
    messages: [user1, assistant1],
  });

  const first = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  const firstRevision = revisionOf(first.content);
  assert.match(first.content, /counts     user 1 \/ assistant 1/u);
  assert.match(first.content, /last user  msg_user_1/u);
  assert.match(first.content, /compaction can reduce/iu);
  for (const secret of ['PROMPT_SECRET_ONE', 'ASSISTANT_SECRET', 'REASONING_SECRET', 'TOOL_SECRET']) {
    assert.ok(!first.content.includes(secret), `must not render ${secret}`);
  }

  // Rendering time is not part of the revision.
  const repeated = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  assert.equal(revisionOf(repeated.content), firstRevision);

  const user2 = {
    id: 'msg_user_2',
    type: 'user',
    text: 'PROMPT_SECRET_TWO',
    time: { created: 200 },
  };
  harness.setMessages([user1, assistant1, user2]);
  const second = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  const secondRevision = revisionOf(second.content);
  assert.notEqual(secondRevision, firstRevision, 'a new admitted user message must change the revision');
  assert.match(second.content, /counts     user 2 \/ assistant 1/u);
  assert.match(second.content, /last user  msg_user_2/u);

  // Compaction may remove assistant entries; counts reflect the current context only.
  harness.setMessages([user1, user2]);
  const compacted = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);
  assert.match(compacted.content, /counts     user 2 \/ assistant 0/u);

  const current = await fingerprint(files);
  assert.deepEqual(current, before, 'status calls must not modify project or framework files');
  assert.equal(await exists(path.join(root, '.hivemind', 'obsidian', 'activity.json')), false);
});

test('observed context is bounded, sanitized, deduplicated, and content-free', async () => {
  const root = await makeRoot();
  const toolNames = Array.from(
    { length: 20 },
    (_, index) => `tool_${String(index).padStart(2, '0')}`,
  );
  const messages = [
    { id: 'msg_user_secret', type: 'user', text: 'PROMPT_SECRET', time: { created: 0 } },
    {
      id: 'msg_assistant_secret',
      type: 'assistant',
      agent: 'agent\n\u001b[31msecret',
      content: [
        ...toolNames.map((name) => ({
          type: 'tool',
          name,
          state: { status: 'completed', input: { secret: 'TOOL_SECRET' }, content: [] },
        })),
        { type: 'tool', name: 'dup', state: { status: 'running', input: {} } },
        { type: 'tool', name: 'dup', state: { status: 'completed', input: {} } },
        { type: 'text', text: 'ASSISTANT_SECRET' },
        { type: 'reasoning', text: 'REASONING_SECRET' },
      ],
      time: { created: 1 },
    },
  ];
  const serializedBefore = JSON.stringify(messages);
  deepFreeze(messages);

  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: root,
    messages,
  });
  const { content } = await harness.tool.execute({ intent: 'general' }, EXEC_CONTEXT);

  for (const secret of ['PROMPT_SECRET', 'ASSISTANT_SECRET', 'REASONING_SECRET', 'TOOL_SECRET']) {
    assert.ok(!content.includes(secret), `must not render ${secret}`);
  }
  assert.ok(!content.includes('\u0000'));
  assert.ok(!content.includes('\u001b'));

  const observed = content.slice(content.indexOf('OBSERVED CURRENT SESSION'));
  assert.ok(observed.length > 0);
  assert.match(observed, /^[\x09\x0a\x20-\x7e]*$/u, 'observed layer must be printable ASCII');
  assert.match(observed, /^agents\s+agent \?\[31msecret$/mu);
  assert.match(observed, /^tools\s+.*, \.\.\.$/mu);

  const toolsLine = observed.match(/^tools\s+(.*)$/mu)?.[1];
  assert.ok(toolsLine);
  const renderedNames = toolsLine.split(', ').filter(Boolean);
  assert.ok(renderedNames.length <= 13, 'tool names must be bounded to 12 plus an ellipsis marker');
  assert.equal((toolsLine.match(/dup/gu) || []).length, 1, 'tool names must be unique');
  assert.ok(content.length <= 24000);
  assert.equal(JSON.stringify(messages), serializedBefore, 'messages must not be mutated');
});

test('reports every suggested branch and marks the selected intent', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, 'app.js'), 'export const app = 1;\n');
  const harness = await installTool({
    pluginDirectory: path.join(root, 'plugin-location'),
    sessionDirectory: root,
    messages: [{ id: 'msg_user_1', type: 'user', text: 'fixture prompt', time: { created: 1 } }],
  });

  for (const intent of INTENTS) {
    const { content } = await harness.tool.execute({ intent }, EXEC_CONTEXT);
    assert.ok(content.includes(`selected intent: ${intent}`), `must select ${intent}`);
    for (const branch of INTENTS) {
      assert.ok(content.includes(`[${branch}]`), `must show suggested branch ${branch}`);
    }
    assert.equal((content.match(/<<< SELECTED/gu) || []).length, 1);
    assert.ok(content.includes(`[${intent}] <<< SELECTED`));
  }

  const defaulted = await harness.tool.execute({}, EXEC_CONTEXT);
  assert.ok(defaulted.content.includes('selected intent: general'));
});

test('resolves HIVEMIND_HOME or the home config fallback and loads absolute module URLs', async () => {
  const custom = path.join(os.tmpdir(), 'hivemind-home-fixture');
  assert.equal(resolveHivemindHome({ HIVEMIND_HOME: custom }), path.resolve(custom));
  assert.equal(
    resolveHivemindHome({ HIVEMIND_HOME: '   ' }),
    path.join(os.homedir(), '.config', 'hivemind'),
  );
  assert.equal(
    resolveHivemindHome({}),
    path.join(os.homedir(), '.config', 'hivemind'),
  );

  const modules = await loadModules(ROOT);
  assert.equal(typeof modules.service.inspectProject, 'function');
  assert.equal(typeof modules.graph.renderStatus, 'function');
  assert.deepEqual(modules.contracts.INTENTS, INTENTS);

  const missingHome = path.join(os.tmpdir(), `hivemind-missing-home-${process.pid}-${Date.now()}`);
  await assert.rejects(
    loadModules(missingHome),
    /Cannot find|ERR_MODULE_NOT_FOUND|ENOENT|ENOTDIR|does not exist/iu,
  );
});
