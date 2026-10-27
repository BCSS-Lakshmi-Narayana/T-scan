/**
 * Remove the sentiment-analysis data an earlier build wrote onto grievances.
 * Police does not analyse grievances; only documents that build touched
 * (they carry analysis_status) are changed.
 *
 *   node src/scripts/remove-grievance-analysis.js                    # dry run, all police tenants
 *   node src/scripts/remove-grievance-analysis.js --tenant t-scan    # dry run, one tenant
 *   node src/scripts/remove-grievance-analysis.js --apply            # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { forTenant, dbNameFor } = require('../config/tenantConnections');
const Tenant = require('../models/Tenant');

const apply = process.argv.includes('--apply');
const tenantArg = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : null;
})();

// Everything that build wrote: the analysis block and its work-tracking fields.
const UNSET = Object.fromEntries([
  'analysis.sentiment', 'analysis.urgency', 'analysis.keywords', 'analysis.summary',
  'analysis.sentiment_confidence', 'analysis.risk_score', 'analysis.risk_level', 'analysis.category',
  'analysis.intent', 'analysis.intent_label', 'analysis.reasoning', 'analysis.recommended_action',
  'analysis.evidence_confidence', 'analysis.language', 'analysis.english_text', 'analysis.signals', 'analysis.model',
  'analysis_status', 'analysis_attempts', 'analysis_error', 'analysis_claim_token',
  'analysis_claimed_at', 'analysis_next_attempt_at', 'analyzed_at',
].map((f) => [f, 1]));

const main = async () => {
  await connectDB();
  const query = { type: 'police', ...(tenantArg ? { $or: [{ slug: tenantArg }, { id: tenantArg }] } : {}) };
  const tenants = await Tenant.find(query).select('id slug type db_name').lean();
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} — ${tenants.length} police tenant(s)\n`);

  for (const t of tenants) {
    try {
      const grievances = forTenant(t).db.collection('grievances');
      const touched = { tenant_id: t.id, analysis_status: { $exists: true } };
      const n = await grievances.countDocuments(touched);
      let line = `  ${t.slug.padEnd(24)} ${dbNameFor(t)}: ${n} grievance(s) with analysis data`;
      if (apply && n) {
        const r = await grievances.updateMany(touched, { $unset: UNSET });
        // Drop the now-empty analysis block so documents match the original shape.
        await grievances.updateMany({ tenant_id: t.id, analysis: {} }, { $unset: { analysis: 1 } });
        line += ` → cleaned ${r.modifiedCount}`;
      }
      console.log(line);
    } catch (err) {
      console.log(`  ${t.slug}: FAILED ${err.message}`);
    }
  }

  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
