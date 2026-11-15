# Packs

Content bundles for desktop agent apps other than DeepSeek Harness. Unlike
`plugins/`, a pack is not a DSH package: it is a set of files an installer or a
human copies into the target app's configuration directory.

## `hivemind/` — OpenCode v2

A `/stack` picker plus a set of agent roles, commands, skills, and provider
profiles for [OpenCode](https://opencode.ai) v2.

- **Agents:** auditor, builder, hivemind-architect, oracle, pr-reviewer,
  researcher, scout, spec-architect, surgeon, swarm-agent-updater, verifier.
- **Commands:** `/stack`, `/swarm`, `/brainstorm`, `/audit-diff`, and six stack
  presets (chatgpt-deepseek, claude-hybrid, claude-native, argon-deepseek,
  carbon-deepseek, opencode-go-max).
- **Skill:** token-discipline.
- **Profiles:** one JSON per provider stack, with its topology, parallel cap,
  verification gate, and agent step budgets.
- **CLI:** `hive-switch <stack>` writes the active profile, merges the shared
  base config, patches agent models/steps, and regenerates the `AGENTS.md`
  topology block. It preserves OpenCode v2 `opencode.json` agent permissions and
  keeps the `@pr-reviewer` subagent available across all profiles.

Install with `install.ps1` (Windows) or `install.sh` (macOS/Linux/WSL) as
described in [`hivemind/README.md`](hivemind/README.md). The pack is
self-contained and does not depend on this repository's DSH plugins.

The agent and command Markdown is the part worth reusing in another host: it is
plain text with a small role prompt and an explicit output contract, and it can
be adapted to any app that discovers Markdown agent directories.
