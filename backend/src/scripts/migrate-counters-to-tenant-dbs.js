/**
 * Move the code sequences out of the shared control-plane database and into each
 * tenant's own database.
 *
 *   node src/scripts/migrate-counters-to-tenant-dbs.js            # report only
 *   node src/scripts/migrate-counters-to-tenant-dbs.js --apply
 *
 * Why this is not a straight copy: the old counters collection held ONE sequence
 * per key for every tenant of every product. There is no way to split a single
 * number back into per-tenant sequences, and the code fields are uniquely indexed
 * inside each tenant database — so a tenant restarted at zero would re-issue codes
 * it has already used and hit a duplicate-key error on the next grievance.
 *
 * Instead each tenant's counter is set from what that tenant has actually consumed:
 * the highest sequence appearing in its own existing codes. A tenant with no codes
 * starts at 0, which is correct — it has issued none.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, isPerTenant, dbNameFor } = require('../config/tenantConnections');

for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
  if (f.endsWith('.js')) { try { require(`../models/${f}`); } catch (_) { /* not a model */ } }
}
const Tenant = require('../models/Tenant');
const Counter = require('../models/Counter');
const Grievance = require('../models/Grievance');

// counter key -> where its codes live, and how to read the sequence back out.
// complaint_code is HCP-000123; the rest are X-P00123-DDMMYYYY.
const SOURCES = [
  { key: 'grievance_complaint_code', field: 'complaint_code', re: /^HCP-(\d+)$/ },
  { key: 'criticism_unique_code', field: 'criticism.unique_code', re: /^C-[A-Z](\d+)-/ },
  { key: 'grievance_workflow_unique_code', field: 'grievance_workflow.unique_code', re: /^G-[A-Z](\d+)-/ },
  { key: 'query_unique_code', field: 'query_workflow.unique_code', re: /^Q-[A-Z](\d+)-/ },
  { key: 'suggestion_unique_code', field: 'suggestion.unique_code', re: /^S-[A-Z](\d+)-/ },
];

const main = async () => {
  const apply = process.argv.includes('--apply');
  await connectDB();

  if (!isPerTenant()) {
    console.log('TENANT_DB_MODE is not per-tenant — the counter already lives with the data. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const shared = await mongoose.connection.collection('counters').find({}).toArray();
  console.log('shared control-plane counters (the ones being retired):');
  shared.forEach((c) => console.log(`  ${c.key.padEnd(34)} seq=${c.seq}`));
  if (!shared.length) console.log('  (none)');

  const tenants = await Tenant.find({}).select('id slug type').lean();
  console.log(`\n${tenants.length} tenant(s) in this product's registry\n`);

  for (const t of tenants) {
    const connection = forTenant(t);
    console.log(`${t.slug}  →  ${dbNameFor(t)}`);

    await runWithTenant({ tenant: t, tenantId: t.id, connection }, async () => {
      for (const src of SOURCES) {
        // Highest sequence this tenant has already issued.
        const rows = await Grievance.find({ [src.field]: { $exists: true, $nin: [null, ''] } })
          .select(src.field).lean();
        let max = 0;
        for (const r of rows) {
          const value = src.field.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
          const m = typeof value === 'string' ? value.match(src.re) : null;
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }

        const existing = await Counter.findOne({ key: src.key }).lean();
        const already = existing ? existing.seq : null;
        const verdict = already !== null && already >= max ? 'ok (already ahead)' : `set to ${max}`;
        console.log(`   ${src.key.padEnd(34)} used=${String(max).padStart(5)}  local=${already === null ? '-' : already}  ${apply ? verdict : '(dry run)'}`);

        // Nothing to write when the tenant has issued no codes — the services
        // upsert the counter themselves on first use, so pre-creating a zero row
        // only adds a collection to a cluster that counts them.
        if (apply && max > 0 && (already === null || already < max)) {
          await Counter.updateOne(
            { key: src.key },
            { $set: { key: src.key, seq: max, updated_at: new Date() } },
            { upsert: true }
          );
        }
      }
    });
    console.log('');
  }

  if (!apply) {
    console.log('dry run — re-run with --apply to write the per-tenant counters.');
  } else {
    console.log('done. The shared counters in the control-plane database are now unused;');
    console.log('leave them in place until you are satisfied, then drop the collection.');
  }

  await mongoose.disconnect();
};

main().catch((e) => { console.error('\nmigration failed:', e.message); process.exit(1); });
