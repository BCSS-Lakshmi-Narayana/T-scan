/**
 * Create the missing alert for analysed monitored posts, from their stored
 * Analysis — no call to the sentiment service. For posts analysed while the
 * alert rule skipped low-risk posts.
 *
 *   node src/scripts/backfill-alerts.js --tenant t-scan            # dry run: counts only
 *   node src/scripts/backfill-alerts.js --tenant t-scan --apply    # create alerts
 *   node src/scripts/backfill-alerts.js --tenant t-scan --since 2026-09-17T00:00:00+05:30
 *
 * Default window: posts analysed since local midnight.
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
const { getSettingsForDistricts } = require('../services/settingsResolver');
const { raiseContentAlert } = require('../services/sentiment/sentiment.alerts');

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

/** The mapped result raiseContentAlert expects, rebuilt from a stored Analysis. */
const mappedFrom = (a) => ({
  risk_score: a.risk_score || 0,
  risk_level: a.risk_level || 'low',
  sentiment: a.sentiment,
  category: a.category,
  intent: a.intent,
  explanation: a.explanation || '',
  reasons: a.reasons || [],
  matched_keywords: a.matched_keywords || [],
  highlights: a.highlights || [],
  legal_sections: a.legal_sections || [],
  violated_policies: a.violated_policies || [],
  llm_analysis: a.llm_analysis || null,
});

const main = async () => {
  if (!tenantArg) throw new Error('--tenant <slug|id> is required');
  await connectDB();
  const tenant = await Tenant.findOne({ $or: [{ slug: tenantArg }, { id: tenantArg }] }).select('id slug type db_name').lean();
  if (!tenant) throw new Error(`tenant not found: ${tenantArg}`);
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to create)'} — tenant ${tenant.slug} → ${dbNameFor(tenant)}`);
  console.log(`posts analysed since ${since.toString()}\n`);

  await runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, async () => {
    const tid = tenant.id;
    const posts = await Content.find({
      tenant_id: tid,
      analysis_status: 'done',
      analyzed_at: { $gte: since },
      source_id: { $exists: true, $nin: [null, ''] },
    }).lean();
    const alerted = new Set((await Alert.find({ tenant_id: tid, content_id: { $in: posts.map((p) => p.id) } }).select('content_id').lean())
      .map((a) => a.content_id));
    const missing = posts.filter((p) => !alerted.has(p.id));
    console.log(`  analysed monitored posts : ${posts.length}`);
    console.log(`  without an alert         : ${missing.length}`);
    if (!apply) return;

    let created = 0;
    for (const post of missing) {
      const analysis = await Analysis.findOne({ tenant_id: tid, content_id: post.id }).lean();
      if (!analysis) { console.log(`  skip ${post.id}: no Analysis row`); continue; }
      const settings = await getSettingsForDistricts(tid, post.districts || []).catch(() => null);
      // No alert emails for a backfill.
      const r = await raiseContentAlert(post, mappedFrom(analysis), {
        analysisId: analysis.id,
        settings: settings ? { ...settings, enable_email_alerts: false } : null,
      });
      if (r.created) created += 1;
    }
    console.log(`\n  created ${created} alert(s)`);
  });

  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
