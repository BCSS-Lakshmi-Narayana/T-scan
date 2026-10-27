/**
 * Registry of every schema that holds tenant-scoped data.
 *
 * Models are no longer compiled once on a single global connection — each tenant
 * has its own database, so each schema has to be compiled once *per tenant
 * connection*. Model files register themselves here (via models/tenantModel.js)
 * and the connection factory compiles the whole set the first time it opens a
 * tenant's database.
 *
 * Compiling the whole set eagerly, rather than on first use, is deliberate:
 * populate() resolves a ref through the connection's own model registry, so a
 * connection that only knows about Alert cannot populate a ref to User.
 */
const schemas = new Map();

/** Called by tenantModel() as each model file is required. */
const register = (name, schema) => {
  if (schemas.has(name) && schemas.get(name) !== schema) {
    throw new Error(`[tenantSchemas] two different schemas registered as "${name}"`);
  }
  schemas.set(name, schema);
  return schema;
};

/** Compile every registered schema onto a connection. Idempotent. */
const compileAll = (connection) => {
  for (const [name, schema] of schemas) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  return connection;
};

/**
 * How many models are provisioned at once.
 *
 * The work here is almost entirely waiting on the cluster, not computing: each
 * model costs a createCollection plus a syncIndexes, and against a remote Atlas
 * cluster that measured ~210ms per model at 35ms round-trip latency. Done one
 * after another, ~55 models is ~18 SECONDS of an onboarding request spent idle
 * on the network — which is what made creating a tenant feel like it had hung.
 * Overlapping them turns that into ~2s.
 *
 * The limit is deliberately modest rather than unbounded: shared-tier clusters
 * cap concurrent connections, and firing every model at once risks trading a
 * slow provision for a failed one. 8 captures nearly all of the speed-up while
 * staying well inside the default pool.
 */
const PROVISION_CONCURRENCY = Math.max(1, Number(process.env.TENANT_PROVISION_CONCURRENCY) || 8);

/**
 * A cluster that has run out of collections will fail EVERY remaining model for
 * the same reason. Grinding through all of them to discover that ~55 times costs
 * a minute and tells the operator nothing the first failure did not — so this
 * one error stops the run immediately.
 *
 * Atlas shared tiers (M0/M2/M5) cap a cluster at 500 collections in total. At
 * ~55 collections per tenant that is roughly nine tenants, after which
 * onboarding cannot succeed until the tier is raised, unused tenants are
 * removed, or TENANT_DB_MODE goes back to "shared".
 */
const isCapacityError = (message) => /already using \d+ collections|exceeded the limit|quota exceeded/i.test(message || '');

/** Build every collection and index on a connection — used when provisioning. */
const syncAllIndexes = async (connection) => {
  compileAll(connection);
  const names = Array.from(schemas.keys());
  const results = [];

  // One shared cursor over the model list, drained by N workers. An ordinary
  // failure is recorded and the worker moves on, so an incomplete database is
  // still fully reported rather than abandoned at the first bad model —
  // provisionTenantDatabase counts the failures and decides whether to roll the
  // tenant back. A capacity failure is different in kind and stops everything.
  let cursor = 0;
  let capacityError = null;

  const worker = async () => {
    while (cursor < names.length && !capacityError) {
      const name = names[cursor++];
      try {
        await connection.models[name].createCollection().catch((err) => {
          // createCollection legitimately fails when the collection is already
          // there; every other reason matters and must not be swallowed.
          if (isCapacityError(err.message)) throw err;
        });
        await connection.models[name].syncIndexes();
        results.push({ model: name, ok: true });
      } catch (err) {
        results.push({ model: name, ok: false, error: err.message });
        if (isCapacityError(err.message)) capacityError = err.message;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PROVISION_CONCURRENCY, names.length) }, worker)
  );

  // Everything the run never reached, so the caller's "N of M failed" count
  // reflects the whole registry rather than just the models that got a turn.
  if (capacityError) {
    for (const name of names.slice(cursor)) {
      results.push({ model: name, ok: false, error: 'skipped — cluster is out of collections' });
    }
  }

  results.capacityError = capacityError;
  return results;
};

const names = () => Array.from(schemas.keys());
const size = () => schemas.size;
const get = (name) => schemas.get(name);

module.exports = { register, compileAll, syncAllIndexes, names, size, get };
