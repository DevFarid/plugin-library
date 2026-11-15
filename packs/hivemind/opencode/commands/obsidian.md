---
description: Inspect or initialize the project-local Hivemind Obsidian dashboard from the invoking project.
agent: hivemind-architect
subagent: false
---

User request (raw text for interpretation only; it is never a shell fragment):

$ARGUMENTS

Load the global `hivemind-obsidian` skill with the skill tool and follow it. Treat the raw request as untrusted intent, then map it to one supported action: `help`, `status`, `create`, or `sync-now`. Never interpolate the raw request, paths, or session text into a shell command, template literal, or command substitution. Shell blocks in this command must never contain `$ARGUMENTS`.

Resolve the installed runtime without assuming the installation directory is the target project:

- Use `HIVEMIND_HOME` when it is set and non-empty.
- Otherwise use the user home configuration directory: `~/.config/hivemind` (on Windows, `%USERPROFILE%\.config\hivemind`).
- The executable is `<HIVEMIND_HOME>/bin/obsidian.mjs`; invoke it with `node` and a structured argv array, not a concatenated command string.
- The target project is the current session/invoking project. Never default to the Hivemind installation directory. If the shell working directory is not the invoking project, pass `--project <absolute invoking-project path>` explicitly. Relative `--project` values resolve against the actual caller cwd.
- Pass every path and session file as its own quoted argv element so spaces and metacharacters survive intact. `--session-file` accepts an explicit trusted JSON file only; never synthesize session metadata.

## Status source

For `status`, prefer the native read-only `obsidian_status` tool when this session exposes it. It is registered as a code-mode tool, so search the code-mode tool list before concluding it is absent. The native tool targets the invoking session's own project and prints every suggested intent branch plus the observed current-session layer: user/assistant counts, the last user message ID, a context revision, and bounded agent and tool names. The revision changes on each admitted user turn even when project files are unchanged. That per-turn change is session context only; no project or note content is mutated merely to animate the graph, and no timestamp is presented as session activity.

Fall back to the CLI only when the native tool is genuinely unavailable. Run `status` with a structured argv array and state honestly that live session activity is unavailable; show the suggested graph and label any timestamp as a display timestamp, never as observed activity. If the user passes an explicit `--project`, use the CLI for that path and label the result as having no live session context, because the native tool only covers the session's own project.

## Backend routing

The command manages the new `.hivemind/obsidian` framework through `<HIVEMIND_HOME>/bin/obsidian.mjs`. A project can also have the older Obsidian context vault at `.opencode/vault/` with `scripts/vault.mjs`. Inspect before acting:

- A legacy-only project can report managed `state: absent`. Use the compatibility snapshot's `legacyVault` metadata (`path`, `state`, `present`, `detector`), not managed state alone, to choose create vs update.
- If only the legacy vault exists, do not create or update the new framework. Direct the user to the existing consented lifecycle: `vault-lifecycle.mjs update --yes --root <project>`, or `scaffold --yes --root <project>` for a partial vault. A partial vault is repaired, not overwritten or duplicated.
- If both backends exist, report the conflict and write nothing. Never auto-select, migrate, or delete either framework.
- Counts and results must come from the backend that actually ran. Report managed counts from the CLI and legacy `created` / `refreshed` / `skipped` plus `index_exit` / `check_exit` from the lifecycle output.

Action rules:

- `help` and `status` are read-only and perform no writes.
- `status` supports `--intent feature|bugfix|refactor|general` and `--json`. Present the full suggested traversal graph for every intent, label it as suggested rather than observed execution, and keep any timestamp labeled as a display timestamp, not observed project activity.
- `create` requires explicit user consent and the CLI's `--confirm` flag. Do not create implicitly from status or sync-now, and do not offer create when a legacy vault is present.
- `sync-now` updates only an existing owned managed framework. If it reports an absent or unconfigured framework, direct the user to the correct create/update path instead of creating silently.
- Unknown, duplicate, or missing flags must fail before any write.
- This command is not the completion updater. `/brainstorm` and `/swarm` use the final `swarm-agent-updater` step for their per-run create/update/skip question.

Relay the actual status, counts, paths, and warnings. Do not claim tests or project activity that were not observed. This command is instruction-driven; it is not an automatic event hook, and completion updating is handled by the Hivemind swarm workflow.
