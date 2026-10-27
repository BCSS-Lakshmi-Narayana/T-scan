/**
 * Seed one tenant's database with demo data.
 *
 *   node src/scripts/seed-tenant-demo-data.js <tenant-slug>
 *   node src/scripts/seed-tenant-demo-data.js <tenant-slug> --wipe
 *
 * Every document it writes carries an id beginning "demo-<slug>-", which is what
 * --wipe matches on, so re-seeding never duplicates and never touches real rows.
 *
 * The point of this data is to make tenant ISOLATION visible: every string it
 * writes embeds the tenant's own slug. If one tenant's screen ever shows another
 * tenant's slug, the leak is obvious at a glance rather than needing a query.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const connectDB = require('../config/db');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant, isPerTenant, dbNameFor } = require('../config/tenantConnections');

// Registering every model is what lets a tenant connection resolve refs.
for (const f of fs.readdirSync(path.join(__dirname, '..', 'models'))) {
  if (f.endsWith('.js')) { try { require(`../models/${f}`); } catch (_) { /* not a model */ } }
}
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Source = require('../models/Source');
const Keyword = require('../models/Keyword');
const Content = require('../models/Content');
const Alert = require('../models/Alert');
const Grievance = require('../models/Grievance');
const POI = require('../models/POI');
const PagePermission = require('../models/PagePermission');
const PolicyMapping = require('../models/PolicyMapping');
const LegalSection = require('../models/LegalSection');
const PlatformPolicy = require('../models/PlatformPolicy');
const Event = require('../models/Event');
const AlertThreshold = require('../models/AlertThreshold');

// This app's User roles. Police has no analyst/viewer tier.
const ROLES = { second: 'admin', third: 'level-1' };
const DEMO_PASSWORD = 'Demo#12345';

// Page paths this product actually defines (config/rbacConfig.js). A non-admin
// user with no PagePermission row falls back to /dashboard ONLY, so without these
// rows the seeded accounts can log in but cannot navigate anywhere.
const BROAD_PAGES = ['/dashboard', '/alerts', '/grievances', '/events', '/person-of-interest',
  '/intelligence-dashboard', '/global-search', '/settings'];
const NARROW_PAGES = ['/dashboard', '/alerts', '/grievances'];

const PLATFORMS = ['x', 'youtube', 'facebook', 'instagram'];
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const main = async () => {
  const slug = process.argv[2];
  const wipe = process.argv.includes('--wipe');
  if (!slug) {
    console.error('usage: node src/scripts/seed-tenant-demo-data.js <tenant-slug> [--wipe]');
    process.exit(1);
  }

  await connectDB();
  const tenant = await Tenant.findOne({ slug });
  if (!tenant) {
    console.error(`No tenant with slug "${slug}" in this product's registry.`);
    const all = await Tenant.find({}).select('slug type').lean();
    console.error('available:', all.map((t) => `${t.slug} (${t.type})`).join(', ') || '(none)');
    process.exit(1);
  }

  const tenantId = tenant.id;
  const P = `demo-${slug}`;                 // id prefix — the handle for --wipe
  const connection = forTenant(tenant);
  console.log(`tenant "${slug}" (${tenant.type})  →  ${isPerTenant() ? dbNameFor(tenant) : connection.name}\n`);

  await runWithTenant({ tenant, tenantId, connection }, async () => {
    // ── wipe ────────────────────────────────────────────────────────────────
    // Most models carry an `id` path we can prefix, but POI does not — an `id`
    // passed to it is silently dropped by strict mode, so a row seeded that way
    // would be invisible to both the count and the wipe. Match POI on its name.
    const byPrefix = { id: new RegExp(`^${P}-`) };
    const DEMO = [
      ['users', User, byPrefix],
      ['sources', Source, byPrefix],
      ['keywords', Keyword, byPrefix],
      ['content', Content, byPrefix],
      ['alerts', Alert, byPrefix],
      ['grievances', Grievance, byPrefix],
      ['pois', POI, { name: new RegExp(`^${slug} POI `) }],
      // These models define no `id` path either — match them on a field they do have.
      ['permissions', PagePermission, { user_id: new RegExp(`^${P}-`) }],
      ['policymaps', PolicyMapping, { category_id: new RegExp(`^${slug}_`) }],
      ['legalsections', LegalSection, { section: new RegExp(`^${slug}-`) }],
      ['platformpolicies', PlatformPolicy, { policy_id: new RegExp(`^${P}-`) }],
      ['events', Event, byPrefix],
      ['thresholds', AlertThreshold, byPrefix],
    ];

    const removed = {};
    for (const [name, Model, filter] of DEMO) {
      const r = await Model.deleteMany(filter);
      if (r.deletedCount) removed[name] = r.deletedCount;
    }
    if (Object.keys(removed).length) {
      console.log('cleared previous demo rows:', JSON.stringify(removed));
    }
    if (wipe) { console.log('\n--wipe: nothing seeded.'); return; }

    // ── users ───────────────────────────────────────────────────────────────
    const hashed = await bcrypt.hash(DEMO_PASSWORD, 10);
    const users = [
      { id: `${P}-u1`, email: `analyst@${slug}.demo`, full_name: `${slug} Analyst`, role: ROLES.second },
      { id: `${P}-u2`, email: `officer@${slug}.demo`, full_name: `${slug} Officer`, role: ROLES.third },
    ];
    for (const u of users) {
      await new User({ ...u, password: hashed, tenant_id: tenantId, is_active: true }).save();
    }

    // ── sources ─────────────────────────────────────────────────────────────
    const sources = PLATFORMS.map((platform, i) => ({
      id: `${P}-s${i + 1}`,
      tenant_id: tenantId,
      platform,
      identifier: `${slug}_${platform}_handle`,
      display_name: `${slug} ${platform} feed`,
      priority: ['high', 'medium', 'low', 'medium'][i],
      risk_level: ['high', 'medium', 'low', 'critical'][i],
      created_by: `${P}-u1`,
      is_active: true,
    }));
    await Source.insertMany(sources);

    // ── keywords ────────────────────────────────────────────────────────────
    const keywords = [
      { k: `${slug} protest`, c: 'threat' },
      { k: `${slug} rally`, c: 'other' },
      { k: `${slug} unrest`, c: 'violence' },
      { k: `${slug} rumour`, c: 'hate' },
      { k: `${slug} traffic`, c: 'other' },
    ].map((x, i) => ({
      id: `${P}-k${i + 1}`, tenant_id: tenantId, keyword: x.k, category: x.c,
      language: 'en', weight: (i % 3) + 1, is_active: true,
    }));
    await Keyword.insertMany(keywords);

    // ── content ─────────────────────────────────────────────────────────────
    const risks = ['low', 'medium', 'high', 'critical'];
    const sentiments = ['positive', 'neutral', 'negative'];
    const contents = Array.from({ length: 12 }, (_, i) => {
      const platform = PLATFORMS[i % PLATFORMS.length];
      return {
        id: `${P}-c${i + 1}`,
        tenant_id: tenantId,
        source_id: `${P}-s${(i % 4) + 1}`,
        platform,
        content_type: platform === 'youtube' ? 'video' : 'post',
        content_id: `${P}-post-${i + 1}`,
        content_url: `https://example.invalid/${slug}/post/${i + 1}`,
        text: `[${slug}] Demo post ${i + 1} — mentions ${slug} rally near the district office.`,
        author: `${slug} Author ${(i % 4) + 1}`,
        author_handle: `@${slug}_author${(i % 4) + 1}`,
        published_at: daysAgo(i),
        risk_level: risks[i % risks.length],
        sentiment: sentiments[i % sentiments.length],
        availability_status: 'available',
      };
    });
    await Content.insertMany(contents);

    // ── alerts (one per high/critical item) ─────────────────────────────────
    const alerts = contents
      .filter((c) => c.risk_level === 'high' || c.risk_level === 'critical')
      .map((c, i) => ({
        id: `${P}-a${i + 1}`,
        tenant_id: tenantId,
        content_id: c.id,
        alert_type: i % 2 === 0 ? 'keyword_risk' : 'ai_risk',
        priority: c.risk_level === 'critical' ? 'HIGH' : 'MEDIUM',
        risk_level: c.risk_level === 'critical' ? 'high' : 'medium',
        title: `[${slug}] ${c.risk_level} risk on ${c.platform}`,
        description: `Flagged for review in tenant ${slug}. Source: ${c.author_handle}.`,
        content_url: c.content_url,
        platform: c.platform,
        author: c.author,
        status: ['active', 'acknowledged', 'resolved'][i % 3],
        created_at: c.published_at,
      }));
    await Alert.insertMany(alerts);

    // ── grievances ──────────────────────────────────────────────────────────
    const grievances = Array.from({ length: 5 }, (_, i) => ({
      id: `${P}-g${i + 1}`,
      tenant_id: tenantId,
      tweet_id: `${P}-tweet-${i + 1}`,
      tagged_account: `@${slug}_official`,
      platform: 'x',
      posted_by: { handle: `@${slug}_citizen${i + 1}`, name: `${slug} Citizen ${i + 1}` },
      content: { text: `[${slug}] Grievance ${i + 1}: streetlight outage reported in ward ${i + 1}.` },
      tweet_url: `https://example.invalid/${slug}/grievance/${i + 1}`,
      post_date: daysAgo(i * 2),
      workflow_status: ['received', 'reviewed', 'action_taken', 'closed', 'received'][i],
      classification: ['complaint', 'acknowledged', 'complaint', 'unclassified', 'complaint'][i],
      complaint: { priority: ['high', 'medium', 'low', 'medium', 'critical'][i], status: 'pending' },
    }));
    await Grievance.insertMany(grievances);

    // ── POIs ────────────────────────────────────────────────────────────────
    // POI takes no `id` — see the DEMO table above.
    await POI.insertMany(Array.from({ length: 3 }, (_, i) => ({
      tenant_id: tenantId,
      name: `${slug} POI ${i + 1}`,
      status: 'active',
    })));

    // ── page permissions ────────────────────────────────────────────────────
    // Without these, any user whose role is not admin/superadmin sees only
    // /dashboard. Two different page sets so RBAC itself is visibly exercised:
    // the second account should be missing pages the first one has.
    const permsFor = (pages) => Object.fromEntries(pages.map((p) => [p, { enabled: true, features: [] }]));
    for (const [u, pages] of [[users[0], BROAD_PAGES], [users[1], NARROW_PAGES]]) {
      await PagePermission.create({
        tenant_id: tenantId,
        user_id: u.id,
        permissions: permsFor(pages),
        allowed_pages: pages,
        updated_by: 'seed-tenant-demo-data',
      });
    }

    // ── mapping engine (legal sections, platform policies, mappings) ────────
    // Also the fixture that makes mappingService's per-tenant load observable:
    // each tenant's categories are prefixed with its own slug.
    await LegalSection.insertMany([
      { tenant_id: tenantId, act: 'BNS 2023', section: `${slug}-196`, description: `Promoting enmity (${slug} demo)`, mapped_intent: 'Threat_Incitement' },
      { tenant_id: tenantId, act: 'BNS 2023', section: `${slug}-353`, description: `Public mischief (${slug} demo)`, mapped_intent: 'Harassment_Abuse' },
    ]);
    await PlatformPolicy.insertMany([
      { tenant_id: tenantId, platform: 'x', policy_name: `${slug} Hateful conduct`, policy_id: `${P}-pol1`, description: `Demo policy for ${slug}.` },
      { tenant_id: tenantId, platform: 'youtube', policy_name: `${slug} Harassment`, policy_id: `${P}-pol2`, description: `Demo policy for ${slug}.` },
    ]);
    await PolicyMapping.insertMany([
      {
        tenant_id: tenantId, category_id: `${slug}_Hate_Speech`, definition: `Hate speech mapping for ${slug}`,
        severity_level: 'High', is_active: true, keywords: [`${slug} hate`],
        legal_sections: [{ code: `${slug}-196`, title: 'Promoting enmity' }],
      },
      {
        tenant_id: tenantId, category_id: `${slug}_Public_Order`, definition: `Public order mapping for ${slug}`,
        severity_level: 'Medium', is_active: true, keywords: [`${slug} unrest`],
        legal_sections: [{ code: `${slug}-353`, title: 'Public mischief' }],
      },
    ]);

    // ── events ──────────────────────────────────────────────────────────────
    await Event.insertMany(Array.from({ length: 3 }, (_, i) => ({
      id: `${P}-e${i + 1}`,
      tenant_id: tenantId,
      name: `${slug} Event ${i + 1}`,
      status: ['active', 'planned', 'archived'][i],
      origin: 'manual',
    })));

    // ── alert thresholds ────────────────────────────────────────────────────
    // A unique index on (tenant_id, platform) caps this at one row per platform,
    // so a tenant that already has thresholds cannot take an insert. Upsert instead
    // — that keeps whatever the tenant already configured and fills in the rest.
    for (const platform of PLATFORMS) {
      await AlertThreshold.updateOne(
        { tenant_id: tenantId, platform },
        { $setOnInsert: { id: `${P}-t-${platform}`, tenant_id: tenantId, platform } },
        { upsert: true }
      );
    }

    // ── report ──────────────────────────────────────────────────────────────
    console.log('seeded:');
    for (const [label, Model, filter] of DEMO) {
      console.log(`  ${label.padEnd(11)} ${await Model.countDocuments(filter)}`);
    }
    console.log(`\nlogin: analyst@${slug}.demo / ${DEMO_PASSWORD}  (${ROLES.second}) → ${BROAD_PAGES.length} pages`);
    console.log(`       officer@${slug}.demo / ${DEMO_PASSWORD}  (${ROLES.third}) → ${NARROW_PAGES.length} pages`);
  });

  await mongoose.disconnect();
};

main().catch((e) => { console.error('\nseed failed:', e.message); process.exit(1); });
