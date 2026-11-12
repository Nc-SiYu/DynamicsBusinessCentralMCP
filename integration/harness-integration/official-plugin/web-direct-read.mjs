/** Optional Web profile entry; activation reads an existing binding through its private pipe. */
import { isAbsolute, dirname, basename, join } from 'node:path';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { bindingOperation } from '../../gateway/mcp/local-binding.mjs';
import { createDirectReadBindings, createDirectReadPlugin, MAX_READ_TIMEOUT_MS, CAPABILITY_MODE, TOOL_NAMES } from './direct-read.mjs';
import { createGatewayReadTransport, connectionIdValid, exactFields, failRead } from './gateway-read-transport.mjs';

export const name = 'bc-gateway-web-direct-mcp';
export const inject = Object.freeze(['tools', 'agents', 'agentPresets']);
export const BC_PRESET = 'bc-agent';

/** Non-secret acknowledgment, written only after registration/binding load succeeds. */
export function publishActivation(config, pid = process.pid, registrations) {
  if (!config.activationFile) return;
  const temporary = join(dirname(config.activationFile), `.direct-read-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ status: 'ready', capabilityMode: CAPABILITY_MODE, revision: config.bindingRevision,
      pid, agentPreset: BC_PRESET, ...(registrations === undefined ? {} : { registrations }) }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, config.activationFile);
  } finally { try { unlinkSync(temporary); } catch { /* No diagnostic content is exported. */ } }
}

/** Host seam for offline tests and trusted composition; never supplied by a model. */
export function createWebDirectReadPlugin(options) {
  if (!exactFields(options, ['agentPreset', 'loadBinding', 'capabilityMode'], ['fetchImpl', 'requestTimeoutMs'])
      || options.capabilityMode !== CAPABILITY_MODE
      || options.agentPreset !== BC_PRESET
      || typeof options.loadBinding !== 'function'
      || (Object.hasOwn(options, 'fetchImpl') && typeof options.fetchImpl !== 'function')
      || (Object.hasOwn(options, 'requestTimeoutMs') && (!Number.isSafeInteger(options.requestTimeoutMs)
        || options.requestTimeoutMs < 1 || options.requestTimeoutMs > MAX_READ_TIMEOUT_MS))) failRead('BAD_REQUEST');
  return { name, inject, async apply(ctx) {
    if (typeof ctx.agents?.get !== 'function' || typeof ctx.agents?.list !== 'function'
        || typeof ctx.agentPresets?.composedPreset !== 'function') failRead('BAD_REQUEST');
    let saved;
    try { saved = options.loadBinding(); } catch { failRead('UNAUTHENTICATED'); }
    if (!exactFields(saved, ['gatewayOrigin', 'connectionId', 'gatewayToken'])
        || !connectionIdValid(saved.connectionId)) failRead('UNAUTHENTICATED');
    const request = createGatewayReadTransport({ gatewayOrigin: saved.gatewayOrigin, accessToken: saved.gatewayToken,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const connectionId = saved.connectionId;
    const cleanup = new Map(); const pending = new Set();
    const authorized = agent => ctx.agents.get(agent.id) === agent
      && ctx.agentPresets.composedPreset(agent.ctx) === BC_PRESET;
    const unbind = agent => {
      const entry = cleanup.get(agent); if (!entry) return;
      cleanup.delete(agent);
      // Abort synchronously, then drain registrations and any in-flight transport.
      const stopping = Promise.allSettled([entry.bindings.dispose(), entry.fiber.dispose()]);
      pending.add(stopping); void stopping.finally(() => pending.delete(stopping));
    };
    const bind = agent => {
      if (!agent) return;
      if (!authorized(agent)) { unbind(agent); return; }
      if (cleanup.has(agent)) return;
      // Inherit the live Agent's context, including its host-owned scope identity.
      // Never mix tsx source scope symbols with a separately imported lib module.
      if (typeof agent.ctx?.plugin !== 'function') failRead('FORBIDDEN');
      let fiber;
      const bindings = createDirectReadBindings();
      try {
        bindings.bind(agent, { connectionId, request: value => {
          if (!authorized(agent)) failRead('UNAUTHENTICATED');
          return request(value);
        }, ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}) });
        fiber = agent.ctx.plugin(createDirectReadPlugin(bindings));
        cleanup.set(agent, { fiber, bindings });
      } catch (error) { void bindings.dispose(); void fiber?.dispose(); throw error; }
    };
    ctx.on('agent/created', ({ agent }) => bind(agent));
    ctx.on('agent/disposed', ({ agent }) => unbind(agent));
    // Official blank-chat preset selection commits before this durable event.
    ctx.on('session/event', (session, event) => {
      if (event.type === 'agent-preset/selected') bind(ctx.agents.get(session.id));
    });
    try { for (const agent of ctx.agents.list()) bind(agent); }
    catch (error) { for (const agent of cleanup.keys()) unbind(agent); throw error; }
    try { await Promise.all([...cleanup.values()].map(entry => entry.fiber)); }
    catch (error) { for (const agent of cleanup.keys()) unbind(agent); await Promise.allSettled(pending); throw error; }
    return async () => { for (const agent of cleanup.keys()) unbind(agent); await Promise.allSettled(pending); };
  } };
}

/** No automatic profile edits, token refresh, BC requests or model selection. */
export async function apply(ctx, config) {
  if (!exactFields(config, ['bindingFile', 'python', 'agentPreset', 'presetFile', 'capabilityMode'], ['requestTimeoutMs', 'bindingRevision', 'activationFile'])
      || config.capabilityMode !== CAPABILITY_MODE
      || config.agentPreset !== BC_PRESET || typeof config.presetFile !== 'string' || !isAbsolute(config.presetFile)
      || typeof config.bindingFile !== 'string' || !isAbsolute(config.bindingFile)
      || typeof config.python !== 'string' || !isAbsolute(config.python)
      || (config.bindingRevision !== undefined && !connectionIdValid(config.bindingRevision))
      || (config.activationFile !== undefined && (typeof config.activationFile !== 'string'
        || !isAbsolute(config.activationFile) || !config.bindingRevision
        || dirname(config.activationFile) !== dirname(config.bindingFile)
        || basename(config.activationFile) !== 'direct-read-activation.json'))) failRead('BAD_REQUEST');
  const preset = await ctx.agentPresets.resolve(BC_PRESET);
  if (preset.broken || preset.path !== config.presetFile) failRead('BAD_REQUEST');
  const dispose = await createWebDirectReadPlugin({ agentPreset: BC_PRESET, capabilityMode: config.capabilityMode,
    loadBinding: () => bindingOperation('load', config.bindingFile, undefined, config.python),
    ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  }).apply(ctx);
  try {
    // Read the running host's actual model-facing catalog; no model/BC call or transcript read.
    const registrations = ctx.agents.list().filter(agent => ctx.agentPresets.composedPreset(agent.ctx) === BC_PRESET).map(agent => {
      const toolNames = ctx.tools.schemas(agent).map(tool => tool.name).sort();
      if (Object.values(TOOL_NAMES).some(name => !toolNames.includes(name))) failRead('FORBIDDEN');
      return { sessionId: agent.id, agentPreset: BC_PRESET, toolNames };
    });
    publishActivation(config, process.pid, registrations);
  }
  catch { void dispose(); failRead('BAD_REQUEST'); }
  return dispose;
}
