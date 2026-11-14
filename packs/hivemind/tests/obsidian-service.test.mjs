// Slice A service tests. Every fixture root is a unique mkdtemp directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  SCHEMA_VERSION,
  FRAMEWORK_RELATIVE,
  MANIFEST_NAME,
  MANAGED_NOTES,
  ObsidianError,
} from '../obsidian/contracts.mjs';
import { inspectProject, refreshProject } from '../obsidian/service.mjs';

const roots = new Set();

async function makeRoot(prefix = 'hivemind-obsidian-service-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
}

after(async () => {
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})),
  );
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

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function makeProjectWithFile() {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  return root;
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof ObsidianError && error.code === code,
  );
}

test('inspect reports an absent framework without writing or following hidden/dependency files', async () => {
  const root = await makeProjectWithFile();
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'ignored\n');
  await fs.writeFile(path.join(root, '.secret'), 'ignored\n');

  const snapshot = await inspectProject(root);

  assert.equal(snapshot.projectRoot, path.resolve(root));
  assert.equal(snapshot.frameworkRoot, frameworkRoot(root));
  assert.equal(snapshot.state, 'absent');
  assert.deepEqual(snapshot.files, ['src/a.js']);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('create writes the vault marker, managed notes, and a hashed manifest', async () => {
  const root = await makeProjectWithFile();
  const session = { summary: 'Built the fixture', changedPaths: ['src/a.js'], outcome: 'created' };

  const result = await refreshProject(root, { create: true, session });

  assert.equal(result.projectRoot, path.resolve(root));
  assert.equal(result.frameworkRoot, frameworkRoot(root));
  assert.equal(result.status, 'created');
  assert.equal(result.createdCount, MANAGED_NOTES.length);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.unchangedCount, 0);

  const appStat = await fs.stat(path.join(frameworkRoot(root), '.obsidian'));
  assert.equal(appStat.isDirectory(), true);

  const manifest = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'));
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(manifest.files), MANAGED_NOTES);
  assert.deepEqual(manifest.session, session);
  for (const name of MANAGED_NOTES) {
    const note = await fs.readFile(notePath(root, name));
    assert.equal(manifest.files[name], digest(note), `manifest hash for ${name}`);
  }

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.state, 'ready');
  assert.deepEqual(snapshot.warnings, []);
  assert.deepEqual(snapshot.files, ['src/a.js']);
});

test('refresh without create refuses to set up an absent framework', async () => {
  const root = await makeRoot();

  await expectCode(refreshProject(root), 'unconfigured');
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});

test('refresh is idempotent for bytes and mtimes, including the manifest', async () => {
  const root = await makeProjectWithFile();
  await refreshProject(root, {
    create: true,
    session: { summary: 'same session', changedPaths: ['src/a.js'], outcome: 'done' },
  });
  const files = [...MANAGED_NOTES.map((name) => notePath(root, name)), manifestPath(root)];
  const before = await fingerprint(files);

  const result = await refreshProject(root);

  assert.equal(result.status, 'unchanged');
  assert.equal(result.createdCount, 0);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.unchangedCount, MANAGED_NOTES.length);
  assert.deepEqual(await fingerprint(files), before);
  const manifest = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'));
  assert.deepEqual(manifest.session, {
    summary: 'same session',
    changedPaths: ['src/a.js'],
    outcome: 'done',
  });
});

test('renamed project files update Files.md while preserving unchanged note mtimes', async () => {
  const root = await makeProjectWithFile();
  await refreshProject(root, { create: true });
  const projectBefore = await fingerprint([notePath(root, 'Project.md'), notePath(root, 'Swarm.md')]);
  const manifestBefore = await fingerprint([manifestPath(root)]);

  await fs.rename(path.join(root, 'src', 'a.js'), path.join(root, 'src', 'b.js'));
  const result = await refreshProject(root);

  assert.equal(result.status, 'updated');
  assert.equal(result.updatedCount, 1);
  assert.equal(result.unchangedCount, 2);
  const filesNote = await fs.readFile(notePath(root, 'Files.md'), 'utf8');
  assert.match(filesNote, /src\/b\.js/u);
  assert.doesNotMatch(filesNote, /src\/a\.js/u);
  assert.deepEqual(
    await fingerprint([notePath(root, 'Project.md'), notePath(root, 'Swarm.md')]),
    projectBefore,
  );
  assert.notDeepEqual(await fingerprint([manifestPath(root)]), manifestBefore);
});

test('session metadata updates on request and is preserved when omitted', async () => {
  const root = await makeProjectWithFile();
  const first = { summary: 'first session', changedPaths: ['src/a.js'], outcome: 'ok' };
  await refreshProject(root, { create: true, session: first });
  const manifestBefore = await fingerprint([manifestPath(root)]);

  await refreshProject(root);
  assert.deepEqual(await fingerprint([manifestPath(root)]), manifestBefore);
  assert.deepEqual(
    JSON.parse(await fs.readFile(manifestPath(root), 'utf8')).session,
    first,
  );

  const second = { summary: 'second session', changedPaths: ['src/a.js', 'src/new.js'], outcome: 'updated' };
  const result = await refreshProject(root, { session: second });
  assert.equal(result.status, 'updated');
  assert.equal(result.updatedCount, 1);
  assert.equal(result.unchangedCount, 2);
  const manifest = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'));
  assert.deepEqual(manifest.session, second);
  const swarm = await fs.readFile(notePath(root, 'Swarm.md'), 'utf8');
  assert.match(swarm, /second session/u);
  assert.match(swarm, /src\/new\.js/u);
});

test('manual edits to managed notes are rejected without replacing any file', async () => {
  const root = await makeProjectWithFile();
  await refreshProject(root, { create: true, session: { summary: 'safe', changedPaths: [], outcome: 'ok' } });
  const edited = notePath(root, 'Project.md');
  await fs.writeFile(edited, '# Hand edited project\n');
  const files = [...MANAGED_NOTES.map((name) => notePath(root, name)), manifestPath(root)];
  const before = await fingerprint(files);

  await expectCode(refreshProject(root), 'conflict');
  assert.deepEqual(await fingerprint(files), before);

  const snapshot = await inspectProject(root);
  assert.equal(snapshot.state, 'conflict');
  assert.match(snapshot.warnings.join('\n'), /hash mismatch/u);
});

test('malformed and malicious manifests are conflicts and never delete unknown files', async () => {
  const root = await makeProjectWithFile();
  await refreshProject(root, { create: true });
  const custom = path.join(frameworkRoot(root), 'Custom.md');
  await fs.writeFile(custom, '# Keep me\n');
  const projectNote = await fs.readFile(notePath(root, 'Project.md'));

  await fs.writeFile(manifestPath(root), '{"schemaVersion": 1,');
  assert.equal((await inspectProject(root)).state, 'conflict');
  await expectCode(refreshProject(root), 'conflict');
  assert.deepEqual(await fs.readFile(notePath(root, 'Project.md')), projectNote);
  assert.equal(await fs.readFile(custom, 'utf8'), '# Keep me\n');

  const malicious = {
    schemaVersion: SCHEMA_VERSION,
    files: {
      'Project.md': '0'.repeat(64),
      'Files.md': '0'.repeat(64),
      'Swarm.md': '0'.repeat(64),
      '../escape.md': '0'.repeat(64),
    },
  };
  await fs.writeFile(manifestPath(root), `${JSON.stringify(malicious)}\n`);
  assert.equal((await inspectProject(root)).state, 'conflict');
  await expectCode(refreshProject(root), 'conflict');
  assert.equal(await exists(path.join(root, '..', 'escape.md')), false);
  assert.equal(await fs.readFile(custom, 'utf8'), '# Keep me\n');
});

test('unknown framework notes and app config are preserved across refresh', async () => {
  const root = await makeProjectWithFile();
  await refreshProject(root, { create: true });
  const extraNote = path.join(frameworkRoot(root), 'Ideas.md');
  const appConfig = path.join(frameworkRoot(root), '.obsidian', 'app.json');
  await fs.writeFile(extraNote, '# Ideas\n');
  await fs.writeFile(appConfig, '{"newFileLocation":"current"}\n');

  const result = await refreshProject(root);

  assert.equal(result.status, 'unchanged');
  assert.equal(await fs.readFile(extraNote, 'utf8'), '# Ideas\n');
  assert.equal(await fs.readFile(appConfig, 'utf8'), '{"newFileLocation":"current"}\n');
  const manifest = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'));
  assert.equal(Object.hasOwn(manifest.files, 'Ideas.md'), false);
});

test('linked managed ancestors and managed files are rejected as unsafe paths', async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot('hivemind-obsidian-outside-');
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside\n');
  const linkedHive = path.join(root, '.hivemind');
  let linked = false;
  try {
    await fs.symlink(outside, linkedHive, 'junction');
    linked = true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error && error.code)) {
      t.skip('directory junctions are unavailable in this environment');
      return;
    }
    throw error;
  }

  try {
    await expectCode(inspectProject(root), 'unsafe-path');
    await expectCode(refreshProject(root, { create: true }), 'unsafe-path');
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside\n');
    assert.equal(await exists(path.join(outside, 'obsidian')), false);
  } finally {
    if (linked) await fs.unlink(linkedHive).catch(() => {});
  }
});

test('nested junction aliases outside the project are rejected before scanning or writing', async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot('hivemind-obsidian-outside-');
  const outsideProject = path.join(outside, 'project');
  await fs.mkdir(outsideProject);
  await fs.writeFile(path.join(outsideProject, 'keep.txt'), 'outside\n');
  const alias = path.join(root, 'alias');
  let linked = false;
  try {
    await fs.symlink(outside, alias, 'junction');
    linked = true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error && error.code)) {
      t.skip('directory junctions are unavailable in this environment');
      return;
    }
    throw error;
  }
  const nestedProject = path.join(alias, 'project');

  try {
    await expectCode(inspectProject(nestedProject), 'unsafe-path');
    await expectCode(refreshProject(nestedProject, { create: true }), 'unsafe-path');
    assert.deepEqual(await fs.readdir(outsideProject), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(outsideProject, 'keep.txt'), 'utf8'), 'outside\n');
    assert.equal(await exists(path.join(outsideProject, '.hivemind')), false);
  } finally {
    if (linked) await fs.unlink(alias).catch(() => {});
  }
});

test('managed note symlinks are rejected without reading or writing the target', async (t) => {
  const root = await makeProjectWithFile();
  await refreshProject(root, { create: true });
  const outside = await makeRoot('hivemind-obsidian-target-');
  const target = path.join(outside, 'target.md');
  await fs.writeFile(target, 'must not change\n');
  const linkedNote = notePath(root, 'Files.md');
  await fs.unlink(linkedNote);
  try {
    await fs.symlink(target, linkedNote, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error && error.code)) {
      t.skip('file symlinks are unavailable in this environment');
      return;
    }
    throw error;
  }

  try {
    await expectCode(inspectProject(root), 'unsafe-path');
    await expectCode(refreshProject(root), 'unsafe-path');
    assert.equal(await fs.readFile(target, 'utf8'), 'must not change\n');
  } finally {
    await fs.unlink(linkedNote).catch(() => {});
  }
});

test('an existing lock makes refresh busy and is never removed automatically', async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, '.hivemind'));
  const lock = path.join(root, '.hivemind', 'obsidian.lock');
  await fs.writeFile(lock, 'held by operator\n');

  await expectCode(refreshProject(root, { create: true }), 'busy');
  assert.equal(await fs.readFile(lock, 'utf8'), 'held by operator\n');
  assert.equal(await exists(frameworkRoot(root)), false);
});

test('filename scan truncates at 2000 files and enforces depth 8', async () => {
  const manyRoot = await makeRoot();
  const manyDirectory = path.join(manyRoot, 'many');
  await fs.mkdir(manyDirectory);
  for (let start = 0; start < 2001; start += 100) {
    const writes = [];
    for (let index = start; index < Math.min(start + 100, 2001); index += 1) {
      writes.push(fs.writeFile(path.join(manyDirectory, `f${String(index).padStart(4, '0')}.txt`), ''));
    }
    await Promise.all(writes);
  }

  const truncated = await inspectProject(manyRoot);
  assert.equal(truncated.files.length, 2000);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.warnings.join('\n'), /truncated/u);

  const depthRoot = await makeRoot();
  let directory = depthRoot;
  for (let level = 1; level <= 8; level += 1) {
    directory = path.join(directory, `d${level}`);
  }
  await fs.mkdir(path.join(directory, 'd9'), { recursive: true });
  await fs.writeFile(path.join(directory, 'keep.txt'), '');
  await fs.writeFile(path.join(directory, 'd9', 'deep.txt'), '');
  const depthSnapshot = await inspectProject(depthRoot);
  const expected = `${Array.from({ length: 8 }, (_, index) => `d${index + 1}`).join('/')}/keep.txt`;
  assert.deepEqual(depthSnapshot.files, [expected]);
  assert.equal(depthSnapshot.truncated, true);
  assert.match(depthSnapshot.warnings.join('\n'), /truncated at depth 8/u);
});

test('invalid roots and options fail with the documented codes before writing', async () => {
  const root = await makeRoot();
  const file = path.join(root, 'plain.txt');
  await fs.writeFile(file, 'not a directory\n');

  await expectCode(inspectProject(''), 'usage');
  await expectCode(inspectProject(path.join(root, 'missing')), 'project');
  await expectCode(inspectProject(file), 'project');
  await expectCode(refreshProject(root, { create: 'yes' }), 'usage');
  await expectCode(refreshProject(root, { unknown: true }), 'usage');
  await expectCode(
    refreshProject(root, { session: { summary: 'x', changedPaths: ['../escape.js'], outcome: 'ok' } }),
    'usage',
  );
  assert.equal(await exists(path.join(root, '.hivemind')), false);
});
