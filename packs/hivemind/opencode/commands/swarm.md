---
description: Adaptive Parallel DAG Swarm - routes by complexity (Tier 1 direct, else Recon -> Contract -> Parallel Builders -> Verify/Audit waves), executes .opencode/SPEC.md, and ends with exactly one Obsidian completion updater.
agent: hivemind-architect
---

Execute the **Adaptive Parallel DAG Swarm** on this request:
$ARGUMENTS

## 0. Input & Vault Check
- Task = the text above. If it is empty or says to use the spec, and `.opencode/SPEC.md` exists, execute that spec: its Shared Data/API Contracts = Wave 1, its File Ownership Matrix rows = Wave 2 builders, its Verification Criteria = Wave 3. If empty and no spec exists, ask the user for a task and stop.
- Read the ACTIVE STACK TOPOLOGY block in AGENTS.md: note MAX_PARALLEL_SUBAGENTS (cap) and the verification gate roster.
- If `.opencode/vault/00-MOC.md` and `scripts/vault.mjs` exist, run `node scripts/vault.mjs index` and `node scripts/vault.mjs check --strict`, read `.opencode/vault/00-MOC.md`, and include `node scripts/vault.mjs brief --task <slice> --budget 1200` in builder prompts instead of scanning the repository.

## 1. Route by complexity
- <= 2 files touched -> **Tier 1 direct fast-path**: do it yourself, no subagents, no wave plan. State "Tier 1 direct: <reason>" in one line, implement and self-check, then proceed to §5 (the single final updater).
- Otherwise -> DAG swarm below.

## 2. Print the Parallel Wave Plan BEFORE firing any batch
Fixed format (example skeleton):

```
PARALLEL WAVE PLAN
Wave 0: Recon [R1..R2]            (only if repo/area unfamiliar; parallel @researcher/@scout)
  R1 @scout      - map auth routes: files, interfaces
  R2 @researcher - existing test conventions
Wave 1: Contract (architect-owned)
  src/types/user.ts, src/db/schema.sql, config/routes.json
Wave 2: Parallel Builders [1..4]
| # | OWNED_FILES              | READ_ONLY_CONTRACTS | ACCEPTANCE_CHECK        |
|---|--------------------------|---------------------|-------------------------|
| 1 | src/api/users.ts         | src/types/user.ts   | tsc --noEmit on file    |
| 2 | src/ui/UserList.tsx      | src/types/user.ts   | tsc + component test    |
| 3 | tests/users.test.ts      | src/types/user.ts   | test file runs green    |
| 4 | src/db/users.repo.ts     | src/db/schema.sql   | tsc --noEmit on file    |
Wave 3: Verify/Audit  [@verifier + @auditor]   (use gate roster from ACTIVE STACK TOPOLOGY)
```

## 3. Rules
- **Single-Message Parallel Tool Batching**: every subagent call in a wave MUST be emitted in ONE assistant message as one parallel tool-call batch. Sequential subagent calls are FORBIDDEN when tasks have no data dependency. The only legal sequencing is between waves (Wave N+1 consumes Wave N output).
- Builders per wave: N = 3-6, never above MAX_PARALLEL_SUBAGENTS. If the ownership matrix has more rows than the cap, run Wave 2 as batches 2a, 2b (each its own single-message batch).
- **Pre-flight**: verify OWNED_FILES sets are pairwise disjoint. Any file needed by 2+ builders moves into Wave 1 (you lock it, builders get it read-only). Fix the plan before firing.
- Each builder prompt carries: OWNED_FILES, READ_ONLY_CONTRACTS, ACCEPTANCE_CHECK (plus verbatim L1 vault brief if a vault exists). Builders must not edit files outside OWNED_FILES.
- Wave 1 is done by you directly (types/schema/config contracts) before Wave 2 fires.

## 4. After Wave 3 (Quality Gate Resolution)
- On failure, re-dispatch only to the owning builder (max 2 attempts per builder), then escalate to @oracle or fix directly as architect.
- Once the verification gate (`@verifier` + `@auditor`) passes with zero blockers, emit a status report under 200 words (waves run, agents per wave, PASS/FAIL, blockers), then execute §5 once (the single final updater).

## 5. Terminal Step - Single Post-Goal Obsidian Updater (`post-goal-checkpoint`)
This is the only completion consent step. Do not run `vault-lifecycle.mjs plan`, do not ask a second legacy checkpoint question, and do not stack an old and a new prompt. Launch no workers after the updater.

1. Load the `hivemind-obsidian` skill and inspect the actual invoking project without writing:
   - Prefer the native read-only `obsidian_status` tool when the session exposes it; it covers the session's own project.
   - Otherwise run `<HIVEMIND_HOME>/bin/obsidian.mjs status --json --project <absolute invoking project>` with structured argv, and use the compatibility adapter's `legacyVault` metadata (`path`, `state`, `present`, `detector`) when available. A legacy-only project can show managed `state: absent`; use `legacyVault.present`, not managed state alone, to choose update vs create.
   - Report any conflict exactly. Both backends present is a conflict, never an auto-selection or migration.
2. Ask the actual `question` tool exactly once for this run:
   - Backend absent (`legacyVault.present === false` and managed framework `absent`/unconfigured): offer `create` and `skip`.
   - Existing managed framework, or a legacy vault in `partial`, `present_healthy`, or `present_unhealthy`: offer `update` and `skip`.
   - Conflict/unknown/unavailable detector with legacy markers: offer only `skip` and write nothing.
   - `skip` is current-run only. Never remember a previous skip, and never reuse old goal-ID records to skip this run.
3. Pass the explicit current `choice` (`create`, `update`, or `skip`) plus the actual `project` to `swarm-agent-updater`. If the session registry does not expose that agent, execute the same skill procedure inline. The updater is final; no later workers.
4. The updater routes by actual backend:
   - New managed framework `create`: `node <HIVEMIND_HOME>/bin/obsidian.mjs create --confirm --project <project>`.
   - New managed framework `update`: `node <HIVEMIND_HOME>/bin/obsidian.mjs sync-now --project <project>`.
   - Legacy vault `update` (`present_healthy` / `present_unhealthy`): `node <HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs update --yes --root <project>` (or the repo-local `scripts/hive/` copy).
   - Legacy vault `partial` repair: `node <HIVEMIND_HOME>/scripts/hive/vault-lifecycle.mjs scaffold --yes --root <project>` with explicit consent from this question; repair the existing scaffold and never create a second `.hivemind` framework.
   - Conflict: no writes; report remediation through the existing legacy lifecycle.
5. Report only observed results: managed `status`/`createdCount`/`updatedCount`/`unchangedCount`; legacy `created`/`refreshed`/`skipped` counts plus `index_exit` and `check_exit`. Never invent counts, results, or activity. On `skip`, report `skipped (no writes)`.

Tier 1 uses its successful self-check instead of spawning a verification gate solely for this prompt.
