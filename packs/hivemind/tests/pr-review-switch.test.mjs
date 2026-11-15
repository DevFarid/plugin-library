// End-to-end /hive-switch + pr-review regression suite.
//
// Every test runs inside a private temp HOME. The live user profile
// (~/.config/hivemind, ~/.config/opencode, User PATH) is never touched:
// install.ps1 is always invoked with -SkipRegistration -SkipPathUpdate, and the
// switcher only ever sees HIVEMIND_HOME / OPENCODE_DIR pointing at the temp root.
//
// The switcher under test is the canonical Node backend
// (packs/hivemind/bin/hive-switch.cjs): it owns unmanaged-config preservation,
// managed agent routing, plugin staging, and skill staging. On win32 the native
// PowerShell entrypoint is exercised instead once, and only if, it delegates to
// that backend (the two implementations must never drift).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = path.resolve(TESTS_DIR, '..');
const REPO_ROOT = path.resolve(PACK_ROOT, '..', '..');
const INSTALL_PS1 = path.join(PACK_ROOT, 'install.ps1');
const SWITCH_PS1 = path.join(PACK_ROOT, 'hive-switch.ps1');
const SWITCH_CJS = path.join(PACK_ROOT, 'bin', 'hive-switch.cjs');
const PR_REVIEW_ENGINE = path.join(REPO_ROOT, 'plugins', 'pr-review');
const HARNESS_REGISTRATION = path.join(PR_REVIEW_ENGINE, 'src', 'harness-registration.mjs');
const PROFILES_DIR = path.join(PACK_ROOT, 'profiles');

const REQUIRED_PROFILES = [
  'argon-deepseek',
  'carbon-deepseek',
  'chatgpt-deepseek',
  'claude-hybrid',
  'claude-native',
  'opencode-go-max',
];

const UNMANAGED_SEED = {
  $schema: 'https://opencode.ai/config.json',
  instructions: ['personal.md'],
  plugins: ['personal-plugin'],
};

const DENY_ALL = [{ action: '*', resource: '*', effect: 'deny' }];

const temporaryRoots = new Set();

let harnessModule;

after(async () => {
  for (const root of temporaryRoots) {
    await fs
      .rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => {});
  }
  temporaryRoots.clear();
});

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

async function copyFileInto(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

/** Recursively copy a tree, merging into an existing destination. */
async function copyTreeInto(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTreeInto(from, to);
    else if (entry.isFile()) await copyFileInto(from, to);
  }
}

function frontmatterOf(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? match[1] : '';
}

function frontmatterModelOf(text) {
  const value = /^model:[ \t]*([^\r\n]*)$/m.exec(frontmatterOf(text));
  return value ? value[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Isolated install / staging
// ---------------------------------------------------------------------------

function powershellBinary() {
  return process.env.POWERSHELL || 'powershell.exe';
}

function assertIsolatedRoot(root) {
  const resolved = path.resolve(root);
  assert.notEqual(resolved, path.resolve(os.homedir()), 'isolated home must never be the live user home');
  assert.ok(
    resolved.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()),
    `isolated home must live under the system temp dir: ${resolved}`,
  );
}

/**
 * Stage an installed-looking HIVEMIND_HOME from the repository. This is the
 * only path on non-win32, and it also tops up anything a full install may not
 * have copied (making the suite independent of incidental install layout).
 */
async function stageHiveHome(hmHome) {
  await copyFileInto(path.join(PACK_ROOT, 'base-opencode.json'), path.join(hmHome, 'base-opencode.json'));
  await copyTreeInto(PROFILES_DIR, path.join(hmHome, 'profiles'));
  await copyTreeInto(path.join(PACK_ROOT, 'opencode'), path.join(hmHome, 'opencode'));
  await copyTreeInto(path.join(REPO_ROOT, 'scripts', 'hive'), path.join(hmHome, 'scripts', 'hive'));
  await copyFileInto(
    path.join(REPO_ROOT, 'config', 'model-tiers.json'),
    path.join(hmHome, 'config', 'model-tiers.json'),
  );

  // The switcher restores skills from HIVEMIND_HOME/skills/<name>. The
  // pr-review skill carries its engine (bin + src) so the installed command
  // never depends on a repository checkout.
  const stagedSkill = path.join(hmHome, 'skills', 'pr-review');
  await copyTreeInto(path.join(PACK_ROOT, 'opencode', 'skills', 'pr-review'), stagedSkill);
  const engine = path.join(stagedSkill, 'engine');
  await copyTreeInto(path.join(PR_REVIEW_ENGINE, 'bin'), path.join(engine, 'bin'));
  await copyTreeInto(path.join(PR_REVIEW_ENGINE, 'src'), path.join(engine, 'src'));
  await copyFileInto(path.join(PR_REVIEW_ENGINE, 'package.json'), path.join(engine, 'package.json'));
  await copyFileInto(path.join(PR_REVIEW_ENGINE, 'README.md'), path.join(engine, 'README.md'));

  await copyTreeInto(
    path.join(PACK_ROOT, 'opencode', 'skills', 'hivemind-obsidian'),
    path.join(hmHome, 'skills', 'hivemind-obsidian'),
  );
}

async function stageOpencodeDir(ocDir) {
  await copyTreeInto(path.join(PACK_ROOT, 'opencode', 'agents'), path.join(ocDir, 'agents'));
  await copyTreeInto(path.join(PACK_ROOT, 'opencode', 'commands'), path.join(ocDir, 'commands'));
  await copyFileInto(path.join(PACK_ROOT, 'opencode', 'AGENTS.md'), path.join(ocDir, 'AGENTS.md'));
  await fs.mkdir(path.join(ocDir, 'plugins'), { recursive: true });
  await fs.mkdir(path.join(ocDir, 'skills'), { recursive: true });
}

function isolatedEnv(home, hmHome, ocDir) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    HIVEMIND_HOME: hmHome,
    OPENCODE_DIR: ocDir,
  };
  delete env.HIVE_PROFILE;
  delete env.OPENCODE_CONFIG;
  return env;
}

async function prepareIsolatedHome(label) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `hivemind switch ${label} `));
  temporaryRoots.add(home);
  assertIsolatedRoot(home);

  const hmHome = path.join(home, '.config', 'hivemind');
  const ocDir = path.join(home, '.config', 'opencode');
  const env = isolatedEnv(home, hmHome, ocDir);

  if (process.platform === 'win32') {
    const installed = spawnSync(
      powershellBinary(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        INSTALL_PS1,
        '-SkipRegistration',
        '-SkipPathUpdate',
      ],
      { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 180_000, windowsHide: true },
    );
    assert.equal(
      installed.status,
      0,
      `install.ps1 isolated install failed\nstatus: ${installed.status}\n` +
        `stdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`,
    );
  }

  await stageHiveHome(hmHome);
  await stageOpencodeDir(ocDir);
  return { home, hmHome, ocDir, env };
}

// ---------------------------------------------------------------------------
// Switcher invocation
// ---------------------------------------------------------------------------

const PS1_DELEGATES_TO_NODE = (() => {
  if (process.platform !== 'win32') return false;
  try {
    return readFileSync(SWITCH_PS1, 'utf8').includes('hive-switch.cjs');
  } catch {
    return false;
  }
})();

function runSwitch(profileId, env) {
  const options = { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 120_000, windowsHide: true };
  if (PS1_DELEGATES_TO_NODE) {
    return spawnSync(
      powershellBinary(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SWITCH_PS1, profileId],
      options,
    );
  }
  return spawnSync(process.execPath, [SWITCH_CJS, profileId], options);
}

function switchFailure(profileId, result) {
  return (
    `hive-switch ${profileId} failed\nstatus: ${result.status}\nsignal: ${result.signal}\n` +
    `error: ${result.error ? result.error.message : '(none)'}\n` +
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

async function readProfiles() {
  const files = (await fs.readdir(PROFILES_DIR)).filter((name) => name.endsWith('.json')).sort();
  const profiles = new Map();
  for (const file of files) {
    const data = await readJson(path.join(PROFILES_DIR, file));
    const id = file.slice(0, -'.json'.length);
    assert.ok(
      data.agent_models && typeof data.agent_models === 'object',
      `profile ${file} must define agent_models`,
    );
    assert.ok(
      typeof data.agent_models['pr-reviewer'] === 'string' &&
        data.agent_models['pr-reviewer'].includes('/'),
      `profile ${file} must route pr-reviewer to a provider/model ID`,
    );
    profiles.set(id, data);
  }
  return profiles;
}

async function loadHarnessRegistration() {
  harnessModule ??= await import(pathToFileURL(HARNESS_REGISTRATION).href);
  return harnessModule;
}

// ---------------------------------------------------------------------------
// Post-switch assertions (a-h from the slice contract)
// ---------------------------------------------------------------------------

async function assertSwitchedState({ profileId, profile, hmHome, ocDir, label }) {
  const context = label ? `${label} -> ${profileId}` : profileId;

  // a) exit status is asserted by the caller; active_profile must match.
  const active = (await fs.readFile(path.join(hmHome, 'active_profile'), 'utf8')).trim();
  assert.equal(active, profileId, `${context}: active_profile must be ${profileId}`);

  // b) the architect stays the default agent.
  const configPath = path.join(ocDir, 'opencode.json');
  const configText = await fs.readFile(configPath, 'utf8');
  let config;
  try {
    config = JSON.parse(configText.replace(/^\uFEFF/, ''));
  } catch (error) {
    assert.fail(`${context}: opencode.json is not valid JSON: ${error.message}`);
  }
  assert.equal(config.default_agent, 'hivemind-architect', `${context}: default_agent`);

  // c) the managed reviewer entry is fully routed.
  const expectedModel = profile.agent_models['pr-reviewer'];
  assert.ok(
    typeof expectedModel === 'string' && expectedModel.includes('/'),
    `${context}: profile must route pr-reviewer`,
  );
  const reviewer = config.agents?.['pr-reviewer'];
  assert.ok(reviewer, `${context}: agents['pr-reviewer'] must exist`);
  assert.equal(reviewer.model, expectedModel, `${context}: pr-reviewer model`);
  assert.equal(reviewer.mode, 'subagent', `${context}: pr-reviewer mode`);
  assert.equal(reviewer.steps, 12, `${context}: pr-reviewer steps`);
  assert.deepEqual(reviewer.permissions, DENY_ALL, `${context}: pr-reviewer must be deny-all`);

  // d) the architect may launch the reviewer and the updater, after the deny.
  const architectPermissions = config.agents?.['hivemind-architect']?.permissions;
  assert.ok(Array.isArray(architectPermissions), `${context}: missing architect permissions`);
  const denyIndex = architectPermissions.findIndex(
    (entry) => entry?.action === 'subagent' && entry?.resource === '*' && entry?.effect === 'deny',
  );
  assert.ok(denyIndex >= 0, `${context}: architect wildcard subagent deny missing`);
  for (const resource of ['pr-reviewer', 'swarm-agent-updater']) {
    const allowIndex = architectPermissions.findIndex(
      (entry) =>
        entry?.action === 'subagent' && entry?.resource === resource && entry?.effect === 'allow',
    );
    assert.ok(
      allowIndex > denyIndex,
      `${context}: subagent allow for '${resource}' must appear strictly after the wildcard deny`,
    );
  }

  // e) the agent frontmatter must never shadow opencode.json with another model.
  const reviewerPath = path.join(ocDir, 'agents', 'pr-reviewer.md');
  assert.ok(await pathExists(reviewerPath), `${context}: agents/pr-reviewer.md must exist`);
  const reviewerText = await fs.readFile(reviewerPath, 'utf8');
  assert.ok(frontmatterOf(reviewerText), `${context}: pr-reviewer.md needs YAML frontmatter`);
  const frontmatterModel = frontmatterModelOf(reviewerText);
  if (frontmatterModel) {
    assert.equal(frontmatterModel, expectedModel, `${context}: reviewer frontmatter model`);
  }

  // f) managed plugins and the installed review engine are present.
  for (const relative of [
    path.join('plugins', 'hivemind-wave-limit.js'),
    path.join('plugins', 'hivemind-obsidian.js'),
    path.join('skills', 'pr-review', 'engine', 'bin', 'pr-review.mjs'),
  ]) {
    assert.ok(await pathExists(path.join(ocDir, relative)), `${context}: missing ${relative}`);
  }

  // g) unmanaged user config survives every switch untouched.
  assert.deepEqual(config.instructions, ['personal.md'], `${context}: unmanaged instructions`);
  assert.ok(Array.isArray(config.plugins), `${context}: plugins must stay an array`);
  assert.equal(
    config.plugins.filter((plugin) => plugin === 'personal-plugin').length,
    1,
    `${context}: unmanaged personal-plugin must survive exactly once`,
  );

  // h) the installed harness registration is already a no-op.
  const { applyHarnessRegistration } = await loadHarnessRegistration();
  const registration = applyHarnessRegistration({
    configText,
    reviewerText,
    sourceName: configPath,
  });
  assert.equal(
    registration.configChanged,
    false,
    `${context}: harness registration must not rewrite opencode.json`,
  );
  assert.equal(
    registration.reviewerChanged,
    false,
    `${context}: harness registration must not rewrite agents/pr-reviewer.md`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  'every committed profile switches cleanly and keeps pr-review wiring intact',
  { timeout: 240_000 },
  async () => {
    const { hmHome, ocDir, env } = await prepareIsolatedHome('all profiles');
    const configPath = path.join(ocDir, 'opencode.json');
    await writeJson(configPath, UNMANAGED_SEED);

    const profiles = await readProfiles();
    for (const required of REQUIRED_PROFILES) {
      assert.ok(profiles.has(required), `profiles/${required}.json must be committed`);
    }

    for (const [profileId, profile] of profiles) {
      const result = runSwitch(profileId, env);
      assert.equal(result.status, 0, switchFailure(profileId, result));
      await assertSwitchedState({ profileId, profile, hmHome, ocDir, env });
    }
  },
);

test(
  'a stale pr-reviewer model is repaired by the carbon-deepseek switch',
  { timeout: 120_000 },
  async () => {
    const { hmHome, ocDir, env } = await prepareIsolatedHome('stale reviewer');
    const configPath = path.join(ocDir, 'opencode.json');

    await writeJson(configPath, {
      ...UNMANAGED_SEED,
      agents: {
        'pr-reviewer': {
          mode: 'subagent',
          steps: 12,
          model: 'deepseek/deepseek-flash',
          permissions: DENY_ALL,
        },
      },
    });

    const profiles = await readProfiles();
    const carbon = profiles.get('carbon-deepseek');
    assert.ok(carbon, 'profiles/carbon-deepseek.json must be committed');
    const expectedModel = 'opencode-go/deepseek-v4.1-flash';
    assert.equal(
      carbon.agent_models['pr-reviewer'],
      expectedModel,
      'carbon-deepseek must route pr-reviewer to the OpenCode Go DeepSeek worker',
    );

    const result = runSwitch('carbon-deepseek', env);
    assert.equal(result.status, 0, switchFailure('carbon-deepseek', result));

    const config = await readJson(configPath);
    assert.equal(
      config.agents?.['pr-reviewer']?.model,
      expectedModel,
      'switch must repair the stale pr-reviewer model in opencode.json',
    );

    const reviewerText = await fs.readFile(path.join(ocDir, 'agents', 'pr-reviewer.md'), 'utf8');
    assert.equal(
      frontmatterModelOf(reviewerText),
      expectedModel,
      'switch must repair the stale pr-reviewer frontmatter model',
    );

    await assertSwitchedState({
      profileId: 'carbon-deepseek',
      profile: carbon,
      hmHome,
      ocDir,
      env,
      label: 'repair',
    });
  },
);
