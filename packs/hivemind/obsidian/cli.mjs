// Slice B: strict, side-effect-free argument handling over the locked service API.
// Help and status never write. Create/sync-now delegate all filesystem safety to service.mjs.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ACTIONS, INTENTS, ObsidianError } from './contracts.mjs';
import { inspectProject, refreshProject } from './service.mjs';
import { renderStatus } from './graph.mjs';

const MAX_SESSION_FILE_BYTES = 1024 * 1024;
const VALUE_FLAGS = new Set(['--project', '--intent', '--session-file']);
const SWITCH_FLAGS = new Set(['--confirm', '--json']);
const ALLOWED_FLAGS = {
  help: new Set(['--json']),
  status: new Set(['--project', '--intent', '--json']),
  create: new Set(['--project', '--session-file', '--confirm', '--json']),
  'sync-now': new Set(['--project', '--session-file', '--json']),
};

const USAGE = [
  'hivemind obsidian',
  '',
  'Usage:',
  '  obsidian help [--json]',
  '  obsidian status [--project PATH] [--intent feature|bugfix|refactor|general] [--json]',
  '  obsidian create --confirm [--project PATH] [--session-file PATH] [--json]',
  '  obsidian sync-now [--project PATH] [--session-file PATH] [--json]',
  '',
  'Flags:',
  '  --project PATH       project root (default: actual caller cwd)',
  '  --intent NAME        status graph highlight: feature, bugfix, refactor, general',
  '  --session-file PATH  explicit trusted JSON session metadata (create/sync-now only)',
  '  --confirm            required acknowledgement for create',
  '  --json               machine-readable output',
  '',
  'create initializes a new managed framework; sync-now only updates an existing one.',
  'Help, status, and usage errors never write to the project.',
  'Exit codes: 0 success, 2 usage/project/unconfigured, 3 conflict/busy/unsafe-path, 1 I/O.',
].join('\n');

function usageError(message) {
  return new ObsidianError('usage', message);
}

function write(stream, text) {
  if (stream && typeof stream.write === 'function') {
    stream.write(text);
  }
}

// Terminal control characters are never meaningful in human output: keep
// intentional newlines/tabs, but render all other C0/C1 controls and DEL as
// inert escapes so user-supplied argv, paths, and warnings cannot inject
// terminal sequences. JSON uses JSON escaping instead and preserves values.
const HUMAN_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;
const JSON_CONTROL_PATTERN = /[\u007F-\u009F]/gu;

function escapeControlCharacter(character) {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function sanitizeHumanText(text) {
  return String(text).replace(HUMAN_CONTROL_PATTERN, escapeControlCharacter);
}

function jsonText(value) {
  // JSON.stringify already escapes C0 controls. Escape remaining C1 controls
  // (and DEL) as JSON unicode escapes so the wire format stays terminal-safe
  // while JSON.parse returns the original, unmutated string.
  return `${JSON.stringify(value, null, 2).replace(JSON_CONTROL_PATTERN, escapeControlCharacter)}\n`;
}

function writeHuman(stream, text) {
  write(stream, sanitizeHumanText(text));
}

function writeJson(stream, value) {
  write(stream, jsonText(value));
}

function exitCodeFor(code) {
  switch (code) {
    case 'usage':
    case 'project':
    case 'unconfigured':
      return 2;
    case 'conflict':
    case 'busy':
    case 'unsafe-path':
      return 3;
    case 'io':
      return 1;
    default:
      return 1;
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw usageError('arguments must be provided as an argv array');
  }
  if (argv.length === 0) {
    throw usageError('missing action; expected help, status, create, or sync-now');
  }
  const rawAction = argv[0];
  if (typeof rawAction !== 'string' || rawAction.length === 0) {
    throw usageError('action must be a non-empty string');
  }
  if (!ACTIONS.includes(rawAction)) {
    throw usageError(`unknown action: ${rawAction}`);
  }
  const flags = Object.create(null);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || argument.length === 0) {
      throw usageError('flags and values must be non-empty strings');
    }
    if (!argument.startsWith('--')) {
      throw usageError(`unexpected argument: ${argument}`);
    }
    if (SWITCH_FLAGS.has(argument)) {
      if (Object.hasOwn(flags, argument)) {
        throw usageError(`duplicate flag: ${argument}`);
      }
      flags[argument] = true;
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      if (Object.hasOwn(flags, argument)) {
        throw usageError(`duplicate flag: ${argument}`);
      }
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw usageError(`flag ${argument} requires a value`);
      }
      flags[argument] = value;
      index += 1;
      continue;
    }
    throw usageError(`unknown flag: ${argument}`);
  }
  return { action: rawAction, flags };
}

function validateFlags(action, flags) {
  const allowed = ALLOWED_FLAGS[action];
  for (const flag of Object.keys(flags)) {
    if (!allowed.has(flag)) {
      throw usageError(`flag ${flag} is not valid for ${action}`);
    }
  }
  if (flags['--project'] !== undefined && flags['--project'].includes('\0')) {
    throw usageError('project path must not contain NUL bytes');
  }
  if (flags['--intent'] !== undefined && !INTENTS.includes(flags['--intent'])) {
    throw usageError(`intent must be one of: ${INTENTS.join(', ')}`);
  }
  if (action === 'create' && flags['--confirm'] !== true) {
    throw usageError('create requires --confirm');
  }
}

function resolveProject(flags, cwd) {
  const target = flags['--project'] === undefined ? cwd : flags['--project'];
  return path.resolve(cwd, target);
}

function ioError(label, error) {
  return new ObsidianError('io', `unable to ${label}: ${error && error.code ? error.code : 'I/O error'}`);
}

async function readSessionFile(filePath, cwd) {
  const resolved = path.resolve(cwd, filePath);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw usageError(`session file does not exist: ${filePath}`);
    }
    throw ioError('inspect session file', error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw usageError('session file must be a regular file');
  }
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    throw usageError(`session file exceeds ${MAX_SESSION_FILE_BYTES} bytes`);
  }
  let bytes;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    throw ioError('read session file', error);
  }
  if (bytes.length > MAX_SESSION_FILE_BYTES) {
    throw usageError(`session file exceeds ${MAX_SESSION_FILE_BYTES} bytes`);
  }
  let parsed;
  try {
    const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
    parsed = JSON.parse(text);
  } catch {
    throw usageError('session file must contain valid JSON');
  }
  // Shape, bounds, and path safety are intentionally delegated to service.mjs.
  return parsed;
}

function helpText() {
  return `${USAGE}\n`;
}

function helpJson(renderedAt) {
  return {
    ok: true,
    action: 'help',
    actions: [...ACTIONS],
    intents: [...INTENTS],
    flags: {
      '--project': 'PATH',
      '--intent': 'feature|bugfix|refactor|general (status only)',
      '--session-file': 'PATH (create/sync-now only; explicit trusted JSON)',
      '--confirm': 'required for create',
      '--json': 'machine-readable output',
    },
    usage: USAGE,
    renderedAt,
  };
}

function formatRefresh(action, result, renderedAt) {
  const lines = [
    `hivemind obsidian :: ${action}`,
    `rendered at ${renderedAt} (display timestamp only)`,
    '',
    `project    ${result.projectRoot}`,
    `framework  ${result.frameworkRoot}`,
    `status     ${result.status}`,
    `counts     created ${result.createdCount}, updated ${result.updatedCount}, unchanged ${result.unchangedCount}`,
  ];
  if (result.warnings.length === 0) {
    lines.push('warnings   none');
  } else {
    lines.push('warnings');
    for (const warning of result.warnings) {
      lines.push(`           - ${warning}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function refreshJson(action, result, renderedAt) {
  return {
    ok: true,
    action,
    status: result.status,
    projectRoot: result.projectRoot,
    frameworkRoot: result.frameworkRoot,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    unchangedCount: result.unchangedCount,
    counts: {
      created: result.createdCount,
      updated: result.updatedCount,
      unchanged: result.unchangedCount,
    },
    warnings: [...result.warnings],
    renderedAt,
  };
}

function statusJson(snapshot, intent, renderedAt) {
  const payload = {
    ok: true,
    action: 'status',
    intent,
    projectRoot: snapshot.projectRoot,
    frameworkRoot: snapshot.frameworkRoot,
    state: snapshot.state,
    scan: {
      files: snapshot.files.length,
      truncated: Boolean(snapshot.truncated),
    },
    warnings: [...snapshot.warnings],
    suggestedBranches: [...INTENTS],
    renderedAt,
  };
  // The updater routes legacy-vault updates through the existing lifecycle
  // backend, so pass the service metadata through unchanged instead of
  // reconstructing it from managed state or human warnings.
  if (Object.hasOwn(snapshot, 'legacyVault') && snapshot.legacyVault !== undefined) {
    payload.legacyVault = snapshot.legacyVault;
  }
  return payload;
}

function reportError(error, { action, wantsJson, stderr }) {
  const known = error instanceof ObsidianError;
  const code = known ? error.code : 'io';
  const message = known ? error.message : (error && error.message ? String(error.message) : 'unexpected failure');
  const renderedAt = new Date().toISOString();
  if (wantsJson) {
    writeJson(stderr, {
      ok: false,
      action: action || null,
      error: { code, message },
      renderedAt,
    });
  } else {
    writeHuman(stderr, `obsidian: ${code}: ${message}\n`);
    if (code === 'usage') {
      writeHuman(stderr, `\n${helpText()}`);
    }
  }
  return exitCodeFor(code);
}

export async function main(argv, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const cwd = settings.cwd === undefined ? process.cwd() : settings.cwd;
  const stdout = settings.stdout === undefined ? process.stdout : settings.stdout;
  const stderr = settings.stderr === undefined ? process.stderr : settings.stderr;
  const wantsJson = Array.isArray(argv) && argv.includes('--json');
  let action = Array.isArray(argv) && typeof argv[0] === 'string' && ACTIONS.includes(argv[0])
    ? argv[0]
    : null;

  try {
    if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0')) {
      throw usageError('working directory must be a non-empty path string');
    }
    const parsed = parseArguments(argv);
    action = parsed.action;
    const { flags } = parsed;
    validateFlags(action, flags);

    if (action === 'help') {
      const renderedAt = new Date().toISOString();
      if (flags['--json']) {
        writeJson(stdout, helpJson(renderedAt));
      } else {
        writeHuman(stdout, helpText());
      }
      return 0;
    }

    const project = resolveProject(flags, cwd);

    if (action === 'status') {
      const intent = flags['--intent'] === undefined ? 'general' : flags['--intent'];
      const snapshot = await inspectProject(project);
      const renderedAt = new Date().toISOString();
      if (flags['--json']) {
        writeJson(stdout, statusJson(snapshot, intent, renderedAt));
      } else {
        writeHuman(stdout, renderStatus(snapshot, { intent, renderedAt }));
      }
      return 0;
    }

    const sessionProvided = flags['--session-file'] !== undefined;
    const session = sessionProvided ? await readSessionFile(flags['--session-file'], cwd) : undefined;
    const result = await refreshProject(project, {
      create: action === 'create',
      ...(sessionProvided ? { session } : {}),
    });
    const renderedAt = new Date().toISOString();
    if (flags['--json']) {
      writeJson(stdout, refreshJson(action, result, renderedAt));
    } else {
      writeHuman(stdout, formatRefresh(action, result, renderedAt));
    }
    return 0;
  } catch (error) {
    return reportError(error, { action, wantsJson, stderr });
  }
}
