// Slice B installation tests. All homes and projects are unique temp dirs,
// including spaces in the home path. No live user profile is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = path.resolve(TESTS_DIR, '..');
const REPO_ROOT = path.resolve(PACK_ROOT, '..', '..');
const INSTALL_PS1 = path.join(PACK_ROOT, 'install.ps1');
const INSTALL_SH = path.join(PACK_ROOT, 'install.sh');

const roots = new Set();

async function makeRoot(prefix = 'hivemind install spaces ') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
}

after(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

async function read(target) {
  return fs.readFile(target, 'utf8');
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

async function listFiles(directory, suffix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
}

function extractPowerShellFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = source.indexOf('{', start + marker.length);
  assert.notEqual(open, -1, `${name} must have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} body is not balanced`);
}

function isolatedEnv(home) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    HIVEMIND_HOME: path.join(home, '.config', 'hivemind'),
    OPENCODE_DIR: path.join(home, '.config', 'opencode'),
  };
}

function runPowerShell(args, env) {
  return spawnSync(
    process.env.POWERSHELL || 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1, ...args],
    {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    },
  );
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstatus: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test('install.ps1 deploys obsidian runtime, plugin, skill, detectors and preserves update policy', {
  skip: process.platform === 'win32' ? false : 'install.ps1 integration test requires Windows PowerShell',
}, async () => {
  const home = await makeRoot();
  const hmHome = path.join(home, '.config', 'hivemind');
  const ocDir = path.join(home, '.config', 'opencode');
  const env = isolatedEnv(home);

  // Seed assets whose existing behavior must stay intact.
  await fs.mkdir(path.join(hmHome, 'obsidian'), { recursive: true });
  await fs.writeFile(path.join(hmHome, 'obsidian', 'contracts.mjs'), '// stale runtime\n');
  await fs.mkdir(ocDir, { recursive: true });
  await fs.writeFile(path.join(ocDir, 'AGENTS.md'), 'custom agents\n');
  await fs.mkdir(path.join(ocDir, 'skills', 'token-discipline'), { recursive: true });
  await fs.writeFile(path.join(ocDir, 'skills', 'token-discipline', 'SKILL.md'), 'custom token skill\n');

  const installed = runPowerShell(['-SkipRegistration', '-SkipPathUpdate'], env);
  assertSuccess(installed, 'install.ps1 full install');

  // Managed engine and CLI are deployed together so the installed CLI resolves
  // every sibling module and the legacy detector at <HIVEMIND_HOME>/scripts/hive.
  const obsidianModules = await listFiles(path.join(PACK_ROOT, 'obsidian'), '.mjs');
  assert.ok(obsidianModules.includes('contracts.mjs'));
  assert.ok(obsidianModules.includes('service.mjs'));
  for (const name of obsidianModules) {
    assert.equal(
      await read(path.join(hmHome, 'obsidian', name)),
      await read(path.join(PACK_ROOT, 'obsidian', name)),
      `installed obsidian/${name}`,
    );
  }
  assert.equal(
    await read(path.join(hmHome, 'bin', 'obsidian.mjs')),
    await read(path.join(PACK_ROOT, 'bin', 'obsidian.mjs')),
  );

  const runtimeFiles = await fs.readdir(path.join(hmHome, 'obsidian'));
  const runtimeBackup = runtimeFiles.find((name) => name.startsWith('contracts.mjs.bak.'));
  assert.ok(runtimeBackup, 'runtime overwrite must create a timestamped backup');
  assert.equal(await read(path.join(hmHome, 'obsidian', runtimeBackup)), '// stale runtime\n');

  // Native plugin and skill destinations are explicit; .mjs source becomes the
  // installed .js plugin, while the skill is added to the existing skill loop.
  assert.equal(
    await read(path.join(ocDir, 'plugins', 'hivemind-obsidian.js')),
    await read(path.join(PACK_ROOT, 'opencode', 'hivemind-obsidian.mjs')),
  );
  assert.equal(
    await read(path.join(ocDir, 'skills', 'hivemind-obsidian', 'SKILL.md')),
    await read(path.join(PACK_ROOT, 'opencode', 'skills', 'hivemind-obsidian', 'SKILL.md')),
  );

  // Existing wildcards must continue to install the updater agent and /obsidian.
  for (const name of await listFiles(path.join(PACK_ROOT, 'opencode', 'agents'), '.md')) {
    assert.equal(
      await read(path.join(ocDir, 'agents', name)),
      await read(path.join(PACK_ROOT, 'opencode', 'agents', name)),
      `installed agent ${name}`,
    );
  }
  for (const name of await listFiles(path.join(PACK_ROOT, 'opencode', 'commands'), '.md')) {
    const installedText = await read(path.join(ocDir, 'commands', name));
    assert.ok(installedText.length > 0, `installed command ${name}`);
    if (name === 'obsidian.md') {
      assert.equal(
        installedText,
        await read(path.join(PACK_ROOT, 'opencode', 'commands', name)),
        'installed /obsidian command matches source',
      );
    }
  }
  assert.ok(
    (await read(path.join(ocDir, 'commands', 'stack.md'))).includes('hive-switch.ps1'),
    'stack command must be rendered to the installed switcher',
  );
  for (const name of await listFiles(path.join(PACK_ROOT, 'opencode', 'commands', 'stack'), '.md')) {
    const installedText = await read(path.join(ocDir, 'commands', 'stack', name));
    assert.ok(installedText.length > 0, `installed stack command ${name}`);
    assert.doesNotMatch(installedText, /\{\{HIVE_SWITCH_CMD\}\}/u, `rendered stack command ${name}`);
  }

  // Source layout compatibility: the legacy detector is copied to the location
  // the installed service adapter probes.
  for (const name of await listFiles(path.join(REPO_ROOT, 'scripts', 'hive'), '.mjs')) {
    assert.equal(
      await read(path.join(hmHome, 'scripts', 'hive', name)),
      await read(path.join(REPO_ROOT, 'scripts', 'hive', name)),
      `installed scripts/hive/${name}`,
    );
  }
  for (const name of await listFiles(path.join(PACK_ROOT, 'profiles'), '.json')) {
    assert.equal(
      await read(path.join(hmHome, 'profiles', name)),
      await read(path.join(PACK_ROOT, 'profiles', name)),
      `installed profile ${name}`,
    );
  }

  // KeepExisting and backup policy: user-edited prompt assets are preserved,
  // while updatable runtime/skill/prompt assets follow their existing modes.
  assert.equal(await read(path.join(ocDir, 'AGENTS.md')), 'custom agents\n');
  assert.equal(
    await read(path.join(ocDir, 'skills', 'token-discipline', 'SKILL.md')),
    'custom token skill\n',
  );

  // Installed CLI lifecycle from a path containing spaces.
  const cli = path.join(hmHome, 'bin', 'obsidian.mjs');
  const project = path.join(home, 'project with spaces');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'app.js'), 'export const app = 1;\n');

  const created = runNode([cli, 'create', '--confirm', '--project', project, '--json'], env);
  assertSuccess(created, 'installed obsidian create');
  const createdJson = JSON.parse(created.stdout);
  assert.equal(createdJson.projectRoot, path.resolve(project));
  assert.equal(createdJson.status, 'created');
  assert.equal(await exists(path.join(project, '.hivemind', 'obsidian', 'Project.md')), true);

  const synced = runNode([cli, 'sync-now', '--project', project, '--json'], env);
  assertSuccess(synced, 'installed obsidian sync-now');
  assert.equal(JSON.parse(synced.stdout).status, 'unchanged');

  // The installed compatibility adapter must find the copied detector and fail
  // closed on a legacy marker without creating a second framework.
  const legacyProject = path.join(home, 'legacy project');
  await fs.mkdir(path.join(legacyProject, '.opencode', 'vault'), { recursive: true });
  await fs.writeFile(
    path.join(legacyProject, '.opencode', 'vault', '00-MOC.md'),
    '---\nid: moc-root\ntitle: Root\n---\n',
  );
  const legacyStatus = runNode([cli, 'status', '--project', legacyProject, '--json'], env);
  assertSuccess(legacyStatus, 'installed obsidian legacy status');
  const legacyJson = JSON.parse(legacyStatus.stdout);
  assert.equal(legacyJson.state, 'absent');
  assert.ok(
    legacyJson.warnings.some((warning) => /legacy Obsidian context vault detected/.test(warning)),
    `legacy detector warning missing: ${JSON.stringify(legacyJson.warnings)}`,
  );
  assert.equal(await exists(path.join(legacyProject, '.hivemind')), false);

  // Focused PR-review refresh keeps its narrow contract: PR assets are
  // overwritten, while the obsidian runtime and unrelated skill assets remain.
  await fs.writeFile(path.join(ocDir, 'commands', 'pr-review.md'), 'stale again\n');
  await fs.writeFile(path.join(hmHome, 'obsidian', 'contracts.mjs'), '// focused sentinel\n');
  const focused = runPowerShell(['-ReinstallPRReview', '-SkipRegistration', '-SkipPathUpdate'], env);
  assertSuccess(focused, 'install.ps1 focused PR-review refresh');
  assert.equal(
    await read(path.join(ocDir, 'commands', 'pr-review.md')),
    await read(path.join(PACK_ROOT, 'opencode', 'commands', 'pr-review.md')),
  );
  assert.equal(await read(path.join(hmHome, 'obsidian', 'contracts.mjs')), '// focused sentinel\n');
  assert.equal(
    await read(path.join(ocDir, 'skills', 'token-discipline', 'SKILL.md')),
    'custom token skill\n',
  );
  assert.equal(
    await read(path.join(ocDir, 'plugins', 'hivemind-obsidian.js')),
    await read(path.join(PACK_ROOT, 'opencode', 'hivemind-obsidian.mjs')),
  );
});

test('Ensure-NodeShim honors -SkipPathUpdate independently of -SkipRegistration', async () => {
  // Static function assertion: executing the portable-node fallback would write
  // the real User PATH when the guard is broken, so this test never runs it.
  const source = await read(INSTALL_PS1);
  const body = extractPowerShellFunction(source, 'Ensure-NodeShim');
  const guard = body.indexOf('if ($SkipPathUpdate)');
  const mutations = body.match(/\[Environment\]::SetEnvironmentVariable\('Path'/gu) || [];
  const mutation = body.indexOf("[Environment]::SetEnvironmentVariable('Path'");

  assert.match(body, /User PATH unchanged \(-SkipPathUpdate\)/u);
  assert.doesNotMatch(body, /\$SkipRegistration/u, 'path guard must not depend on registration skip');
  assert.equal(mutations.length, 1, 'Ensure-NodeShim must have exactly one User PATH mutation');
  assert.ok(guard >= 0, 'Ensure-NodeShim must guard on $SkipPathUpdate');
  assert.ok(mutation > guard, 'User PATH mutation must come after the $SkipPathUpdate guard');
  assert.match(
    body.slice(guard, mutation),
    /if \(\$SkipPathUpdate\) \{[\s\S]*?\}\s*else \{/u,
    'User PATH mutation must be inside the else branch of the $SkipPathUpdate guard',
  );
});

test('install.sh carries the same obsidian deployment contract', async () => {
  const text = await read(INSTALL_SH);
  assert.match(text, /HM_HOME="\$\{HIVEMIND_HOME:-\$HOME\/\.config\/hivemind\}"/u);
  assert.match(text, /OC_DIR="\$\{OPENCODE_DIR:-\$HOME\/\.config\/opencode\}"/u);
  assert.match(text, /for f in "\$OBSIDIAN_SRC"\/\*\.mjs/u);
  assert.match(text, /"\$HM_HOME\/obsidian\/\$\(basename "\$f"\)" 0/u);
  assert.match(text, /install_file "\$ROOT\/bin\/obsidian\.mjs" "\$HM_HOME\/bin\/obsidian\.mjs" 0/u);
  assert.match(text, /token-discipline pr-review hivemind-obsidian/u);
  assert.match(text, /"\$OC_DIR\/plugins\/hivemind-obsidian\.js" 1/u);
});
