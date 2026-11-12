/** User-invoked setup wizard. Importing does nothing. Never requests or prints a secret. */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseRestoreArguments, runRestore } from './restore.mjs';
import { RestoreError } from './restore-core.mjs';

export const SETUP_HELP = {
  HARNESS_NOT_FOUND: 'Harness was not found. Install DSH 0.1.2-alpha.1 / Cordis 4.0.1 before setup.',
  HARNESS_ROOT_INVALID: 'Select a complete Harness installation folder or repository root.',
  HARNESS_INSTALL_INCOMPLETE: 'The Harness installation is incomplete. Use a complete DSH 0.1.2-alpha.1 / Cordis 4.0.1 installation.',
  HARNESS_VERSION_UNSUPPORTED: 'This Harness version is not supported. Use DSH 0.1.2-alpha.1 / Cordis 4.0.1.',
  PYTHON_NOT_FOUND: 'Python 3.12 or later was not found. Enter the path to an installed python.exe.',
  POWERSHELL_NOT_FOUND: '64-bit PowerShell 7 was not found. Enter the path to an installed pwsh.exe.',
  FULL_CAPABILITY_ENABLE_REQUIRED: 'First-time setup requires confirmation. Open connect.cmd to continue.',
  SAVED_CONNECTION_UNAVAILABLE: 'Save a BC connection in the Gateway first, then run setup again.',
  FOREIGN_PROCESS: 'The Gateway or Harness address is in use by another process. Ask your administrator to check the running instance.',
  PROCESS_UNVERIFIED: 'Could not verify the running instance. Check PowerShell 7 and process access permissions.',
  PROCESS_START_FAILED: 'Could not start the Gateway or Harness. Check that both applications can start, then try again.',
  PLUGIN_ACTIVATION_TIMEOUT: 'Harness did not confirm the plugin. Check the rollback result below and the installed Harness version.',
  PROFILE_ENTRY_COLLISION: 'An existing plugin entry belongs to another installation. The configuration was not overwritten.',
  PROFILE_INVALID: 'The Harness plugin configuration could not be read. It was not overwritten.',
  PROFILE_ALIAS_UNSUPPORTED: 'The existing configuration contains unsupported YAML references. It was not overwritten.',
  PROFILE_CHANGED: 'The configuration changed during setup. Wait for other changes to finish, then try again.',
  PRESET_COLLISION: 'The existing bc-agent preset does not match this installation. It was not overwritten.',
  RESTORE_BUSY: 'Another setup is running. Wait for it to finish. If it has stopped unexpectedly, ask your administrator to check the setup lock.',
  GATEWAY_SETTINGS_LOAD_FAILED: 'Could not read the Gateway address. Check the address in the Gateway page.',
  PORTABLE_ROOT_INVALID: 'Use the complete CSY folder and run setup beside CSY.exe.',
  ARGUMENTS_INVALID: 'Invalid setup arguments. Open connect.cmd to continue.',
  HARNESS_PORT_INVALID: 'The Harness port must be an integer from 1 to 65535.',
};

export async function connect(args = [], { question, output, run = runRestore } = {}) {
  const options = parseRestoreArguments(args);
  if (options.mode !== 'prepare' || options.enableNativeFull) throw new RestoreError('ARGUMENTS_INVALID');
  output('Set up CSY Agent and connect the Gateway. Its BC tools can change business data. Other agent presets are unchanged.');
  output('Save your BC connection in the Gateway first. Setup does not call BC or a model, or install software.');
  const answer = await question('Set up now? Enter yes to continue, or press Enter to cancel: ');
  if (answer.trim().toLowerCase() !== 'yes') return { status: 'CANCELED', applied: false };
  const prompted = new Set();
  for (;;) {
    let result;
    try { result = await run({ ...options, mode: 'apply', enableNativeFull: true }); }
    catch (error) { result = { status: 'failed', code: error instanceof RestoreError ? error.code : 'LOCAL_RESTORE_FAILED' }; }
    if (result.status !== 'failed') return result;
    output(SETUP_HELP[result.code] ?? `Setup failed (${result.code}).`);
    const field = /^HARNESS_(NOT_FOUND|ROOT_INVALID|VERSION_UNSUPPORTED|INSTALL_INCOMPLETE)$/.test(result.code) ? 'harnessRoot'
      : result.code === 'PYTHON_NOT_FOUND' ? 'python' : result.code === 'POWERSHELL_NOT_FOUND' ? 'powershell' : null;
    if (!field || prompted.has(field)) return result;
    prompted.add(field);
    const value = await question(field === 'harnessRoot' ? 'Harness installation folder (Enter to cancel): ' : 'Full path to the installed .exe (Enter to cancel): ');
    if (!value.trim()) return result;
    options[field] = value.trim().replace(/^"(.*)"$/, '$1');
  }
}

export async function main() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const output = value => process.stdout.write(value + '\n');
  try {
    const result = await connect(process.argv.slice(2), { question: text => terminal.question(text), output });
    if (result.status === 'BC_MCP_READY') output(`Setup complete. Open ${result.harnessUrl}, start a new chat, and select CSY Agent.`);
    else if (result.status === 'ALREADY_CONFIGURED') output(`Already configured. Open ${result.harnessUrl}. If Harness is stopped, run Start-Harness.cmd.`);
    else if (result.status === 'CANCELED') output('Setup canceled. No configuration changes were made.');
    else { output(`Setup failed: ${result.code}${result.processReason ? ' / ' + result.processReason : ''}; configuration rollback: ${result.rollback ?? 'unchanged'}; preset rollback: ${result.presetRollback ?? 'unchanged'}.`); process.exitCode = 1; }
  } catch (error) {
    const code = error instanceof RestoreError ? error.code : 'LOCAL_RESTORE_FAILED';
    output(SETUP_HELP[code] ?? `Setup failed (${code}).`); process.exitCode = 1;
  } finally { terminal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
