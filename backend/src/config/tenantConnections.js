/**
 * Per-tenant database connections.
 *
 * Every tenant gets its own database on the same cluster. `useDb` reuses the
 * process's existing connection pool, so N tenants cost N logical databases and
 * one set of sockets — a separate createConnection per tenant would multiply the
 * pool by the tenant count.
 *
 * TENANT_DB_MODE controls the switchover:
 *   shared      → every tenant reads the database this process connected to.
 *                 Today's behaviour; the tenant_id filters do the isolating.
 *   per-tenant  → each tenant reads its own database.
 *
 * Keeping both modes behind one flag means the routing can be deployed, watched
 * and rolled back without another release, and the migration can be verified
 * against a running system before anything depends on it.
 */
const mongoose = require('mongoose');
const tenantSchemas = require('./tenantSchemas');

const MODE = String(process.env.TENANT_DB_MODE || 'shared').trim().toLowerCase();
const PREFIX = String(process.env.TENANT_DB_PREFIX || 'saga_tenant_').trim();

const isPerTenant = () => MODE === 'per-tenant';

// Mongo rejects / \ . " $ * < > : | ? in database names and caps them at 63 bytes.
const sanitize = (value) => String(value || '').replace(/[/\\. "$*<>:|?]/g, '_').slice(0, 63);

/**
 * Which database a tenant's data lives in. An explicit db_name on the tenant
 * record always wins, so a tenant can be moved without a code change; otherwise
 * it is derived from the slug, which is already unique and URL-safe.
 */
const dbNameFor = (tenant) => {
  if (!tenant) return null;
  if (tenant.db_name) return sanitize(tenant.db_name);
  const key = tenant.slug || tenant.id;
  if (!key) return null;
  return sanitize(`${PREFIX}${key}`);
};

const cache = new Map(); // dbName -> connection

/**
 * The connection a tenant's models should be compiled on. In shared mode this is
 * always the default connection, which is what makes the flag a no-op until it
 * is flipped.
 */
const forTenant = (tenant) => {
  if (!isPerTenant()) return mongoose.connection;

  const dbName = dbNameFor(tenant);
  if (!dbName) throw new Error('[tenantConnections] cannot resolve a database name for the tenant');

  const cached = cache.get(dbName);
  if (cached) return cached;

  // useCache keeps one logical connection per database on the shared pool.
  const connection = mongoose.connection.useDb(dbName, { useCache: true });
  tenantSchemas.compileAll(connection);
  cache.set(dbName, connection);
  console.log(`[tenantConnections] opened "${dbName}" (${tenantSchemas.size()} models)`);
  return connection;
};

/** Open a database by name without a tenant record — provisioning and migrations. */
const forDbName = (dbName) => {
  const name = sanitize(dbName);
  if (!name) throw new Error('[tenantConnections] a database name is required');
  const cached = cache.get(name);
  if (cached) return cached;
  const connection = mongoose.connection.useDb(name, { useCache: true });
  tenantSchemas.compileAll(connection);
  cache.set(name, connection);
  return connection;
};

/**
 * Forget a tenant database, so the next forTenant() opens it fresh.
 *
 * Required after dropDatabase(): the cached handle would otherwise outlive the
 * database it points at, and a tenant re-created with the same slug would be
 * served a connection whose model registry was built against storage that no
 * longer exists.
 *
 * Two caches have to be cleared, not one. This module's Map is checked first,
 * but Mongoose keeps its own — useDb({ useCache: true }) stores the derived
 * connection in `relatedDbs`, so clearing only the local Map would still hand
 * back the same stale object. removeDb() is Mongoose's supported way to drop
 * both `relatedDbs` and `otherDbs`; it throws when the name is unknown, which
 * is an ordinary outcome here (nothing ever opened that tenant in this
 * process), so the throw is swallowed rather than reported.
 */
const evict = (dbName) => {
  const name = sanitize(dbName);
  if (!name) return false;
  const had = cache.delete(name);
  try {
    mongoose.connection.removeDb(name);
  } catch (_) {
    // No connection to that database in this process — nothing to release.
  }
  if (had) console.log(`[tenantConnections] evicted "${name}"`);
  return had;
};

/** evict() by tenant record rather than database name. */
const evictTenant = (tenant) => {
  const dbName = dbNameFor(tenant);
  return dbName ? evict(dbName) : false;
};

const stats = () => ({ mode: MODE, prefix: PREFIX, open: cache.size, databases: Array.from(cache.keys()) });

module.exports = { forTenant, forDbName, dbNameFor, isPerTenant, sanitize, evict, evictTenant, stats, MODE };
