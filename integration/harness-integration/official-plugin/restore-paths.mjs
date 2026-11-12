/** Discover installed runtimes only. No installation, profile or credential reads. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGatewaySettings } from '../../gateway/native/settings.mjs';
import { stopRestore, BC_PRESET } from './restore-core.mjs';

export const COMPATIBLE_RUNTIME = Object.freeze({ dsh: '0.1.2-alpha.1', cordis: '4.0.1' });
const present = value => typeof value === 'string' && value.trim().length > 0;
export function expandPath(value, userHome = homedir()) {
  if (!present(value)) stopRestore('PATH_INVALID');
  return resolve(value === '~' ? userHome : /^~[/\\]/.test(value) ? join(userHome, value.slice(2)) : value);
}
export function harnessPort(value = 3080) {
  if (!/^[0-9]{1,5}$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) stopRestore('HARNESS_PORT_INVALID');
  return Number(value);
}

export function resolvePython(configured, { run = spawnSync } = {}) {
  const candidates = configured ? [[configured, []]] : [['python', []], ['python3', []], ['py', ['-3']]];
  for (const [executable, prefix] of candidates) {
    const result = run(executable, [...prefix, '-I', '-B', '-c',
      'import sys,json;print(json.dumps({"path":sys.executable,"version":list(sys.version_info[:2])}))'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    try {
      const value = JSON.parse(result.stdout);
      if (result.status === 0 && isAbsolute(value.path) && value.version[0] === 3 && value.version[1] >= 12) return value.path;
    } catch { /* Never export process output. */ }
  }
  stopRestore('PYTHON_NOT_FOUND');
}

export function resolvePowerShell(configured, { run = spawnSync, env = process.env } = {}) {
  const candidates = configured ? [configured] : ['pwsh', ...(env.ProgramFiles ? [join(env.ProgramFiles, 'PowerShell/7/pwsh.exe')] : [])];
  for (const executable of candidates) {
    const result = run(executable, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @{path=(Get-Process -Id $PID).Path; major=$PSVersionTable.PSVersion.Major; bits=[IntPtr]::Size} | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    try {
      const value = JSON.parse(result.stdout);
      if (result.status === 0 && isAbsolute(value.path) && value.major >= 7 && value.bits === 8) return value.path;
    } catch { /* Never export process output. */ }
  }
  stopRestore('POWERSHELL_NOT_FOUND');
}

export function resolveHarness(roots, { explicit = false } = {}) {
  let incompatible = false; let incomplete = false;
  for (const root of roots) {
    // Both an installed package directory and a repository/install root are accepted.
    for (const anchor of [root, join(root, 'apps/cli')]) {
      try {
        const loader = createRequire(join(resolve(anchor), '__bc_setup.cjs'));
        let cliManifest;
        try {
          const own = join(resolve(anchor), 'package.json');
          if (JSON.parse(readFileSync(own, 'utf8')).name === '@deepseek-ai/dsh') cliManifest = own;
        } catch {}
        cliManifest ??= loader.resolve('@deepseek-ai/dsh/package.json');
        const cliLoader = createRequire(cliManifest);
        const cli = dirname(cliManifest);
        const version = JSON.parse(readFileSync(cliManifest, 'utf8')).version;
        const cordis = cliLoader('@deepseek-ai/cordis/package.json').version;
        if (version !== COMPATIBLE_RUNTIME.dsh || cordis !== COMPATIBLE_RUNTIME.cordis) { incompatible = true; continue; }
        // pnpm source checkouts expose some packages through Web's dependency
        // graph or the official profile fallback rather than CLI's direct graph.
        const loaders = [cliLoader, loader];
        try { loaders.push(createRequire(cliLoader.resolve('@deepseek-ai/dsh-web-app/package.json'))); } catch {}
        function dependency(name) {
          for (const candidate of loaders) { try { return candidate.resolve(name); } catch {} }
          throw Error('DEPENDENCY_MISSING');
        }
        let standardPresetDir; let yamlPath;
        try {
          standardPresetDir = join(dirname(dependency('@deepseek-ai/dsh-agent-presets/package.json')), 'presets/standard');
          try { yamlPath = dependency('yaml'); }
          catch {
            // Existing pnpm workspace storage, read-only; no package-manager invocation.
            const store = resolve(cli, '../../node_modules/.pnpm');
            const candidates = readdirSync(store).filter(name => /^yaml@2\./.test(name));
            if (candidates.length !== 1) throw Error('DEPENDENCY_MISSING');
            yamlPath = createRequire(join(store, candidates[0], '__bc_setup.cjs')).resolve('yaml');
          }
        } catch { incomplete = true; continue; }
        const webEntry = join(cli, 'lib/bin.js');
        if (!existsSync(webEntry) || !existsSync(join(standardPresetDir, 'agent.cordis.yml'))) { incomplete = true; continue; }
        return { webEntry, webCwd: resolve(cli, '../..'), standardPresetDir, yamlPath,
          runtimeVersions: { dsh: version, cordis }, harnessRoot: cli };
      } catch { /* A resolution miss is not a reason to inspect settings.yaml. */ }
    }
  }
  stopRestore(incomplete ? 'HARNESS_INSTALL_INCOMPLETE' : incompatible ? 'HARNESS_VERSION_UNSUPPORTED' : explicit ? 'HARNESS_ROOT_INVALID' : 'HARNESS_NOT_FOUND');
}

export function defaultRestorePaths(options = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const userHome = deps.userHome ?? homedir();
  const pluginRoot = deps.pluginRoot ?? dirname(fileURLToPath(import.meta.url));
  const code = resolve(pluginRoot, '../..');
  const portableRoot = present(options.portableRoot) ? expandPath(options.portableRoot, userHome) : undefined;
  const gatewayExecutable = portableRoot ? join(portableRoot, 'CSY.exe') : undefined;
  if (gatewayExecutable && !existsSync(gatewayExecutable)) stopRestore('PORTABLE_ROOT_INVALID');
  const gatewayRuntime = portableRoot ? join(portableRoot, 'data') : resolve(code, '../.runtime/native-gateway');
  // Client grant/receipt files can be isolated without moving the Gateway's
  // address, saved BC connection, or server-side authorization store.
  const stateDir = options.stateDir ?? env.BC_GATEWAY_STATE_DIR;
  const runtime = present(stateDir) ? expandPath(stateDir, userHome) : gatewayRuntime;
  const defaultHome = expandPath(join(userHome, '.dsh'), userHome);
  const home = expandPath(options.harnessHome ?? (present(env.DSH_HOME) ? env.DSH_HOME : defaultHome), userHome);
  const webPort = harnessPort(options.harnessPort ?? env.BC_GATEWAY_HARNESS_PORT ?? 3080);
  const configuredRoot = options.harnessRoot ?? env.BC_GATEWAY_HARNESS_ROOT;
  const roots = present(configuredRoot) ? [expandPath(configuredRoot, userHome)]
    : [join(home, 'profiles'), home, deps.cwd ?? process.cwd(), dirname(process.execPath), join(pluginRoot, '../runtime')];
  const installed = (deps.resolveHarness ?? resolveHarness)(roots, { explicit: present(configuredRoot) });
  const python = (deps.resolvePython ?? resolvePython)(options.python ?? env.BC_GATEWAY_PYTHON);
  const powershell = (deps.resolvePowerShell ?? resolvePowerShell)(options.powershell ?? env.BC_GATEWAY_POWERSHELL);
  let settings;
  try { settings = (deps.readSettings ?? readGatewaySettings)(python, join(gatewayRuntime, 'settings.json')); }
  catch { stopRestore('GATEWAY_SETTINGS_LOAD_FAILED'); }
  const { gatewayOrigin, addressSaved: gatewayAddressSaved } = settings;
  const presetDir = join(home, '.agent-presets', BC_PRESET);
  return { ...installed, code, runtime, gatewayRuntime, portableRoot, gatewayExecutable, home, defaultHome, webPort,
    managedWeb: home.toLowerCase() !== defaultHome.toLowerCase() || webPort !== 3080,
    webLauncher: join(pluginRoot, 'restore-web.mjs'), presetDir, presetFile: join(presetDir, 'agent.cordis.yml'),
    profile: join(home, 'profiles/web/cordis.patch.yml'), selection: join(runtime, 'direct-read-selection.json'),
    binding: join(runtime, 'harness-binding.dpapi'), activation: join(runtime, 'direct-read-activation.json'),
    plugin: join(pluginRoot, 'web-direct-read.mjs'), bridge: join(code, 'gateway/mcp/run.mjs'),
    gatewayEntry: join(pluginRoot, 'restore-gateway.py'), processProbe: join(pluginRoot, 'restore-process.ps1'),
    python, powershell, node: process.execPath, gatewayOrigin, gatewayAddressSaved,
  };
}
