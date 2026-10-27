/**
 * Delete one tenant's analysed monitored posts that have no alert, plus their
 * analyses, so the next scan re-ingests them and they are analysed and alerted again.
 *
 *   node src/scripts/reset-unalerted-posts.js --tenant t-scan                          # dry run
 *   node src/scripts/reset-unalerted-posts.js --tenant t-scan --apply                  # delete
 *   node src/scripts/reset-unalerted-posts.js --tenant t-scan --include-unfinished     # also pending/processing posts
 *   node src/scripts/reset-unalerted-posts.js --tenant t-scan --since 2026-09-17T00:00:00+05:30
 *
 * Default window: posts created since local midnight.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, dbNameFor } = require('../config/tenantConnections');
const Tenant = require('../models/Tenant');
const Content = require('../models/Content');
const Analysis = require('../models/Analysis');
const Alert = require('../models/Alert');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');
const includeUnfinished = process.argv.includes('--include-unfinished');
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

  const statuses = includeUnfinished ? ['done', 'pending', 'processing'] : ['done'];
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to delete)'} — tenant ${tenant.slug} → ${dbNameFor(tenant)}`);
  console.log(`monitored posts created since ${since.toString()}, status: ${statuses.join('/')}, no alert\n`);

  await runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, async () => {
    const tid = tenant.id;
    const posts = await Content.find({
      tenant_id: tid,
      created_at: { $gte: since },
      source_id: { $exists: true, $nin: [null, ''] },
      analysis_status: { $in: statuses },
    }).select('id analysis_status').lean();
    const alerted = new Set((await Alert.find({ tenant_id: tid, content_id: { $in: posts.map((p) => p.id) } })
      .select('content_id').lean()).map((a) => a.content_id));
    const targets = posts.filter((p) => !alerted.has(p.id));
    const ids = targets.map((p) => p.id);
    const byStatus = targets.reduce((m, p) => ({ ...m, [p.analysis_status]: (m[p.analysis_status] || 0) + 1 }), {});

    console.log(`  posts without an alert : ${targets.length} ${JSON.stringify(byStatus)}`);
    console.log(`  (posts with an alert, kept: ${posts.length - targets.length})`);
    console.log(`  analyses               : ${await Analysis.countDocuments({ tenant_id: tid, content_id: { $in: ids } })}`);
    if (!apply) return;

    const a = await Analysis.deleteMany({ tenant_id: tid, content_id: { $in: ids } });
    const c = await Content.deleteMany({ tenant_id: tid, id: { $in: ids } });
    console.log(`\n  deleted → contents ${c.deletedCount}, analyses ${a.deletedCount}`);
  });

  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
