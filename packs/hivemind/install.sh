#!/usr/bin/env bash
# install.sh — Hivemind Stack Switcher for OpenCode v2 (macOS / Linux / WSL)
#
# What you get in the composer after installing:
#   /stack                     -> show the active stack + topology
#   /stack/chatgpt-deepseek    -> pick a stack from the list (descriptions shown)
#   /stack/claude-hybrid
#   /stack/claude-native
#   /stack/argon-deepseek
#   /stack/opencode-go-max
#   /swarm <task>              -> adaptive DAG swarm
#   /brainstorm <dump>         -> compile the dump to .opencode/SPEC.md
#   /pr-review <pr-link>       -> multi-angle PR review swarm (parallel lenses + intent gate)
#
# Installs:
#   ~/.config/hivemind/profiles/*.json
#   ~/.config/hivemind/base-opencode.json
#   ~/.config/hivemind/hive-switch
#   ~/.config/hivemind/scripts/hive/*.mjs
#   ~/.config/hivemind/config/model-tiers.json
#   ~/.config/hivemind/vault-kit/
#   ~/.config/hivemind/obsidian/*.mjs (managed framework engine)
#   ~/.config/hivemind/bin/obsidian.mjs (CLI)
#   ~/.config/hivemind/bin/hive-switch.cjs (shared switcher backend)
#   ~/.config/hivemind/opencode/swarm-agents.json
#   ~/.config/hivemind/opencode/hivemind-wave-limit.mjs
#   ~/.config/hivemind/skills/hivemind-obsidian/SKILL.md
#   ~/.config/hivemind/skills/pr-review/ (SKILL.md, lenses/, engine/)
#   ~/.config/opencode/{AGENTS.md,agents/,commands/,skills/}
#   ~/.config/opencode/skills/token-discipline/, skills/pr-review/ (incl. lenses/)
#   ~/.config/opencode/skills/hivemind-obsidian/SKILL.md
#   ~/.config/opencode/skills/pr-review/engine/ (bin/, src/, package.json, README.md)
#   ~/.config/opencode/plugins/hivemind-obsidian.js (native status tool)
#   ~/.config/opencode/commands/stack.md + commands/stack/*.md
#   ~/.local/bin/hive-switch
#
# Safe by default:
#   - existing profiles and opencode.json are backed up (.bak.<timestamp>)
#   - existing agent prompts, AGENTS.md, /swarm, /brainstorm, /pr-review and /audit-diff are left alone
#   - opencode.json is NOT rewritten unless you pass -a <profile>
#
# Usage:
#   bash install.sh
#   bash install.sh -a chatgpt-deepseek     # also activate a stack
#   bash install.sh -r                      # refresh ONLY PR-review assets (command, agent, skill, lenses, engine)
#                                           # then apply narrow harness registration
#   bash install.sh -s                      # skip local harness registration (tests/isolated homes)
#   FORCE=1 bash install.sh                 # overwrite existing prompt files

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
HM_HOME="${HIVEMIND_HOME:-$HOME/.config/hivemind}"
OC_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
BIN_DIR="$HOME/.local/bin"
STAMP="$(date +%Y%m%d_%H%M%S)"
FORCE="${FORCE:-0}"
ACTIVATE=""
PR_REVIEW_ONLY=0
SKIP_REGISTRATION="${SKIP_REGISTRATION:-0}"

while getopts "a:hrs" opt; do
  case "$opt" in
    a) ACTIVATE="$OPTARG" ;;
    r) PR_REVIEW_ONLY=1 ;;
    s) SKIP_REGISTRATION=1 ;;
    h) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option" >&2; exit 2 ;;
  esac
done

ok()   { printf '  [ok]   %s\n' "$*"; }
keep() { printf '  [keep] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }

backup_if_exists() { [ -e "$1" ] && cp -p "$1" "$1.bak.$STAMP" || true; }

install_file() { # src dest keep_existing
  local src="$1" dest="$2" keep_existing="${3:-0}"
  if [ "$keep_existing" = "1" ] && [ -e "$dest" ] && [ "$FORCE" != "1" ]; then
    keep "$(basename "$dest")"; return 0
  fi
  backup_if_exists "$dest"
  cp -f "$src" "$dest"
  ok "$(basename "$dest")"
}

install_dir_files() { # src_dir dest_dir keep_existing
  local src_dir="$1" dest_dir="$2" keep_existing="${3:-0}"
  [ -d "$src_dir" ] || return 0
  mkdir -p "$dest_dir"
  local f
  for f in "$src_dir"/*; do
    [ -f "$f" ] || continue
    install_file "$f" "$dest_dir/$(basename "$f")" "$keep_existing"
  done
}

# Engine lives with the installed skill so the command never depends on a repo
# checkout: ~/.config/opencode/skills/pr-review/engine/{bin,src}.
install_pr_review_engine() { # keep_existing [skill_dir]
  local keep="${1:-0}"
  local skill_dir="${2:-$OC_DIR/skills/pr-review}"
  local engine_src="$ROOT/../../plugins/pr-review"
  if [ ! -d "$engine_src" ]; then
    warn "pr-review engine source not found: $engine_src"; return 0
  fi
  local engine_dst="$skill_dir/engine"
  install_dir_files "$engine_src/bin" "$engine_dst/bin" "$keep"
  install_dir_files "$engine_src/src" "$engine_dst/src" "$keep"
  install_file "$engine_src/package.json" "$engine_dst/package.json" "$keep"
  install_file "$engine_src/README.md" "$engine_dst/README.md" "$keep"
  chmod +x "$engine_dst/bin/pr-review.mjs" 2>/dev/null || true
}

# Durable local wiring. Uses the Node already on PATH; never downloads a runtime.
register_harness() {
  if [ "$SKIP_REGISTRATION" = "1" ]; then
    warn "harness registration skipped (-s)"
    return 0
  fi
  local helper="$OC_DIR/skills/pr-review/engine/src/harness-registration.mjs"
  if [ ! -f "$helper" ]; then
    warn "harness-registration helper not installed: $helper"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found on PATH; harness registration skipped (no downloads)."
    return 0
  fi
  if ! node "$helper" --config-dir "$OC_DIR"; then
    warn "harness registration failed; parse errors leave config files unchanged."
    return 0
  fi
}

install_pr_review_assets() { # keep_existing
  local keep="${1:-1}"
  install_file "$ROOT/opencode/commands/pr-review.md" "$OC_DIR/commands/pr-review.md" "$keep"
  install_file "$ROOT/opencode/agents/pr-reviewer.md" "$OC_DIR/agents/pr-reviewer.md" "$keep"
  install_file "$ROOT/opencode/skills/pr-review/SKILL.md" "$OC_DIR/skills/pr-review/SKILL.md" "$keep"
  if [ -d "$ROOT/opencode/skills/pr-review/lenses" ]; then
    mkdir -p "$OC_DIR/skills/pr-review/lenses"
    local f
    for f in "$ROOT"/opencode/skills/pr-review/lenses/*.md; do
      [ -f "$f" ] || continue
      install_file "$f" "$OC_DIR/skills/pr-review/lenses/$(basename "$f")" "$keep"
    done
  fi
  install_pr_review_engine "$keep"
}

# Canonical switcher backend + templates live under HM_HOME so hive-switch.cjs
# can restore missing agents/plugins/skills without a repo checkout.
install_hive_switch_templates() {
  mkdir -p "$HM_HOME/bin" "$HM_HOME/opencode"
  if [ -f "$ROOT/bin/hive-switch.cjs" ]; then
    install_file "$ROOT/bin/hive-switch.cjs" "$HM_HOME/bin/hive-switch.cjs" 0
  else
    warn "missing $ROOT/bin/hive-switch.cjs; hive-switch will fail until the backend is installed"
  fi
  if [ -f "$ROOT/opencode/swarm-agents.json" ]; then
    install_file "$ROOT/opencode/swarm-agents.json" "$HM_HOME/opencode/swarm-agents.json" 0
  else
    warn "missing $ROOT/opencode/swarm-agents.json; the switcher will fall back to built-in templates"
  fi
  if [ -f "$ROOT/opencode/hivemind-wave-limit.mjs" ]; then
    install_file "$ROOT/opencode/hivemind-wave-limit.mjs" "$HM_HOME/opencode/hivemind-wave-limit.mjs" 0
  else
    warn "missing $ROOT/opencode/hivemind-wave-limit.mjs; wave limits will rely on the live plugin only"
  fi
}

stage_hivemind_obsidian_skill() {
  local src="$ROOT/opencode/skills/hivemind-obsidian/SKILL.md"
  if [ ! -f "$src" ]; then
    warn "missing $src; the switcher cannot restore the hivemind-obsidian skill"
    return 0
  fi
  mkdir -p "$HM_HOME/skills/hivemind-obsidian"
  install_file "$src" "$HM_HOME/skills/hivemind-obsidian/SKILL.md" 0
}

stage_pr_review_skill() {
  local src="$ROOT/opencode/skills/pr-review"
  if [ ! -d "$src" ]; then
    warn "missing $src; the switcher cannot restore the pr-review skill"
    return 0
  fi
  mkdir -p "$HM_HOME/skills/pr-review"
  install_file "$src/SKILL.md" "$HM_HOME/skills/pr-review/SKILL.md" 0
  local f
  if [ -d "$src/lenses" ]; then
    mkdir -p "$HM_HOME/skills/pr-review/lenses"
    for f in "$src"/lenses/*.md; do
      [ -f "$f" ] || continue
      install_file "$f" "$HM_HOME/skills/pr-review/lenses/$(basename "$f")" 0
    done
  fi
  install_pr_review_engine 0 "$HM_HOME/skills/pr-review"
}

echo
echo "=================================================================="
echo "  HIVEMIND STACK SWITCHER -> OpenCode v2 (macOS / Linux / WSL)"
echo "=================================================================="

if command -v opencode >/dev/null 2>&1; then
  ok "opencode found: $(command -v opencode)"
else
  warn "opencode not on PATH. Install OpenCode v2 (Desktop + CLI 2.2.x+) first."
fi

mkdir -p "$HM_HOME/profiles" "$OC_DIR/agents" "$OC_DIR/commands/stack" \
         "$OC_DIR/skills/token-discipline" "$OC_DIR/skills/pr-review/lenses" "$BIN_DIR"

if [ "$PR_REVIEW_ONLY" = "1" ]; then
  echo
  echo "Focused reinstall -> PR-review assets only"
  install_pr_review_assets 0
  # Refresh only the staged pr-review skill/engine; obsidian and unrelated
  # skill assets stay exactly as they are.
  if [ -d "$HM_HOME" ]; then
    stage_pr_review_skill
  fi
  echo
  echo "Harness registration"
  register_harness
  echo
  echo "Done. Profiles, AGENTS.md, other commands/agents, and PATH were not touched."
  echo "OpenCode watches the config directory; use /reload if refreshed PR-review assets are not visible."
  exit 0
fi

echo
echo "Profiles -> $HM_HOME/profiles"
for f in "$ROOT"/profiles/*.json; do
  install_file "$f" "$HM_HOME/profiles/$(basename "$f")" 0
done
install_file "$ROOT/base-opencode.json" "$HM_HOME/base-opencode.json" 0

echo
echo "Model-tier guard + portable kit -> $HM_HOME"
GUARD_SRC="$REPO_ROOT/scripts/hive"
MODEL_TIERS_SRC="$REPO_ROOT/config/model-tiers.json"
VAULT_KIT_SRC="$REPO_ROOT/vault-kit"
if [ -d "$GUARD_SRC" ]; then
  mkdir -p "$HM_HOME/scripts"
  rm -rf "$HM_HOME/scripts/hive"
  cp -R "$GUARD_SRC" "$HM_HOME/scripts/hive"
  ok "scripts/hive/*.mjs"
else
  warn "missing $GUARD_SRC; hive-switch will fail closed until the guard is installed"
fi
mkdir -p "$HM_HOME/config"
if [ -f "$MODEL_TIERS_SRC" ]; then
  install_file "$MODEL_TIERS_SRC" "$HM_HOME/config/model-tiers.json" 0
else
  warn "missing $MODEL_TIERS_SRC; hive-switch will fail closed until the registry is installed"
fi
if [ -d "$VAULT_KIT_SRC" ]; then
  rm -rf "$HM_HOME/vault-kit"
  cp -R "$VAULT_KIT_SRC" "$HM_HOME/vault-kit"
  ok "vault-kit/"
else
  warn "missing $VAULT_KIT_SRC; vault commands will not work in consumer repos"
fi

echo
echo "Obsidian engine -> $HM_HOME/obsidian + $HM_HOME/bin"
OBSIDIAN_SRC="$ROOT/obsidian"
if [ -d "$OBSIDIAN_SRC" ]; then
  mkdir -p "$HM_HOME/obsidian" "$HM_HOME/bin"
  for f in "$OBSIDIAN_SRC"/*.mjs; do
    [ -f "$f" ] || continue
    install_file "$f" "$HM_HOME/obsidian/$(basename "$f")" 0
  done
  ok "obsidian/*.mjs"
  install_file "$ROOT/bin/obsidian.mjs" "$HM_HOME/bin/obsidian.mjs" 0
  chmod +x "$HM_HOME/bin/obsidian.mjs" 2>/dev/null || true
else
  warn "missing $OBSIDIAN_SRC; /obsidian will fail until the engine is installed"
fi

echo
echo "OpenCode config -> $OC_DIR"
install_file "$ROOT/opencode/AGENTS.md" "$OC_DIR/AGENTS.md" 1
for f in "$ROOT"/opencode/agents/*.md; do
  install_file "$f" "$OC_DIR/agents/$(basename "$f")" 1
done
for f in "$ROOT"/opencode/commands/*.md; do
  install_file "$f" "$OC_DIR/commands/$(basename "$f")" 1
done
for f in "$ROOT"/opencode/commands/stack/*.md; do
  install_file "$f" "$OC_DIR/commands/stack/$(basename "$f")" 1
done
for skill in token-discipline pr-review hivemind-obsidian; do
  mkdir -p "$OC_DIR/skills/$skill"
  install_file "$ROOT/opencode/skills/$skill/SKILL.md" "$OC_DIR/skills/$skill/SKILL.md" 1
done
if [ -d "$ROOT/opencode/skills/pr-review/lenses" ]; then
  for f in "$ROOT"/opencode/skills/pr-review/lenses/*.md; do
    install_file "$f" "$OC_DIR/skills/pr-review/lenses/$(basename "$f")" 1
  done
fi
if [ -f "$ROOT/opencode/hivemind-obsidian.mjs" ]; then
  mkdir -p "$OC_DIR/plugins"
  install_file "$ROOT/opencode/hivemind-obsidian.mjs" "$OC_DIR/plugins/hivemind-obsidian.js" 1
else
  warn "missing $ROOT/opencode/hivemind-obsidian.mjs; the native obsidian_status tool will be unavailable"
fi
install_pr_review_engine 1

echo
echo "Harness registration"
register_harness

echo
echo "Switcher -> $BIN_DIR"
install_file "$ROOT/bin/hive-switch" "$BIN_DIR/hive-switch" 0
chmod +x "$BIN_DIR/hive-switch"
install_file "$ROOT/bin/hive-switch" "$HM_HOME/hive-switch" 0
chmod +x "$HM_HOME/hive-switch"

echo
echo "Switcher backend + staged templates -> $HM_HOME"
install_hive_switch_templates
stage_hivemind_obsidian_skill
stage_pr_review_skill

# --- point the /stack commands at this machine's switcher ---------------
CMD="$BIN_DIR/hive-switch"
rendered=0
while IFS= read -r -d '' f; do
  if grep -q '{{HIVE_SWITCH_CMD}}' "$f"; then
    # quote the path so it survives spaces in $HOME
    awk -v repl="\"$CMD\"" '{ gsub(/\{\{HIVE_SWITCH_CMD\}\}/, repl); print }' "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
    rendered=$((rendered + 1))
  fi
done < <(find "$OC_DIR/commands" -maxdepth 2 -name '*.md' -print0)
echo
echo "Commands -> $OC_DIR/commands"
ok "$rendered command file(s) wired to $CMD"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR already on PATH" ;;
  *) warn "For the bare 'hive-switch' command, add to your shell rc:"
     printf '         export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac

echo
if [ -n "$ACTIVATE" ]; then
  backup_if_exists "$OC_DIR/opencode.json"
  "$BIN_DIR/hive-switch" "$ACTIVATE"
else
  echo "Next steps:"
  echo "  1. Activate a stack:  $BIN_DIR/hive-switch chatgpt-deepseek"
  echo "  2. Restart OpenCode Desktop once, then type /stack in the composer."
fi

echo
echo "=================================================================="
echo "  DONE"
echo "=================================================================="
echo "  /stack                  show the active stack"
echo "  /stack/claude-hybrid    switch stack (pick any from the /stack list)"
echo "  /pr-review <pr-link>    multi-angle PR review swarm"
echo "  OpenCode watches the config directory and reloads automatically."
echo "=================================================================="
