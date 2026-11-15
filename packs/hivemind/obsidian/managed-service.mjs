// Slice A: safe project-local Obsidian framework service.
// Public API and error codes are locked by ./contracts.mjs.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  FRAMEWORK_RELATIVE,
  MANIFEST_NAME,
  MANAGED_NOTES,
  ObsidianError,
} from './contracts.mjs';

const MAX_SCAN_FILES = 2000;
const MAX_SCAN_DEPTH = 8;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_OUTCOME_LENGTH = 500;
const MAX_SESSION_PATHS = 500;
const MAX_SESSION_PATH_LENGTH = 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IGNORED_DIRECTORIES = new Set([
  '__pycache__',
  'bower_components',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const FRAMEWORK_PARTS = FRAMEWORK_RELATIVE.split('/').filter(Boolean);
const HIVE_DIRECTORY = FRAMEWORK_PARTS[0];

function fail(code, message) {
  return new ObsidianError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function frameworkPath(projectRoot) {
  return path.join(projectRoot, ...FRAMEWORK_PARTS);
}

function hivePath(projectRoot) {
  return path.join(projectRoot, HIVE_DIRECTORY);
}

function lockPath(projectRoot) {
  const name = FRAMEWORK_PARTS[FRAMEWORK_PARTS.length - 1];
  return path.join(hivePath(projectRoot), `${name}.lock`);
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw fail('io', `unable to inspect path: ${error && error.code ? error.code : 'I/O error'}`);
  }
}

function assertNotLink(stat, label) {
  if (stat && stat.isSymbolicLink()) {
    throw fail('unsafe-path', `${label} is a symbolic link or junction`);
  }
}

async function assertNoLinkedAncestors(resolved) {
  // A junction/symlink anywhere above the project lets a nested path such as
  // alias/project resolve outside the caller's tree. Check every existing
  // ancestor up to the filesystem root before scanning or writing. Compare
  // parent and child instead of a fixed root string so Windows drive/share
  // case variants cannot loop forever.
  let current = path.dirname(resolved);
  while (true) {
    const stat = await lstatOrNull(current);
    if (stat) {
      assertNotLink(stat, `project ancestor ${path.basename(current) || current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function resolveProject(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '' || projectRoot.includes('\0')) {
    throw fail('usage', 'projectRoot must be a non-empty path string');
  }
  const resolved = path.resolve(projectRoot);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw fail('project', 'project directory does not exist');
    }
    throw fail('io', `unable to inspect project directory: ${error && error.code ? error.code : 'I/O error'}`);
  }
  assertNotLink(stat, 'project directory');
  if (!stat.isDirectory()) {
    throw fail('project', 'project path is not a directory');
  }
  await assertNoLinkedAncestors(resolved);
  return resolved;
}

function assertDataProperties(value, label) {
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw fail('usage', `${label} must contain plain data fields`);
    }
  }
}

function normalizeRelativeSessionPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_PATH_LENGTH) {
    throw fail('usage', 'session.changedPaths entries must be bounded non-empty strings');
  }
  if (value.includes('\0') || /[\u0000-\u001f]/u.test(value)) {
    throw fail('usage', 'session.changedPaths entries must not contain control characters');
  }
  if (value.startsWith('/') || value.startsWith('\\') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw fail('usage', 'session.changedPaths entries must be relative paths');
  }
  const parts = value.split(/[\\/]+/u);
  if (parts.some((part) => part === '..')) {
    throw fail('usage', 'session.changedPaths entries must not traverse parents');
  }
  const normalized = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (normalized === '' || normalized.includes(':')) {
    throw fail('usage', 'session.changedPaths entries must be plain relative paths');
  }
  return normalized;
}

function normalizeSession(value) {
  if (!isPlainObject(value)) {
    throw fail('usage', 'session must be a plain object');
  }
  assertDataProperties(value, 'session');
  const allowed = new Set(['summary', 'changedPaths', 'outcome']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw fail('usage', `session contains an unsupported field: ${key}`);
  }
  const summary = value.summary === undefined ? '' : value.summary;
  const outcome = value.outcome === undefined ? '' : value.outcome;
  if (typeof summary !== 'string' || summary.length > MAX_SUMMARY_LENGTH || summary.includes('\0')) {
    throw fail('usage', `session.summary must be a string of at most ${MAX_SUMMARY_LENGTH} characters`);
  }
  if (typeof outcome !== 'string' || outcome.length > MAX_OUTCOME_LENGTH || outcome.includes('\0')) {
    throw fail('usage', `session.outcome must be a string of at most ${MAX_OUTCOME_LENGTH} characters`);
  }
  let changedPaths = [];
  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length > MAX_SESSION_PATHS) {
      throw fail('usage', `session.changedPaths must be an array of at most ${MAX_SESSION_PATHS} paths`);
    }
    changedPaths = value.changedPaths.map(normalizeRelativeSessionPath);
  }
  return { summary, changedPaths, outcome };
}

function validateManifest(value) {
  if (!isPlainObject(value)) return null;
  const topLevel = new Set(['schemaVersion', 'files', 'session']);
  for (const key of Object.keys(value)) {
    if (!topLevel.has(key)) return null;
  }
  if (value.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isPlainObject(value.files)) return null;
  const fileKeys = Object.keys(value.files);
  if (fileKeys.length !== MANAGED_NOTES.length) return null;
  const expected = new Set(MANAGED_NOTES);
  const files = {};
  for (const name of MANAGED_NOTES) {
    if (!Object.hasOwn(value.files, name)) return null;
    const hash = value.files[name];
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return null;
    files[name] = hash;
  }
  for (const key of fileKeys) {
    if (!expected.has(key)) return null;
  }
  let session;
  if (Object.hasOwn(value, 'session')) {
    try {
      session = normalizeSession(value.session);
    } catch {
      return null;
    }
  }
  return {
    manifest: { schemaVersion: SCHEMA_VERSION, files },
    session,
  };
}

function conflictResult(base, reason) {
  base.state = 'conflict';
  base.structuralConflict = true;
  base.conflictReasons.push(reason);
  return base;
}

async function readFramework(projectRoot) {
  const frameworkRoot = frameworkPath(projectRoot);
  const snapshot = {
    frameworkRoot,
    state: 'absent',
    structuralConflict: false,
    conflictReasons: [],
    mismatches: [],
    contents: Object.create(null),
    manifest: null,
    manifestBytes: null,
    session: undefined,
  };

  const hive = await lstatOrNull(hivePath(projectRoot));
  if (!hive) return snapshot;
  assertNotLink(hive, '.hivemind directory');
  if (!hive.isDirectory()) {
    return conflictResult(snapshot, '.hivemind exists but is not a directory');
  }

  const framework = await lstatOrNull(frameworkRoot);
  if (!framework) return snapshot;
  assertNotLink(framework, 'managed framework directory');
  if (!framework.isDirectory()) {
    return conflictResult(snapshot, 'managed framework path is not a directory');
  }

  const appDirectory = path.join(frameworkRoot, '.obsidian');
  const appStat = await lstatOrNull(appDirectory);
  assertNotLink(appStat, '.obsidian directory');
  if (!appStat || !appStat.isDirectory()) {
    conflictResult(snapshot, '.obsidian directory is missing or not a directory');
  }

  const manifestFile = path.join(frameworkRoot, MANIFEST_NAME);
  const manifestStat = await lstatOrNull(manifestFile);
  assertNotLink(manifestStat, 'manifest');
  if (!manifestStat) {
    return conflictResult(snapshot, 'framework exists without a manifest; refusing to claim it');
  }
  if (!manifestStat.isFile()) {
    return conflictResult(snapshot, 'manifest is not a regular file');
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    return conflictResult(snapshot, 'manifest is unreasonably large');
  }

  let manifestBytes;
  try {
    manifestBytes = await fs.readFile(manifestFile);
  } catch (error) {
    throw fail('io', `unable to read manifest: ${error && error.code ? error.code : 'I/O error'}`);
  }
  snapshot.manifestBytes = manifestBytes;

  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return conflictResult(snapshot, 'manifest is not valid JSON');
  }
  const validated = validateManifest(parsed);
  if (!validated) {
    return conflictResult(snapshot, 'manifest does not match the expected schema and filenames');
  }
  snapshot.manifest = validated.manifest;
  snapshot.session = validated.session;

  for (const name of MANAGED_NOTES) {
    const notePath = path.join(frameworkRoot, name);
    const noteStat = await lstatOrNull(notePath);
    assertNotLink(noteStat, `managed file ${name}`);
    if (!noteStat || !noteStat.isFile()) {
      conflictResult(snapshot, `managed file is missing or not a regular file: ${name}`);
      continue;
    }
    if (noteStat.size > MAX_NOTE_BYTES) {
      conflictResult(snapshot, `managed file is unreasonably large: ${name}`);
      continue;
    }
    let content;
    try {
      content = await fs.readFile(notePath);
    } catch (error) {
      throw fail('io', `unable to read managed file: ${error && error.code ? error.code : 'I/O error'}`);
    }
    snapshot.contents[name] = content;
    if (hashBuffer(content) !== validated.manifest.files[name]) {
      snapshot.mismatches.push(name);
    }
  }

  if (!snapshot.structuralConflict && snapshot.mismatches.length === 0) {
    snapshot.state = 'ready';
  } else {
    snapshot.state = 'conflict';
  }
  return snapshot;
}

function relativeName(projectRoot, absolute) {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

async function scanProject(projectRoot) {
  const state = {
    files: [],
    truncated: false,
    warnings: [],
  };
  let fileLimitReached = false;
  let depthWarningAdded = false;

  function markFileLimit() {
    if (fileLimitReached) return;
    fileLimitReached = true;
    state.truncated = true;
    state.warnings.push(`filename scan truncated at ${MAX_SCAN_FILES} files`);
  }

  async function walk(directory, relativeDirectory, depth, root) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (root) {
        throw fail('io', `unable to scan project directory: ${error && error.code ? error.code : 'I/O error'}`);
      }
      state.warnings.push(`unable to scan subdirectory: ${relativeDirectory || '.'}`);
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue; // hidden files and directories, including .git/.hivemind/.obsidian
      if (entry.isSymbolicLink()) continue; // never follow links or junctions

      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (!isFile && !isDirectory) {
        const absolute = path.join(directory, name);
        const stat = await lstatOrNull(absolute);
        if (!stat) continue;
        if (stat.isSymbolicLink()) continue;
        isFile = stat.isFile();
        isDirectory = stat.isDirectory();
      }

      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (isFile) {
        if (state.files.length >= MAX_SCAN_FILES) {
          markFileLimit();
          return;
        }
        state.files.push(relative);
        continue;
      }
      if (!isDirectory) continue;
      if (IGNORED_DIRECTORIES.has(name.toLowerCase())) continue;
      if (depth >= MAX_SCAN_DEPTH) {
        // The subtree is unknown, not empty: mark the scan incomplete instead
        // of silently reporting a complete listing that omits these entries.
        state.truncated = true;
        if (!depthWarningAdded) {
          depthWarningAdded = true;
          state.warnings.push(`filename scan truncated at depth ${MAX_SCAN_DEPTH}: ${relative}`);
        }
        continue;
      }
      if (state.files.length >= MAX_SCAN_FILES) {
        markFileLimit();
        return;
      }
      await walk(path.join(directory, name), relative, depth + 1, false);
      if (fileLimitReached) return;
    }
  }

  await walk(projectRoot, '', 0, true);
  state.files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return state;
}

function oneLine(value, maximum) {
  const text = String(value).replace(/\r\n?/gu, ' ').replace(/\n/gu, ' ').replace(/\0/gu, ' ');
  return maximum === undefined ? text : text.slice(0, maximum);
}

function renderProjectNote(projectName, scan) {
  const truncated = scan.truncated ? ' (truncated)' : '';
  return [
    '# Project',
    '',
    `- Name: ${oneLine(projectName)}`,
    '- Managed by: hivemind obsidian',
    `- Framework: \`${FRAMEWORK_RELATIVE}\``,
    `- Scanned files: ${scan.files.length}${truncated}`,
    '',
    'Related: [[Files]] / [[Swarm]]',
    '',
  ].join('\n');
}

function renderFilesNote(scan) {
  const truncated = scan.truncated ? ' (truncated)' : '';
  const listing = scan.files.length === 0
    ? '_No files found._'
    : scan.files.map((file) => `- ${oneLine(file)}`).join('\n');
  return [
    '# Files',
    '',
    'Related: [[Project]] / [[Swarm]]',
    '',
    `Scanned files: ${scan.files.length}${truncated}`,
    '',
    listing,
    '',
  ].join('\n');
}

function renderSwarmNote(session) {
  const lines = [
    '# Swarm',
    '',
    'Related: [[Project]] / [[Files]]',
    '',
    '## Session',
    '',
  ];
  if (!session) {
    lines.push('No session recorded.');
  } else {
    lines.push(`- Summary: ${session.summary ? oneLine(session.summary, MAX_SUMMARY_LENGTH) : 'None recorded.'}`);
    lines.push(`- Outcome: ${session.outcome ? oneLine(session.outcome, MAX_OUTCOME_LENGTH) : 'None recorded.'}`);
    if (session.changedPaths.length === 0) {
      lines.push('- Changed paths: None recorded.');
    } else {
      lines.push('- Changed paths:');
      for (const changedPath of session.changedPaths) {
        lines.push(`  - ${changedPath}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderManagedNote(name, context) {
  switch (name) {
    case 'Project.md':
      return renderProjectNote(context.projectName, context.scan);
    case 'Files.md':
      return renderFilesNote(context.scan);
    case 'Swarm.md':
      return renderSwarmNote(context.session);
    default:
      return `# ${oneLine(name.replace(/\.md$/u, ''))}\n\nManaged by hivemind obsidian.\n`;
  }
}

function buildDesired(projectRoot, scan, session) {
  const context = { projectName: path.basename(projectRoot), scan, session };
  const contents = Object.create(null);
  const files = {};
  for (const name of MANAGED_NOTES) {
    const content = Buffer.from(renderManagedNote(name, context), 'utf8');
    contents[name] = content;
    files[name] = hashBuffer(content);
  }
  const manifest = { schemaVersion: SCHEMA_VERSION, files };
  if (session !== undefined) manifest.session = session;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { contents, manifestBytes };
}

async function atomicWrite(target, content) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Ignore cleanup failures; the original I/O error is what matters.
      }
    }
    try {
      await fs.unlink(temporary);
    } catch {
      // The temporary file may never have been created.
    }
    throw fail('io', `unable to write ${path.basename(target)}: ${error && error.code ? error.code : 'I/O error'}`);
  }
}

async function ensureHiveDirectory(projectRoot) {
  const hive = hivePath(projectRoot);
  const existing = await lstatOrNull(hive);
  if (existing) {
    assertNotLink(existing, '.hivemind directory');
    if (!existing.isDirectory()) {
      throw fail('conflict', '.hivemind exists but is not a directory');
    }
    return;
  }
  try {
    await fs.mkdir(hive);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw fail('io', `unable to create .hivemind directory: ${error && error.code ? error.code : 'I/O error'}`);
    }
  }
  const created = await lstatOrNull(hive);
  assertNotLink(created, '.hivemind directory');
  if (!created || !created.isDirectory()) {
    throw fail('conflict', 'unable to establish a safe .hivemind directory');
  }
}

async function createFrameworkDirectories(projectRoot) {
  const frameworkRoot = frameworkPath(projectRoot);
  try {
    await fs.mkdir(frameworkRoot);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = await lstatOrNull(frameworkRoot);
      assertNotLink(existing, 'managed framework directory');
      throw fail('conflict', 'managed framework appeared while creating it; refusing to claim it');
    }
    throw fail('io', `unable to create framework directory: ${error && error.code ? error.code : 'I/O error'}`);
  }
  const appDirectory = path.join(frameworkRoot, '.obsidian');
  try {
    await fs.mkdir(appDirectory);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = await lstatOrNull(appDirectory);
      assertNotLink(existing, '.obsidian directory');
      if (existing && existing.isDirectory()) return frameworkRoot;
    }
    throw fail('io', `unable to create .obsidian directory: ${error && error.code ? error.code : 'I/O error'}`);
  }
  return frameworkRoot;
}

async function withProjectLock(projectRoot, operation) {
  const target = lockPath(projectRoot);
  let handle;
  try {
    handle = await fs.open(target, 'wx', 0o600);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EISDIR')) {
      throw fail('busy', 'another refresh operation holds the project lock');
    }
    throw fail('io', `unable to acquire project lock: ${error && error.code ? error.code : 'I/O error'}`);
  }
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    } catch (error) {
      throw fail('io', `unable to initialize project lock: ${error && error.code ? error.code : 'I/O error'}`);
    }
    return await operation();
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing is best effort; the exclusive file remains until unlink succeeds.
    }
    try {
      await fs.unlink(target);
    } catch {
      // A lock that cannot be removed is left for explicit operator recovery.
    }
  }
}

export async function inspectProject(projectRoot) {
  const resolved = await resolveProject(projectRoot);
  const scan = await scanProject(resolved);
  const framework = await readFramework(resolved);
  const warnings = [...scan.warnings, ...framework.conflictReasons];
  if (framework.mismatches.length > 0) {
    warnings.push(`managed file hash mismatch: ${framework.mismatches.join(', ')}`);
  }
  return {
    projectRoot: resolved,
    frameworkRoot: framework.frameworkRoot,
    state: framework.state,
    files: scan.files,
    truncated: scan.truncated,
    warnings,
  };
}

export async function refreshProject(projectRoot, options = {}) {
  if (!isPlainObject(options)) {
    throw fail('usage', 'refresh options must be a plain object');
  }
  assertDataProperties(options, 'refresh options');
  for (const key of Object.keys(options)) {
    if (key !== 'create' && key !== 'session') {
      throw fail('usage', `unsupported refresh option: ${key}`);
    }
  }
  const create = options.create === undefined ? false : options.create;
  if (typeof create !== 'boolean') {
    throw fail('usage', 'create must be a boolean');
  }
  const sessionProvided = Object.hasOwn(options, 'session') && options.session !== undefined;
  const session = sessionProvided ? normalizeSession(options.session) : undefined;

  const resolved = await resolveProject(projectRoot);
  const probe = await readFramework(resolved);
  if (probe.structuralConflict) {
    throw fail('conflict', probe.conflictReasons[0] || 'framework cannot be safely updated');
  }
  if (probe.state === 'absent' && !create) {
    throw fail('unconfigured', 'no managed Obsidian framework exists; run create first');
  }
  if (probe.state === 'absent') {
    await ensureHiveDirectory(resolved);
  }

  return withProjectLock(resolved, async () => {
    const current = await readFramework(resolved);
    if (current.structuralConflict) {
      throw fail('conflict', current.conflictReasons[0] || 'framework cannot be safely updated');
    }
    if (current.state === 'absent' && !create) {
      throw fail('unconfigured', 'no managed Obsidian framework exists; run create first');
    }

    const scan = await scanProject(resolved);
    const effectiveSession = sessionProvided ? session : current.session;
    const desired = buildDesired(resolved, scan, effectiveSession);
    const existed = current.state !== 'absent';

    if (existed && current.mismatches.length > 0) {
      for (const name of current.mismatches) {
        const present = current.contents[name];
        if (!present || !present.equals(desired.contents[name])) {
          throw fail('conflict', `managed file has manual edits: ${name}`);
        }
      }
    }

    let createdCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;

    if (!existed) {
      await createFrameworkDirectories(resolved);
    }

    for (const name of MANAGED_NOTES) {
      const target = path.join(current.frameworkRoot, name);
      if (!existed) {
        await atomicWrite(target, desired.contents[name]);
        createdCount += 1;
        continue;
      }
      const previous = current.contents[name];
      if (previous && previous.equals(desired.contents[name])) {
        unchangedCount += 1;
      } else {
        await atomicWrite(target, desired.contents[name]);
        updatedCount += 1;
      }
    }

    const manifestTarget = path.join(current.frameworkRoot, MANIFEST_NAME);
    const manifestChanged = !current.manifestBytes || !current.manifestBytes.equals(desired.manifestBytes);
    if (manifestChanged) {
      await atomicWrite(manifestTarget, desired.manifestBytes);
    }

    const status = !existed
      ? 'created'
      : updatedCount > 0 || manifestChanged
        ? 'updated'
        : 'unchanged';

    return {
      projectRoot: resolved,
      frameworkRoot: current.frameworkRoot,
      status,
      createdCount,
      updatedCount,
      unchangedCount,
      warnings: [...scan.warnings],
    };
  });
}
