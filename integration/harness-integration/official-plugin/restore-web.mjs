/** Formal launcher for a selected Harness home/port, used by connect/restore.
 * Keep the home in the OS command line so process matching never has to read
 * another process's environment (which can contain model credentials).
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harnessPort } from './restore-paths.mjs';
import { RestoreError, stopRestore } from './restore-core.mjs';

export function parseWebArguments(args) {
  const result = {}; const keys = { '--home': 'home', '--port': 'port', '--entry': 'entry' };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]]; const value = args[i + 1];
    if (!key || Object.hasOwn(result, key) || !value || value.startsWith('--')) stopRestore('ARGUMENTS_INVALID');
    result[key] = key === 'port' ? harnessPort(value) : value;
  }
  if (Object.keys(result).length !== 3 || !isAbsolute(result.home) || !isAbsolute(result.entry)) stopRestore('ARGUMENTS_INVALID');
  return { ...result, home: resolve(result.home), entry: resolve(result.entry) };
}

export async function main(args = process.argv.slice(2)) {
  const { home, port, entry } = parseWebArguments(args);
  process.env.DSH_HOME = home;
  // The official loader checks .env in cwd and DSH_HOME. An isolated home must
  // not implicitly load the installed repository's project .env.
  process.chdir(home);
  process.argv = [process.execPath, entry, 'web', '--host', '127.0.0.1', '--port', String(port)];
  await import(pathToFileURL(entry).href);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write((error instanceof RestoreError ? error.code : 'HARNESS_START_FAILED') + '\n');
    process.exitCode = 1;
  });
}
