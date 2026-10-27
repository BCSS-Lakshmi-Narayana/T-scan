/**
 * Direct transport — the same upstream providers, without the gateway.
 *
 * CONTENT_PROVIDER=blugate (default) routes every platform call through BluGate,
 * which holds the tenant's credentials and meters its quota. CONTENT_PROVIDER
 * =rapidapi routes the identical call straight to the upstream provider with a
 * single environment key, which is what this backend did before the migration.
 *
 * WHY THIS IS SAFE FOR THE PARSERS
 * --------------------------------
 * BluGate returns the provider payload unchanged, so both transports hand the
 * provider services the same shapes. The direct mode deliberately calls the
 * SAME upstream provider the gateway fronts — twitter241, ig-downloader-api,
 * facebook-scraper3 — rather than whatever each platform used historically.
 * Instagram matters here: before BluGate this backend used instagram120, whose
 * payloads differ, so "direct" meaning instagram120 would break every Instagram
 * parser. Direct means the same provider, one hop shorter.
 *
 * YOUTUBE IS NOT RAPIDAPI
 * -----------------------
 * YouTube is Google's own Data API v3, so its direct mode takes an API key as a
 * query parameter rather than RapidAPI headers. Keeping that difference here,
 * declared per platform, is why this module describes auth style instead of
 * assuming one.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * There is no per-tenant metering on this path: one environment key serves every
 * tenant, so one tenant's traffic spends the same quota as another's. That is the
 * trade for not depending on the gateway, and it is why blugate stays the
 * default.
 */

const axios = require('axios');

/**
 * Per-platform direct configuration.
 *
 * `baseUrl` is overridable per platform so a provider change needs no code
 * edit, and `auth` names the scheme rather than implying it.
 */
const DIRECT = {
  // Direct mode calls the SAME upstream provider the gateway fronts, so the
  // parsers see identical payloads either way — the switch changes the route,
  // never the provider.
  x: {
    // `RAPIDAPI_HOST` is the name this .env already uses for X.
    hostEnv: ['RAPIDAPI_X_BASE_URL', 'RAPIDAPI_X_HOST', 'RAPIDAPI_HOST'],
    baseUrl: 'https://twitter241.p.rapidapi.com',
    keyEnv: ['RAPIDAPI_X_KEY', 'RAPIDAPI_KEY'],
    auth: 'rapidapi',
  },
  facebook: {
    hostEnv: ['RAPIDAPI_FACEBOOK_BASE_URL', 'RAPIDAPI_FACEBOOK_HOST'],
    baseUrl: 'https://facebook-scraper3.p.rapidapi.com',
    keyEnv: ['RAPIDAPI_FACEBOOK_KEY', 'RAPIDAPI_KEY'],
    auth: 'rapidapi',
  },

  // Instagram: ig-downloader-api, the same provider the gateway fronts and the
  // one this deployment is subscribed to. instagram120 appears commented out in
  // .env from before the migration — it is a DIFFERENT provider whose response
  // bodies differ, so it must not be used here.
  instagram: {
    hostEnv: ['RAPIDAPI_INSTAGRAM_BASE_URL', 'RAPIDAPI_INSTAGRAM_HOST'],
    baseUrl: 'https://ig-downloader-api.p.rapidapi.com',
    // The plural is the name already in this .env.
    keyEnv: ['RAPIDAPI_INSTAGRAM_KEY', 'RAPIDAPI_INSTAGRAM_KEYS', 'RAPIDAPI_KEY'],
    auth: 'rapidapi',
  },

  // Not RapidAPI at all: Google's own Data API v3, keyed by query parameter.
  youtube: {
    hostEnv: ['YOUTUBE_API_BASE_URL'],
    baseUrl: 'https://www.googleapis.com/youtube/v3',
    keyEnv: ['YOUTUBE_API_KEY'],
    auth: 'google_key',
  },
};

/** First env var in *names* that holds a non-empty value. */
const firstEnv = (names) => {
  for (const name of names || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

/**
 * The base URL for a platform in direct mode.
 *
 * Accepts a bare host ("twitter241.p.rapidapi.com") as well as a full URL,
 * because the existing .env stores hosts without a scheme.
 */
const baseUrlFor = (cfg) => {
  const configured = firstEnv(cfg.hostEnv) || cfg.baseUrl;
  const withScheme = /^https?:\/\//.test(configured) ? configured : `https://${configured}`;
  return withScheme.replace(/\/+$/, '');
};

/** Which transport is configured. Anything but "rapidapi" means the gateway. */
const mode = () =>
  String(process.env.CONTENT_PROVIDER || 'blugate').trim().toLowerCase() === 'rapidapi'
    ? 'rapidapi'
    : 'blugate';

const isDirect = () => mode() === 'rapidapi';

const directConfig = (slug) => DIRECT[slug] || null;

/** The key this platform needs in direct mode, or '' when none is set. */
const directKey = (slug) => {
  const cfg = directConfig(slug);
  return cfg ? firstEnv(cfg.keyEnv) : '';
};

/**
 * Is direct mode usable for this platform? Mirrors blugate.isConfigured so a
 * caller asking "can I fetch X?" gets the right answer under either transport.
 */
const isDirectConfigured = (slug) => Boolean(directConfig(slug) && directKey(slug));

/** Human-readable name of what direct mode would call, for logs and preflight. */
const describeDirect = (slug) => {
  const cfg = directConfig(slug);
  if (!cfg) return null;
  return {
    slug,
    baseUrl: baseUrlFor(cfg),
    auth: cfg.auth,
    keyEnv: (cfg.keyEnv || []).join(' or '),
    configured: isDirectConfigured(slug),
    // True where the provider differs from the gateway's, so its payloads have
    // not been verified against these parsers.
    verifyPayloads: Boolean(cfg.verifyPayloads),
  };
};

/**
 * Call one endpoint directly on its upstream provider.
 *
 * Signature deliberately mirrors blugateRequest so index.js can choose between
 * them without the call site knowing which ran.
 */
const directRequest = async ({
  slug,
  path,
  method = 'GET',
  params = {},
  timeout = 45000,
  label = 'API',
  endpointKey = '',
}) => {
  const cfg = directConfig(slug);
  if (!cfg) {
    const err = new Error(`${label}: no direct provider is configured for "${slug}"`);
    err.status = 500;
    throw err;
  }

  const key = directKey(slug);
  if (!key) {
    const err = new Error(
      `${label}: CONTENT_PROVIDER=rapidapi but no key is set — ` +
      `set one of ${(cfg.keyEnv || []).join(', ')} in the backend .env`
    );
    err.status = 400;
    throw err;
  }

  const baseUrl = baseUrlFor(cfg);
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl}${suffix}`;
  const verb = String(method).toUpperCase();
  const sendsBody = verb !== 'GET' && verb !== 'DELETE' && verb !== 'HEAD';

  const headers = {
    Accept: 'application/json',
    // Same reason as the gateway path: a mismatched Content-Encoding makes axios
    // fail to inflate the body.
    'Accept-Encoding': 'identity',
  };
  let query = sendsBody ? undefined : params;

  if (cfg.auth === 'rapidapi') {
    const host = baseUrl.replace(/^https?:\/\//, '');
    headers['x-rapidapi-key'] = key;
    headers['x-rapidapi-host'] = host;
  } else {
    // Google takes the key as a query parameter, on GET and POST alike.
    query = { ...(query || {}), key };
    if (sendsBody) {
      // Keep the body as the caller built it; the key rides in the query.
      query = { key };
    }
  }

  const response = await axios({
    url,
    method: verb,
    headers,
    params: query,
    data: sendsBody ? params : undefined,
    timeout,
    // Let the caller see a provider error body rather than an axios throw, the
    // same way the gateway path surfaces upstream failures.
    validateStatus: undefined,
    transitional: { silentJSONParsing: true, forcedJSONParsing: true },
  });

  if (response.status >= 400) {
    const err = new Error(
      `${label} ${endpointKey || suffix}: provider returned ${response.status}`
    );
    err.status = response.status;
    err.body = response.data;
    throw err;
  }
  return response.data;
};

module.exports = {
  mode,
  isDirect,
  directRequest,
  isDirectConfigured,
  describeDirect,
  directConfig,
  DIRECT,
};
