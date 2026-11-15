#!/usr/bin/env node
/**
 * Static workflow-contract tests for the Hivemind Obsidian feature.
 *
 * These tests pin the user-approved completion behavior: vault-first
 * exploration and tier selection are preserved, every completed brainstorm
 * inference asks the framework question before the separate launch question,
 * and swarm has exactly one final updater. Backend routing must honor legacy
 * metadata, repair partial legacy vaults through the existing lifecycle, and
 * write nothing on a dual-backend conflict.
 *
 * Zero dependencies: Node built-in test runner plus Markdown reads.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const FILES = Object.freeze({
  brainstorm: 'packs/hivemind/opencode/commands/brainstorm.md',
  swarm: 'packs/hivemind/opencode/commands/swarm.md',
  obsidian: 'packs/hivemind/opencode/commands/obsidian.md',
  architect: 'packs/hivemind/opencode/agents/hivemind-architect.md',
  updater: 'packs/hivemind/opencode/agents/swarm-agent-updater.md',
  agents: 'packs/hivemind/opencode/AGENTS.md',
  skill: 'packs/hivemind/opencode/skills/hivemind-obsidian/SKILL.md',
  packReadme: 'packs/hivemind/README-obsidian.md',
  rootReadme: 'README.md',
  guide: 'docs/context-vault/GUIDE.md',
  usage: 'docs/context-vault/USAGE.md',
})

function read(relativePath) {
  const absPath = join(ROOT, relativePath)
  assert.ok(existsSync(absPath), `missing file: ${absPath}`)
  const text = readFileSync(absPath, 'utf8')
  assert.ok(text.trim().length > 0, `empty file: ${absPath}`)
  return text
}

function firstExplorationIndex(text) {
  const match = /\b(?:read|grep|glob)\b/i.exec(text)
  return match ? match.index : Number.POSITIVE_INFINITY
}

function requireNeedle(text, needle, label) {
  const index = text.indexOf(needle)
  assert.notEqual(index, -1, `${label}: missing required marker ${JSON.stringify(needle)}`)
  return index
}

function headingIndex(text, pattern, label) {
  const match = pattern.exec(text)
  assert.ok(match, `${label}: missing required section heading ${pattern}`)
  return match.index
}

// Constructed at runtime so this repository contains no personal absolute path.
const PERSONAL_PATH_PREFIX = ['C:', 'Users'].join('\\')

function containsPersonalPath(text) {
  let index = text.indexOf(PERSONAL_PATH_PREFIX)
  while (index !== -1) {
    // Documentation may describe the forbidden shape as `C:\Users\<name>\`.
    const after = text.slice(index + PERSONAL_PATH_PREFIX.length, index + PERSONAL_PATH_PREFIX.length + 2)
    if (after !== '\\<') return true
    index = text.indexOf(PERSONAL_PATH_PREFIX, index + 1)
  }
  return false
}

test('brainstorm keeps the gate and tier law, compiles once, and asks framework before launch', () => {
  const text = read(FILES.brainstorm)
  const boundary = firstExplorationIndex(text)
  assert.ok(Number.isFinite(boundary), 'brainstorm: expected exploration instructions after the gate')
  for (const needle of [
    'model-tier.mjs resolve --role spec-architect',
    'vault-lifecycle.mjs detect',
    'vault-gate:',
  ]) {
    assert.ok(requireNeedle(text, needle, 'brainstorm') < boundary, `brainstorm: ${needle} must precede exploration`)
  }

  const compile = headingIndex(text, /^##[ \t]*1\./m, 'brainstorm')
  const completion = headingIndex(text, /^##[ \t]*2\./m, 'brainstorm')
  const launchSection = headingIndex(text, /^##[ \t]*3\./m, 'brainstorm')
  assert.ok(compile < completion && completion < launchSection, 'brainstorm: compile, completion, launch order regressed')

  requireNeedle(text, 'Make ONE foreground call to `@spec-architect` exactly once', 'brainstorm')
  requireNeedle(text, 'Never create a vault mid-brainstorm', 'brainstorm')
  assert.match(text, /EVERY completed brainstorm inference/i, 'brainstorm: per-run question missing')
  requireNeedle(text, 'legacyVault', 'brainstorm')
  requireNeedle(text, '.hive/lifecycle', 'brainstorm')

  const questionIndex = requireNeedle(text, '`question` tool', 'brainstorm')
  const launchIndex = requireNeedle(text, 'Launch /swarm', 'brainstorm')
  assert.ok(questionIndex > completion, 'brainstorm: framework question must follow completed inference')
  assert.ok(questionIndex < launchIndex, 'brainstorm: framework question must precede the launch question')

  const completionSection = text.slice(completion, launchSection)
  for (const marker of ['`create`', '`update`', '`skip`', 'Never create or update a framework mid-inference']) {
    requireNeedle(completionSection, marker, 'brainstorm completion section')
  }
  assert.match(completionSection, /goal-ID `No`\/`none`/, 'brainstorm: old goal answers must not suppress the question')
  assert.match(completionSection, /previous run|remembered skip/, 'brainstorm: skip must not carry forward')
  assert.equal(/vault-lifecycle\.mjs plan --goal/.test(text), false, 'brainstorm: legacy plan gating is superseded')
})

test('swarm has exactly one final updater after Wave 3 and no duplicated legacy checkpoint', () => {
  const text = read(FILES.swarm)
  const gate = headingIndex(text, /^##[ \t]*4\./m, 'swarm')
  const terminal = headingIndex(text, /^##[ \t]*5\./m, 'swarm')
  assert.ok(terminal > gate, 'swarm: terminal updater must follow the Wave 3 verification gate')

  const section = text.slice(terminal)
  requireNeedle(section, 'post-goal-checkpoint', 'swarm terminal section')
  requireNeedle(section, '`question` tool', 'swarm terminal section')
  requireNeedle(section, 'swarm-agent-updater', 'swarm terminal section')
  requireNeedle(section, 'legacyVault', 'swarm terminal section')
  for (const marker of ['`create`', '`update`', '`skip`', 'Conflict', 'index_exit', 'check_exit']) {
    requireNeedle(section, marker, 'swarm terminal section')
  }
  assert.match(section, /no later workers/i, 'swarm: updater must be final')
  assert.match(section, /exactly once/i, 'swarm: only one completion question is allowed')
  assert.equal((section.match(/`question` tool/g) || []).length, 1, 'swarm: duplicate question prompts regressed')
  assert.equal(/vault-lifecycle\.mjs plan --goal/.test(text), false, 'swarm: legacy plan checkpoint is superseded')
  assert.equal(/plan\(\)\.data\.question/.test(text), false, 'swarm: legacy plan payload must not drive the updater')
})

test('skill routes managed and legacy backends truthfully and keeps the updater final', () => {
  const text = read(FILES.skill)
  for (const marker of [
    'legacyVault: { path, state, present, detector }',
    '.opencode/vault',
    'bin/obsidian.mjs',
    'create --confirm',
    'sync-now',
    'vault-lifecycle.mjs update --yes',
    'scaffold --yes',
    'conflict',
    'index_exit',
    'check_exit',
    '`create`, `update`, or `skip`',
    'Launch no later implementation workers',
    'execute the same procedure inline',
    'genuinely unavailable',
    'live session activity is unavailable',
  ]) {
    requireNeedle(text, marker, 'hivemind-obsidian skill')
  }
  assert.match(text, /never choose create vs update from the managed `state` alone/i, 'skill: legacy metadata guard missing')
  assert.match(text, /never create a second framework|never create a second `\.hivemind` framework/i, 'skill: duplicate-framework guard missing')
  assert.match(text, /never auto-select, migrate, or delete/i, 'skill: conflict safety missing')
})

test('updater requires an explicit current choice and routes by actual backend', () => {
  const text = read(FILES.updater)
  for (const marker of [
    '`choice`: exactly `create`, `update`, or `skip`',
    'blocked: explicit current choice required',
    'legacyVault',
    'create --confirm',
    'sync-now',
    'vault-lifecycle.mjs update --yes',
    'scaffold --yes',
    'Conflict',
    'createdCount',
    'index_exit',
    'Launch no later implementation workers',
    'executes this same procedure inline',
  ]) {
    requireNeedle(text, marker, 'swarm-agent-updater')
  }
  assert.match(text, /never infer consent/i, 'updater: consent inference guard missing')
  assert.match(text, /never create a new `\.hivemind` framework/i, 'updater: partial repair must not create a second backend')
  assert.match(text, /Never synthesize test outcomes|Never invent counts/i, 'updater: truthful reporting guard missing')
})

test('architect may dispatch the final updater and keeps the existing roster', () => {
  const text = read(FILES.architect)
  assert.match(
    text,
    /resource:\s*"swarm-agent-updater"\s*\n\s*effect:\s*allow/,
    'architect: swarm-agent-updater is not allowed',
  )
  for (const agent of ['scout', 'researcher', 'builder', 'spec-architect', 'verifier', 'auditor']) {
    assert.match(text, new RegExp(`resource:\\s*"${agent}"`), `architect: missing existing allow for ${agent}`)
  }
  assert.match(text, /Completion Updater/i, 'architect: final updater rule missing')
})

test('AGENTS constitution carries the per-run question, single updater, and tier law', () => {
  const text = read(FILES.agents)
  requireNeedle(text, 'post-goal-checkpoint', 'AGENTS.md')
  requireNeedle(text, 'swarm-agent-updater', 'AGENTS.md')
  requireNeedle(text, 'tier(spec-architect) >= tier(builder) + 1', 'AGENTS.md')
  assert.match(text, /EVERY completed `\/brainstorm` inference/i, 'AGENTS.md: per-run question missing')
  assert.match(text, /legacyVault/, 'AGENTS.md: legacy metadata routing missing')
  assert.match(text, /Both backends present is a conflict/i, 'AGENTS.md: conflict rule missing')
})

test('commands and documentation cover the complete feature without personal paths', () => {
  const obsidian = read(FILES.obsidian)
  for (const marker of ['legacyVault', 'vault-lifecycle.mjs update --yes', 'scaffold --yes', 'both backends exist']) {
    requireNeedle(obsidian.toLowerCase(), marker.toLowerCase(), 'obsidian command')
  }

  const packReadme = read(FILES.packReadme)
  for (const marker of [
    '.hivemind/obsidian',
    '.opencode/vault',
    'legacyVault',
    'bin/obsidian.mjs',
    'create --confirm',
    'sync-now',
    'update --yes',
    'scaffold --yes',
    'conflict',
    'every completed run',
    'no later implementation workers',
  ]) {
    requireNeedle(packReadme, marker, 'README-obsidian')
  }

  const rootReadme = read(FILES.rootReadme)
  requireNeedle(rootReadme, '.hivemind/obsidian', 'root README')
  requireNeedle(rootReadme, 'legacyVault', 'root README')
  requireNeedle(rootReadme, 'After every completed `/brainstorm` inference', 'root README')
  requireNeedle(rootReadme, 'exactly one final `swarm-agent-updater`', 'root README')

  for (const [label, file] of [['GUIDE', FILES.guide], ['USAGE', FILES.usage]]) {
    const text = read(file)
    requireNeedle(text, 'legacyVault', label)
    requireNeedle(text, '.hivemind/obsidian', label)
    requireNeedle(text, 'scaffold --yes', label)
  }

  for (const file of Object.values(FILES)) {
    const text = read(file)
    assert.equal(containsPersonalPath(text), false, `${file}: contains a personal absolute path`)
  }
})
