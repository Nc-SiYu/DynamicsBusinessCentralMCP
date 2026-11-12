/** Desktop entry. Default is read-only prepare. --apply is for separately approved activation only. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recoverDirectRead, RestoreError, stopRestore, BC_PRESET } from './restore-core.mjs';
import { defaultRestorePaths, createDesktopIo } from './restore-host.mjs';
import { CAPABILITY_MODE } from './direct-read.mjs';
import { harnessPort } from './restore-paths.mjs';

export function parseRestoreArguments(args) {
  const flags = []; const options = {}; const seen = new Set();
  const values = { '--harness-home': 'harnessHome', '--harness-root': 'harnessRoot', '--python': 'python', '--powershell': 'powershell',
    '--portable-root': 'portableRoot', '--state-dir': 'stateDir', '--harness-port': 'harnessPort' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) stopRestore('ARGUMENTS_INVALID');
    seen.add(key);
    if (Object.hasOwn(values, key)) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) stopRestore('ARGUMENTS_INVALID');
      options[values[key]] = key === '--harness-port' ? harnessPort(value) : value;
    } else if (['--prepare', '--dry-run', '--apply', '--enable-native-full', '--refresh-binding'].includes(key)) flags.push(key);
    else stopRestore('ARGUMENTS_INVALID');
  }
  const modes = flags.filter(value => ['--prepare', '--dry-run', '--apply'].includes(value));
  if (modes.length > 1) stopRestore('ARGUMENTS_INVALID');
  return { mode: (modes[0] ?? '--prepare').slice(2), enableNativeFull: flags.includes('--enable-native-full'),
    ...(flags.includes('--refresh-binding') ? { refreshBinding: true } : {}), ...options };
}
export async function runRestore(options) {
  const { mode, enableNativeFull, refreshBinding } = options;
  const paths = defaultRestorePaths(options); const io = createDesktopIo(paths);
  const require = createRequire(import.meta.url);
  const selection = { version: 3, agentPreset: BC_PRESET, capabilityMode: CAPABILITY_MODE,
    harnessHome: paths.home, harnessPort: paths.webPort };
  const result = await recoverDirectRead({ mode, selection, enableNativeFull, refreshBinding, paths, io, yaml: require(paths.yamlPath), revision: randomUUID() });
  return { ...result, harnessUrl: `http://127.0.0.1:${paths.webPort}`, harnessHome: paths.home, stateDirectory: paths.runtime };
}
export async function main(args = process.argv.slice(2)) {
  const result = await runRestore(parseRestoreArguments(args));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'failed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stdout.write(JSON.stringify({ status: 'failed', code: error instanceof RestoreError ? error.code : 'LOCAL_RESTORE_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}
