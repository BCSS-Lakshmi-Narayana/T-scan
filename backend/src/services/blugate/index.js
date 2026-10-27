/**
 * BluGate — the one way this backend reaches a social platform.
 *
 *   const blugate = require('../services/blugate');
 *   const data = await blugate.x('USER_TWEETS', { user: '44196397', count: 20 });
 *   const feed = await blugate.instagram('POSTS', { username: 'someone' });
 *
 * The caller names a platform and an endpoint key. Everything else — the
 * gateway URL, the tenant's API key and client code, whether the endpoint is a
 * GET with a query string or a POST with a JSON body — is resolved here. No
 * controller or service builds a provider URL or holds a provider credential.
 *
 * The tenant comes from the ambient request scope, so a call made while serving
 * tenant A can only ever spend tenant A's quota. Background work must wrap
 * itself in runWithTenant(), the same requirement it already has for reading
 * any tenant-scoped model.
 */

const { blugateRequest, resolveGatewayBaseUrl } = require('./blugate.http');
const { getPlatform, getEndpoint, PLATFORMS, findEndpointKeyByPath } = require('./blugate.endpoints');
const { getPlatformAuth, isConfigured: isGatewayConfigured, invalidate } = require('./blugate.auth');
const direct = require('./blugate.direct');

/**
 * Call one BluGate endpoint for the tenant in scope.
 *
 * @param {'x'|'instagram'|'facebook'|'youtube'} slug
 * @param {string} endpointKey  a key from blugate.endpoints (e.g. 'USER_TWEETS')
 * @param {object} [params]     query string for GET, JSON body for POST
 * @param {{timeout?: number}} [options]
 * @returns {Promise<any>} the provider's response, passed through by the gateway
 */
const call = async (slug, endpointKey, params = {}, options = {}) => {
  const platform = getPlatform(slug);
  const endpoint = getEndpoint(slug, endpointKey);

  // CONTENT_PROVIDER=rapidapi calls the SAME upstream provider the gateway
  // fronts, one hop shorter and on one environment key. The choice is made here
  // because this function is the only way the backend reaches a platform, so
  // neither transport can be bypassed and no call site needs to know which ran.
  if (direct.isDirect()) {
    return direct.directRequest({
      slug,
      path: endpoint.path,
      method: endpoint.method,
      params,
      timeout: options.timeout || Number(process.env.BLUGATE_TIMEOUT_MS) || 60000,
      label: platform.label,
      endpointKey,
    });
  }

  // Reads the tenant's row; throws a configuration error if it is missing,
  // disabled, or its credentials will not decrypt.
  const { auth, baseUrlOverride } = await getPlatformAuth(slug, platform.label);

  const baseUrl = resolveGatewayBaseUrl(platform.segment, {
    override: baseUrlOverride,
    envKeys: platform.envKeys,
  });

  return blugateRequest({
    // Some gateways nest the provider's own prefix beneath the segment; the
    // endpoint map records that once per platform rather than in every path.
    baseUrl: platform.pathPrefix ? `${baseUrl}${platform.pathPrefix}` : baseUrl,
    path: endpoint.path,
    method: endpoint.method,
    params,
    auth,
    timeout: options.timeout || Number(process.env.BLUGATE_TIMEOUT_MS) || 60000,
    label: platform.label,
    endpointKey,
  });
};

// Per-platform shorthands. These read better at call sites than passing the
// slug as a string, and they make a typo a missing-function error rather than
// an unknown-platform error thrown at runtime.
const x = (endpointKey, params, options) => call('x', endpointKey, params, options);
const instagram = (endpointKey, params, options) => call('instagram', endpointKey, params, options);
const facebook = (endpointKey, params, options) => call('facebook', endpointKey, params, options);
const youtube = (endpointKey, params, options) => call('youtube', endpointKey, params, options);

/**
 * Call an endpoint by its upstream path rather than its key — the form the
 * provider services already use internally. Same auth, same tenant resolution.
 */
const callByPath = (slug, rawPath, params, options) =>
  call(slug, findEndpointKeyByPath(slug, rawPath), params, options);

/**
 * Can this platform be fetched right now? Answers for the ACTIVE transport: in
 * gateway mode the tenant's stored credentials, in direct mode the environment
 * key. monitorService uses this to choose between the API path and the scraper,
 * so a wrong answer here silently changes how content is collected.
 */
const isConfigured = async (slug) =>
  direct.isDirect() ? direct.isDirectConfigured(slug) : isGatewayConfigured(slug);

/** Which transport is live and what it would call. For logs and preflight. */
const transport = () => ({
  mode: direct.mode(),
  platforms: Object.keys(PLATFORMS)
    .map((slug) => direct.describeDirect(slug))
    .filter(Boolean),
});

module.exports = {
  call,
  callByPath,
  findEndpointKeyByPath,
  x,
  instagram,
  facebook,
  youtube,
  // Configuration helpers — used by health checks and by the Super Admin
  // controller after credentials change.
  isConfigured,
  invalidate,
  PLATFORMS,
  // Which transport is live, and what each platform would call under it.
  transport,
};
