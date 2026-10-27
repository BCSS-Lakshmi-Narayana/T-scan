/**
 * Delete one tenant's alerts created today, plus the content they point to and
 * that content's analyses — so the next scan re-ingests the posts and the
 * sentiment pipeline analyses them again from scratch.
 *
 *   node src/scripts/reset-todays-alerts.js --tenant t-scan            # dry run: counts only
 *   node src/scripts/reset-todays-alerts.js --tenant t-scan --apply    # delete
 *   node src/scripts/reset-todays-alerts.js --tenant t-scan --since 2026-09-17T00:00:00+05:30
 *
 * "Today" = since local midnight on the machine running the script.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, dbNameFor } = require('../config/tenantConnections');
const Tenant = require('../models/Tenant');
const Alert = require('../models/Alert');
const Content = require('../models/Content');
const Analysis = require('../models/Analysis');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');
const tenantArg = arg('--tenant');

const since = (() => {
  if (arg('--since')) return new Date(arg('--since'));
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

const main = async () => {
  if (!tenantArg) throw new Error('--tenant <slug|id> is required');
  if (Number.isNaN(since.getTime())) throw new Error('--since is not a valid date');

  await connectDB();
  const tenant = await Tenant.findOne({ $or: [{ slug: tenantArg }, { id: tenantArg }] }).select('id slug type db_name').lean();
  if (!tenant) throw new Error(`tenant not found: ${tenantArg}`);

  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to delete)'} — tenant ${tenant.slug} → ${dbNameFor(tenant)}`);
  console.log(`alerts created since ${since.toISOString()} (${since.toString()})\n`);

  await runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, async () => {
    const tid = tenant.id;
    const alerts = await Alert.find({ tenant_id: tid, created_at: { $gte: since } })
      .select('_id content_id content_ref_id').lean();
    const contentIds = [...new Set(alerts.flatMap((a) => [a.content_id, a.content_ref_id]).filter(Boolean))];

    const contents = await Content.find({ tenant_id: tid, id: { $in: contentIds } }).select('_id id').lean();
    const ids = contents.map((c) => c.id);
    const analyses = await Analysis.countDocuments({ tenant_id: tid, content_id: { $in: ids } });

    console.log(`  alerts   : ${alerts.length}`);
    console.log(`  contents : ${contents.length}`);
    console.log(`  analyses : ${analyses}`);

    if (!apply) return;

    const a = await Analysis.deleteMany({ tenant_id: tid, content_id: { $in: ids } });
    const c = await Content.deleteMany({ tenant_id: tid, id: { $in: ids } });
    const al = await Alert.deleteMany({ tenant_id: tid, _id: { $in: alerts.map((x) => x._id) } });
    console.log(`\n  deleted → alerts ${al.deletedCount}, contents ${c.deletedCount}, analyses ${a.deletedCount}`);
  });

  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
