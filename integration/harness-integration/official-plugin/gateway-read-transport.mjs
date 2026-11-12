/** Bounded HTTP transport for native_actions_contract.json; no I/O on import. */
export const READ_ROUTES = Object.freeze({
  search: '/api/actions/search', describe: '/api/actions/describe', execute: '/api/actions/execute',
  tools: '/api/mcp/tools', call: '/api/mcp/call',
});
// Allow the bounded 1 MiB native result plus the HTTP envelope; never clip content.
export const READ_LIMITS = Object.freeze({ requestBytes: 16384, parametersBytes: 8192, responseBytes: 2097152 });
const MESSAGES = Object.freeze({
  BAD_REQUEST: 'Unsupported BC MCP input or host configuration.',
  INVALID_REQUEST: 'The Gateway rejected the request format.',
  INVALID_PARAMETERS: 'The Gateway rejected the bounded JSON arguments or connection overrides.',
  INVALID_JSON: 'The Gateway rejected the JSON request.',
  BODY_TOO_LARGE: 'The Gateway request exceeded its size limit.',
  UNAUTHENTICATED: 'An authenticated Gateway binding is required.',
  FORBIDDEN: 'This Agent or connection is not authorized.',
  TOKEN_REQUIRED: 'An authenticated Gateway binding is required.',
  TOKEN_INVALID: 'The Gateway binding is no longer valid.',
  CONNECTION_NOT_FOUND: 'The bound Gateway connection is no longer available.',
  ACTION_NOT_READ_ONLY: 'The Gateway has not approved this operation as read-only.',
  SCHEMA_UNSUPPORTED: 'The Gateway cannot safely validate this operation schema.',
  HOST_REJECTED: 'The Gateway rejected the request host.',
  ORIGIN_REJECTED: 'The Gateway rejected the request origin.',
  BROWSER_AUTH_REQUIRED: 'The Gateway requires an authenticated connection.',
  INTERNAL_ERROR: 'The Gateway could not complete the request.',
  DESCRIBE_REQUIRED: 'Describe this operation before calling it.',
  TOOL_NOT_AVAILABLE: 'The native tool is not available in this BC session.',
  BUSY: 'A Gateway operation is already active.',
  BC_REJECTED: 'Business Central rejected the request. No retry was made.',
  BC_UNAVAILABLE: 'Gateway communication failed; remote completion is unconfirmed.',
  RESPONSE_INVALID: 'The Gateway returned an unsupported response.',
  IDENTITY_MISMATCH: 'The response does not match the bound connection.',
  TIMEOUT: 'The request timed out; remote completion is unconfirmed. No retry was made. Verify BC state before repeating a potentially mutating operation.',
  REQUEST_ABORTED: 'The request was aborted; remote completion is unconfirmed. No retry was made.',
});
export class GatewayReadError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'BC_UNAVAILABLE';
    super(MESSAGES[safe]); this.name = 'GatewayReadError'; this.code = safe;
  }
}
export const failRead = code => { throw new GatewayReadError(code); };
export const plainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const exactFields = (value, required, optional = []) => plainObject(value)
  && required.every(key => Object.hasOwn(value, key))
  && Reflect.ownKeys(value).every(key => [...required, ...optional].includes(key));
export const connectionIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const boundedString = (value, min, max) => typeof value === 'string'
  && value.length >= min && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
export const actionNameValid = value => boundedString(value, 1, 256) && !/[\u0000-\u001f]/.test(value);

/** Snapshot JSON without invoking accessors; reject cycles, lossy values and oversized trees. */
export function snapshotJson(value, code = 'BAD_REQUEST', maxBytes = READ_LIMITS.responseBytes) {
  const seen = new Set(); let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 65536 || depth > 32) failRead(code);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { if (item.length > maxBytes) failRead(code); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) failRead(code); return item; }
    if ((!plainObject(item) && !Array.isArray(item)) || seen.has(item)) failRead(code);
    seen.add(item);
    const array = Array.isArray(item); const result = array ? [] : {};
    const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) failRead(code);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failRead(code);
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true,
        writable: true, configurable: true });
    }
    seen.delete(item); return result;
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes) failRead(code);
  return result;
}

export function validateReadArguments(kind, input) {
  const args = snapshotJson(input, 'BAD_REQUEST', READ_LIMITS.requestBytes);
  if (kind === 'search') {
    if (!exactFields(args, ['searchText'], ['top', 'searchMode', 'actionTypes']) || !actionNameValid(args.searchText) || !args.searchText.trim()
        || (Object.hasOwn(args, 'top') && (!Number.isInteger(args.top) || args.top < 1 || args.top > 50))) failRead('BAD_REQUEST');
    if (Object.hasOwn(args, 'searchMode') && (!actionNameValid(args.searchMode) || args.searchMode.length > 32)) failRead('BAD_REQUEST');
    if (Object.hasOwn(args, 'actionTypes') && (!Array.isArray(args.actionTypes) || args.actionTypes.length > 32
        || args.actionTypes.some(value => !actionNameValid(value) || value.length > 64))) failRead('BAD_REQUEST');
  } else if (kind === 'describe') {
    if (!exactFields(args, ['actionName']) || !actionNameValid(args.actionName)) failRead('BAD_REQUEST');
  } else if (kind === 'execute') {
    if (!exactFields(args, ['actionName', 'parameters']) || !actionNameValid(args.actionName) || !plainObject(args.parameters)) failRead('BAD_REQUEST');
    validateNativeArguments(args.parameters);
  } else if (kind === 'tools') {
    if (!exactFields(args, [])) failRead('BAD_REQUEST');
  } else if (kind === 'call') {
    if (!exactFields(args, ['toolName', 'arguments']) || !actionNameValid(args.toolName)) failRead('BAD_REQUEST');
    validateNativeArguments(args.arguments);
    if (args.toolName === 'bc_actions_invoke') {
      let parameters;
      try { parameters = JSON.parse(args.arguments.RequestParameters); } catch { failRead('BAD_REQUEST'); }
      if (typeof args.arguments.RequestParameters !== 'string') failRead('BAD_REQUEST');
      validateNativeArguments(parameters);
    }
  } else failRead('BAD_REQUEST');
  return args;
}

const CONNECTION_FIELDS = new Set(['company', 'tenant', 'tenantid', 'environment', 'environmentname',
  'configurationname', 'authorization', 'cookie', 'headers', 'bcmcpurl', 'webservicekey', 'gatewaytoken', 'connectionid']);
function validateNativeArguments(value) {
  if (!plainObject(value) || Object.keys(value).some(key => CONNECTION_FIELDS.has(key.toLowerCase()))) failRead('BAD_REQUEST');
  snapshotJson(value, 'BAD_REQUEST', READ_LIMITS.parametersBytes);
}

const ERROR_STATUS = Object.freeze({ INVALID_REQUEST: 400, INVALID_PARAMETERS: 400, INVALID_JSON: 400, BODY_TOO_LARGE: 413,
  TOKEN_REQUIRED: 401, TOKEN_INVALID: 401, ACTION_NOT_READ_ONLY: 403, CONNECTION_NOT_FOUND: 403,
  HOST_REJECTED: 403, ORIGIN_REJECTED: 403, BROWSER_AUTH_REQUIRED: 403, INTERNAL_ERROR: 500,
  BUSY: 409, TOOL_NOT_AVAILABLE: 404, SCHEMA_UNSUPPORTED: 422, BC_REJECTED: 502, BC_UNAVAILABLE: 502, TIMEOUT: 504 });

export function createGatewayReadTransport(options) {
  if (!exactFields(options, ['gatewayOrigin', 'accessToken'], ['fetchImpl'])) failRead('BAD_REQUEST');
  let origin;
  try { origin = new URL(options.gatewayOrigin); } catch { failRead('BAD_REQUEST'); }
  if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) failRead('BAD_REQUEST');
  const token = options.accessToken;
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(token)) failRead('BAD_REQUEST');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') failRead('BAD_REQUEST');
  return async request => {
    if (!exactFields(request, ['method', 'path', 'body', 'signal']) || request.method !== 'POST'
        || !(request.signal instanceof AbortSignal)) failRead('BAD_REQUEST');
    const kind = Object.keys(READ_ROUTES).find(key => READ_ROUTES[key] === request.path);
    if (!kind || !plainObject(request.body) || !connectionIdValid(request.body.connectionId)) failRead('BAD_REQUEST');
    const { connectionId, ...args } = snapshotJson(request.body, 'BAD_REQUEST', READ_LIMITS.requestBytes);
    validateReadArguments(kind, args);
    if (request.signal.aborted) failRead('REQUEST_ABORTED');
    const url = new URL(request.path, origin).href;
    let response; let reader;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, ...args }), signal: request.signal });
      if (request.signal.aborted) failRead('REQUEST_ABORTED');
      if (response.redirected || (response.url && response.url !== url)) failRead('RESPONSE_INVALID');
      if (response.status !== 200 && !Object.values(ERROR_STATUS).includes(response.status)) failRead('BC_UNAVAILABLE');
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
          || !response.body?.getReader) failRead('RESPONSE_INVALID');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > READ_LIMITS.responseBytes)) failRead('RESPONSE_INVALID');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (request.signal.aborted) failRead('REQUEST_ABORTED');
        if (done) break;
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > READ_LIMITS.responseBytes) failRead('RESPONSE_INVALID');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failRead('RESPONSE_INVALID'); }
      data = snapshotJson(data, 'RESPONSE_INVALID');
      if (response.status === 200 && data?.status !== 'succeeded') failRead('RESPONSE_INVALID');
      if (response.status !== 200) {
        if (!exactFields(data, ['status', 'source', 'error'], ['result', 'bc']) || data.status !== 'failed' || data.source !== 'bc-native-mcp'
            || !exactFields(data.error, ['code', 'message']) || typeof data.error.message !== 'string' || !Object.hasOwn(ERROR_STATUS, data.error.code)
            || ERROR_STATUS[data.error.code] !== response.status) failRead('RESPONSE_INVALID');
        // Fixed host failures never export server text. Native BC errors retain their
        // sanitized protocol details/result for the plugin's scoped failure projection.
        if (data.error.code !== 'BC_REJECTED') failRead(data.error.code);
        data.error.message = MESSAGES.BC_REJECTED;
      }
      const serialized = JSON.stringify(data);
      if (serialized.includes(token) || serialized.includes(origin.origin)) failRead('RESPONSE_INVALID');
      return data;
    } catch (error) {
      if (request.signal.aborted) failRead('REQUEST_ABORTED');
      throw new GatewayReadError(error instanceof GatewayReadError ? error.code : 'BC_UNAVAILABLE');
    } finally {
      try { if (reader) { await reader.cancel(); reader.releaseLock(); }
        else if (response?.body) await response.body.cancel(); } catch { /* Stream diagnostics stay private. */ }
    }
  };
}
