// Slice B: read-only ASCII status rendering for the managed Obsidian framework.
// The graph is a *suggestion* of swarm traversal, never observed execution history.
import { INTENTS, ObsidianError } from './contracts.mjs';

const INTENT_BRANCHES = {
  feature: 'architect -> planner -> implementer -> verifier -> auditor',
  bugfix: 'architect -> reproducer -> fixer -> verifier -> auditor',
  refactor: 'architect -> mapper -> refactorer -> verifier -> auditor',
  general: 'architect -> router -> specialist -> verifier',
};

function oneLine(value, fallback = '(unknown)') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).replace(/\r\n?/gu, ' ').replace(/\n/gu, ' ').replace(/\0/gu, ' ');
}

function stateLabel(state) {
  switch (state) {
    case 'ready':
      return 'ready (managed framework detected)';
    case 'absent':
      return 'absent (not initialized; run create --confirm)';
    case 'conflict':
      return 'conflict (managed files need operator attention)';
    default:
      return oneLine(state, 'unknown');
  }
}

// Legacy context-vault metadata is reported independently of the managed
// framework state. A legacy-only project can legitimately report managed
// state absent, so operators and the updater must see present/state/path/
// detector without inferring them from the managed state or warnings.
function legacyStatusLines(legacy, managedState) {
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return [];
  }
  const present = legacy.present === true;
  const lines = [
    `legacy     ${present ? 'present' : 'not present'}`,
    `legacy state ${oneLine(legacy.state, 'unknown')}`,
    `legacy path ${oneLine(legacy.path)}`,
    `legacy detector ${oneLine(legacy.detector, 'unknown')}`,
  ];
  if (present && managedState !== 'absent') {
    lines.push('dual       conflict: legacy and managed backends both present; no backend auto-selected');
  }
  return lines;
}

export function renderStatus(snapshot, options = {}) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ObsidianError('usage', 'status snapshot must be an object');
  }
  const settings = options && typeof options === 'object' ? options : {};
  const intent = settings.intent === undefined ? 'general' : settings.intent;
  if (typeof intent !== 'string' || !INTENTS.includes(intent)) {
    throw new ObsidianError('usage', `intent must be one of: ${INTENTS.join(', ')}`);
  }
  const renderedAt = settings.renderedAt === undefined
    ? new Date().toISOString()
    : String(settings.renderedAt);
  const files = Array.isArray(snapshot.files) ? snapshot.files.length : 0;
  const truncated = Boolean(snapshot.truncated);
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];

  const lines = [];
  lines.push('hivemind obsidian :: status');
  lines.push(`rendered at ${renderedAt} (display timestamp only; not observed project activity)`);
  lines.push('');
  lines.push(`project    ${oneLine(snapshot.projectRoot)}`);
  lines.push(`framework  ${oneLine(snapshot.frameworkRoot)}`);
  lines.push(`state      ${stateLabel(snapshot.state)}`);
  for (const line of legacyStatusLines(snapshot.legacyVault, snapshot.state)) {
    lines.push(line);
  }
  lines.push(`scan       ${files} file(s) (${truncated ? 'truncated' : 'complete'})`);
  if (warnings.length === 0) {
    lines.push('warnings   none');
  } else {
    lines.push('warnings');
    for (const warning of warnings) {
      lines.push(`           - ${oneLine(warning)}`);
    }
  }
  lines.push('');
  lines.push('SUGGESTED SWARM TRAVERSAL (suggested, not observed execution history)');
  lines.push(`selected intent: ${intent}`);
  lines.push('');
  lines.push('  project');
  lines.push('    |');
  lines.push(`    +-- hivemind/obsidian [${oneLine(snapshot.state, 'unknown')}]`);
  for (const name of INTENTS) {
    const marker = name === intent ? ' <<< SELECTED' : '';
    lines.push('    |');
    lines.push(`    +-- [${name}]${marker}`);
    lines.push(`    |     ${INTENT_BRANCHES[name]}`);
  }
  lines.push('');
  return lines.join('\n');
}
