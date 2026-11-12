/** Concrete Windows desktop adapter. All effects are behind functions invoked by explicit CLI modes. */
import { readFile, writeFile, rename, unlink, mkdir, open, lstat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindingOperation } from '../../gateway/mcp/local-binding.mjs';
import { RestoreError, stopRestore, validateSelection } from './restore-core.mjs';
import { CAPABILITY_MODE } from './direct-read.mjs';

import { preparePreset, installPreset, rollbackPreset } from './preset-files.mjs';
export { defaultRestorePaths } from './restore-paths.mjs';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
export async function boundedRead(path, maximum = 1048576) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) stopRestore('LOCAL_FILE_INVALID');
  const value = await readFile(path, 'utf8');
  if (Buffer.byteLength(value) > maximum) stopRestore('LOCAL_FILE_INVALID');
  return value;
}
export async function atomicWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function optionalProfile(path) {
  try { return await boundedRead(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function compareReplace(path, expected, value) {
  if (await optionalProfile(path) !== expected) stopRestore('PROFILE_CHANGED');
  if (value === null) { await unlink(path); return; }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    if (await optionalProfile(path) !== expected) stopRestore('PROFILE_CHANGED');
    // An absent profile must be created without replacing a concurrent creator.
    if (expected === null) {
      try { await copyFile(temp, path, constants.COPYFILE_EXCL); } catch (error) { if (error.code === 'EEXIST') stopRestore('PROFILE_CHANGED'); throw error; }
    } else await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export function processSpec(paths, kind) {
  if (kind === 'gateway') {
    const port = Number(new URL(paths.gatewayOrigin).port || 80);
    if (paths.gatewayExecutable) return { kind, port, executable: paths.gatewayExecutable,
      savedPortOverrides: paths.gatewayAddressSaved === true, arguments: [], cwd: paths.portableRoot,
      alternateArguments: [['--no-browser'], ['--port', String(port)], ['--no-browser', '--port', String(port)]] };
    return { kind, port, executable: paths.python, savedPortOverrides: paths.gatewayAddressSaved === true,
      arguments: ['-B', paths.gatewayEntry, '--run', '--port', String(port)], cwd: paths.code,
      alternateArguments: [['-B', '-m', 'gateway.native.run', '--run', '--port', String(port)],
        ['-B', '-m', 'gateway.native.run', '--run']] };
  }
  if (kind === 'web') {
    const port = paths.webPort ?? 3080;
    if (paths.managedWeb) return { kind, port, executable: paths.node,
      arguments: [paths.webLauncher, '--home', paths.home, '--port', String(port), '--entry', paths.webEntry],
      cwd: paths.home, alternateArguments: [] };
    return { kind, port, executable: paths.node,
      arguments: [paths.webEntry, 'web'], cwd: paths.webCwd,
      alternateArguments: [['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web']] };
  }
  stopRestore('PROCESS_KIND_INVALID');
}
export async function inspectProcess(paths, kind) {
  const spec = processSpec(paths, kind);
  // Probe receives only known paths/arguments, never a token or model configuration.
  const child = spawn(paths.powershell, ['-NoProfile', '-NonInteractive', '-File', paths.processProbe],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolveProbe, reject) => {
    let output = ''; const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) child.kill(); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new RestoreError('PROCESS_UNVERIFIED')); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(output);
        const reasons = ['LISTENER_QUERY_FAILED', 'PROCESS_METADATA_FAILED', 'PROCESS_HELPER_COMPILE_FAILED', 'PROCESS_PROBE_FAILED'];
        if (data.state === 'unverified' && reasons.includes(data.reason)) {
          const error = new RestoreError('PROCESS_UNVERIFIED'); error.reason = data.reason; throw error;
        }
        if (code !== 0 || !['absent', 'owned', 'foreign'].includes(data.state)) stopRestore('PROCESS_UNVERIFIED');
        if (data.state === 'owned' && (!Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.started !== 'string')) stopRestore('PROCESS_UNVERIFIED');
        resolveProbe(data);
      } catch (error) { reject(error instanceof RestoreError ? error : new RestoreError('PROCESS_UNVERIFIED')); }
    });
    child.stdin.end(JSON.stringify(spec));
  });
}

/** Existing single-user loopback bootstrap is not an authenticated Windows-user boundary. */
export async function refreshLocalBinding(paths, { fetchImpl = fetch, save = bindingOperation } = {}) {
  const origin = paths.gatewayOrigin;
  async function request(path, options = {}) {
    const response = await fetchImpl(origin + path, { ...options, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!response.ok || response.redirected || (response.url && response.url !== origin + path)
        || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') stopRestore('LOCAL_BOOTSTRAP_FAILED');
    const reader = response.body?.getReader(); if (!reader) stopRestore('LOCAL_BOOTSTRAP_FAILED');
    let bytes = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (bytes.length + value.byteLength > 32768) stopRestore('LOCAL_BOOTSTRAP_FAILED');
        bytes = Buffer.concat([bytes, value]);
      }
      return JSON.parse(bytes.toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const session = await request('/api/browser-session', { headers: { 'X-Gateway-UI': '1' } });
  if (!session.connection?.connectionId || session.storageError || typeof session.browserToken !== 'string'
      || typeof session.csrfToken !== 'string') stopRestore('SAVED_CONNECTION_UNAVAILABLE');
  const issued = await request('/api/harness/token', { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': session.csrfToken, 'X-Gateway-Session': session.browserToken,
  }, body: JSON.stringify({ connectionId: session.connection.connectionId }) });
  if (issued.connectionId !== session.connection.connectionId) stopRestore('LOCAL_BOOTSTRAP_FAILED');
  await save('save', paths.binding, { gatewayOrigin: origin, connectionId: issued.connectionId, gatewayToken: issued.gatewayToken }, paths.python);
}

export function createDesktopIo(paths) {
  return {
    readProfile: () => optionalProfile(paths.profile),
    async bindingExists() {
      try { const info = await lstat(paths.binding); return info.isFile() && !info.isSymbolicLink() && info.size > 0; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    async readSelection() { try { return JSON.parse(await boundedRead(paths.selection, 4096)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    preparePreset: () => preparePreset(paths),
    installPreset: plan => installPreset(paths, plan),
    rollbackPreset: plan => rollbackPreset(paths, plan),
    async lock() {
      await mkdir(paths.runtime, { recursive: true });
      const path = join(paths.runtime, 'direct-read-restore.lock'); let handle;
      try { handle = await open(path, 'wx', 0o600); } catch { stopRestore('RESTORE_BUSY'); }
      return async () => { await handle.close(); await unlink(path); };
    },
    inspect: kind => inspectProcess(paths, kind),
    async backup(original, revision) {
      await mkdir(dirname(paths.profile), { recursive: true });
      const file = `${paths.profile}.before-direct-read-${revision}${original === null ? '.absent.json' : ''}`;
      await writeFile(file, original ?? '{"profileExisted":false}\n', { flag: 'wx', mode: 0o600 });
    },
    compareReplace: (expected, updated) => compareReplace(paths.profile, expected, updated),
    refreshBinding: () => refreshLocalBinding(paths),
    saveSelection: selection => atomicWrite(paths.selection, JSON.stringify(validateSelection(selection)) + '\n'),
    async ensure(kind, observed) {
      const current = await inspectProcess(paths, kind);
      if (current.state === 'owned') {
        if (observed.state === 'owned' && (current.pid !== observed.pid || current.started !== observed.started)) stopRestore('PROCESS_CHANGED');
        return current;
      }
      if (current.state !== 'absent' || observed.state !== 'absent') stopRestore('PROCESS_CHANGED');
      const spec = processSpec(paths, kind);
      const child = spawn(spec.executable, spec.arguments, { cwd: spec.cwd, windowsHide: true, detached: true, stdio: 'ignore',
        env: { ...process.env, DSH_HOME: paths.home } });
      let failed = false; child.on('error', () => { failed = true; }); child.unref();
      const end = Date.now() + 30000;
      while (Date.now() < end && !failed) {
        await delay(300); const state = await inspectProcess(paths, kind);
        if (state.state === 'owned' && state.pid === child.pid) return state;
        if (state.state !== 'absent') stopRestore('PROCESS_CHANGED');
      }
      stopRestore('PROCESS_START_FAILED');
    },
    async waitActivation({ revision, pid, agentPreset }) {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        try {
          // Activation includes every BC Agent's tool catalog; use the existing local-file bound.
          const value = JSON.parse(await boundedRead(paths.activation));
          if (value.status === 'ready' && value.capabilityMode === CAPABILITY_MODE && value.revision === revision && value.pid === pid
              && value.agentPreset === agentPreset) {
            const current = await inspectProcess(paths, 'web');
            if (current.state === 'owned' && current.pid === pid) return;
          }
        } catch { /* Missing/old receipts are not activation evidence. */ }
        await delay(200);
      }
      stopRestore('PLUGIN_ACTIVATION_TIMEOUT');
    },
  };
}
