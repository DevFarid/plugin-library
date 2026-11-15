# Hivemind Obsidian workflow

This feature adds a project-local Obsidian dashboard command and a final completion updater to Hivemind. It does not import, sync, or modify an external Obsidian application vault. The managed framework lives at `.hivemind/obsidian` inside the actual project that invokes the command.

A project may already have the older Obsidian-compatible context vault at `.opencode/vault/` plus `scripts/vault.mjs`. That legacy backend is kept working unchanged. This workflow inspects both backends, updates an existing legacy vault through its current consented lifecycle, and never creates a second framework beside it.

## Runtime location

- The globally installed managed CLI is `<HIVEMIND_HOME>/bin/obsidian.mjs`.
- `HIVEMIND_HOME` overrides the installation root when set and non-empty.
- The default is `~/.config/hivemind` (Windows: `%USERPROFILE%\.config\hivemind`).
- The legacy lifecycle is `<HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs`; this checkout also has `scripts/hive/vault-lifecycle.mjs`.
- The target project is the current invoking project, never the Hivemind installation directory. Relative `--project` values resolve against the caller cwd; legacy commands use `--root`.

## `/obsidian` actions

```text
/obsidian help
/obsidian status [--project PATH] [--intent feature|bugfix|refactor|general] [--json]
/obsidian create --confirm [--project PATH] [--session-file PATH] [--json]
/obsidian sync-now [--project PATH] [--session-file PATH] [--json]
```

- `help` and `status` perform no writes. `status` is valid when the framework is absent.
- `create` requires explicit consent and `--confirm`. It is never initiated silently by status or sync-now, and it is not offered when a legacy vault is present.
- `sync-now` updates only an already-created owned managed framework. A missing framework produces a direction to create it, not an implicit creation.
- Duplicate, unknown, and missing flags fail before writes.
- `--session-file` accepts an explicit trusted JSON file. The updater never invents test results or activity.

The command loads the global `hivemind-obsidian` skill and invokes the real CLI with a structured argv array. Raw `$ARGUMENTS` text is interpreted as intent only and is never interpolated into a shell command. Paths and session files are passed as separate quoted arguments so spaces and metacharacters remain intact.

## Status graph

The preferred source for `status` is the native, read-only `obsidian_status` tool when the invoking session exposes it. It is a code-mode tool, so locate it through code-mode tool search before concluding it is absent. The native tool reports the session's own project, every suggested intent branch, and the observed current-session layer: user/assistant counts, the last user message ID, a context revision, and bounded agent and tool names.

The context revision changes on every admitted user turn even when no project file changes. That is session context, not project activity: the command does not mutate project or note content just to animate the graph, and it never presents a timestamp as observed session activity.

When the native tool is genuinely unavailable, `status` falls back to the CLI and states honestly that live session activity is unavailable. `status` prints every suggested intent branch (`feature`, `bugfix`, `refactor`, `general`). The graph is a suggestion of swarm traversal, not observed execution history. Any timestamp is labeled as a display timestamp only and is not evidence of project activity. An explicit `--project` uses the CLI and is labeled as having no live session context, because the native tool only covers the session's own project.

## Backend routing

The compatibility adapter's snapshot exposes:

```text
legacyVault: { path, state, present, detector }
```

- `state` may be `absent`, `partial`, `present_healthy`, `present_unhealthy`, or `unknown`; `present` can be true when `state` is `absent` because a legacy marker exists. `detector` is `vault-detect` or `unavailable`.
- Choose update vs create from `legacyVault` plus managed state, never from managed state alone.
- Only legacy vault, healthy or unhealthy: update with `node <HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs update --yes --root <project>`. Do not use the managed CLI.
- Only legacy vault, partial: repair with explicit consent via the existing `scaffold --yes --root <project>`. Missing notes are filled in; existing content is not overwritten and no `.hivemind` framework is created.
- Only managed framework: update with `bin/obsidian.mjs sync-now`.
- Neither backend: create with `bin/obsidian.mjs create --confirm` after explicit consent.
- Both backends: conflict. No writes and no auto-selection or migration; direct the user to the existing legacy lifecycle.
- Legacy markers with an unavailable detector: fail closed; do not create or refresh the managed backend.
- Report managed `status` / `createdCount` / `updatedCount` / `unchangedCount`, or legacy `created` / `refreshed` / `skipped` plus `index_exit` / `check_exit`. Never invent counts.

## Final completion updater

After the integrated quality gate of a completed run, the parent asks with the actual question tool exactly once for that run: create, update, or skip. The valid options follow the observed backend: absent means create/skip; an existing managed or legacy framework means update/skip; a conflict means skip with the conflict reported. The question repeats on every completed run; a previous skip is never remembered and silence is not consent. An old goal-ID record or `.hive/lifecycle` answer cannot suppress a new inference question.

The final `swarm-agent-updater` receives that explicit choice and executes only that action:

- `create` -> managed `create --confirm`
- `update` -> managed `sync-now` for `.hivemind/obsidian`, or legacy `vault-lifecycle.mjs update --yes` / partial `scaffold --yes` for `.opencode/vault`
- `skip` -> no writes

If the current session registry does not yet expose the updater agent, the parent executes the same procedure inline after loading the skill. The updater is the final step; no later implementation workers run. Failed gates are disclosed, and the summary reports only actual counts, paths, warnings, and failures.

## `/brainstorm` completion policy

`/brainstorm` keeps the original vault-first gate before exploration, validates and resolves the higher `spec-architect` tier, and makes exactly one `@spec-architect` call. After that inference completes, it asks the framework question with the actual question tool before it separately offers to launch `/swarm`.

- The framework question runs after every completed brainstorm inference, including repeat runs and runs where an earlier skip or old goal record exists.
- No framework is created or updated mid-inference.
- A create, update, or skip is not launch consent; the launch question is separate.
- When implementation proceeds, `/swarm` owns its single final updater, so `/brainstorm` does not add a second checkpoint.

## Limitations

This behavior is instruction-driven. It is not an automatic runtime event hook, and it does not claim external application slash-command execution or Obsidian app integration without runtime evidence.
