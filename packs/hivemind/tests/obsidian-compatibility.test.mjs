// Slice A compatibility tests: public service adapter over the unchanged
// managed engine, with read-only legacy vault detection.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FRAMEWORK_RELATIVE, MANAGED_NOTES, ObsidianError } from '../obsidian/contracts.mjs';
import { inspectProject, refreshProject } from '../obsidian/service.mjs';

const PACK_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = new Set();

const LEGACY_MOC = [
  '---',
  'id: moc-root',
  'title: MOC Root',
  '---',
  '',
  '# MOC',
  '',
].join('\n');

const LEGACY_VAULT_CLI = [
  '#!/usr/bin/env node',
  'const args = process.argv.slice(2);',
  "if (args[0] === 'check') {",
  "  process.stdout.write('{\"ok\":true}\\n');",
  "} else if (args[0] === 'stats') {",
  "  process.stdout.write('{\"ok\":true,\"data\":{\"notes\":1,\"symbols\":0,\"index_status\":\"ready\"}}\\n');",
  '}',
  'process.exit(0);',
  '',
].join('\n');

async function makeRoot(prefix = 'hivemind-obsidian-compat-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
}

after(async () => {
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})),
  );
});

async function makeProject() {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const app = 1;\n');
  return root;
}

function frameworkRoot(root) {
  return path.join(root, ...FRAMEWORK_RELATIVE.split('/'));
}

function posix(target) {
  return path.resolve(target).split(path.sep).join('/');
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

async function fingerprint(files) {
  const result = {};
  for (const file of files) {
    const stat = await fs.stat(file, { bigint: true });
    result[file] = {
      mtimeNs: stat.mtimeNs.toString(),
      bytes: (await fs.readFile(file)).toString('base64'),
    };
  }
  return result;
}

async function expectConflict(promise) {
  await assert.rejects(
    promise,
    (error) => (error instanceof ObsidianError || (error && error.name === 'ObsidianError'))
      && error.code === 'conflict'
      && /vault-lifecycle\.mjs/u.test(error.message),
  );
}

async function writeLegacySentinels(root, options = {}) {
  const vaultDirectory = relayParts(root, options.vaultDir ?? '.opencode/vault');
  const scriptsDirectory = relayParts(root, options.scriptsDir ?? 'scripts');
  if (options.moc !== false) {
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(path.join(vaultDirectory, '00-MOC.md'), LEGACY_MOC);
  }
  if (options.cli !== false) {
    await fs.mkdir(scriptsDirectory, { recursive: true });
    await fs.writeFile(path.join(scriptsDirectory, 'vault.mjs'), LEGACY_VAULT_CLI);
  }
}

function relayParts(root, relative) {
  return path.join(root, ...relative.split('/'));
}

function legacyFiles(root, options = {}) {
  const files = [];
  if (options.moc !== false) {
    files.push(path.join(relayParts(root, options.vaultDir ?? '.opencode/vault'), '00-MOC.md'));
  }
  if (options.cli !== false) {
    files.push(path.join(relayParts(root, options.scriptsDir ?? 'scripts'), 'vault.mjs'));
  }
  return files;
}

test('normal fixtures without legacy markers still inspect, create, and refresh', async () => {
  const root = await makeProject();

  const absent = await inspectProject(root);
  assert.equal(absent.state, 'absent');
  assert.deepEqual(absent.warnings, []);
  assert.equal(absent.legacyVault, undefined);
  assert.equal(await exists(path.join(root, '.opencode', 'vault')), false);

  const created = await refreshProject(root, { create: true });
  assert.equal(created.status, 'created');
  const ready = await inspectProject(root);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.warnings, []);
  assert.equal(ready.legacyVault, undefined);
});

test('partial legacy vault reports its path/state and blocks managed creation', async () => {
  const root = await makeProject();
  await writeLegacySentinels(root, { cli: false });
  const legacyBefore = await fingerprint(legacyFiles(root, { cli: false }));

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.state, 'absent');
  assert.equal(snapshot.legacyVault.present, true);
  assert.equal(snapshot.legacyVault.state, 'partial');
  assert.equal(posix(snapshot.legacyVault.path), posix(path.join(root, '.opencode', 'vault')));
  const warning = snapshot.warnings.join('\n');
  assert.match(warning, /legacy Obsidian context vault/u);
  assert.match(warning, /partial/u);
  assert.match(warning, /vault-lifecycle\.mjs/u);

  const again = await inspectProject(root);
  assert.deepEqual(again, snapshot);
  assert.deepEqual(await fingerprint(legacyFiles(root, { cli: false })), legacyBefore);

  await expectConflict(refreshProject(root, { create: true }));
  assert.equal(await exists(frameworkRoot(root)), false);
  assert.deepEqual(await fingerprint(legacyFiles(root, { cli: false })), legacyBefore);
});

test('healthy legacy vault blocks create and refresh without touching its files', async () => {
  const root = await makeProject();
  await writeLegacySentinels(root);
  const legacyBefore = await fingerprint(legacyFiles(root));

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.state, 'absent');
  assert.equal(snapshot.legacyVault.state, 'present_healthy');
  assert.equal(posix(snapshot.legacyVault.path), posix(path.join(root, '.opencode', 'vault')));
  assert.match(snapshot.warnings.join('\n'), /vault-lifecycle\.mjs/u);

  await expectConflict(refreshProject(root, { create: true }));
  await expectConflict(refreshProject(root));
  assert.equal(await exists(frameworkRoot(root)), false);
  assert.deepEqual(await fingerprint(legacyFiles(root)), legacyBefore);
});

test('vault.config.json custom vault path is detected and protected', async () => {
  const root = await makeProject();
  const config = {
    schema_version: 1,
    vault_dir: 'docs/vault',
    scripts_dir: 'scripts',
  };
  await fs.writeFile(path.join(root, 'vault.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeLegacySentinels(root, { vaultDir: 'docs/vault' });
  const legacyBefore = await fingerprint(legacyFiles(root, { vaultDir: 'docs/vault' }));

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.legacyVault.state, 'present_healthy');
  assert.equal(posix(snapshot.legacyVault.path), posix(path.join(root, 'docs', 'vault')));
  assert.match(snapshot.warnings.join('\n'), /docs[\\/]vault/u);

  await expectConflict(refreshProject(root, { create: true }));
  assert.equal(await exists(frameworkRoot(root)), false);
  assert.deepEqual(
    await fingerprint(legacyFiles(root, { vaultDir: 'docs/vault' })),
    legacyBefore,
  );
});

test('both backends present report conflict and are never migrated or mutated', async () => {
  const root = await makeProject();
  await refreshProject(root, { create: true });
  const managedBefore = await fingerprint([
    ...MANAGED_NOTES.map((name) => path.join(frameworkRoot(root), name)),
    path.join(frameworkRoot(root), 'manifest.json'),
  ]);

  await writeLegacySentinels(root);
  const legacyBefore = await fingerprint(legacyFiles(root));

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.state, 'conflict');
  assert.equal(snapshot.legacyVault.state, 'present_healthy');
  assert.match(snapshot.warnings.join('\n'), /both the legacy Obsidian context vault/u);
  assert.match(snapshot.warnings.join('\n'), /vault-lifecycle\.mjs/u);

  await expectConflict(refreshProject(root));
  await expectConflict(refreshProject(root, { create: true }));
  assert.deepEqual(await fingerprint(legacyFiles(root)), legacyBefore);
  assert.deepEqual(
    await fingerprint([
      ...MANAGED_NOTES.map((name) => path.join(frameworkRoot(root), name)),
      path.join(frameworkRoot(root), 'manifest.json'),
    ]),
    managedBefore,
  );
});

test('missing legacy detector fails closed when markers exist but not for normal fixtures', async () => {
  const root = await makeRoot();
  const home = path.join(root, 'a', 'b', 'c', 'home');
  await fs.mkdir(path.join(home, 'obsidian'), { recursive: true });
  for (const name of ['contracts.mjs', 'managed-service.mjs', 'service.mjs']) {
    await fs.copyFile(
      path.join(PACK_ROOT, 'obsidian', name),
      path.join(home, 'obsidian', name),
    );
  }
  const isolated = await import(pathToFileURL(path.join(home, 'obsidian', 'service.mjs')).href);

  const legacyProject = path.join(root, 'legacy-project');
  await fs.mkdir(path.join(legacyProject, '.opencode', 'vault'), { recursive: true });
  await fs.writeFile(path.join(legacyProject, '.opencode', 'vault', '00-MOC.md'), LEGACY_MOC);

  const snapshot = await isolated.inspectProject(legacyProject);
  assert.equal(snapshot.legacyVault.detector, 'unavailable');
  assert.match(snapshot.warnings.join('\n'), /detector/u);
  assert.match(snapshot.warnings.join('\n'), /vault-lifecycle\.mjs/u);
  await expectConflict(isolated.refreshProject(legacyProject, { create: true }));
  assert.equal(await exists(path.join(legacyProject, '.hivemind')), false);

  // The canonical legacy CLI sentinel alone must also fail closed: a partial
  // legacy scaffold can be just scripts/vault.mjs without .opencode/vault.
  const cliOnlyProject = path.join(root, 'cli-only-project');
  await fs.mkdir(path.join(cliOnlyProject, 'scripts'), { recursive: true });
  const cliSentinel = path.join(cliOnlyProject, 'scripts', 'vault.mjs');
  await fs.writeFile(cliSentinel, LEGACY_VAULT_CLI);
  await fs.writeFile(path.join(cliOnlyProject, 'app.js'), 'export const app = 1;\n');
  const cliBefore = await fingerprint([cliSentinel]);

  const cliSnapshot = await isolated.inspectProject(cliOnlyProject);
  assert.equal(cliSnapshot.legacyVault.present, true);
  assert.equal(cliSnapshot.legacyVault.detector, 'unavailable');
  assert.match(cliSnapshot.warnings.join('\n'), /scripts[\\/]vault\.mjs/u);
  await expectConflict(isolated.refreshProject(cliOnlyProject, { create: true }));
  assert.equal(await exists(path.join(cliOnlyProject, '.hivemind')), false);
  assert.deepEqual(await fingerprint([cliSentinel]), cliBefore);

  const normalProject = path.join(root, 'normal-project');
  await fs.mkdir(normalProject);
  await fs.writeFile(path.join(normalProject, 'app.js'), 'export const app = 1;\n');
  const normalSnapshot = await isolated.inspectProject(normalProject);
  assert.equal(normalSnapshot.state, 'absent');
  assert.deepEqual(normalSnapshot.warnings, []);
  const created = await isolated.refreshProject(normalProject, { create: true });
  assert.equal(created.status, 'created');
});
