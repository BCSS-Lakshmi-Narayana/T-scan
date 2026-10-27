#!/usr/bin/env node
/**
 * Split the shared database into one database per tenant.
 *
 *   node src/scripts/migrate-to-tenant-databases.js                 # dry run, all tenants
 *   node src/scripts/migrate-to-tenant-databases.js --tenant=bsk    # dry run, one tenant
 *   node src/scripts/migrate-to-tenant-databases.js --apply         # actually copy
 *   node src/scripts/migrate-to-tenant-databases.js --verify        # compare counts only
 *
 * How it behaves, and why:
 *
 * COPIES, NEVER MOVES. Nothing is deleted from the shared database. That is the
 * rollback: if anything looks wrong after the cutover, set TENANT_DB_MODE back to
 * "shared" and the original data is still sitting there, untouched.
 *
 * USES THE RAW DRIVER, NOT THE MODELS. Documents written years ago do not
 * necessarily validate against today's schemas, and a migration is the worst
 * possible moment to discover that. Copying through the driver reproduces each
 * document byte-for-byte instead of casting it.
 *
 * IS RE-RUNNABLE. Documents are upserted by _id, so an interrupted run can be
 * repeated and a second run copies only what changed.
 *
 * REPORTS ORPHANS. Documents whose tenant_id matches no tenant (or is missing)
 * belong to nobody and are left where they are — deciding what they are is a
 * judgement call, not something a migration should guess at.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const tenantSchemas = require('../config/tenantSchemas');
const { dbNameFor, sanitize } = require('../config/tenantConnections');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const APPLY = flag('apply');
const VERIFY_ONLY = flag('verify');
const ONLY_TENANT = value('tenant');
const BATCH = Number(value('batch', 1000));

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n).toLocaleString('en-IN');

/** Load every model file so the tenant-scoped schema registry is populated. */
const loadModels = () => {
  const dir = path.join(__dirname, '../models');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.js') && file !== 'tenantModel.js') require(path.join(dir, file));
  }
};

/**
 * Copy one collection's slice for one tenant. Batched upserts by _id so the run
 * is restartable and a re-run is cheap.
 */
const copyCollection = async (source, target, collectionName, tenantId) => {
  const filter = { tenant_id: tenantId };
  const total = await source.collection(collectionName).countDocuments(filter);
  if (!total) return { total: 0, copied: 0 };
  if (!APPLY) return { total, copied: 0 };

  const cursor = source.collection(collectionName).find(filter);
  let batch = [];
  let copied = 0;

  const flush = async () => {
    if (!batch.length) return;
    await target.collection(collectionName).bulkWrite(batch, { ordered: false });
    copied += batch.length;
    batch = [];
  };

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    batch.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  return { total, copied };
};

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing in .env');
  const sourceDbName = value('source-db', process.env.DB_NAME || null);

  await mongoose.connect(uri, sourceDbName ? { dbName: sourceDbName } : undefined);
  const source = mongoose.connection;
  loadModels();

  // Model name → collection name, taken from the schemas themselves so the list
  // can never drift from what the app actually reads.
  tenantSchemas.compileAll(source);
  const collections = tenantSchemas.names()
    .map((name) => source.models[name].collection.name)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  const tenants = await source.collection('tenants')
    .find(ONLY_TENANT ? { slug: ONLY_TENANT } : {})
    .project({ id: 1, slug: 1, name: 1, status: 1, db_name: 1 })
    .toArray();

  if (!tenants.length) throw new Error(ONLY_TENANT ? `No tenant with slug "${ONLY_TENANT}"` : 'No tenants found');

  const mode = VERIFY_ONLY ? 'VERIFY' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\n${mode} — source "${source.name}" → ${tenants.length} tenant database(s), ${collections.length} collections each\n`);

  const summary = [];

  for (const tenant of tenants) {
    const targetName = dbNameFor(tenant);
    const target = source.useDb(targetName, { useCache: true });
    console.log(`── ${tenant.name || tenant.slug} (${tenant.slug}) → "${targetName}"`);

    let docsToCopy = 0;
    let docsCopied = 0;
    const mismatches = [];

    for (const collectionName of collections) {
      const { total, copied } = VERIFY_ONLY
        ? { total: await source.collection(collectionName).countDocuments({ tenant_id: tenant.id }), copied: 0 }
        : await copyCollection(source, target, collectionName, tenant.id);

      if (!total) continue;
      docsToCopy += total;
      docsCopied += copied;

      const landed = await target.collection(collectionName).countDocuments({ tenant_id: tenant.id });
      const ok = APPLY || VERIFY_ONLY ? landed === total : true;
      if (!ok) mismatches.push(`${collectionName}: source ${total}, target ${landed}`);

      console.log(`   ${ok ? ' ' : '!'} ${pad(collectionName, 30)} source ${pad(num(total), 10)} target ${num(landed)}`);
    }

    summary.push({ tenant: tenant.slug, targetName, docsToCopy, docsCopied, mismatches });
    console.log(`   ${docsToCopy ? num(docsToCopy) : 'no'} document(s)${APPLY ? `, ${num(docsCopied)} copied` : ''}` +
      `${mismatches.length ? ` — ${mismatches.length} MISMATCH` : ''}\n`);
  }

  // Documents that belong to no tenant at all — reported, never moved.
  console.log('── Orphans (tenant_id matching no tenant, or missing)');
  const tenantIds = (await source.collection('tenants').find({}).project({ id: 1 }).toArray()).map((t) => t.id);
  let orphanTotal = 0;
  for (const collectionName of collections) {
    const n = await source.collection(collectionName).countDocuments({
      $or: [{ tenant_id: { $nin: tenantIds } }, { tenant_id: { $exists: false } }, { tenant_id: null }],
    });
    if (n) { orphanTotal += n; console.log(`   ${pad(collectionName, 30)} ${num(n)}`); }
  }
  console.log(`   ${orphanTotal ? `${num(orphanTotal)} orphaned document(s) left in "${source.name}"` : 'none'}\n`);

  const failed = summary.filter((s) => s.mismatches.length);
  console.log('── Summary');
  for (const s of summary) {
    console.log(`   ${pad(s.tenant, 22)} → ${pad(s.targetName, 32)} ${num(s.docsToCopy)} doc(s)` +
      `${s.mismatches.length ? `  MISMATCH: ${s.mismatches.join('; ')}` : ''}`);
  }

  if (!APPLY && !VERIFY_ONLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to copy.');
  } else if (failed.length) {
    console.log(`\n${failed.length} tenant(s) did NOT verify. The shared database is untouched; fix and re-run.`);
  } else {
    console.log('\nEvery tenant verified: target counts match source counts.');
    console.log('The shared database still holds the originals — set TENANT_DB_MODE=per-tenant when ready,');
    console.log('and back to "shared" to roll back.');
  }

  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error('\nMIGRATION ERROR', err); process.exit(1); });
