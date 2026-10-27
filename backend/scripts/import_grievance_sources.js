/**
 * Import grievance sources (X handles + Facebook pages) from another deployment's
 * MongoDB into a tenant of this multi-tenant police saga.
 *
 * Each source is district-scoped so officers only see their own: the district is
 * taken from the account's own name (e.g. "Nalgonda District Police" -> Nalgonda),
 * with aliases for names that differ from the tenant's district list. Accounts
 * that are state-level (DGP, Telangana State Police) apply to every district.
 *
 * Run:  node scripts/import_grievance_sources.js --tenant <slug> --from "<mongodb-uri>" [--db <name>]
 *       node scripts/import_grievance_sources.js --tenant <slug> --from "<uri>" --apply
 *       ... --platform facebook      (only one platform)
 *
 * Dry run by default. Existing sources (same tenant + platform + handle) are skipped.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const { runWithTenant } = require('../src/config/tenantContext');
const { forTenant, dbNameFor } = require('../src/config/tenantConnections');
const Tenant = require('../src/models/Tenant');
const GrievanceSource = require('../src/models/GrievanceSource');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');
const tenantArg = arg('--tenant');
const fromUri = arg('--from');
const fromDbName = arg('--db');
const platformArg = (arg('--platform') || '').toLowerCase();

// Account-name spellings that differ from the tenant's district list.
const DISTRICT_ALIASES = {
  'Jagitial': ['jagtial'],
  'Kumuram Bheem Asifabad': ['kumrambheem', 'asifabad', 'kumram bheem'],
  'Jayashankar Bhupalapally': ['bhupalpally', 'bhoopalpalli', 'bhupalapally', 'jsb'],
  'Bhadradri Kothagudem': ['kothagudem'],
  'Rajanna Sircilla': ['sircilla'],
  'Yadadri Bhuvanagiri': ['yadadri', 'bhuvanagiri'],
  'Jogulamba Gadwal': ['gadwal'],
  'Mahabubnagar': ['mbnr'],
  'Mahabubabad': ['mhbd'],
  'Medchal Malkajgiri': ['malkajgiri', 'medchal'],
  'Hanumakonda': ['hanamkonda'],
  'Warangal': ['warangal'],
  'Peddapalli': ['ramagundam'],
  'Nizamabad': ['nizamabad'],
};

// Commissionerates that cover more than one district.
const MULTI_DISTRICT = {
  cyberabad: ['Ranga Reddy', 'Medchal Malkajgiri', 'Sangareddy'],
  rachakonda: ['Medchal Malkajgiri', 'Ranga Reddy', 'Yadadri Bhuvanagiri'],
  futurecity: ['Ranga Reddy'],
};

const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Districts an account belongs to; [] means state-wide (every district). */
const districtsFor = (source, tenantDistricts) => {
  const hay = ` ${norm(`${source.display_name} ${source.handle}`)} `;

  for (const [key, districts] of Object.entries(MULTI_DISTRICT)) {
    if (hay.includes(` ${key} `) || hay.includes(key)) return districts.filter((d) => tenantDistricts.includes(d));
  }

  const hits = tenantDistricts.filter((district) => {
    const names = [norm(district), ...(DISTRICT_ALIASES[district] || []).map(norm)];
    return names.some((n) => n && hay.includes(n));
  });
  // "Hyderabad Traffic Police" must not also match nothing else; longest wins when nested.
  return hits.length ? hits : [];
};

const main = async () => {
  if (!tenantArg) throw new Error('--tenant <slug|id> is required');
  if (!fromUri) throw new Error('--from "<mongodb-uri>" is required');

  await connectDB();
  const tenant = await Tenant.findOne({ $or: [{ slug: tenantArg }, { id: tenantArg }] })
    .select('id slug type db_name police_config location_config').lean();
  if (!tenant) throw new Error(`tenant not found: ${tenantArg}`);

  const tenantDistricts = tenant.police_config?.districts?.length
    ? tenant.police_config.districts
    : (tenant.location_config?.districts || []);
  const state = tenant.police_config?.state || tenant.location_config?.state_name || '';
  if (!tenantDistricts.length) throw new Error('tenant has no districts configured; set them before importing');

  // Read the source deployment (read-only).
  const client = new mongoose.mongo.MongoClient(fromUri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const sourceDb = client.db(fromDbName || undefined);
  const query = platformArg ? { platform: platformArg } : {};
  const rows = await sourceDb.collection('grievancesources').find(query).toArray();
  await client.close();

  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} — ${rows.length} source(s) from ${sourceDb.databaseName}`);
  console.log(`target: ${tenant.slug} → ${dbNameFor(tenant)}  (${tenantDistricts.length} districts, state "${state}")\n`);

  let added = 0;
  let skipped = 0;
  let stateWide = 0;

  await runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, async () => {
    for (const row of rows) {
      const platform = String(row.platform || 'x').toLowerCase();
      const handle = String(row.handle || '').trim();
      if (!handle || !['x', 'facebook'].includes(platform)) {
        console.log(`  SKIP   ${handle || '(no handle)'} — unsupported platform ${platform}`);
        skipped += 1;
        continue;
      }

      const exists = await GrievanceSource.findOne({ tenant_id: tenant.id, platform, handle });
      if (exists) {
        console.log(`  EXISTS ${platform.padEnd(8)} ${handle}`);
        skipped += 1;
        continue;
      }

      const matched = districtsFor(row, tenantDistricts);
      const districts = matched.length ? matched : tenantDistricts;
      if (!matched.length) stateWide += 1;

      console.log(`  ADD    ${platform.padEnd(8)} ${handle.padEnd(22)} "${row.display_name}" → ${matched.length ? matched.join(', ') : 'ALL DISTRICTS (state-level)'}`);

      if (apply) {
        await GrievanceSource.create({
          tenant_id: tenant.id,
          handle,
          display_name: row.display_name || handle,
          profile_image_url: row.profile_image_url || '',
          x_user_id: platform === 'x' ? row.x_user_id : undefined,
          is_verified: Boolean(row.is_verified),
          is_active: row.is_active !== false,
          department: row.department || 'Government',
          designation: row.designation,
          contact_number: row.contact_number,
          platform,
          state,
          districts,
          created_by: 'import',
        });
      }
      added += 1;
    }
  });

  console.log(`\n${apply ? 'added' : 'would add'} ${added}, skipped ${skipped} (of which state-level, all districts: ${stateWide})`);
  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
