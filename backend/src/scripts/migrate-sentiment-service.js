/**
 * Prepare every tenant database for the sentiment-service pipeline.
 *
 *   node src/scripts/migrate-sentiment-service.js                  # report only
 *   node src/scripts/migrate-sentiment-service.js --apply
 *   node src/scripts/migrate-sentiment-service.js --apply --tenant <slug>
 *
 * Per tenant:
 *   1. Analysis: remove duplicate rows (keep the newest per content), then build
 *      the unique { tenant_id, content_id } index the pipeline upserts against.
 *   2. Content: set analysis_status where it is missing —
 *        has an Analysis row -> 'done'
 *        otherwise           -> 'pending' (analysed by the service; this is the backfill)
 *   3. Grievance, Comment: missing status -> 'pending' (never analysed before).
 *
 * Idempotent: documents that already carry analysis_status are left alone.
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

const apply = process.argv.includes('--apply');
const tenantArg = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const UNIQUE_INDEX = { tenant_id: 1, content_id: 1 };
const CHUNK = 1000;

const dedupeAnalyses = async (tenantId) => {
  const groups = await Analysis.aggregate([
    { $match: { tenant_id: tenantId } },
    { $sort: { analyzed_at: -1, _id: -1 } },
    { $group: { _id: '$content_id', keep: { $first: '$_id' }, all: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).allowDiskUse(true);

  const removeIds = groups.flatMap((g) => g.all.filter((id) => String(id) !== String(g.keep)));
  if (apply && removeIds.length) {
    for (let i = 0; i < removeIds.length; i += CHUNK) {
      await Analysis.collection.deleteMany({ _id: { $in: removeIds.slice(i, i + CHUNK) } });
    }
  }
  return { contentsWithDuplicates: groups.length, rowsRemoved: removeIds.length };
};

const ensureUniqueIndex = async () => {
  const indexes = await Analysis.collection.indexes();
  const exists = indexes.some((ix) => ix.unique && JSON.stringify(ix.key) === JSON.stringify(UNIQUE_INDEX));
  if (exists) return 'present';
  if (!apply) return 'would create';
  await Analysis.collection.createIndex(UNIQUE_INDEX, { unique: true, name: 'tenant_id_1_content_id_1' });
  return 'created';
};

const backfillContent = async (tenantId) => {
  const missing = { tenant_id: tenantId, analysis_status: { $exists: false } };
  const total = await Content.countDocuments(missing);
  if (!total) return { total: 0, done: 0, pending: 0 };

  // content_id on Analysis holds Content.id
  const analysed = await Analysis.aggregate([
    { $match: { tenant_id: tenantId } },
    { $group: { _id: '$content_id', analyzed_at: { $max: '$analyzed_at' } } },
  ]).allowDiskUse(true);

  let done = 0;
  if (analysed.length) {
    const candidates = await Content.find({ ...missing, id: { $in: analysed.map((a) => a._id) } })
      .select('id').lean();
    const when = new Map(analysed.map((a) => [a._id, a.analyzed_at]));
    done = candidates.length;
    if (apply) {
      for (let i = 0; i < candidates.length; i += CHUNK) {
        await Content.collection.bulkWrite(candidates.slice(i, i + CHUNK).map((c) => ({
          updateOne: {
            filter: { id: c.id, analysis_status: { $exists: false } },
            update: { $set: { analysis_status: 'done', analysis_attempts: 0, analyzed_at: when.get(c.id) || new Date() } },
          },
        })));
      }
    }
  }

  const pending = total - done;
  if (apply && pending) {
    await Content.collection.updateMany(missing, { $set: { analysis_status: 'pending', analysis_attempts: 0 } });
  }
  return { total, done, pending };
};

const backfillPending = async (Model, tenantId) => {
  const missing = { tenant_id: tenantId, analysis_status: { $exists: false } };
  const n = await Model.countDocuments(missing);
  if (apply && n) await Model.collection.updateMany(missing, { $set: { analysis_status: 'pending', analysis_attempts: 0 } });
  return n;
};

const main = async () => {
  await connectDB();
  const query = tenantArg ? { $or: [{ slug: tenantArg }, { id: tenantArg }] } : {};
  const tenants = await Tenant.find(query).select('id slug type db_name').lean();
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} — ${tenants.length} tenant(s)\n`);

  for (const t of tenants) {
    console.log(`${t.slug}  →  ${dbNameFor(t)}`);
    try {
      await runWithTenant({ tenant: t, tenantId: t.id, connection: forTenant(t) }, async () => {
        const dup = await dedupeAnalyses(t.id);
        console.log(`  analysis duplicates   : ${dup.contentsWithDuplicates} post(s), ${dup.rowsRemoved} extra row(s) ${apply ? 'removed' : 'to remove'}`);
        console.log(`  unique index          : ${await ensureUniqueIndex()}`);
        const c = await backfillContent(t.id);
        console.log(`  content status        : ${c.total} without status → ${c.done} done, ${c.pending} pending${apply ? '' : ' (not written)'}`);
        console.log(`  grievances → pending  : ${await backfillPending(Grievance, t.id)}`);
        console.log(`  comments → pending    : ${await backfillPending(Comment, t.id)}`);
      });
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
    console.log('');
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
