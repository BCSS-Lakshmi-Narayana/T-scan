/**
 * Seed monitoring keywords (Keywords page) into police tenants — tenant-wide and
 * per district officer. Matched keywords show as "Detected Keywords" on alerts;
 * they never change a risk score.
 *
 *   Common keywords   tagged with ALL the tenant's districts (so every officer sees
 *                     them on the Keywords page), created by the tenant admin
 *   District keywords tagged with one officer's district(s), created by that officer
 *
 * The tenant's districts come from police_config / location_config, else from its
 * users' and sources' district assignments.
 *
 * Run:  node scripts/seed_keywords.js --tenant t-scan            (dry run: shows the plan)
 *       node scripts/seed_keywords.js --tenant t-scan --apply    (write)
 *       node scripts/seed_keywords.js --apply                    (all police tenants)
 *
 * Existing keywords are never modified (a keyword is unique per tenant).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const { runWithTenant } = require('../src/config/tenantContext');
const { forTenant, dbNameFor } = require('../src/config/tenantConnections');
const Tenant = require('../src/models/Tenant');
const Keyword = require('../src/models/Keyword');
const User = require('../src/models/User');
const Source = require('../src/models/Source');

// category: violence | threat | hate | other   language: en | te | hi
const COMMON = [
  // violence
  ['riot', 'violence', 'en'], ['mob attack', 'violence', 'en'], ['lynching', 'violence', 'en'],
  ['stone pelting', 'violence', 'en'], ['arson', 'violence', 'en'], ['stabbed', 'violence', 'en'],
  ['murder', 'violence', 'en'], ['clash', 'violence', 'en'],
  ['హింస', 'violence', 'te'], ['హత్య', 'violence', 'te'], ['దాడి', 'violence', 'te'],
  ['दंगा', 'violence', 'hi'], ['हिंसा', 'violence', 'hi'], ['हत्या', 'violence', 'hi'],
  // threat
  ['kill you', 'threat', 'en'], ['bomb', 'threat', 'en'], ['blast', 'threat', 'en'],
  ['death threat', 'threat', 'en'], ['will attack', 'threat', 'en'],
  ['చంపేస్తా', 'threat', 'te'], ['బెదిరింపు', 'threat', 'te'],
  ['जान से मार', 'threat', 'hi'], ['धमकी', 'threat', 'hi'],
  // hate
  ['communal', 'hate', 'en'], ['hate speech', 'hate', 'en'], ['anti-national', 'hate', 'en'],
  ['మతకలహాలు', 'hate', 'te'], ['सांप्रदायिक', 'hate', 'hi'],
  // other (law & order)
  ['bandh', 'other', 'en'], ['dharna', 'other', 'en'], ['rasta roko', 'other', 'en'],
  ['protest', 'other', 'en'], ['ganja', 'other', 'en'], ['drugs', 'other', 'en'],
  ['fake news', 'other', 'en'], ['rumour', 'other', 'en'], ['chain snatching', 'other', 'en'],
  ['బంద్', 'other', 'te'], ['ధర్నా', 'other', 'te'], ['నిరసన', 'other', 'te'], ['గంజాయి', 'other', 'te'],
  ['गांजा', 'other', 'hi'], ['अफवाह', 'other', 'hi'],
];

// District-specific terms. Districts not listed here get the generic template.
const DISTRICT = {
  Hyderabad: [
    ['old city', 'other', 'en'], ['charminar', 'other', 'en'], ['chalo assembly', 'other', 'en'],
    ['hydraa demolition', 'other', 'en'], ['traffic jam', 'other', 'en'], ['pub raid', 'other', 'en'],
    ['హైడ్రా', 'other', 'te'], ['పాతబస్తీ', 'other', 'te'],
  ],
  Mulugu: [
    ['maoist', 'violence', 'en'], ['naxal', 'violence', 'en'], ['encounter', 'violence', 'en'],
    ['sand mining', 'other', 'en'], ['medaram', 'other', 'en'], ['eturnagaram', 'other', 'en'],
    ['godavari floods', 'other', 'en'], ['ganja smuggling', 'other', 'en'],
    ['మావోయిస్టు', 'violence', 'te'], ['ఇసుక మాఫియా', 'other', 'te'],
  ],
};
const districtTemplate = (d) => [[`${d} bandh`, 'other', 'en'], [`${d} protest`, 'other', 'en'], [`${d} police`, 'other', 'en']];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;

const uniq = (list) => [...new Set(list.filter(Boolean))];

const seedTenant = async (t) => {
  const users = await User.find({ tenant_id: t.id }).select('email role districts state').lean();
  const sources = await Source.find({ tenant_id: t.id }).select('districts').lean();
  const admin = users.find((u) => u.role === 'admin');
  const officers = users.filter((u) => u.role !== 'admin' && (u.districts || []).length);
  const allDistricts = uniq([
    ...(t.police_config?.districts || []),
    ...(t.location_config?.districts || []),
    ...users.flatMap((u) => u.districts || []),
    ...sources.flatMap((s) => s.districts || []),
  ]);
  const state = t.police_config?.state || t.location_config?.state_name || admin?.state || '';

  if (!allDistricts.length) {
    console.log('  no districts configured or assigned — skipped (keywords must carry districts to be visible)');
    return { inserted: 0, skipped: 0 };
  }
  console.log(`  districts: ${allDistricts.join(', ')}   state: ${state || '-'}`);
  console.log(`  admin: ${admin?.email || '-'}   officers: ${officers.map((o) => `${o.email} [${o.districts.join(',')}]`).join('; ') || '-'}`);

  // keyword (lowercase) -> planned doc; a keyword is unique per tenant
  const plan = new Map();
  const add = ([keyword, category, language], districts, createdBy, scope) => {
    const key = keyword.toLowerCase();
    const existing = plan.get(key);
    if (existing) { existing.districts = uniq([...existing.districts, ...districts]); return; }
    plan.set(key, { keyword, category, language, districts: [...districts], created_by: createdBy, scope });
  };

  COMMON.forEach((k) => add(k, allDistricts, admin?.email || 'seed', 'common'));
  for (const officer of officers) {
    for (const d of officer.districts) {
      (DISTRICT[d] || districtTemplate(d)).forEach((k) => add(k, [d], officer.email, d));
    }
  }

  const existing = new Set((await Keyword.find({ tenant_id: t.id }).select('keyword').lean()).map((k) => k.keyword.toLowerCase()));
  let inserted = 0;
  let skipped = 0;
  const byScope = {};
  for (const [key, k] of plan) {
    if (existing.has(key)) { skipped += 1; continue; }
    byScope[k.scope] = (byScope[k.scope] || 0) + 1;
    if (apply) {
      await Keyword.create({
        tenant_id: t.id, keyword: k.keyword, category: k.category, language: k.language,
        weight: 50, is_active: true, state, districts: k.districts, created_by: k.created_by,
      });
    }
    inserted += 1;
  }
  console.log(`  ${apply ? 'inserted' : 'would insert'}: ${inserted} ${JSON.stringify(byScope)}   skipped (exists): ${skipped}`);
  return { inserted, skipped };
};

const main = async () => {
  await connectDB();
  const query = { type: 'police', ...(tenantArg ? { $or: [{ id: tenantArg }, { slug: tenantArg }] } : {}) };
  const tenants = await Tenant.find(query).select('id slug type db_name police_config location_config').lean();
  if (!tenants.length) throw new Error('No matching police tenants found.');
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} — ${tenants.length} police tenant(s)`);

  let total = 0;
  for (const t of tenants) {
    console.log(`\nTenant: ${t.slug} → ${dbNameFor(t)}`);
    const r = await runWithTenant({ tenant: t, tenantId: t.id, connection: forTenant(t) }, () => seedTenant(t));
    total += r.inserted;
  }
  console.log(`\nDone — ${apply ? 'inserted' : 'would insert'} ${total} keyword(s)`);
  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
