/**
 * Provisioning a new tenant's database.
 *
 * MongoDB has no "create database" step — a database exists once something is
 * written to it. So provisioning is really: open the tenant's database, build
 * every collection and index the app expects, and record that it was done. Doing
 * it up front (rather than letting collections appear on first write) means the
 * first request into a brand-new tenant is not the one paying for index builds,
 * and a tenant with no traffic yet still shows up in backups and monitoring.
 *
 * Safe to re-run: creating an existing collection is ignored and syncIndexes is
 * idempotent.
 */
const Tenant = require('../models/Tenant');
const tenantSchemas = require('../config/tenantSchemas');
const { forTenant, dbNameFor, isPerTenant } = require('../config/tenantConnections');

/**
 * @param {object} tenant  the tenant document (needs at least slug or id)
 * @param {object} [opts]
 * @param {boolean} [opts.force]  re-run even if already provisioned
 */
const provisionTenantDatabase = async (tenant, { force = false } = {}) => {
  if (!tenant) throw new Error('[provision] a tenant is required');

  if (!isPerTenant()) {
    // Nothing to build: in shared mode the tenant's data lives in the database
    // this process is already connected to.
    return { skipped: true, reason: 'TENANT_DB_MODE is "shared"', dbName: null };
  }

  const dbName = dbNameFor(tenant);
  if (!dbName) throw new Error('[provision] cannot resolve a database name for the tenant');

  if (tenant.db_provisioned_at && !force) {
    return { skipped: true, reason: 'already provisioned', dbName };
  }

  const started = Date.now();
  const connection = forTenant(tenant);
  const results = await tenantSchemas.syncAllIndexes(connection);
  const failed = results.filter((r) => !r.ok);

  // A database that is missing collections is not provisioned, and saying it is
  // would be worse than failing: the tenant gets stamped as ready, onboarding
  // reports success, and the first request into a collection that was never
  // built is where the problem finally surfaces — long after the context that
  // would explain it is gone. Cluster-wide limits make this a real case, not a
  // theoretical one (Atlas shared tiers cap total collections), so fail here and
  // let the caller roll the tenant back.
  // Running out of collections is not a fault in this tenant — it is the cluster
  // being full, and it will fail identically for every tenant onboarded from now
  // on. Saying so directly saves the operator from reading it as a bad name or a
  // transient glitch and retrying into the same wall.
  if (results.capacityError) {
    throw new Error(
      `the database cluster has no room for another tenant — ${results.capacityError}. ` +
      'Each tenant needs its own set of collections, and the cluster is at its limit. ' +
      'Raise the cluster tier, remove tenants that are no longer needed, or set TENANT_DB_MODE=shared.'
    );
  }

  if (failed.length) {
    const detail = failed.slice(0, 3).map((f) => `${f.model}: ${f.error}`).join('; ');
    throw new Error(
      `[provision] "${dbName}" is incomplete — ${failed.length} of ${results.length} models failed. ${detail}` +
      (failed.length > 3 ? ` (+${failed.length - 3} more)` : '')
    );
  }

  // Record the database on the tenant so routing never has to re-derive it, and
  // so a later rename of the derivation rule cannot strand existing data.
  await Tenant.updateOne(
    { id: tenant.id },
    { $set: { db_name: dbName, db_provisioned_at: new Date() } }
  );
  // The updateOne above clears the tenantLookupService caches through the
  // model's post-hook, so the first request for this tenant reads the freshly
  // stamped db_name rather than a copy cached before provisioning finished.

  const summary = {
    dbName,
    models: results.length,
    failed: failed.map((f) => `${f.model}: ${f.error}`),
    ms: Date.now() - started,
  };
  console.log(`[provision] ${tenant.slug || tenant.id} → "${dbName}": ${results.length - failed.length}/${results.length} models ready in ${summary.ms}ms`);
  if (failed.length) console.error(`[provision] ${failed.length} model(s) failed:`, summary.failed);

  return summary;
};

module.exports = { provisionTenantDatabase };
