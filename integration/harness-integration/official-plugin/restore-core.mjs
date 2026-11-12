/** One-user desktop recovery orchestration. No import-time I/O or credential handling. */
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { connectionIdValid, exactFields } from './gateway-read-transport.mjs';
import { DEFAULT_READ_TIMEOUT_MS, CAPABILITY_MODE } from './direct-read.mjs';
export const BC_PRESET = 'bc-agent';

export const DIRECT_ENTRY = 'bc-gateway-direct-mcp';
export const OLD_READ_ENTRY = 'bc-gateway-direct-read';
export const LEGACY_ENTRY = 'bc-gateway-mcp';
export class RestoreError extends Error {
  constructor(code) { super(code); this.name = 'RestoreError'; this.code = code; }
}
export const stopRestore = code => { throw new RestoreError(code); };
export function validateSelection(value) {
  if (!exactFields(value, ['version', 'agentPreset', 'capabilityMode'], ['harnessHome', 'harnessPort']) || value.version !== 3
      || value.capabilityMode !== CAPABILITY_MODE
      || value.agentPreset !== BC_PRESET) stopRestore('PRESET_REQUIRED');
  const hasTarget = Object.hasOwn(value, 'harnessHome') || Object.hasOwn(value, 'harnessPort');
  if (hasTarget && (typeof value.harnessHome !== 'string' || !isAbsolute(value.harnessHome)
      || !Number.isInteger(value.harnessPort) || value.harnessPort < 1 || value.harnessPort > 65535)) stopRestore('PRESET_REQUIRED');
  return { version: 3, agentPreset: BC_PRESET, capabilityMode: CAPABILITY_MODE,
    ...(hasTarget ? { harnessHome: value.harnessHome, harnessPort: value.harnessPort } : {}) };
}
function sameHarnessTarget(saved, selection, paths) {
  if (selection.harnessHome === undefined) return true; // Legacy callers without an explicit target.
  if (saved?.harnessHome === undefined) {
    // Existing default installations remain idempotent without a state migration.
    return selection.harnessPort === 3080 && selection.harnessHome === paths.defaultHome;
  }
  return saved.harnessHome === selection.harnessHome && saved.harnessPort === selection.harnessPort;
}
export function directEntry(paths, selection, revision) {
  validateSelection(selection);
  if (!connectionIdValid(revision)) stopRestore('INVALID_REVISION');
  return { id: DIRECT_ENTRY, name: pathToFileURL(paths.plugin).href, config: {
    bindingFile: paths.binding, python: paths.python, agentPreset: BC_PRESET, presetFile: paths.presetFile, capabilityMode: CAPABILITY_MODE,
    requestTimeoutMs: DEFAULT_READ_TIMEOUT_MS, bindingRevision: revision, activationFile: paths.activation,
  } };
}
export function legacyEntry(paths, revision) {
  return { id: LEGACY_ENTRY, name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'bc_gateway', transport: 'stdio', command: paths.node,
    args: [paths.bridge, '--binding-file', paths.binding, '--python', paths.python],
    env: { BC_GATEWAY_BINDING_REVISION: revision }, failOnStartupError: false, reconnect: { enabled: false },
  } };
}

/** Locate our single top-level insert, or an empty slot. Preserve every other YAML node. */
function projectDocument(yaml, original, paths) {
  let doc;
  try { doc = yaml.parseDocument(original ?? '', { uniqueKeys: true }); } catch { stopRestore('PROFILE_INVALID'); }
  if (doc.errors.length) stopRestore('PROFILE_INVALID');
  if (doc.contents === null) doc.contents = doc.createNode([]);
  if (!yaml.isSeq(doc.contents)) stopRestore('PROFILE_INVALID');
  let found;
  const ids = new Set([DIRECT_ENTRY, OLD_READ_ENTRY, LEGACY_ENTRY]);
  // Count all id occurrences, including unexpected nested/patch locations, before touching anything.
  let count = 0;
  yaml.visit(doc, {
    Alias() { stopRestore('PROFILE_ALIAS_UNSUPPORTED'); },
    Pair(_key, pair) { if (pair.key?.value === 'id' && ids.has(pair.value?.value)) count++; },
  });
  for (const patch of doc.contents.items) {
    const rows = patch?.get?.('insert');
    if (!yaml.isSeq(rows)) continue;
    for (let i = 0; i < rows.items.length; i++) {
      const row = rows.items[i]; const id = row?.get?.('id');
      if (!ids.has(id)) continue;
      const value = row.toJSON();
      const ours = id === LEGACY_ENTRY
        ? value.name === '@deepseek-ai/dsh-mcp-client' && value.config?.transport === 'stdio'
          && value.config?.serverName === 'bc_gateway' && value.config?.args?.[0] === paths.bridge
        : value.name === pathToFileURL(paths.plugin).href;
      if (!ours) stopRestore('PROFILE_ENTRY_COLLISION');
      found = { rows, index: i };
    }
  }
  if (count > 1 || (count && !found)) stopRestore('PROFILE_ENTRY_COLLISION');
  return { doc, found };
}
export function replaceProjectEntry(yaml, original, paths, entry) {
  const { doc, found } = projectDocument(yaml, original, paths);
  if (found) found.rows.items[found.index] = doc.createNode(entry);
  else doc.contents.add(doc.createNode({ insert: [entry] }));
  return String(doc);
}

function configuredRevision(yaml, original, paths, selection) {
  const { found } = projectDocument(yaml, original, paths);
  if (!found) return null;
  const entry = found.rows.items[found.index].toJSON();
  const revision = entry.config?.bindingRevision;
  if (!connectionIdValid(revision)) return null;
  const expected = directEntry(paths, selection, revision);
  const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => typeof a[key] === 'object' ? same(a[key], b[key]) : a[key] === b[key]);
  return same(entry, expected) ? revision : null;
}

/** io is a trusted host seam. prepare performs reads only; apply is always explicit. */
export async function recoverDirectRead({ mode = 'prepare', selection: chosen, enableNativeFull = false, refreshBinding = false, paths, yaml, io, revision }) {
  if (!['prepare', 'dry-run', 'apply'].includes(mode)) stopRestore('MODE_INVALID');
  let release; let written; let rollback; let presetPlan; let presetCreated = false; let backupMade = false; let bindingUpdated = false;
  try {
    if (mode === 'apply') release = await io.lock();
    const original = await io.readProfile();
    const saved = await io.readSelection();
    const selection = validateSelection(chosen ?? { version: 3, agentPreset: BC_PRESET, capabilityMode: CAPABILITY_MODE });
    const scopeAlreadyEnabled = saved?.version === 3 && saved.capabilityMode === CAPABILITY_MODE && saved.agentPreset === BC_PRESET;
    if (mode === 'apply' && !scopeAlreadyEnabled && enableNativeFull !== true) stopRestore('FULL_CAPABILITY_ENABLE_REQUIRED');
    presetPlan = await io.preparePreset();
    const existingRevision = configuredRevision(yaml, original, paths, selection);
    if (scopeAlreadyEnabled && sameHarnessTarget(saved, selection, paths) && presetPlan.exists && existingRevision
        && !refreshBinding && await io.bindingExists?.()) {
      // Installation idempotence only: do not read a secret or contact either service.
      // Ordinary startup/restart uses the persistent binding; explicit repair remains available.
      return { status: 'ALREADY_CONFIGURED', capabilityMode: CAPABILITY_MODE, scope: 'preset', agentPreset: BC_PRESET,
        applied: false, bindingUpdated: false, bindingRead: false, tokenIssued: false,
        connectionVerified: false, modelCalls: 0, bcCalls: 0 };
    }
    const updated = replaceProjectEntry(yaml, original, paths, directEntry(paths, selection, revision));
    rollback = original;
    // Check both listeners BEFORE minting, saving, or replacing any configuration.
    const gateway = await io.inspect('gateway'); const web = await io.inspect('web');
    if (![gateway.state, web.state].every(state => ['owned', 'absent'].includes(state))) stopRestore('FOREIGN_PROCESS');
    if (mode !== 'apply') return { status: 'PREPARED', scope: 'preset', agentPreset: BC_PRESET,
      capabilityMode: CAPABILITY_MODE, requiresExplicitEnable: !scopeAlreadyEnabled,
      profileChange: projectDocument(yaml, original, paths).found ? 'replace-project-entry' : 'insert-project-entry',
      gateway: gateway.state, web: web.state, bindingRead: false, tokenIssued: false, bindingUpdated: false, applied: false };
    await io.backup(original, revision); backupMade = true;
    presetCreated = await io.installPreset(presetPlan);
    await io.ensure('gateway', gateway);
    // Host performs existing loopback bootstrap + CSRF issuance + DPAPI save internally.
    // No token, session secret, or binding payload crosses this orchestration interface.
    await io.refreshBinding(); bindingUpdated = true;
    await io.compareReplace(original, updated); written = updated;
    const running = await io.ensure('web', web);
    await io.waitActivation({ revision, pid: running.pid, agentPreset: BC_PRESET });
    await io.saveSelection(selection);
    return { status: 'BC_MCP_READY', capabilityMode: CAPABILITY_MODE, scope: 'preset', agentPreset: BC_PRESET, applied: true, bindingUpdated: true,
      modelCalls: 0, bcCalls: 0, activation: 'plugin-loaded' };
  } catch (error) {
    let rollbackStatus = 'not-needed';
    if (written !== undefined) {
      try { await io.compareReplace(written, rollback); rollbackStatus = 'original-profile-restored'; }
      catch { rollbackStatus = 'profile-changed-or-write-failed'; }
    }
    let presetRollback = 'not-needed';
    if (presetCreated && rollbackStatus !== 'profile-changed-or-write-failed') {
      try { await io.rollbackPreset(presetPlan); presetRollback = 'created-preset-removed'; }
      catch { presetRollback = 'preset-changed-or-remove-failed'; }
    }
    // Never restore a pre-restart token. A valid new binding is shared by both transports.
    return { status: 'failed', code: error instanceof RestoreError ? error.code : 'LOCAL_RESTORE_FAILED',
      ...(error instanceof RestoreError && error.reason ? { processReason: error.reason } : {}),
      applied: false, backupMade, bindingUpdated, rollback: rollbackStatus, presetRollback, modelCalls: 0, bcCalls: 0 };
  } finally { await release?.(); }
}
