// Architect-owned v1 boundary. Node built-ins only.
export const SCHEMA_VERSION = 1;
export const FRAMEWORK_RELATIVE = '.hivemind/obsidian';
export const MANIFEST_NAME = 'manifest.json';
export const MANAGED_NOTES = ['Project.md', 'Files.md', 'Swarm.md'];
export const ACTIONS = ['help', 'status', 'create', 'sync-now'];
export const INTENTS = ['feature', 'bugfix', 'refactor', 'general'];
export class ObsidianError extends Error {
  constructor(code, message) { super(message); this.name = 'ObsidianError'; this.code = code; }
}
/**
 * service.mjs exports async inspectProject(projectRoot) -> Snapshot and
 * async refreshProject(projectRoot, {create=false, session}={}) -> Result.
 * Snapshot: {projectRoot, frameworkRoot, state:'absent'|'ready'|'conflict',
 * files:string[] (relative paths only), truncated:boolean, warnings:string[]}.
 * Result: {projectRoot, frameworkRoot, status:'created'|'updated'|'unchanged',
 * createdCount:number, updatedCount:number, unchangedCount:number, warnings:string[]}.
 * Throws ObsidianError(code,message); codes usage, project, unconfigured,
 * conflict, busy, unsafe-path, io. No success on partial failure.
 * session?: {summary:string, changedPaths:string[], outcome:string}; plain data only.
 * cli.mjs exports async main(argv,{cwd,stdout,stderr}={}) -> numeric exit code.
 * graph.mjs exports renderStatus(snapshot,{intent='general'}={}) -> ASCII string.
 * CLI flags: --project PATH, --intent feature|bugfix|refactor|general (status only),
 * --session-file PATH (create/sync-now only; explicit trusted JSON), --json.
 * create requires --confirm; sync-now consents to updating ONLY an existing framework.
 * Help/status/usage errors perform no writes.
 * Exit: 0 success, 2 usage/project/unconfigured, 3 conflict/busy/unsafe-path, 1 io.
 */
