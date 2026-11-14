---
description: Turn a raw thought dump into .opencode/SPEC.md via @spec-architect (vault-first gate, smarter architect tier, contracts, ownership matrix, verification), run the per-completion framework question, then separately offer /swarm.
agent: hivemind-architect
---

Raw thought dump (verbatim):
$ARGUMENTS

## 0. Pre-Exploration Vault & Model-Tier Gate (MANDATORY BEFORE ANY FILE EXPLORATION)
1. If the dump above is empty, ask the user for their thought dump and stop.
2. **Verify and resolve the higher-tier `@spec-architect` model** (strictly above worker/`builder` tier: `tier(spec-architect) >= tier(builder) + 1`):
   - Run `node scripts/hive/model-tier.mjs resolve --role spec-architect --profile <active-stack> --json` (or `~/.config/hivemind/scripts/hive/model-tier.mjs` in installed consumer projects).
   - Never pass a worker-tier model override when spawning `@spec-architect`; if an override violates `tier(spec-architect) >= tier(builder) + 1`, refuse with `tier_violation`.
3. **Check whether an Obsidian Context Vault exists before exploring project files**:
   - Run `node scripts/hive/vault-lifecycle.mjs detect --json` (fallback: `~/.config/hivemind/scripts/hive/vault-lifecycle.mjs detect --json`, or stat `.opencode/vault/00-MOC.md` and `scripts/vault.mjs`).
   - Emit `vault-gate: <state>` (`absent | partial | present_healthy | present_unhealthy`) before reading or listing any repository files.
   - **If `present_healthy` or `present_unhealthy`**: run `node scripts/vault.mjs index` and `node scripts/vault.mjs check --strict` (retry `index` once on exit `4`), read `.opencode/vault/00-MOC.md` (`[[moc-root]]`), run up to 3 L1 briefs (`node scripts/vault.mjs brief --task <id> --budget 1200`), and pass `vault-gate: <state>` plus the verbatim L0/L1 vault briefs into `@spec-architect` so it uses `find`/`slice` instead of blind directory scans.
   - **If `absent` or `partial`**: pass `vault-gate: <state>` to `@spec-architect` and allow normal Hivemind recon.
   - Never create a vault mid-brainstorm. Never create or update a framework during this gate, during inference, or before explicit completion consent in §2.

## 1. Compile Spec via `@spec-architect`
1. Make ONE foreground call to `@spec-architect` exactly once, on its resolved higher-tier model, passing the dump above VERBATIM (unedited, not summarized, not reordered) together with `vault-gate: <state>` and any L0/L1 vault briefs from §0. Instruct it to compile `.opencode/SPEC.md` with sections: Goal & Non-Goals, Shared Data/API Contracts, Disjoint Parallel Builder Workstreams (File Ownership Matrix), Verification Criteria, Open Questions / Assumptions.
2. You must NOT write `.opencode/SPEC.md` yourself and must NOT start implementing before user confirmation.
3. When `@spec-architect` returns, print a compact summary:
   - spec path (`.opencode/SPEC.md`)
   - `vault-gate` state and resolved `spec-architect` model tier
   - contract files
   - one line per workstream (builder # -> owned files)
   - open questions
4. If any open question changes contracts, ask those first and wait for answers (relay them to `@spec-architect` to update the spec if needed) before the completion question in §2.

## 2. Per-Completion Framework Question (actual `question` tool)
Run this section after EVERY completed brainstorm inference, before the separate launch-swarm question in §3. It runs again on every brainstorm run, even when an earlier run chose skip, even in the same project, and even when a goal record already exists.

1. Inspect the actual invoking project, never the Hivemind installation directory:
   - Prefer the native read-only `obsidian_status` tool when this session exposes it; it is scoped to the session's own project.
   - Otherwise run the managed CLI `status --json` with a structured argv array, and use the compatibility adapter's `legacyVault` metadata (`path`, `state`, `present`, `detector`) when it is available. Do not choose create vs update from the managed `state` alone: a legacy-only project can report managed `state: absent` while `legacyVault.present` is true.
   - Do not call `vault-lifecycle.mjs plan` for this question, and do not treat a `.hive/lifecycle` record, a remembered skip, or an old goal-ID `No`/`none` record as consent or as permission to suppress this inference run's question.
2. Ask exactly one `question` tool for this run with the explicit create/update/skip decision:
   - Both backends absent (`legacyVault.present === false` and the managed framework is `absent`/unconfigured): offer `create` and `skip`. `create` is explicit consent only when the user selects it.
   - An existing framework (managed `ready`, or `legacyVault.present` with legacy state `partial`, `present_healthy`, or `present_unhealthy`): offer `update` and `skip`. A partial legacy vault is repaired through its existing scaffold, never replaced by a second `.hivemind` framework.
   - Conflict, unknown backend, or legacy markers with an unavailable detector: report the conflict exactly, offer only `skip`, and write nothing.
   - `skip` applies to this run only; never remember it and never carry it forward.
3. Apply only the choice made in this run. Spawn `swarm-agent-updater` with `choice: create|update|skip` and the actual invoking `project`. If the current session registry does not expose that agent, execute the same `hivemind-obsidian` skill procedure inline. The updater is the final framework step; launch no later implementation workers.
4. Never create or update a framework mid-inference. The question and any resulting write happen only after the completed inference above.
5. A framework create, update, or skip is not approval to launch the swarm.

## 3. Separate Launch-Swarm Decision
1. After the §2 framework action completes, ask: "Launch /swarm on .opencode/SPEC.md now? (yes / edit first)"
   - `yes` -> proceed as `/swarm` would using `.opencode/SPEC.md` (Wave 1 contracts -> Wave 2 parallel builders -> Wave 3 verification gate -> the single final `swarm-agent-updater` completion step described in `/swarm`).
   - `edit first` -> stop and wait for the user.
2. The launch decision is separate from the framework decision. Creating or updating the framework never launches the swarm, and skipping the framework never blocks a launch the user explicitly chooses.
3. If the user declines implementation and considers the compiled spec complete, report the spec's validation result and stop. The §2 completion question has already run for this inference; do not add a second legacy checkpoint prompt.
4. If implementation proceeds, `/swarm` owns its exactly-one final completion updater; do not duplicate that updater from `/brainstorm`.
