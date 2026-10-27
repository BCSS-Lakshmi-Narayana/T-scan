/**
 * The single outbound path to BluGate.
 *
 * Every social-media call in this backend goes through here. No module builds a
 * provider URL or holds a provider key of its own — the per-platform clients
 * under this directory name an endpoint, and this file turns that into a signed
 * request. That is what keeps provider details out of controllers and services.
 *
 *   Authorization: Bearer <tenant's BluGate API key>
 *   x-client-id:   <tenant's BluGate client code>
 *
 * BluGate holds the upstream RapidAPI credentials, meters each tenant's usage,
 * and returns the provider's response unchanged.
 */

const axios = require('axios');

/** Add a scheme if one was omitted, and drop any trailing slash. */
const normalizeBaseUrl = (raw) => {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
};

/**
 * Where a platform's gateway lives.
 *
 * Resolution order, most specific first:
 *   1. the tenant's own Platform.base_url  — per-tenant override
 *   2. BLUGATE_<PLATFORM>_HOST             — per-platform deployment
 *   3. BLUGATE_BASE_URL + /api/gateway/<segment>
 *
 * There is no hardcoded default. An unconfigured gateway raises a clear error
 * instead of silently reaching for someone else's host.
 *
 * Callers may pass a root, a `/api/gateway` root, or an already-complete
 * `/api/gateway/<segment>` URL; all three normalize to the same base, so an
 * admin pasting any form of the URL from the BluGate docs gets a working value.
 */
const resolveGatewayBaseUrl = (segment, { override = '', envKeys = [] } = {}) => {
  const fromOverride = normalizeBaseUrl(override);
  if (fromOverride) return withSegment(fromOverride, segment);

  for (const key of envKeys) {
    const fromEnv = normalizeBaseUrl(process.env[key]);
    if (fromEnv) return withSegment(fromEnv, segment);
  }

  const root = normalizeBaseUrl(process.env.BLUGATE_BASE_URL);
  return root ? withSegment(root, segment) : '';
};

/** Append /api/gateway/<segment> unless the URL already carries it. */
const withSegment = (url, segment) => {
  if (new RegExp(`/api/gateway/${segment}(/|$)`, 'i').test(url)) return url.replace(/\/+$/, '');
  if (/\/api\/gateway$/i.test(url)) return `${url}/${segment}`;
  return `${url}/api/gateway/${segment}`;
};

/**
 * Turn a gateway failure into an error that names the platform, the endpoint and
 * what the gateway actually said. The raw axios error says only "Request failed
 * with status code 400", which is useless when four gateways and dozens of
 * endpoints can produce it.
 */
const formatGatewayError = (err, label, endpointKey) => {
  const status = err.response?.status;
  const data = err.response?.data;

  // The gateway is inconsistent about where the reason lives, and some of those
  // fields hold an object rather than a string — taking them as-is produced
  // "[object Object]", which tells the operator nothing. Coerce each candidate
  // and fall back to the serialised body.
  const asText = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    // A nested { message } / { error } is the common shape.
    if (typeof v === 'object') {
      const inner = v.message || v.error || v.detail || v.reason;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
      try { return JSON.stringify(v); } catch (_) { return ''; }
    }
    return '';
  };

  let detail;
  if (typeof data === 'string') {
    detail = data.slice(0, 300);
  } else if (data && typeof data === 'object') {
    detail = (asText(data.message) || asText(data.error) || asText(data.detail)
      || asText(data.reason) || (() => { try { return JSON.stringify(data); } catch (_) { return ''; } })()
    ).slice(0, 300);
  }
  if (!detail) detail = err.message;

  // Raised when the gateway sends a compressed body the client did not ask for.
  // The message is otherwise cryptic, so name the real cause.
  if (/incorrect header check/i.test(String(err.message || ''))) {
    detail = 'gateway returned a compressed body that could not be decoded';
  }

  const wrapped = new Error(
    status
      ? `BluGate ${label} ${endpointKey} failed (HTTP ${status}): ${detail}`
      : `BluGate ${label} ${endpointKey} failed: ${detail}`
  );
  wrapped.status = status || 502;
  wrapped.code = err.code;
  wrapped.response = err.response;
  // Quota and throttling are worth distinguishing from ordinary failures so
  // callers can back off instead of retrying straight into the same wall.
  wrapped.isRateLimited = status === 429;
  wrapped.isAuthFailure = status === 401 || status === 403;
  return wrapped;
};

/**
 * Issue one request to BluGate.
 *
 * @param {object}  opts
 * @param {string}  opts.baseUrl      resolved gateway base
 * @param {string}  opts.path         endpoint path, e.g. '/user-tweets'
 * @param {string}  [opts.method]     defaults to GET
 * @param {object}  [opts.params]     query string for GET/DELETE, JSON body otherwise
 * @param {{accessKey: string, clientId: string}} opts.auth  the tenant's credentials
 * @param {number}  [opts.timeout]
 * @param {string}  [opts.label]      platform name, for error messages
 * @param {string}  [opts.endpointKey]
 */
const blugateRequest = async ({
  baseUrl,
  path,
  method = 'GET',
  params = {},
  auth,
  timeout = 45000,
  label = 'API',
  endpointKey = '',
}) => {
  const accessKey = String(auth?.accessKey || '').trim();
  const clientId = String(auth?.clientId || '').trim();

  if (!accessKey || !clientId) {
    const err = new Error(
      `BluGate ${label}: this tenant has no API key / client code configured — add them in Super Admin → Platforms`
    );
    err.status = 400;
    throw err;
  }
  if (!baseUrl) {
    const err = new Error(
      `BluGate ${label}: gateway URL is not configured (set BLUGATE_BASE_URL, or a per-tenant base URL)`
    );
    err.status = 500;
    throw err;
  }

  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl.replace(/\/+$/, '')}${suffix}`;
  const verb = String(method).toUpperCase();
  // GET and DELETE carry their arguments in the query string; everything else
  // sends JSON. Instagram's gateway is POST-with-body, X/Facebook/YouTube are GET.
  const sendsBody = verb !== 'GET' && verb !== 'DELETE' && verb !== 'HEAD';

  const headers = {
    Authorization: `Bearer ${accessKey}`,
    'x-client-id': clientId,
    Accept: 'application/json',
    // The gateway can return a body whose Content-Encoding does not match the
    // bytes, which makes axios fail to inflate it ("incorrect header check").
    // Asking for identity and decoding the text ourselves sidesteps it.
    'Accept-Encoding': 'identity',
  };
  if (sendsBody) headers['Content-Type'] = 'application/json';

  try {
    const response = await axios({
      method: verb,
      url,
      params: sendsBody ? undefined : params,
      data: sendsBody ? params : undefined,
      headers,
      timeout,
      decompress: false,
      responseType: 'text',
      transformResponse: [
        (raw) => {
          if (raw == null || raw === '') return raw;
          if (typeof raw === 'object') return raw;
          try { return JSON.parse(raw); } catch (_) { return raw; }
        },
      ],
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return response.data;
  } catch (err) {
    throw formatGatewayError(err, label, endpointKey || verb);
  }
};

module.exports = {
  normalizeBaseUrl,
  resolveGatewayBaseUrl,
  blugateRequest,
};
