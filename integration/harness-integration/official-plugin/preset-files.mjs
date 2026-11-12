/** Official user-preset files. No profile, session, settings or secret reads. */
import { readFile, readdir, lstat, mkdir, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stopRestore } from './restore-core.mjs';

/** Task-focused information gathering for the BC Agent persona. */
export const BC_TASK_GUIDANCE = 'Prefer existing tool descriptions; make targeted queries only for information necessary to complete the current task; stop once the result is confirmed; if searches yield no new information, explain the remaining gap to the user instead of searching repeatedly.';
const composition = 'agent.cordis.yml';
const marker = 'bc-gateway-preset.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const legacyMetadata = 'name: BC Agent\ndescription: Standard tools plus full Business Central native MCP via the local Gateway. BC operations may change business data.\n';
const previousMetadata = 'name: Ncc\ndescription: Ncc：基于 DeepSeek Harness 的 Business Central 助手，通过本地 Gateway 使用 BC 原生工具，可按账号权限查询或修改业务数据。\n';
const previousAgentMetadata = 'name: Ncc Agent\ndescription: Ncc Agent：基于 DeepSeek Harness 的 Business Central 助手，通过本地 Gateway 使用 BC 原生工具，可按账号权限查询或修改业务数据。\n';
const metadata = 'name: CSY Agent\ndescription: CSY Agent uses native Business Central tools through DeepSeek Harness and the local Gateway to query or modify business data within your account permissions.\n';
async function read(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) stopRestore('PRESET_FILE_INVALID');
  return readFile(path, 'utf8');
}
async function snapshot(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) stopRestore('PRESET_FILE_INVALID');
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([composition, marker, 'preset.yml'].sort())) stopRestore('PRESET_COLLISION');
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await read(join(directory, name))])));
}
function target(paths) {
  if (resolve(paths.presetDir) !== resolve(paths.home, '.agent-presets', 'bc-agent')) stopRestore('PRESET_PATH_INVALID');
  return paths.presetDir;
}
export async function preparePreset(paths) {
  const directory = target(paths);
  // Preserve the installed standard composition and loader tags, adding only BC persona guidance.
  const sourceNames = (await readdir(paths.standardPresetDir)).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify([composition, 'preset.yml'].sort())) stopRestore('STANDARD_PRESET_CHANGED');
  const base = await read(join(paths.standardPresetDir, composition));
  const persona = '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.';
  if (base.split(persona).length !== 2) stopRestore('STANDARD_PRESET_CHANGED');
  const agent = base.replace(persona, `${persona}\n      ${BC_TASK_GUIDANCE}`);
  const files = { [composition]: agent, 'preset.yml': metadata,
    [marker]: JSON.stringify({ version: 1, owner: 'bc-identity-gateway', preset: 'bc-agent', baseSha256: hash(base) }) + '\n' };
  try {
    const existing = await snapshot(directory);
    // Accept the exact previous display metadata without rewriting installed user files.
    const compatible = Object.keys(files).every(name => existing[name] === files[name]
      || (name === 'preset.yml' && [legacyMetadata, previousMetadata, previousAgentMetadata].includes(existing[name])));
    if (!compatible) stopRestore('PRESET_COLLISION');
    return { directory, files: existing, exists: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A partially populated directory is not ours to replace.
  try { await lstat(directory); stopRestore('PRESET_COLLISION'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { directory, files, exists: false };
}
export async function installPreset(paths, plan) {
  if (target(paths) !== plan.directory) stopRestore('PRESET_PATH_INVALID');
  const fresh = await preparePreset(paths);
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) stopRestore('PRESET_CHANGED');
  if (plan.exists) return false;
  await mkdir(dirname(plan.directory), { recursive: true });
  const temporary = join(dirname(plan.directory), `.bc-agent-${randomUUID()}`);
  await mkdir(temporary);
  try {
    for (const [name, value] of Object.entries(plan.files)) await writeFile(join(temporary, name), value, { flag: 'wx', mode: 0o600 });
    try { await lstat(plan.directory); stopRestore('PRESET_COLLISION'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, plan.directory);
  } finally {
    for (const name of Object.keys(plan.files)) await unlink(join(temporary, name)).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
  return true;
}
export async function rollbackPreset(paths, plan) {
  if (target(paths) !== plan.directory) stopRestore('PRESET_PATH_INVALID');
  const actual = await snapshot(plan.directory);
  if (Object.keys(plan.files).some(name => actual[name] !== plan.files[name])) stopRestore('PRESET_CHANGED');
  // Fixed, verified files only: no recursive delete and no user-authored preset overwrite.
  for (const name of Object.keys(plan.files)) await unlink(join(plan.directory, name));
  await rmdir(plan.directory);
}
