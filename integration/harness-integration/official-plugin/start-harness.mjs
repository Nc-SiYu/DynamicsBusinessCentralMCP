/** Start only the installed Harness; never bind, alter its profile or call BC/model. */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseRestoreArguments } from './restore.mjs';
import { defaultRestorePaths, createDesktopIo } from './restore-host.mjs';
import { RestoreError, validateSelection } from './restore-core.mjs';
import { SETUP_HELP } from './connect.mjs';

export async function startHarness(args, { question, output, resolvePaths = defaultRestorePaths, createIo = createDesktopIo } = {}) {
  const options = parseRestoreArguments(args);
  if (options.mode !== 'prepare' || options.enableNativeFull || options.refreshBinding) throw new RestoreError('ARGUMENTS_INVALID');
  const prompted = new Set();
  for (;;) {
    try {
      let paths = resolvePaths(options);
      const saved = await createIo(paths).readSelection();
      if (saved) {
        const selection = validateSelection(saved);
        if (selection.harnessHome !== undefined) {
          options.harnessHome ??= selection.harnessHome;
          options.harnessPort ??= selection.harnessPort;
          paths = resolvePaths(options);
        }
      }
      const io = createIo(paths);
      const observed = await io.inspect('web');
      if (observed.state === 'foreign') throw new RestoreError('FOREIGN_PROCESS');
      if (!['absent', 'owned'].includes(observed.state)) throw new RestoreError('PROCESS_UNVERIFIED');
      await io.ensure('web', observed);
      const harnessUrl = `http://127.0.0.1:${paths.webPort}`;
      output(`Harness is running: ${harnessUrl}. Select CSY Agent.`);
      return { status: 'HARNESS_STARTED', harnessUrl };
    } catch (error) {
      const code = error instanceof RestoreError ? error.code : 'HARNESS_START_FAILED';
      output(SETUP_HELP[code] ?? `Harness could not start (${code}).`);
      const field = /^HARNESS_(NOT_FOUND|ROOT_INVALID|VERSION_UNSUPPORTED|INSTALL_INCOMPLETE)$/.test(code) ? 'harnessRoot'
        : code === 'PYTHON_NOT_FOUND' ? 'python' : code === 'POWERSHELL_NOT_FOUND' ? 'powershell' : null;
      if (!field || prompted.has(field)) return { status: 'failed', code };
      prompted.add(field);
      const value = await question(field === 'harnessRoot' ? 'Harness installation folder (Enter to cancel): ' : 'Full path to the installed .exe (Enter to cancel): ');
      if (!value.trim()) return { status: 'failed', code };
      options[field] = value.trim().replace(/^"(.*)"$/, '$1');
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await startHarness(process.argv.slice(2), { question: value => terminal.question(value), output: value => process.stdout.write(value + '\n') });
    if (result.status === 'failed') process.exitCode = 1;
  } catch { process.stdout.write('Invalid start arguments. Open Start-Harness.cmd.\n'); process.exitCode = 1; }
  finally { terminal.close(); }
}
