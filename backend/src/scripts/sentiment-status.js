/**
 * Read-only: sentiment analysis progress per tenant.
 *
 *   node src/scripts/sentiment-status.js
 *   node src/scripts/sentiment-status.js --tenant <slug>
 *
 * Shows analysis_status counts for Content and Comment, duplicate
 * Analysis rows (should be 0), recent errors, and whether the service is reachable.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, dbNameFor } = require('../config/tenantConnections');

for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
  if (f.endsWith('.js')) { try { require(`../models/${f}`); } catch (_) { /* not a model */ } }
}
const Tenant = require('../models/Tenant');
const Analysis = require('../models/Analysis');
const Content = require('../models/Content');
const Comment = require('../models/Comment');
const Grievance = require('../models/Grievance');
const http = require('../services/sentiment/sentiment.http');

const tenantArg = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const statusCounts = async (Model, tenantId) => {
  const rows = await Model.aggregate([
    { $match: { tenant_id: tenantId } },
    { $group: { _id: { $ifNull: ['$analysis_status', '(missing)'] }, n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
};

const fmt = (counts) => ['pending', 'processing', 'done', 'failed', 'skipped', '(missing)']
  .filter((k) => counts[k])
  .map((k) => `${k}=${counts[k]}`)
  .join('  ') || '(none)';

const main = async () => {
  try {
    const h = await http.getHealth();
    console.log(`service ${process.env.SENTIMENT_SERVICE_URL}: healthy=${h.healthy} device=${h.device} intelligence=${h.intelligence?.reachable}\n`);
  } catch (err) {
    console.log(`service: NOT reachable — ${err.message}\n`);
  }

  await connectDB();
  const query = tenantArg ? { $or: [{ slug: tenantArg }, { id: tenantArg }] } : {};
  const tenants = await Tenant.find(query).select('id slug type db_name').lean();

  for (const t of tenants) {
    console.log(`${t.slug}  →  ${dbNameFor(t)}`);
    try {
      await runWithTenant({ tenant: t, tenantId: t.id, connection: forTenant(t) }, async () => {
        console.log(`  content     ${fmt(await statusCounts(Content, t.id))}`);
        console.log(`  grievances  ${fmt(await statusCounts(Grievance, t.id))}`);
        console.log(`  comments    ${fmt(await statusCounts(Comment, t.id))}`);

        const dup = await Analysis.aggregate([
          { $match: { tenant_id: t.id } },
          { $group: { _id: '$content_id', n: { $sum: 1 } } },
          { $match: { n: { $gt: 1 } } },
          { $count: 'posts' },
        ]);
        console.log(`  analysis rows ${await Analysis.countDocuments({ tenant_id: t.id })}, duplicated posts ${dup[0]?.posts || 0}`);

        const errors = await Content.find({ tenant_id: t.id, analysis_error: { $nin: [null, ''] }, analysis_status: { $ne: 'done' } })
          .select('id analysis_status analysis_attempts analysis_error').sort({ created_at: -1 }).limit(3).lean();
        errors.forEach((e) => console.log(`  recent error [${e.analysis_status}, attempts ${e.analysis_attempts}]: ${String(e.analysis_error).slice(0, 140)}`));
      });
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
    console.log('');
  }
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
