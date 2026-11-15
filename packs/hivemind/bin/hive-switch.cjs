#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const packRoot = path.dirname(__dirname);
const hiveDir = process.env.HIVEMIND_HOME || path.join(os.homedir(), '.config', 'hivemind');
const opencodeDir = process.env.OPENCODE_DIR || path.join(os.homedir(), '.config', 'opencode');
const profileDir = path.join(hiveDir, 'profiles');
const activePath = path.join(hiveDir, 'active_profile');
const configPath = path.join(opencodeDir, 'opencode.json');
const baseConfigPath = path.join(hiveDir, 'base-opencode.json');
const architect = 'hivemind-architect';
const validId = /^[a-z][a-z0-9-]*$/;
const MARK_BEGIN = '<!-- HIVEMIND:TOPOLOGY:BEGIN -->';
const MARK_END = '<!-- HIVEMIND:TOPOLOGY:END -->';

const BASE_STEPS = Object.freeze({
  builder: 25,
  researcher: 12,
  scout: 8,
  surgeon: 15,
  verifier: 12,
  auditor: 10,
  oracle: 6,
  'spec-architect': 12,
  'pr-reviewer': 12,
  'swarm-agent-updater': 20,
});

const DEFAULT_SWARM_AGENTS = Object.freeze({
  default_agent: architect,
  experimental: { subagent_depth: 1 },
  agents: {
    'hivemind-architect': {
      permissions: [
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: 'scout', effect: 'allow' },
        { action: 'subagent', resource: 'researcher', effect: 'allow' },
        { action: 'subagent', resource: 'builder', effect: 'allow' },
        { action: 'subagent', resource: 'spec-architect', effect: 'allow' },
        { action: 'subagent', resource: 'swarm-agent-updater', effect: 'allow' },
        { action: 'subagent', resource: 'surgeon', effect: 'allow' },
        { action: 'subagent', resource: 'verifier', effect: 'allow' },
        { action: 'subagent', resource: 'auditor', effect: 'allow' },
        { action: 'subagent', resource: 'oracle', effect: 'allow' },
        { action: 'subagent', resource: 'pr-reviewer', effect: 'allow' },
      ],
    },
    'pr-reviewer': {
      mode: 'subagent',
      steps: 12,
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    },
    'swarm-agent-updater': {
      steps: 20,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'skill', resource: 'hivemind-obsidian', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
      ],
    },
    builder: {
      steps: 25,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
      ],
    },
    researcher: {
      steps: 12,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'webfetch', resource: '*', effect: 'allow' },
      ],
    },
    scout: {
      steps: 8,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'webfetch', resource: '*', effect: 'allow' },
      ],
    },
    'spec-architect': {
      steps: 12,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'edit', resource: '.opencode/SPEC.md', effect: 'allow' },
      ],
    },
    surgeon: {
      steps: 15,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
      ],
    },
    verifier: {
      steps: 12,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'shell', resource: '*', effect: 'allow' },
      ],
    },
    auditor: {
      steps: 10,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
        { action: 'shell', resource: 'git diff *', effect: 'allow' },
        { action: 'shell', resource: 'git status *', effect: 'allow' },
        { action: 'shell', resource: 'git --no-pager diff *', effect: 'allow' },
        { action: 'shell', resource: 'git --no-pager status *', effect: 'allow' },
      ],
    },
    oracle: {
      steps: 6,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'grep', resource: '*', effect: 'allow' },
        { action: 'glob', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'ask' },
        { action: 'read', resource: '*.env.*', effect: 'ask' },
        { action: 'read', resource: '*.env.example', effect: 'allow' },
      ],
    },
  },
});

function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function readJson(file, missingAllowed = false) {
  const bytes = readOptional(file);
  if (!bytes && missingAllowed) return undefined;
  if (!bytes) throw new Error(`Missing ${file}.`);
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base, overlay) {
  if (!isRecord(base) || !isRecord(overlay)) return overlay;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overlay)])].map(key => {
    if (!Object.hasOwn(overlay, key)) return [key, base[key]];
    if (!Object.hasOwn(base, key)) return [key, overlay[key]];
    return [key, isRecord(base[key]) && isRecord(overlay[key])
      ? merge(base[key], overlay[key]) : overlay[key]];
  }));
}

function profileIds() {
  if (!fs.existsSync(profileDir)) return [];
  return fs.readdirSync(profileDir, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith('.json'))
    .map(item => item.name.slice(0, -5))
    .filter(id => validId.test(id))
    .sort();
}

function normalizeTopology(profile, name) {
  if (isRecord(profile.topology)) {
    const topo = profile.topology;
    for (const key of ['name', 'max_parallel_subagents', 'verification_gate', 'directive']) {
      assert(Object.hasOwn(topo, key), `Profile '${name}' topology is missing '${key}'.`);
    }
    const max = topo.max_parallel_subagents;
    assert(Number.isInteger(max), `Profile '${name}': max_parallel_subagents must be an integer.`);
    assert(max >= 1 && max <= 12, `Profile '${name}': max_parallel_subagents must be 1..12 (got ${max}).`);
    assert(Array.isArray(topo.verification_gate) && topo.verification_gate.length > 0,
      `Profile '${name}': verification_gate must be a non-empty array.`);
    const agentSteps = isRecord(topo.agent_steps) ? topo.agent_steps : {};
    return {
      name: String(topo.name),
      maxParallel: max,
      gate: topo.verification_gate,
      directive: String(topo.directive),
      agentSteps,
      agentOverrides: isRecord(topo.agent_overrides) ? topo.agent_overrides : undefined,
    };
  }
  if (isRecord(profile.swarm)) {
    const sw = profile.swarm;
    const max = sw.max_parallel_subagents;
    assert(typeof sw.topology === 'string' && sw.topology.trim() &&
      typeof sw.guidance === 'string' && sw.guidance.trim() &&
      Number.isInteger(max) && max >= 1 && max <= 12 &&
      Array.isArray(sw.quality_gate) && sw.quality_gate.length > 0,
      `Invalid swarm topology in ${name}.json.`);
    const agentSteps = {};
    if (Number.isInteger(sw.builder_max_steps)) agentSteps.builder = sw.builder_max_steps;
    if (Number.isInteger(sw.researcher_max_steps)) {
      agentSteps.researcher = sw.researcher_max_steps;
      agentSteps.scout = sw.researcher_max_steps;
    }
    return {
      name: sw.topology.trim(),
      maxParallel: max,
      gate: sw.quality_gate,
      directive: sw.guidance.trim(),
      agentSteps,
      agentOverrides: isRecord(sw.agent_overrides) ? sw.agent_overrides : undefined,
    };
  }
  throw new Error(`Profile '${name}' is missing required key 'topology'.`);
}

function getProfile(id) {
  assert(validId.test(id), `Unknown profile '${id}'. Run 'hive-switch list'.`);
  const profile = readJson(path.join(profileDir, `${id}.json`), true);
  assert(profile, `Unknown profile '${id}'. Run 'hive-switch list'.`);
  for (const key of ['agent_models', 'opencode_config']) {
    assert(isRecord(profile[key]), `Profile '${id}' is missing required key '${key}'.`);
  }
  const normalized = normalizeTopology(profile, id);
  return { ...profile, profile_id: profile.profile_id || id, _normalized: normalized };
}

function loadSwarmAgents() {
  const candidates = [
    path.join(hiveDir, 'opencode', 'swarm-agents.json'),
    path.join(packRoot, 'opencode', 'swarm-agents.json'),
  ];
  for (const file of candidates) {
    const loaded = readJson(file, true);
    if (loaded) {
      assert(isRecord(loaded.agents) && Object.hasOwn(loaded.agents, architect), 'Invalid swarm-agents.json.');
      return loaded;
    }
  }
  return JSON.parse(JSON.stringify(DEFAULT_SWARM_AGENTS));
}

function resolveStepMap(profile) {
  const topo = profile._normalized;
  const stepMap = {};
  for (const [agent, steps] of Object.entries(BASE_STEPS)) {
    if (Object.hasOwn(profile.agent_models, agent)) stepMap[agent] = steps;
  }
  for (const [agent, rawSteps] of Object.entries(topo.agentSteps)) {
    assert(Object.hasOwn(profile.agent_models, agent), `agent_steps names unknown agent '${agent}'.`);
    const parsed = Number(rawSteps);
    assert(Number.isInteger(parsed) && parsed >= 1, `agent_steps.${agent} must be >= 1.`);
    stepMap[agent] = parsed;
  }
  return stepMap;
}

function runModelTierPreflight(profileName) {
  const candidates = [
    path.join(hiveDir, 'scripts', 'hive', 'model-tier.mjs'),
    path.join(__dirname, 'scripts', 'hive', 'model-tier.mjs'),
    path.join(packRoot, 'scripts', 'hive', 'model-tier.mjs'),
    path.join(path.dirname(packRoot), 'scripts', 'hive', 'model-tier.mjs'),
    path.join(path.dirname(path.dirname(packRoot)), 'scripts', 'hive', 'model-tier.mjs'),
  ];
  const guard = candidates.find(candidate => fs.existsSync(candidate));
  if (!guard) {
    throw new Error(
      `model-tier guard missing. Re-run install.ps1 / install.sh to install scripts/hive/model-tier.mjs ` +
      `and config/model-tiers.json into ${hiveDir} (legacy install predates model-tier enforcement).`
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      guard,
      'verify',
      '--strict',
      '--json',
      '--profiles',
      profileDir,
      '--agents',
      path.join(opencodeDir, 'agents'),
    ],
    { encoding: 'utf8' }
  );
  if (result.error) {
    throw new Error(`model-tier preflight failed for profile '${profileName}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.replace(/\s+/g, ' ').trim();
    throw new Error(
      `model-tier preflight failed for profile '${profileName}' (exit ${result.status}). ` +
      `Refusing to write config. ${detail}`
    );
  }
}

function renderProfileConfig(profile, swarmConfig, baseConfig) {
  const topo = profile._normalized;
  for (const member of topo.gate) {
    assert(Object.hasOwn(profile.agent_models, member), `verification_gate names unknown agent '${member}'.`);
  }

  const base = baseConfig ? merge(baseConfig, profile.opencode_config) : profile.opencode_config;
  const { agent, agents, ...rest } = base;
  const builtins = Object.fromEntries(Object.entries(agent || {}).map(([id, options]) => {
    if (!isRecord(options)) return [id, options];
    const { reasoningEffort, ...nativeOptions } = options;
    return [id, nativeOptions];
  }));
  if (typeof rest.small_model === 'string' && rest.small_model && !builtins.title) {
    builtins.title = { model: rest.small_model };
  }

  const stepMap = resolveStepMap(profile);
  const allAgentNames = [...new Set([
    ...Object.keys(swarmConfig.agents),
    ...Object.keys(profile.agent_models),
  ])];

  const routedAgents = {};
  for (const name of allAgentNames) {
    const model = profile.agent_models[name];
    if (!model) continue;
    assert(typeof model === 'string' && model.includes('/'),
      `Missing routed model for ${name} in ${profile.profile_id}.json.`);
    const templateEntry = swarmConfig.agents[name] || (name === 'pr-reviewer'
      ? DEFAULT_SWARM_AGENTS.agents['pr-reviewer']
      : {});
    const override = topo.agentOverrides?.[name] || {};
    const settings = { ...merge(templateEntry, override), model };
    if (Object.hasOwn(stepMap, name)) {
      settings.steps = stepMap[name];
    }
    routedAgents[name] = settings;
  }

  // Ensure hivemind-architect always retains allow rules for pr-reviewer & swarm-agent-updater.
  if (routedAgents[architect]) {
    const basePerms = Array.isArray(routedAgents[architect].permissions)
      ? routedAgents[architect].permissions
      : DEFAULT_SWARM_AGENTS.agents[architect].permissions;
    const perms = [...basePerms];
    if (!perms.some(p => isRecord(p) && p.action === 'subagent' && p.resource === '*' && p.effect === 'deny')) {
      perms.unshift({ action: 'subagent', resource: '*', effect: 'deny' });
    }
    for (const requiredSubagent of ['swarm-agent-updater', 'pr-reviewer']) {
      const hasAllow = perms.some(p =>
        isRecord(p) && p.action === 'subagent' && p.resource === requiredSubagent && p.effect === 'allow');
      if (!hasAllow) {
        perms.push({ action: 'subagent', resource: requiredSubagent, effect: 'allow' });
      }
    }
    routedAgents[architect] = { ...routedAgents[architect], permissions: perms };
  }

  const mergedSwarm = {
    ...swarmConfig,
    default_agent: architect,
    agents: routedAgents,
  };

  return merge({ ...rest, agents: merge(builtins, agents || {}) }, mergedSwarm);
}

// Drop exact values from the prior profile so user-added config keys survive switches.
function unmanaged(current, previous) {
  const entries = [];
  for (const [key, value] of Object.entries(current)) {
    if (!Object.hasOwn(previous, key)) {
      entries.push([key, value]);
    } else if (key === 'plugins' && Array.isArray(value) && Array.isArray(previous[key])) {
      const extras = value.filter(plugin => !previous[key].some(old => isDeepStrictEqual(old, plugin)));
      if (extras.length) entries.push([key, extras]);
    } else if (isRecord(value) && isRecord(previous[key])) {
      const children = unmanaged(value, previous[key]);
      if (Object.keys(children).length) entries.push([key, children]);
    } else if (!isDeepStrictEqual(value, previous[key])) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

function patchAgentFrontmatter(sourceText, filePath, model, steps) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(sourceText);
  assert(match, `No YAML frontmatter in ${filePath}`);
  let front = match[1];
  const nl = front.includes('\r\n') ? '\r\n' : '\n';
  if (!/^model:[^\r\n]*/m.test(front)) {
    // Model-less template convention: leave frontmatter clean so opencode.json governs.
    return sourceText;
  }
  front = front.replace(/^model:[^\r\n]*/m, `model: ${model}`);
  if (steps !== undefined) {
    front = front.replace(/^maxSteps:[^\r\n]*\r?\n?/gm, '');
    if (/^steps:[^\r\n]*$/m.test(front)) {
      front = front.replace(/^steps:[^\r\n]*/m, `steps: ${steps}`);
    } else {
      front = front.replace(/^model:[^\r\n]*/m, line => `${line}${nl}steps: ${steps}`);
    }
  }
  const fmStart = match.index + match[0].indexOf('\n') + 1;
  return sourceText.slice(0, fmStart) + front + sourceText.slice(fmStart + match[1].length);
}

function buildTopologyBlock(profile) {
  const topo = profile._normalized;
  const lines = [
    MARK_BEGIN,
    '## ACTIVE STACK TOPOLOGY',
    `Generated by hive-switch. Do not edit by hand; edit profiles/${profile.profile_id}.json instead.`,
    '',
    `- Stack: \`${profile.profile_id}\``,
    `- Topology: **${topo.name}**`,
    `- MAX_PARALLEL_SUBAGENTS=${topo.maxParallel} (hard cap on subagent calls per single-message batch)`,
    `- Verification gate (spawn concurrently in ONE batch): ${topo.gate.map(a => `@${a}`).join(', ')}`,
  ];
  const stepEntries = Object.entries(topo.agentSteps);
  if (stepEntries.length > 0) {
    lines.push(`- Step budgets: ${stepEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push(`- Models: ${Object.entries(profile.agent_models).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  lines.push('', '### Stack directive for hivemind-architect', topo.directive, MARK_END);
  return lines.join('\n');
}

function renderAgentsMd(existingText, profile) {
  const block = buildTopologyBlock(profile);
  const begin = existingText.indexOf(MARK_BEGIN);
  const end = existingText.indexOf(MARK_END);
  if (begin >= 0 && end > begin) {
    return existingText.slice(0, begin) + block + existingText.slice(end + MARK_END.length);
  }
  if (begin < 0 && end < 0) {
    return `${existingText.trimEnd()}\n\n${block}\n`;
  }
  throw new Error(`AGENTS.md topology markers are unbalanced; fix ${path.join(opencodeDir, 'AGENTS.md')} by hand.`);
}

function walkFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap(entry => {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) return walkFiles(path.join(dir, entry.name), rel);
    if (!entry.isFile() || entry.name.includes('.bak.')) return [];
    return [rel];
  });
}

function findTemplateFile(...relativeParts) {
  const candidates = [
    path.join(hiveDir, ...relativeParts),
    path.join(packRoot, ...relativeParts),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function stageSwitch(profile, previous) {
  const swarmConfig = loadSwarmAgents();
  const baseConfig = readJson(baseConfigPath, true);
  const selected = renderProfileConfig(profile, swarmConfig, baseConfig);
  const current = readJson(configPath, true) || {};
  assert(isRecord(current), 'Invalid OpenCode config object.');
  const known = previous
    ? merge(
        baseConfig ? merge(baseConfig, previous.opencode_config) : previous.opencode_config,
        renderProfileConfig(previous, swarmConfig, baseConfig)
      )
    : {};
  const remaining = unmanaged(current, known);
  const config = merge(remaining, selected);
  if (Array.isArray(remaining.plugins) && Array.isArray(selected.plugins)) {
    config.plugins = [...selected.plugins, ...remaining.plugins.filter(plugin =>
      !selected.plugins.some(item => isDeepStrictEqual(item, plugin)))];
  }

  const writes = [[configPath, `${JSON.stringify(config, null, 2)}\n`]];
  const stepMap = resolveStepMap(profile);
  const agentsOutDir = path.join(opencodeDir, 'agents');

  for (const [agentName, model] of Object.entries(profile.agent_models)) {
    const targetAgentPath = path.join(agentsOutDir, `${agentName}.md`);
    let sourceBytes = readOptional(targetAgentPath);
    if (!sourceBytes) {
      const stagedAgent = findTemplateFile('opencode', 'agents', `${agentName}.md`);
      assert(stagedAgent, `Profile '${profile.profile_id}' maps agent '${agentName}' but ${targetAgentPath} does not exist.`);
      sourceBytes = fs.readFileSync(stagedAgent);
    }
    const updatedAgent = patchAgentFrontmatter(
      sourceBytes.toString('utf8'),
      targetAgentPath,
      model,
      stepMap[agentName]
    );
    writes.push([targetAgentPath, updatedAgent]);
  }

  const targetAgentsMd = path.join(opencodeDir, 'AGENTS.md');
  let agentsMdBytes = readOptional(targetAgentsMd);
  if (!agentsMdBytes) {
    const stagedAgentsMd = findTemplateFile('opencode', 'AGENTS.md');
    assert(stagedAgentsMd, `Missing ${targetAgentsMd}`);
    agentsMdBytes = fs.readFileSync(stagedAgentsMd);
  }
  writes.push([targetAgentsMd, renderAgentsMd(agentsMdBytes.toString('utf8'), profile)]);

  // Ensure missing managed commands (such as pr-review.md or obsidian.md) are restored if staged.
  for (const sub of ['commands']) {
    const stagedCommandsDir = findTemplateFile('opencode', sub);
    if (stagedCommandsDir) {
      for (const entry of fs.readdirSync(stagedCommandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const dst = path.join(opencodeDir, sub, entry.name);
        if (!fs.existsSync(dst)) {
          writes.push([dst, fs.readFileSync(path.join(stagedCommandsDir, entry.name))]);
        }
      }
    }
  }

  const waveLimitTemplate = findTemplateFile('opencode', 'hivemind-wave-limit.mjs');
  if (waveLimitTemplate) {
    const limitMarker = 'const maxParallel = 0;';
    const pluginSource = fs.readFileSync(waveLimitTemplate, 'utf8');
    assert(pluginSource.split(limitMarker).length === 2, 'Missing wave limit marker in local plugin template.');
    writes.push([
      path.join(opencodeDir, 'plugins', 'hivemind-wave-limit.js'),
      pluginSource.replace(limitMarker, `const maxParallel = ${profile._normalized.maxParallel};`),
    ]);
  }

  const obsidianPluginTemplate = findTemplateFile('opencode', 'hivemind-obsidian.mjs');
  if (obsidianPluginTemplate) {
    writes.push([
      path.join(opencodeDir, 'plugins', 'hivemind-obsidian.js'),
      fs.readFileSync(obsidianPluginTemplate),
    ]);
  }

  for (const skillName of ['hivemind-obsidian', 'pr-review']) {
    const stagedSkillDir = path.join(hiveDir, 'skills', skillName);
    if (fs.existsSync(path.join(stagedSkillDir, 'SKILL.md'))) {
      for (const rel of walkFiles(stagedSkillDir)) {
        writes.push([
          path.join(opencodeDir, 'skills', skillName, rel),
          fs.readFileSync(path.join(stagedSkillDir, rel)),
        ]);
      }
    }
  }

  writes.push([activePath, `${profile.profile_id}\n`]);
  return writes;
}

function replaceFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.hive-switch-${randomUUID()}.tmp`);
  try {
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function commit(writes) {
  const changes = writes.flatMap(([target, contents]) => {
    const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const original = readOptional(target);
    return original?.equals(buf) ? [] : [{ target, contents: buf, original }];
  });
  const committed = [];
  try {
    for (const change of changes) {
      replaceFile(change.target, change.contents);
      committed.push(change);
    }
  } catch (error) {
    const failed = [];
    for (const { target, original } of committed.reverse()) {
      try {
        if (original === undefined) fs.rmSync(target, { force: true });
        else replaceFile(target, original);
      } catch {
        failed.push(target);
      }
    }
    if (failed.length) throw new Error(`Switch failed and rollback needs attention for ${failed.join(', ')}.`);
    throw error;
  }
}

function syncMirror() {
  const mirror = path.join(hiveDir, 'opencode');
  fs.mkdirSync(mirror, { recursive: true });
  for (const sub of ['agents', 'commands']) {
    const src = path.join(opencodeDir, sub);
    const dst = path.join(mirror, sub);
    if (fs.existsSync(src) && path.resolve(src) !== path.resolve(dst)) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
  const agentsMd = path.join(opencodeDir, 'AGENTS.md');
  const dstAgentsMd = path.join(mirror, 'AGENTS.md');
  if (fs.existsSync(agentsMd) && path.resolve(agentsMd) !== path.resolve(dstAgentsMd)) {
    fs.copyFileSync(agentsMd, dstAgentsMd);
  }
}

function activeId() {
  return readOptional(activePath)?.toString('utf8').trim() || '';
}

function formatSummary(profile) {
  const topo = profile._normalized;
  const gate = topo.gate.map(a => `@${a}`).join(' + ');
  return `${profile.profile_id} | Topology: ${topo.name} | MAX_PARALLEL_SUBAGENTS=${topo.maxParallel} | Gate: ${gate}`;
}

function validateModels(which) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync('opencode', ['models'], { encoding: 'utf8', env, shell: process.platform === 'win32' });
  assert(!res.error && res.status === 0, "'opencode models' failed or opencode CLI not found on PATH; cannot validate model IDs.");
  const known = new Set(
    (res.stdout || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^[^\s/]+\/\S+$/.test(line))
  );
  assert(known.size > 0, "'opencode models' returned no models.");
  const names = which === 'all' ? profileIds() : which ? [which] : (activeId() ? [activeId()] : []);
  let bad = 0;
  for (const name of names) {
    const profile = getProfile(name);
    const ids = [
      ...Object.values(profile.agent_models),
      profile.opencode_config.model || '',
      profile.opencode_config.small_model || '',
    ].filter(Boolean);
    const missing = [...new Set(ids)].sort().filter(id => !known.has(id));
    if (missing.length === 0) {
      console.log(`[OK]   ${name} - all model IDs resolve`);
    } else {
      bad += 1;
      console.log(`[WARN] ${name} - not in 'opencode models' (provider not authenticated?): ${missing.join(', ')}`);
    }
  }
  if (bad > 0) process.exitCode = 2;
}

function main(command = 'status', target = '', ...extra) {
  assert(!extra.length, 'Usage: hive-switch <profile> | status | list | validate [profile|all]');
  if (!command || command === 'status') {
    const current = activeId();
    if (!current) {
      console.log('Active Hivemind stack: (not set)');
      return;
    }
    console.log(`Active Hivemind stack: ${formatSummary(getProfile(current))}`);
    return;
  }
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Usage: hive-switch <profile> | status | list | validate [profile|all]');
    console.log('  <profile>  write opencode.json, sync agent models + step budgets, and regenerate');
    console.log('             the ACTIVE STACK TOPOLOGY block in AGENTS.md');
    console.log("  validate   check a profile's model IDs against 'opencode models'");
    return;
  }
  if (command === 'list') {
    const current = activeId();
    for (const id of profileIds()) {
      const mark = id === current ? '*' : ' ';
      console.log(`${mark} ${formatSummary(getProfile(id))}`);
    }
    return;
  }
  if (command === 'validate') {
    validateModels(target);
    return;
  }
  assert(!target, 'Usage: hive-switch <profile> | status | list | validate [profile|all]');

  const profile = getProfile(command);
  runModelTierPreflight(command);

  fs.mkdirSync(hiveDir, { recursive: true });
  const lock = path.join(hiveDir, '.hive-switch.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another profile switch holds ${lock}.`);
    throw error;
  }
  try {
    const current = activeId();
    const previous = current && profileIds().includes(current) ? getProfile(current) : undefined;
    commit(stageSwitch(profile, previous));
    syncMirror();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  console.log(`[OK] Hivemind stack: ${formatSummary(profile)}`);
}

try {
  main(...process.argv.slice(2));
} catch (error) {
  console.error(`[hive-switch] ERROR: ${error.message}`);
  process.exitCode = 1;
}
