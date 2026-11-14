# Context Vault Usage

> The lifecycle CLI and scaffolded project CLI are covered by unit and
> end-to-end tests. Always confirm observed exit codes before claiming success.

Task-oriented recipes for the optional Obsidian-compatible context vault. For
concepts, consent semantics, and invariants, read [`GUIDE.md`](GUIDE.md).

## Install or upgrade

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

macOS / Linux / WSL:

```bash
bash install.sh
```

Restart OpenCode Desktop once, then activate a stack:

```powershell
hive-switch chatgpt-deepseek
```

To upgrade, rerun the installer. Installed prompts are **kept** unless you
explicitly force them:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force
```

```bash
FORCE=1 bash install.sh
```

Use the force flag only after backing up local prompt customizations. Existing
profiles and `opencode.json` are backed up; a project's existing vault is never
edited by the installer.

## Normal loop

1. `/brainstorm <thought dump>` — checks the model-tier invariant and runs the
   vault gate before exploring files. It emits `vault-gate: <state>` and, when a
   vault exists, feeds L0/L1 vault context to `@spec-architect`.
2. After that inference completes, the actual `question` tool asks once for that
   run: create when both backends are absent, update when a managed or legacy
   framework exists, or skip for this run only. The question repeats on every
   brainstorm run; old goal records and earlier skips cannot suppress it.
3. Review `.opencode/SPEC.md`, then separately answer the launch `/swarm`
   question. A framework create, update, or skip is not launch consent.
4. After the swarm verification gate passes, one final `swarm-agent-updater`
   asks and applies the same create/update/skip choice. There is no second legacy
   checkpoint prompt.

## Managed framework and legacy routing

The managed framework is `.hivemind/obsidian`, operated by
`<HIVEMIND_HOME>/bin/obsidian.mjs` (`help`, `status`, `create --confirm`,
`sync-now`). The compatibility snapshot reports `legacyVault` with `path`,
`state`, `present`, and `detector`; use it instead of managed state alone.

```bash
# managed status / create / update
node ~/.config/hivemind/bin/obsidian.mjs status --json --project <project>
node ~/.config/hivemind/bin/obsidian.mjs create --confirm --project <project>
node ~/.config/hivemind/bin/obsidian.mjs sync-now --project <project>

# legacy update / partial repair (existing lifecycle, unchanged)
node ~/.config/hivemind/scripts/hive/vault-lifecycle.mjs update --yes --root <project>
node ~/.config/hivemind/scripts/hive/vault-lifecycle.mjs scaffold --yes --root <project>
```

- Legacy healthy/unhealthy: update through the legacy lifecycle.
- Legacy partial: repair with explicit consent through the existing `scaffold`.
- Both backends present: conflict, no writes, never auto-select or migrate.
- Report managed counts or legacy `created` / `refreshed` / `skipped` and
  `index_exit` / `check_exit` only when actually observed.

The native read-only `obsidian_status` tool is preferred when available; an
offline CLI fallback must state honestly that live session activity is
unavailable.

## Consent prompts

**No vault (`absent` or `partial`)** — header `Obsidian Context Vault`:

- `Yes`: create or repair `.opencode/vault/`, index, and require
  `check --strict` exit `0`.
- `No`: write nothing. A later goal can offer again, or you can scaffold through
  the CLI.

**Vault exists (`present_healthy` or `present_unhealthy`)** — header
`Refresh Context Vault`:

- `Yes`: refresh drifted pointer notes, re-index, and require `check --strict`
  exit `0`.
- `No`: leave the vault unchanged. It is not an error.

`No` and CI (auto-`No`) never write into the vault or create `scripts/vault.mjs`.
The answer is stored per goal in `.hive/lifecycle/<goal_id>.json`.

## Manual checks

Run these before debugging agent behavior. Use the local path when you are in a
checkout; otherwise use the installed copies under `~/.config/hivemind/`.

```bash
# read-only state: absent | partial | present_healthy | present_unhealthy
node scripts/hive/vault-lifecycle.mjs detect --json

# pure, idempotent checkpoint plan for a goal
node scripts/hive/vault-lifecycle.mjs plan --goal <goal_id> --json

# model-tier invariant across profiles and baseline agents
node scripts/hive/model-tier.mjs verify --strict --json
```

Installed fallbacks:

```bash
node ~/.config/hivemind/scripts/hive/vault-lifecycle.mjs detect --json
node ~/.config/hivemind/scripts/hive/model-tier.mjs verify --strict --json
```

The tier definitions themselves live in
`~/.config/hivemind/config/model-tiers.json`; inspect that file only as data.

After a vault exists in the project, the project-local CLI is the query surface:

```bash
node scripts/vault.mjs index
node scripts/vault.mjs check --strict
node scripts/vault.mjs brief --task <id> --budget 1200
node scripts/vault.mjs find --query <text> --limit 8
node scripts/vault.mjs slice --file <path> --symbol <name>
node scripts/vault.mjs handoff write --run <run> --slice <slice> --status done
node scripts/vault.mjs handoff list --run <run>
node scripts/vault.mjs stats --json
```

Do not replace the project CLI with the installed `vault-kit/` template; scaffold
or update through the lifecycle path so placeholders are substituted.

## Recipes

**Enable a vault for an existing project.** Complete a Hivemind goal with a
clean verification gate, then choose `Yes` on `Obsidian Context Vault`. Or run
the scaffold command directly only if you understand it will write
`.opencode/vault/` and `scripts/vault.mjs`:

```bash
node scripts/hive/vault-lifecycle.mjs scaffold --yes --json
```

**Refresh after a large change.** Choose `Yes` on `Refresh Context Vault`, or
run `update` explicitly:

```bash
node scripts/hive/vault-lifecycle.mjs update --yes --goal <goal_id> --json
```

**Repair a partial vault.** Detection reports `partial`; choose `Yes` on the
create prompt. The contract is to fill missing required notes, not overwrite
existing content.

**Vault looks stale.** Run `index`, then `check --strict`. Exit `4` means the
index no longer matches the tree; a single `index` retry is expected. Other
non-zero codes are typed errors — report them and treat the vault as degraded
read-only context.

**Custom layout.** Add `vault.config.json` with `schema_version: 1` and optional
`vault_dir` / `scripts_dir`, or pass `--vault-dir` / `--root` where supported.
Override handoff storage with `--runs-dir` (for example `40-runs`).

**No prompt should have appeared.** The goal may already have an answer, or CI
is set. `plan` returns `action: "none"` in both cases. Use a new goal id or the
manual CLI instead of forcing a duplicate prompt.

## Exit codes

| Code | Use it when |
| --- | --- |
| `0` | Success. For create/update/check, both `index` and `check --strict` exited `0`. |
| `1` | Internal error; report the message and stop. |
| `2` | Validation/budget/config failure; fix the input instead of retrying. |
| `3` | Not found or refused; check ids/paths, or avoid overwriting a `done` handoff. |
| `4` | Stale/missing index; run `index` once and retry. |

Detection uses `0` for every resolved state, `2` for invalid configuration or
traversal, and `3` for a missing `--root`. Lifecycle subcommands are planned to
reuse the shared exit codes; a non-zero exit is never silently ignored.

## Troubleshooting

- **`vault-gate: absent` but the vault exists** — required sentinels are missing
  or the configured layout differs. Check `.opencode/vault/00-MOC.md`,
  `scripts/vault.mjs`, and `vault.config.json`.
- **`vault-gate: partial`** — a sentinel or required note is missing. Use the
  create prompt to repair.
- **Exit `4` loops** — confirm the CLI and vault root point at the same project,
  then run `index` once.
- **Exit `2` on a handoff** — trim to at most 5 bullets, 400 estimated tokens,
  and no diffs/logs/code fences; fix ids to `[A-Za-z0-9._-]` (max 64 chars).
- **Exit `3` on a handoff** — the slice already has a `done` digest. Re-run the
  slice instead of overwriting.
- **Command not found in a consumer project** — use
  `~/.config/hivemind/scripts/hive/...`; rerun the installer if missing.
- **`tier_violation`** — run `model-tier.mjs verify --strict --json`, then switch
  to a compliant profile. Do not spawn `@spec-architect` on a worker tier.

## Limits

The vault is an index over pointers, not a source of truth. `check` validates
structure, links, freshness, and budgets; it cannot prove prose accuracy.
Budgets are hard failures, not warnings. Detection and the published CLIs are
offline and deterministic; they perform no network fetches and do not scan for
secrets. Keep diffs, logs, credentials, and personal absolute paths out of vault
notes and handoffs.
