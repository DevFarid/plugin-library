---
name: hivemind-obsidian
description: Safely operate the project-local Hivemind Obsidian framework from any invoking project, route legacy context vaults through their existing lifecycle, and apply the per-run completion updater policy after swarm or brainstorm runs.
---

# Hivemind Obsidian

This skill is the shared, portable procedure for `/obsidian`, `/brainstorm` completion, and the final `swarm-agent-updater`. It works from any invoking project; it does not require the Hivemind installation directory to be the current directory.

## Resolve the real executable

- Use `HIVEMIND_HOME` when it is set and non-empty.
- Otherwise use `~/.config/hivemind` (Windows: `%USERPROFILE%\.config\hivemind`).
- The managed CLI is `<HIVEMIND_HOME>/bin/obsidian.mjs`, run with `node`.
- The legacy lifecycle is `<HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs`; a repo checkout can use `scripts/hive/vault-lifecycle.mjs`.
- Pass a structured argv array: action first, then flags and values as separate elements. Quote each path or session-file value as one argument. Never build a shell string from user text, and never interpolate `$ARGUMENTS` or an LLM-authored summary into a shell command.

## Managed command contract

- `help` and `status` are read-only. They perform no writes.
- `status` accepts `--project PATH`, `--intent feature|bugfix|refactor|general`, and `--json`, and is valid even when the framework is absent.
- `create --confirm` is the only new-framework creation path and requires explicit, current user consent.
- `sync-now` updates only an existing owned managed framework. If the framework is missing, direct the user to create it; never create silently.
- `--session-file PATH` is an explicit trusted JSON file containing bounded `summary`, `changedPaths`, and `outcome` data. Validate it through the CLI; never invent test results or session metadata.
- Duplicate, unknown, or missing flags fail before writes. Surface exit codes and warnings instead of hiding them.

## Legacy context vault routing

Some projects already have the older Obsidian-compatible context vault at `.opencode/vault/` with `scripts/vault.mjs` (configurable through `vault.config.json`). The compatibility adapter reports it as:

```text
legacyVault: { path, state, present, detector }
```

- `state` can be `absent`, `partial`, `present_healthy`, `present_unhealthy`, or `unknown`; `present` can be true even when `state` is `absent` because a legacy marker exists. `detector` is `vault-detect` or `unavailable`.
- Never choose create vs update from the managed `state` alone. A legacy-only project may report managed `state: absent` while `legacyVault.present` is true.
- Legacy existing healthy/unhealthy vault: update through the current consented lifecycle command, `node <HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs update --yes --root <project>`. Do not use the managed CLI to modify it.
- Legacy partial vault: explicit consent plus the existing repair path, `node <HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs scaffold --yes --root <project>`. Repair the existing scaffold; never overwrite it and never create a second `.hivemind` framework.
- Both backends present: conflict. Write nothing, never auto-select, migrate, or delete either framework. Direct the user to the existing legacy lifecycle.
- Legacy markers with an unavailable detector: fail closed; do not create or refresh the managed backend.
- Counts and results must come from the backend that actually ran: managed `status` / `createdCount` / `updatedCount` / `unchangedCount`, or legacy `created` / `refreshed` / `skipped` plus `index_exit` / `check_exit`. Never invent counts.

## Target project

The target is the actual invoking project, not the installation cwd and not a home fallback. For the managed CLI, when the shell cwd differs from the invoking project, pass `--project <absolute invoking-project path>`; for the legacy lifecycle, pass `--root <absolute invoking-project path>`. Relative paths resolve against the actual caller cwd. Preserve spaces and metacharacters by passing each value as its own argv element.

## Prefer the native status tool

When the current session exposes the native read-only `obsidian_status` tool, prefer it for `status`. It is a code-mode tool, so use code-mode tool search before deciding it is unavailable. It scopes to the invoking session's own project and returns every suggested intent branch plus the observed current-session layer: user/assistant counts, the last user message ID, a context revision, and bounded agent and tool names.

The context revision changes on every admitted user turn even when project files do not change. That is a property of the session context, not of the project: never mutate project content just to animate the graph, and never present a timestamp as observed session activity.

If the native tool is genuinely unavailable, run the CLI `status` with structured argv and state honestly that live session activity is unavailable. Any CLI timestamp is a display timestamp only. An explicit `--project` always uses the CLI and must be labeled as having no live session context, because the native tool covers only the session's own project.

## Truthful status

Render the complete suggested traversal for every intent (`feature`, `bugfix`, `refactor`, `general`), and label the graph as suggested, not observed execution history. Any timestamp is a display timestamp only; it is not evidence of project activity. Show scan counts, truncation, warnings, and conflict state exactly as reported, including the legacy path/warning when present.

## Completion updater policy

This policy applies after every completed inference run, including `/swarm` and `/brainstorm` completions and any other run that produces a verified result. It is instruction-driven, not an automatic event hook.

1. After the integrated quality gate or inference completion, the parent agent asks the user exactly once with the actual `question` tool for that run: `create`, `update`, or `skip`. The valid options depend on the observed backend: absent means `create`/`skip`; an existing managed or legacy framework means `update`/`skip`; conflict means `skip` only with a reported conflict.
2. Do not remember a previous `skip`, a previous choice, a `.hive/lifecycle` record, or prior approval. Ask again on every completed run, including a repeat brainstorm in the same project. Silence, feature approval, or an earlier decision is not consent.
3. Choose from the compatibility `legacyVault` metadata plus managed state, never managed state alone. Never auto-adopt or overwrite a conflicted, partial, or unmanaged framework.
4. Execute only the choice the user makes in this run. `skip` performs no write and creates no consent for later runs. Execute a chosen `create` or `update` before the final answer.
5. Route by backend: new managed framework uses `bin/obsidian.mjs create --confirm` or `sync-now`; an existing legacy vault uses `vault-lifecycle.mjs update --yes`; a partial legacy vault uses `vault-lifecycle.mjs scaffold --yes`. Never create a second framework and never send legacy updates through the managed CLI.
6. If the current session registry does not yet include `swarm-agent-updater`, execute the same procedure inline in the parent agent after loading this skill. Do not silently omit the final step.
7. Report the actual action, status, counts, paths, warnings, and exit codes. Do not claim tests passed, files changed, or activity occurred unless the CLI or verified run output proves it. Failed gates must be disclosed, not hidden.
8. The updater is the final step. Launch no later implementation workers, and never add a duplicate legacy checkpoint question.

`/brainstorm` separates the framework decision from the launch-swarm decision: creating, updating, or skipping the framework is not consent to launch the swarm. After the framework action completes, the command may ask once whether to launch the compiled spec, and it executes only explicit agreement. Brainstorm completions run this question after every completed inference, before the launch question; the brainstorm command itself is wired separately by the architect.
