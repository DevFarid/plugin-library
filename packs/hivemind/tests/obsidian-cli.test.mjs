// Slice B CLI/graph tests. Unique fixture roots only; no live project or vault writes.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  FRAMEWORK_RELATIVE,
  INTENTS,
  MANIFEST_NAME,
  MANAGED_NOTES,
  ObsidianError,
} from '../obsidian/contracts.mjs';
import { main } from '../obsidian/cli.mjs';
import { renderStatus } from '../obsidian/graph.mjs';

const roots = new Set();

// Minimal valid legacy MOC sentinel. The matching scripts/vault.mjs sentinel is
// intentionally omitted so detection stays a pure read of a partial vault and
// no legacy CLI is spawned.
const LEGACY_MOC = [
  '---',
  'id: moc-root',
  'title: MOC Root',
  '---',
  '',
  '# MOC',
  '',
].join('\n');

async function makeRoot(prefix = 'hivemind-obsidian-cli-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
}

after(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

function frameworkRoot(root) {
  return path.join(root, ...FRAMEWORK_RELATIVE.split('/'));
}

function notePath(root, name) {
  return path.join(frameworkRoot(root), name);
}

function manifestPath(root) {
  return path.join(frameworkRoot(root), MANIFEST_NAME);
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fingerprintTree(root) {
  const result = {};
  async function walk(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result[key] = 'dir';
        await walk(absolute, key);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute, { bigint: true });
        result[key] = `${stat.mtimeNs}:${(await fs.readFile(absolute)).toString('base64')}`;
      } else {
        result[key] = 'other';
      }
    }
  }
  await walk(root, '');
  return result;
}

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: { write(chunk) { out += chunk; return true; } },
    stderr: { write(chunk) { err += chunk; return true; } },
    out() { return out; },
    err() { return err; },
  };
}

async function run(argv, cwd) {
  const streams = capture();
  const code = await main(argv, { cwd, stdout: streams.stdout, stderr: streams.stderr });
  return { code, stdout: streams.out(), stderr: streams.err() };
}

// Newlines and tabs are legitimate formatting; every other C0/C1 control and
// DEL is a terminal-injection risk in human output.
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

function assertNoTerminalControls(text, label) {
  assert.doesNotMatch(text, TERMINAL_CONTROL_PATTERN, `${label} must not contain terminal control characters`);
}

async function makeProject(files = ['src/a.js', 'README.md']) {
  const root = await makeRoot();
  for (const file of files) {
    const target = path.join(root, ...file.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `// ${file}\n`);
  }
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'ignored\n');
  await fs.writeFile(path.join(root, '.hidden'), 'ignored\n');
  return root;
}

function assertAllIntentBranches(text, selected) {
  for (const intent of INTENTS) {
    assert.ok(text.includes(`[${intent}]`), `graph should include ${intent}`);
  }
  assert.ok(text.includes(`[${selected}] <<< SELECTED`), `graph should highlight ${selected}`);
  assert.match(text, /suggested, not observed execution history/iu);
  assert.match(text, /rendered at \S+ \(display timestamp only; not observed project activity\)/u);
}

test('help and status are read-only and status graphs every suggested intent', async () => {
  const root = await makeProject();
  const before = await fingerprintTree(root);

  const help = await run(['help'], root);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/u);
  assert.equal(help.stderr, '');

  const helpJson = await run(['help', '--json'], root);
  assert.equal(helpJson.code, 0);
  const parsedHelp = JSON.parse(helpJson.stdout);
  assert.equal(parsedHelp.ok, true);
  assert.deepEqual(parsedHelp.actions, ['help', 'status', 'create', 'sync-now']);
  assert.deepEqual(parsedHelp.intents, INTENTS);

  for (const intent of INTENTS) {
    const result = await run(['status', '--intent', intent], root);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /state      absent/u);
    assert.match(result.stdout, /scan       2 file\(s\) \(complete\)/u);
    assertAllIntentBranches(result.stdout, intent);
  }

  const statusJson = await run(['status', '--intent', 'bugfix', '--json'], root);
  assert.equal(statusJson.code, 0);
  const parsedStatus = JSON.parse(statusJson.stdout);
  assert.equal(parsedStatus.ok, true);
  assert.equal(parsedStatus.action, 'status');
  assert.equal(parsedStatus.state, 'absent');
  assert.equal(parsedStatus.intent, 'bugfix');
  assert.deepEqual(parsedStatus.scan, { files: 2, truncated: false });
  assert.deepEqual(parsedStatus.warnings, []);
  assert.deepEqual(parsedStatus.suggestedBranches, INTENTS);

  assert.deepEqual(await fingerprintTree(root), before);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('invalid actions and flags fail with code 2 before any writes', async () => {
  const root = await makeProject();
  const before = await fingerprintTree(root);
  const cases = [
    [],
    ['bogus'],
    ['status', '--nope'],
    ['status', '--project'],
    ['status', '--project', '--json'],
    ['status', '--intent', 'shiny'],
    ['status', '--intent', 'feature', '--intent', 'bugfix'],
    ['status', '--confirm'],
    ['create'],
    ['create', '--confirm', '--intent', 'feature'],
    ['sync-now', '--confirm'],
    ['help', '--project', 'x'],
    ['status', '--json', '--json'],
  ];
  for (const argv of cases) {
    const result = await run(argv, root);
    assert.equal(result.code, 2, `argv ${JSON.stringify(argv)} should be a usage error`);
    assert.match(result.stderr, /usage/u);
  }

  const missing = await run(['status', '--project', path.join(root, 'missing'), '--json'], root);
  assert.equal(missing.code, 2);
  const missingJson = JSON.parse(missing.stderr);
  assert.equal(missingJson.ok, false);
  assert.equal(missingJson.error.code, 'project');

  assert.deepEqual(await fingerprintTree(root), before);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('human usage errors escape terminal controls from unknown argv values', async () => {
  const root = await makeProject();
  const malicious = '--bad\u001b[2J\u009b2J\u000dX\u007f';

  const result = await run(['help', malicious], root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage/u);
  assertNoTerminalControls(result.stderr, 'human stderr');
  assert.match(result.stderr, /\\u001b\[2J/u);
  assert.match(result.stderr, /\\u009b2J/u);
  assert.match(result.stderr, /\\u000dX/u);
  assert.match(result.stderr, /\\u007f/u);
  assert.ok(!result.stderr.includes('\u001b'));
  assert.ok(!result.stderr.includes('\u009b'));
});

test('json usage errors preserve original control characters through JSON escaping', async () => {
  const root = await makeProject();
  const malicious = '--bad\u001b[2J\u009b2J\u000dX\u007f';

  const result = await run(['help', malicious, '--json'], root);
  assert.equal(result.code, 2);
  assertNoTerminalControls(result.stderr, 'json stderr');
  assert.match(result.stderr, /\\u001b/u);
  assert.match(result.stderr, /\\u009b/u);

  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'usage');
  assert.ok(
    parsed.error.message.includes(malicious),
    'parsed JSON must retain the original unmutated control characters',
  );
});

test('human refresh and status output escape controls in valid project paths', async (t) => {
  const outer = await makeRoot();
  const project = path.join(outer, 'project\u009bwith\u009dcontrols');
  try {
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.writeFile(path.join(project, 'src', 'a.js'), 'export const a = 1;\n');
  } catch (error) {
    t.skip(`filesystem does not allow control characters in paths: ${error && error.code ? error.code : 'error'}`);
    return;
  }

  const created = await run(['create', '--confirm', '--project', project], outer);
  assert.equal(created.code, 0);
  assertNoTerminalControls(created.stdout, 'create stdout');
  assert.match(created.stdout, /\\u009b/u);
  assert.match(created.stdout, /\\u009d/u);
  assert.ok(!created.stdout.includes('\u009b'));
  assert.ok(!created.stdout.includes('\u009d'));

  const statusHuman = await run(['status', '--project', project], outer);
  assert.equal(statusHuman.code, 0);
  assertNoTerminalControls(statusHuman.stdout, 'status stdout');
  assert.match(statusHuman.stdout, /\\u009b/u);

  const syncJson = await run(['sync-now', '--project', project, '--json'], outer);
  assert.equal(syncJson.code, 0);
  assertNoTerminalControls(syncJson.stdout, 'sync json stdout');
  const parsed = JSON.parse(syncJson.stdout);
  assert.equal(parsed.projectRoot, path.resolve(project));
  assert.ok(parsed.projectRoot.includes('\u009b'));
  assert.ok(parsed.projectRoot.includes('\u009d'));
});

test('human status output escapes controls in scan warnings while json preserves them', async () => {
  const root = await makeProject();
  const hostile = path.join(root, 'warning\u009bdir');
  await fs.mkdir(hostile);
  const originalReaddir = fs.readdir;
  fs.readdir = async (target, options) => {
    if (target === hostile) {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    }
    return originalReaddir.call(fs, target, options);
  };
  try {
    const human = await run(['status'], root);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /unable to scan subdirectory/u);
    assertNoTerminalControls(human.stdout, 'status warning stdout');
    assert.match(human.stdout, /\\u009b/u);
    assert.ok(!human.stdout.includes('\u009b'));

    const json = await run(['status', '--json'], root);
    assert.equal(json.code, 0);
    assertNoTerminalControls(json.stdout, 'status warning json stdout');
    assert.match(json.stdout, /\\u009b/u);
    const parsed = JSON.parse(json.stdout);
    assert.ok(parsed.warnings.some((warning) => warning.includes('\u009b')));
  } finally {
    fs.readdir = originalReaddir;
  }
});

test('create requires confirm and sync-now never initializes an absent framework', async () => {
  const root = await makeProject();

  const refused = await run(['create', '--json'], root);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stderr).error.code, 'usage');
  assert.equal(await exists(path.join(root, '.hivemind')), false);

  const syncAbsent = await run(['sync-now', '--json'], root);
  assert.equal(syncAbsent.code, 2);
  assert.equal(JSON.parse(syncAbsent.stderr).error.code, 'unconfigured');
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('real fixture lifecycle: create, status, idempotent sync, changed filenames, conflict', async () => {
  const root = await makeProject();

  const created = await run(['create', '--confirm', '--json'], root);
  assert.equal(created.code, 0);
  const createdJson = JSON.parse(created.stdout);
  assert.equal(createdJson.status, 'created');
  assert.deepEqual(createdJson.counts, {
    created: MANAGED_NOTES.length,
    updated: 0,
    unchanged: 0,
  });
  assert.equal(await exists(path.join(frameworkRoot(root), '.obsidian')), true);
  for (const name of MANAGED_NOTES) {
    assert.equal(await exists(notePath(root, name)), true);
  }
  assert.equal(JSON.parse(await fs.readFile(manifestPath(root), 'utf8')).schemaVersion, 1);

  const ready = await run(['status', '--json', '--intent', 'refactor'], root);
  assert.equal(ready.code, 0);
  const readyJson = JSON.parse(ready.stdout);
  assert.equal(readyJson.state, 'ready');
  assert.deepEqual(readyJson.scan, { files: 2, truncated: false });
  assert.deepEqual(readyJson.warnings, []);

  const statusBefore = await fingerprintTree(root);
  await run(['status', '--intent', 'feature'], root);
  await run(['help'], root);
  await run(['status', '--intent', 'nope'], root);
  assert.deepEqual(await fingerprintTree(root), statusBefore);

  const unchanged = await run(['sync-now', '--json'], root);
  assert.equal(unchanged.code, 0);
  const unchangedJson = JSON.parse(unchanged.stdout);
  assert.equal(unchangedJson.status, 'unchanged');
  assert.deepEqual(unchangedJson.counts, {
    created: 0,
    updated: 0,
    unchanged: MANAGED_NOTES.length,
  });

  const beforeRename = await fingerprintTree(frameworkRoot(root));
  await fs.rename(path.join(root, 'src', 'a.js'), path.join(root, 'src', 'b.js'));
  const updated = await run(['sync-now', '--json'], root);
  assert.equal(updated.code, 0);
  const updatedJson = JSON.parse(updated.stdout);
  assert.equal(updatedJson.status, 'updated');
  assert.equal(updatedJson.counts.updated, 1);
  assert.equal(updatedJson.counts.unchanged, MANAGED_NOTES.length - 1);
  const filesNote = await fs.readFile(notePath(root, 'Files.md'), 'utf8');
  assert.match(filesNote, /src\/b\.js/u);
  assert.doesNotMatch(filesNote, /src\/a\.js/u);
  assert.notDeepEqual(await fingerprintTree(frameworkRoot(root)), beforeRename);

  const projectNote = await fs.readFile(notePath(root, 'Project.md'), 'utf8');
  await fs.writeFile(notePath(root, 'Project.md'), `${projectNote}manual edit\n`);
  const conflictStatus = await run(['status', '--json'], root);
  assert.equal(conflictStatus.code, 0);
  const conflictJson = JSON.parse(conflictStatus.stdout);
  assert.equal(conflictJson.state, 'conflict');
  assert.match(conflictJson.warnings.join('\n'), /hash mismatch/u);

  const conflictSync = await run(['sync-now', '--json'], root);
  assert.equal(conflictSync.code, 3);
  assert.equal(JSON.parse(conflictSync.stderr).error.code, 'conflict');
  assert.match(await fs.readFile(notePath(root, 'Project.md'), 'utf8'), /manual edit/u);
});

test('paths with spaces stay one argv token and session metadata is bounded and preserved', async () => {
  const outer = await makeRoot();
  const project = path.join(outer, 'project with spaces');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'a.js'), 'export const a = 1;\n');
  const sessionPath = path.join(outer, 'session one.json');
  const summary = 'Fix "quoted" path and spaces';
  await fs.writeFile(
    sessionPath,
    JSON.stringify({ summary, changedPaths: ['src/a.js'], outcome: 'ok' }),
  );

  const created = await run([
    'create',
    '--confirm',
    '--project',
    project,
    '--session-file',
    sessionPath,
    '--json',
  ], outer);
  assert.equal(created.code, 0);
  const createdJson = JSON.parse(created.stdout);
  assert.equal(createdJson.projectRoot, path.resolve(project));
  assert.equal(createdJson.frameworkRoot, frameworkRoot(project));
  assert.equal(await exists(path.join(project, '.hivemind')), true);
  assert.equal(await exists(path.join(outer, '.hivemind')), false);

  const manifest = JSON.parse(await fs.readFile(manifestPath(project), 'utf8'));
  assert.deepEqual(manifest.session, { summary, changedPaths: ['src/a.js'], outcome: 'ok' });
  assert.match(await fs.readFile(notePath(project, 'Swarm.md'), 'utf8'), /Fix "quoted" path and spaces/u);

  const manifestBefore = await fingerprintTree(frameworkRoot(project));
  const preserved = await run(['sync-now', '--project', project], outer);
  assert.equal(preserved.code, 0);
  assert.deepEqual(await fingerprintTree(frameworkRoot(project)), manifestBefore);
  assert.deepEqual(
    JSON.parse(await fs.readFile(manifestPath(project), 'utf8')).session,
    { summary, changedPaths: ['src/a.js'], outcome: 'ok' },
  );

  const secondSession = path.join(outer, 'session two.json');
  await fs.writeFile(
    secondSession,
    JSON.stringify({
      summary: 'second pass',
      changedPaths: ['src/a.js', 'src/new name.js'],
      outcome: 'updated',
    }),
  );
  const second = await run(['sync-now', '--project', project, '--session-file', secondSession, '--json'], outer);
  assert.equal(second.code, 0);
  const secondJson = JSON.parse(second.stdout);
  assert.equal(secondJson.status, 'updated');
  assert.equal(secondJson.counts.updated, 1);
  const secondManifest = JSON.parse(await fs.readFile(manifestPath(project), 'utf8'));
  assert.deepEqual(secondManifest.session, {
    summary: 'second pass',
    changedPaths: ['src/a.js', 'src/new name.js'],
    outcome: 'updated',
  });
  assert.match(await fs.readFile(notePath(project, 'Swarm.md'), 'utf8'), /new name\.js/u);
});

test('invalid, oversized, and escaping session files fail before writes', async () => {
  const root = await makeProject();
  const invalid = path.join(root, 'invalid.json');
  await fs.writeFile(invalid, '{not json\n');
  const extra = path.join(root, 'extra.json');
  await fs.writeFile(extra, JSON.stringify({ summary: 'x', changedPaths: [], outcome: 'ok', extra: true }));
  const escape = path.join(root, 'escape.json');
  await fs.writeFile(escape, JSON.stringify({ summary: 'x', changedPaths: ['../escape.js'], outcome: 'ok' }));
  const oversized = path.join(root, 'oversized.json');
  await fs.writeFile(oversized, 'a'.repeat(1024 * 1024 + 1));

  for (const sessionFile of [invalid, extra, escape, oversized]) {
    const result = await run(['create', '--confirm', '--session-file', sessionFile, '--json'], root);
    assert.equal(result.code, 2, `${path.basename(sessionFile)} should be a usage error`);
    assert.equal(JSON.parse(result.stderr).error.code, 'usage');
    assert.equal(await exists(path.join(root, '.hivemind')), false);
  }

  const missing = await run(['create', '--confirm', '--session-file', path.join(root, 'missing.json')], root);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /does not exist/u);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('legacy-only fixture exposes legacyVault in status JSON and human graph without writes', async () => {
  const root = await makeProject();
  const vaultDirectory = path.join(root, '.opencode', 'vault');
  await fs.mkdir(vaultDirectory, { recursive: true });
  await fs.writeFile(path.join(vaultDirectory, '00-MOC.md'), LEGACY_MOC);
  const before = await fingerprintTree(root);

  const statusJson = await run(['status', '--json'], root);
  assert.equal(statusJson.code, 0);
  const parsed = JSON.parse(statusJson.stdout);
  assert.equal(parsed.state, 'absent');
  assert.deepEqual(parsed.legacyVault, {
    path: path.resolve(vaultDirectory),
    state: 'partial',
    present: true,
    detector: 'vault-detect',
  });
  assert.match(parsed.warnings.join('\n'), /legacy Obsidian context vault detected/u);

  const human = await run(['status'], root);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /state      absent/u);
  assert.match(human.stdout, /^legacy     present$/mu);
  assert.match(human.stdout, /^legacy state partial$/mu);
  assert.ok(human.stdout.includes(`legacy path ${path.resolve(vaultDirectory)}`));
  assert.match(human.stdout, /^legacy detector vault-detect$/mu);
  assert.doesNotMatch(human.stdout, /^dual /mu);
  assertNoTerminalControls(human.stdout, 'legacy-only status stdout');

  assert.deepEqual(await fingerprintTree(root), before);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('graph shows conflict, truncation, warnings, and rejects invalid intents', () => {
  const snapshot = {
    projectRoot: 'C:/tmp/project',
    frameworkRoot: 'C:/tmp/project/.hivemind/obsidian',
    state: 'conflict',
    files: Array.from({ length: 12 }, (_, index) => `file-${index}.js`),
    truncated: true,
    warnings: ['filename scan truncated at 2000 files', 'managed file hash mismatch: Files.md'],
  };

  for (const intent of INTENTS) {
    const text = renderStatus(snapshot, { intent, renderedAt: '2026-01-01T00:00:00.000Z' });
    assertAllIntentBranches(text, intent);
    assert.match(text, /state      conflict/u);
    assert.match(text, /scan       12 file\(s\) \(truncated\)/u);
    assert.match(text, /filename scan truncated/u);
    assert.match(text, /managed file hash mismatch/u);
    assert.match(text, /rendered at 2026-01-01T00:00:00\.000Z/u);
  }

  assert.throws(
    () => renderStatus(snapshot, { intent: 'shiny' }),
    (error) => error instanceof ObsidianError && error.code === 'usage',
  );
});

test('graph separates legacy vault metadata from managed state and marks dual backends', () => {
  const legacyOnly = {
    projectRoot: 'C:/tmp/project',
    frameworkRoot: 'C:/tmp/project/.hivemind/obsidian',
    state: 'absent',
    files: [],
    truncated: false,
    warnings: ['legacy Obsidian context vault detected at C:/tmp/project/.opencode/vault (state: partial)'],
    legacyVault: {
      path: 'C:/tmp/project/.opencode/vault',
      state: 'partial',
      present: true,
      detector: 'vault-detect',
    },
  };

  const text = renderStatus(legacyOnly, { renderedAt: '2026-01-01T00:00:00.000Z' });
  assert.match(text, /^state      absent /mu);
  assert.match(text, /^legacy     present$/mu);
  assert.match(text, /^legacy state partial$/mu);
  assert.match(text, /^legacy path C:\/tmp\/project\/\.opencode\/vault$/mu);
  assert.match(text, /^legacy detector vault-detect$/mu);
  assert.doesNotMatch(text, /^dual /mu);

  const dual = {
    ...legacyOnly,
    state: 'conflict',
    warnings: ['both the legacy Obsidian context vault and the managed framework exist'],
  };
  const dualText = renderStatus(dual, { renderedAt: '2026-01-01T00:00:00.000Z' });
  assert.match(dualText, /^state      conflict /mu);
  assert.match(dualText, /^legacy     present$/mu);
  assert.match(
    dualText,
    /^dual       conflict: legacy and managed backends both present; no backend auto-selected$/mu,
  );
  assertNoTerminalControls(dualText, 'dual graph');
});

test('default project is the caller cwd and explicit relative project resolves there', async () => {
  const outer = await makeRoot();
  const nested = path.join(outer, 'nested project');
  await fs.mkdir(path.join(nested, 'src'), { recursive: true });
  await fs.writeFile(path.join(nested, 'src', 'a.js'), 'export const a = 1;\n');

  const defaulted = await run(['create', '--confirm', '--json'], nested);
  assert.equal(defaulted.code, 0);
  assert.equal(JSON.parse(defaulted.stdout).projectRoot, path.resolve(nested));
  assert.equal(await exists(path.join(nested, '.hivemind')), true);

  const relative = await run(['create', '--confirm', '--project', 'nested project', '--json'], outer);
  assert.equal(relative.code, 0);
  const relativeJson = JSON.parse(relative.stdout);
  assert.equal(relativeJson.projectRoot, path.resolve(nested));
  assert.equal(relativeJson.status, 'unchanged');
  assert.equal(await exists(path.join(outer, '.hivemind')), false);
});
