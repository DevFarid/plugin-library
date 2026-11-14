// Slice A compatibility adapter for the public Obsidian service API.
//
// The original managed-framework implementation is preserved unchanged in
// ./managed-service.mjs. This module validates the project through that
// implementation first (root, symlink/junction ancestors, structural safety),
// then uses the existing read-only legacy vault detector before delegating any
// write. A legacy vault is never upgraded, migrated, or duplicated by the
// managed backend.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ObsidianError } from './contracts.mjs';
import {
  inspectProject as inspectManagedProject,
  refreshProject as refreshManagedProject,
} from './managed-service.mjs';

const LEGACY_VAULT_PARTS = ['.opencode', 'vault'];
const LEGACY_CLI_PARTS = ['scripts', 'vault.mjs'];
const LEGACY_CONFIG_NAME = 'vault.config.json';
const LIFECYCLE_COMMAND = 'node scripts/hive/vault-lifecycle.mjs';

// Repo checkout: packs/hivemind/obsidian -> <repo>/scripts/hive.
// Installed layout: <hivemind-home>/obsidian -> <hivemind-home>/scripts/hive.
// No personal or absolute user paths are embedded here.
const DETECTOR_CANDIDATES = [
  new URL('../../../scripts/hive/vault-detect.mjs', import.meta.url),
  new URL('../scripts/hive/vault-detect.mjs', import.meta.url),
];

let detectorPromise = null;

function fail(code, message) {
  return new ObsidianError(code, message);
}

function oneLine(value) {
  return String(value).replace(/\r\n?/gu, ' ').replace(/\n/gu, ' ').replace(/\0/gu, ' ');
}

function errorMessage(error) {
  return error && error.message ? oneLine(error.message) : 'unexpected failure';
}

async function lstatExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw fail('io', `unable to inspect legacy vault marker: ${error && error.code ? error.code : 'I/O error'}`);
  }
}

// Dynamic import keeps the managed adapter usable when the legacy helper is not
// installed. Missing helper and unreadable helper are both reported as
// availability=false; callers fail closed only when a legacy marker exists.
async function loadDetector() {
  if (detectorPromise === null) {
    detectorPromise = (async () => {
      let lastError = null;
      for (const candidate of DETECTOR_CANDIDATES) {
        try {
          const detector = await import(candidate.href);
          if (detector && typeof detector.detectVault === 'function') {
            return { detectVault: detector.detectVault, error: null };
          }
        } catch (error) {
          const code = error && (error.code || (error.cause && error.cause.code));
          if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
            lastError = error;
          }
        }
      }
      return { detectVault: null, error: lastError };
    })();
  }
  return detectorPromise;
}

async function identifyLegacyMarkers(projectRoot) {
  const markers = [];
  const vaultDirectory = path.join(projectRoot, ...LEGACY_VAULT_PARTS);
  const vaultCli = path.join(projectRoot, ...LEGACY_CLI_PARTS);
  const configFile = path.join(projectRoot, LEGACY_CONFIG_NAME);
  for (const [kind, target] of [
    ['vault-directory', vaultDirectory],
    ['vault-cli', vaultCli],
    ['config', configFile],
  ]) {
    if (await lstatExists(target)) {
      markers.push({ kind, path: target });
    }
  }
  return markers;
}

/**
 * Read-only legacy vault probe. Never creates or modifies anything.
 * @param {string} projectRoot resolved project path already validated by managed-service
 */
async function detectLegacyVault(projectRoot) {
  const markers = await identifyLegacyMarkers(projectRoot);
  const { detectVault, error } = await loadDetector();

  if (typeof detectVault !== 'function') {
    if (markers.length === 0) {
      return {
        available: false,
        present: false,
        state: 'absent',
        path: null,
        markers,
        error: error ? errorMessage(error) : null,
      };
    }
    return {
      available: false,
      present: true,
      state: 'unknown',
      path: markers[0].path,
      markers,
      error: error ? errorMessage(error) : 'legacy detector helper not found',
    };
  }

  let detected;
  try {
    detected = detectVault({ root: projectRoot });
  } catch (cause) {
    if (markers.length === 0) {
      throw fail('io', `unable to inspect legacy Obsidian vault: ${errorMessage(cause)}`);
    }
    return {
      available: true,
      present: true,
      state: 'unknown',
      path: markers[0].path,
      markers,
      error: errorMessage(cause),
    };
  }

  const state = typeof detected.state === 'string' && detected.state ? detected.state : 'unknown';
  const detectedPath = typeof detected.vault_dir === 'string' && detected.vault_dir
    ? path.resolve(projectRoot, ...detected.vault_dir.split('/'))
    : null;
  // A marker (empty .opencode/vault or vault.config.json) is still an
  // intentionally initialized legacy layout even when detectVault reports no
  // sentinels yet. Treat it as present so the managed backend fails closed.
  return {
    available: true,
    present: state !== 'absent' || markers.length > 0,
    state,
    path: detectedPath || (markers.length > 0 ? markers[0].path : null),
    markers,
    error: null,
  };
}

function legacyMarkerText(legacy) {
  if (legacy.markers.length === 0) return 'legacy marker';
  return legacy.markers.map((marker) => marker.path).join(', ');
}

function legacyStateText(legacy) {
  if (!legacy.available) return 'state: unknown (legacy detector unavailable)';
  if (legacy.state === 'absent' && legacy.markers.length > 0) {
    return 'state: absent but a legacy marker is present';
  }
  return `state: ${legacy.state}`;
}

function legacyOnlyWarning(legacy) {
  const detail = legacy.available
    ? ''
    : ` Legacy detector unavailable (${legacy.error || 'helper not found'}).`;
  return `legacy Obsidian context vault detected at ${oneLine(legacy.path || legacyMarkerText(legacy))} `
    + `(${legacyStateText(legacy)}); the managed backend will not create or refresh a second framework.${detail} `
    + `Use the existing lifecycle: ${LIFECYCLE_COMMAND} scaffold --yes (or update --yes).`;
}

function dualBackendWarning(legacy, frameworkRoot) {
  return `both the legacy Obsidian context vault at ${oneLine(legacy.path || legacyMarkerText(legacy))} `
    + `(${legacyStateText(legacy)}) and the managed framework at ${oneLine(frameworkRoot)} exist; `
    + 'refusing to auto-select or migrate. Use '
    + `${LIFECYCLE_COMMAND} update --yes to update the legacy vault, or remove one framework intentionally.`;
}

function legacyConflictMessage(legacy, frameworkRoot) {
  if (frameworkRoot) {
    return dualBackendWarning(legacy, frameworkRoot);
  }
  if (!legacy.available) {
    return `legacy Obsidian context vault markers exist at ${oneLine(legacyMarkerText(legacy))} but the legacy `
      + 'detector helper could not be loaded; refusing to create or refresh a managed framework. Use '
      + `${LIFECYCLE_COMMAND} detect --json and the existing lifecycle.`;
  }
  return `legacy Obsidian context vault detected at ${oneLine(legacy.path || legacyMarkerText(legacy))} `
    + `(${legacyStateText(legacy)}); refusing to create or refresh a managed framework. Use the existing `
    + `lifecycle: ${LIFECYCLE_COMMAND} scaffold --yes (or update --yes).`;
}

/**
 * inspectProject(projectRoot) -> Snapshot, contract-compatible.
 * Adds `legacyVault` and compatibility warnings without changing the original
 * snapshot fields; the managed framework state becomes conflict when both
 * backends exist.
 */
export async function inspectProject(projectRoot) {
  const snapshot = await inspectManagedProject(projectRoot);
  const legacy = await detectLegacyVault(snapshot.projectRoot);
  if (!legacy.present) return snapshot;

  const managedPresent = snapshot.state !== 'absent';
  const warnings = [...snapshot.warnings];
  warnings.push(
    managedPresent
      ? dualBackendWarning(legacy, snapshot.frameworkRoot)
      : legacyOnlyWarning(legacy),
  );

  return {
    ...snapshot,
    state: managedPresent ? 'conflict' : snapshot.state,
    warnings,
    legacyVault: {
      path: legacy.path,
      state: legacy.state,
      present: true,
      detector: legacy.available ? 'vault-detect' : 'unavailable',
    },
  };
}

/**
 * refreshProject(projectRoot, {create, session}) -> Result, contract-compatible.
 * Delegates unchanged option validation and managed writes to managed-service;
 * any legacy vault (present or partial) blocks all create/update writes.
 */
export async function refreshProject(projectRoot, options = {}) {
  // Validate the project and all ancestors through the original inspect path
  // before the legacy detector performs any reads of its own.
  const snapshot = await inspectManagedProject(projectRoot);
  const legacy = await detectLegacyVault(snapshot.projectRoot);
  if (legacy.present) {
    const frameworkRoot = snapshot.state === 'absent' ? null : snapshot.frameworkRoot;
    throw fail('conflict', legacyConflictMessage(legacy, frameworkRoot));
  }
  return refreshManagedProject(snapshot.projectRoot, options);
}
