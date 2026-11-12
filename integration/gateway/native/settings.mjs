/** Read the same non-secret settings through the Python resolver; never read DPAPI. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function readGatewaySettings(python = 'python', settingsFile) {
  const args = ['-B', fileURLToPath(new URL('./settings.py', import.meta.url))];
  if (settingsFile !== undefined) args.push(settingsFile);
  const result = spawnSync(python, args, { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('GATEWAY_SETTINGS_LOAD_FAILED'); }
  if (result.status !== 0 || value.error || typeof value.gatewayOrigin !== 'string'
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.addressSaved !== 'boolean') throw new Error('GATEWAY_SETTINGS_LOAD_FAILED');
  return value;
}
