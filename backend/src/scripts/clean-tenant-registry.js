#!/usr/bin/env node
/**
 * Separate genuine Police Saga tenants from Super Admin mirror rows that leaked
 * into this saga's tenant registry.
 *
 *   node src/scripts/clean-tenant-registry.js            # classify only
 *   node src/scripts/clean-tenant-registry.js --apply    # remove the foreign rows
 *
 * Background: the Super Admin used to default into the "test" database — the same
 * one this saga uses — so its tenant-mirror upserts landed in this saga's
 * `tenants` collection. The result is that tenants belonging to the political and
 * state sagas appear here as if they were police tenants. tenantMiddleware will
 * happily resolve them, and the database-per-tenant migration would build a
 * database for every one of them.
 *
 * Classification: `type` is the discriminator. This saga only ever creates
 * type: 'police'. A political or state row here can only have arrived via the
 * mirror. Field presence (admin_user_id / onboarding) is reported as corroborating
 * evidence, not used to decide — the collision merged mirror fields INTO genuine
 * police records, so those fields appear on both.
 *
 * NEVER DELETES BLIND. A foreign row is only removed once it has been confirmed
 * to exist in the Super Admin's own database, which is the mirror's real home.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const SUPER_ADMIN_DB = process.env.SUPER_ADMIN_DB_NAME || 'saga-super-admin';

// Collections worth checking for stray data belonging to a foreign tenant.
const PROBE = ['users', 'settings', 'alertthresholds', 'alerts', 'grievances', 'sources'];

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing in .env');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'test' });
  const db = mongoose.connection;
  const superAdmin = db.useDb(SUPER_ADMIN_DB, { useCache: true });

  const tenants = await db.collection('tenants').find({}).toArray();
  const own = tenants.filter((t) => t.type === 'police');
  const foreign = tenants.filter((t) => t.type !== 'police');

  console.log(`\n${APPLY ? 'APPLY' : 'CLASSIFY'} — "${db.name}".tenants holds ${tenants.length} row(s)\n`);
  console.log(`── Genuine police tenants: ${own.length} (kept)`);
  for (const t of own) console.log(`   ${String(t.slug).padEnd(26)} ${t.status}`);

  console.log(`\n── Foreign rows (type is not "police"): ${foreign.length}`);
  let removable = 0;
  let blocked = 0;

  for (const t of foreign) {
    // Does the mirror's real home have it? If not, removing here loses the row.
    const inSuperAdmin = await superAdmin.collection('tenants').countDocuments({ id: t.id });

    // Does this saga hold any data for it? Default rows seeded at onboarding are
    // expected; anything more means real work happened under this tenant here.
    const data = {};
    for (const c of PROBE) {
      try {
        const n = await db.collection(c).countDocuments({ tenant_id: t.id });
        if (n) data[c] = n;
      } catch { /* collection may not exist */ }
    }
    const dataSummary = Object.keys(data).length
      ? Object.entries(data).map(([k, v]) => `${k}:${v}`).join(' ')
      : 'no data';

    // Some foreign rows turned out to have been genuinely onboarded HERE — they
    // own users and settings in this database. Those are not mirror artifacts,
    // whatever their `type` says, and dropping them from the registry would
    // orphan real accounts. Only rows carrying no identity data are removable.
    const ownsIdentity = !!(data.users || data.settings);
    const safe = inSuperAdmin > 0 && !ownsIdentity;
    if (safe) removable++; else blocked++;

    const why = inSuperAdmin === 0 ? 'no mirror copy' : ownsIdentity ? 'HAS USERS HERE' : '';
    console.log(`   ${safe ? ' ' : '!'} ${String(t.slug).padEnd(26)} type=${String(t.type).padEnd(9)} ` +
      `mirror_in_super_admin=${inSuperAdmin > 0 ? 'yes' : 'NO'}  ${dataSummary}${why ? `  → KEEP (${why})` : ''}`);

    if (APPLY && safe) {
      await db.collection('tenants').deleteOne({ _id: t._id });
    }
  }

  console.log('');
  if (!APPLY) {
    console.log(`${removable} row(s) can be removed safely; ${blocked} kept (they own users here, or have no mirror copy).`);
    console.log('Dry run — nothing removed. Re-run with --apply.');
  } else {
    console.log(`Removed ${removable} foreign row(s) from "${db.name}".tenants; kept ${blocked} that had no mirror copy.`);
    console.log(`"${db.name}" now resolves only its own tenants. The Super Admin still holds every mirror in "${SUPER_ADMIN_DB}".`);
  }

  // Any data those foreign tenants left behind is reported, never touched — it
  // belongs to whichever saga actually created it, and that is not a call this
  // script should make.
  console.log('\nNote: data rows shown above are left in place. Removing a tenant from the');
  console.log('registry stops it resolving here; it does not delete anything it wrote.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('\nCLEANUP ERROR', err.message); process.exit(1); });
