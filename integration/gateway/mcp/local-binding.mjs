import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function bindingOperation(mode, path, value, python = 'python') {
  const result = spawnSync(python, ['-B', fileURLToPath(new URL('./binding.py', import.meta.url)), mode, path], {
    input: value === undefined ? undefined : JSON.stringify(value), encoding: 'utf8',
    windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
  if (result.status !== 0) throw new Error('GATEWAY_BINDING_FAILED');
  const data = JSON.parse(result.stdout);
  if (data.error) throw new Error('GATEWAY_BINDING_FAILED');
  return data;
}
