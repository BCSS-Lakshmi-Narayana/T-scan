/**
 * The tenant a piece of work belongs to, carried implicitly.
 *
 * Controllers and services call models directly (`Alert.find(...)`) in ~230
 * places in this backend alone. Rather than thread a connection through every
 * one of those signatures, the tenant is held in AsyncLocalStorage: the request
 * middleware enters a context, and every async continuation underneath it — a
 * controller, a service it calls, a promise chain three levels down — can ask
 * which tenant it is running for.
 *
 * Work that has no request behind it (schedulers, queue consumers, scripts) has
 * no context of its own and MUST wrap itself in runWithTenant. Model access
 * outside a context fails loudly in per-tenant mode rather than quietly reading
 * the wrong database.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `context` ({ tenant, tenantId, connection }) in scope.
 * Everything awaited inside inherits it.
 */
const runWithTenant = (context, fn) => storage.run(context, fn);

/**
 * Enter `context` for the rest of the current execution, without wrapping a
 * callback. runWithTenant is the safer form and should be preferred; this exists
 * for the one shape it cannot express — a helper that resolves a tenant partway
 * through a request handler and needs everything *after* it to run in that
 * tenant's scope (see actAsTenant in superAdminController). Wrapping there would
 * mean re-indenting every handler around a callback.
 *
 * Scope ends with the async execution that called it, so a request that enters
 * here cannot leak its tenant into the next request.
 */
const enterTenant = (context) => storage.enterWith(context);

const getTenantContext = () => storage.getStore() || null;

const getTenantId = () => getTenantContext()?.tenantId || null;

/** The connection for the tenant in scope, or null when there is none. */
const getConnection = () => getTenantContext()?.connection || null;

/**
 * Run `fn` for each tenant in turn, each inside its own context. Used by the
 * schedulers, which are the main source of tenant-less work.
 */
const forEachTenant = async (tenants, fn) => {
  const results = [];
  for (const entry of tenants) {
    const context = typeof entry.connection === 'undefined'
      ? { tenant: entry, tenantId: entry.id, connection: require('./tenantConnections').forTenant(entry) }
      : entry;
    try {
      results.push({ tenantId: context.tenantId, value: await runWithTenant(context, () => fn(context.tenant)) });
    } catch (error) {
      // One tenant's failure must not stop the sweep for the others.
      console.error(`[tenantContext] ${context.tenantId}: ${error.message}`);
      results.push({ tenantId: context.tenantId, error: error.message });
    }
  }
  return results;
};

module.exports = { runWithTenant, enterTenant, getTenantContext, getTenantId, getConnection, forEachTenant, storage };
