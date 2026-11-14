# Obsidian command-system PR integration contract

## Scope
Port the completed local implementation without personal paths, backups, credentials, or local runtime state. New portable code lives at `packs/hivemind/obsidian/`, executable at `packs/hivemind/bin/obsidian.mjs`, native V2 plugin at `packs/hivemind/opencode/hivemind-obsidian.mjs`, skill under pack `opencode/skills/hivemind-obsidian` and final updater under pack agents. Existing provider/model tiers and context-vault APIs remain compatible.

## Locked boundaries
`packs/hivemind/obsidian/contracts.mjs` retains original service/CLI APIs and local managed framework safety. New managed implementation is moved unchanged to `managed-service.mjs`; public `service.mjs` becomes a compatibility adapter.
- Before any new framework creation/update, adapter uses the existing `scripts/hive/vault-detect.mjs` read-only API to detect the configured legacy vault. Resolve installed helper at `<hivemind-home>/scripts/hive/`, repo helper at `<repo>/scripts/hive/`, no hardcoded user paths.
- If legacy vault exists (including partial) never create a second framework or mutate it using the new backend. `inspectProject` shows the legacy framework path/state with a clear compatibility warning. Refresh throws `conflict` with remediation to existing `vault-lifecycle.mjs scaffold/update --yes`. Both backends present reports conflict, never auto-selects/migrates. Optional missing helper must fail closed when legacy sentinels/config exist; normal new fixtures still work.
- Existing legacy lifecycle implementation remains untouched. Skill/updater routes legacy updates through that existing consented lifecycle command; new managed framework actions use new CLI. Counts/results must be from each actual backend, never invented. Do not treat old goal-ID No record as consent/skip on a new inference run.
- Native `obsidian_status` remains read-only, session-location scoped and permission asserted, includes suggested ASCII branches plus actual context revision changing with every admitted user turn. Offline CLI fallback cannot claim live session activity.
- Every brainstorm inference completion asks create/update/skip before the separate launch-swarm question, including when skip was chosen in earlier inference runs. Preserve initial legacy vault-first check, tier validation and spec-architect once. Do not create mid-inference. Swarm has exactly one final updater/consent step, not duplicate old+new checkpoint prompts.
- Existing legacy lifecycle CLIs/tests remain supported; migrate tests only where prior prose explicitly conflicts with new user-approved end-of-inference QA requirement.

## Disjoint ownership and checks
| Slice | OWNED_FILES | READ_ONLY_CONTRACTS | Check |
|---|---|---|---|
| A compatibility | pack `obsidian/service.mjs`, `obsidian/managed-service.mjs`, `tests/obsidian-compatibility.test.mjs`; adapt service tests only if import of unchanged implementation needed | this spec, pack contracts, scripts/hive vault detection/lifecycle | `node --test packs/hivemind/tests/obsidian-{service,cli,plugin,compatibility}.test.mjs` (enumerate paths if shell requires) |
| B installation | `packs/hivemind/install.ps1`, `install.sh`, `tests/obsidian-install.test.mjs` | spec, contracts, existing profile/switcher APIs | `node --test packs/hivemind/tests/obsidian-install.test.mjs`; PS parser and bash syntax if available |
| C workflow/docs | pack commands `brainstorm.md`, `swarm.md`, `obsidian.md`; agents `hivemind-architect.md`, `swarm-agent-updater.md`; `opencode/AGENTS.md`; skill `opencode/skills/hivemind-obsidian/SKILL.md`; `README-obsidian.md`; `tests/obsidian-workflow.test.mjs`; repo `README.md`, `docs/context-vault/GUIDE.md`, `USAGE.md`; existing `tests/hive/prompt-contract.test.mjs` only for changed prose expectations | spec, contracts, legacy lifecycle APIs, current initial vault-first/model-tier rules | `node --test packs/hivemind/tests/obsidian-workflow.test.mjs tests/hive/prompt-contract.test.mjs` |
| Architect | profiles updater routing, package test scripts, this contract and integration | joined slices | root verify, all tests, strict model-tier verification |

No worker edits legacy shared scripts, profile models, manifests, lockfiles, or another slice. All fixtures use unique temp dirs. No actual installed user configuration updates while preparing PR. Builders never push.

## Integrated criteria and publication
All existing repository checks plus imported engine/CLI/plugin tests and new compatibility/install/workflow tests pass, except honestly reported platform symlink skip. Native engine retains ancestor-junction checks, manifest/hash/manual edit protection, locks, bounded filename scans, depth warnings, idempotent mtimes and control-safe CLI. Verify secret/personal-path policy, `git diff --check`, tests, independent verifier+auditor against same diff. Commit only intended tracked/addon files, push feature branch to DevFarid/plugin-library, create PR with `--repo DevFarid/plugin-library --base main --head feat/obsidian-swarm-framework`, report actual URL.
