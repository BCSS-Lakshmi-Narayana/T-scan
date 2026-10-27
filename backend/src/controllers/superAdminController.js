const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Keyword = require('../models/Keyword');
const Alert = require('../models/Alert');
const Content = require('../models/Content');
const Grievance = require('../models/Grievance');
const AuditLog = require('../models/AuditLog');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { provisionTenantDatabase } = require('../services/tenantProvisioningService');
const { runWithTenant } = require('../config/tenantContext');
const mongoose = require('mongoose');
const { forTenant, isPerTenant, evictTenant, dbNameFor } = require('../config/tenantConnections');

// Base domain this app's tenant subdomains live under (e.g. policesaga.com →
// <slug>.policesaga.com). Configured per deployment; falls back to saga.in.
const TENANT_BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'saga.in';

// Subdomain slug rule: 3–40 chars, lowercase letters/numbers/hyphens, no leading
// or trailing hyphen. Shared by onboarding + slug-edit validation.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

// The host a tenant is reached at by convention. Stored on the tenant as `domain`
// at creation so the workspace URL is a fact in the database rather than
// something every caller re-derives — and so it can simply be edited when a
// tenant needs a host the convention cannot express (a vanity domain, or plain
// "localhost" during development).
const domainForSlug = (slug) => `${slug}.${TENANT_BASE_DOMAIN}`.toLowerCase();

// Existing tenant-facing controllers. The super admin reuses these EXACT functions
// (no reimplementation) so profiles created/edited from the super admin behave
// identically to those created by the tenant — same Source creation, POI linking,
// background scan (tenant-tagged via source.tenant_id) and audit logging.
const sourceController = require('./sourceController');
const poiController = require('./poiController');
const keywordController = require('./keywordController');
const eventController = require('./eventController');
const grievanceController = require('./grievanceController');
const blugateConfigController = require('./blugateConfigController');
const settingsController = require('./settingsController');
const alertThresholdController = require('./alertThresholdController');
const rbacController = require('./rbacController');
const authController = require('./authController');
const templatesController = require('./templatesController');
const policyController = require('./policyController');
const Source = require('../models/Source');
const { withTenant } = require('../utils/tenantFilter');
const { buildTenantStats } = require('../services/tenantStatsService');

// Resolve a tenant by its UUID and impersonate it on the request, so the delegated
// tenant controllers scope every query/write to this tenant via withTenant(req).
// A synthetic super-admin "user" is attached for created_by / audit-log fields.
const actAsTenant = async (req, tenantId) => {
  const tenant = await Tenant.findOne({ id: tenantId });
  if (!tenant) return null;
  req.tenantId = tenant.id;
  req.tenantSlug = tenant.slug;
  req.user = {
    id: 'super-admin',
    email: 'superadmin@saga-platform.in',
    full_name: 'Super Admin',
    role: 'admin',
    tenant_id: tenant.id
  };
  // The tenant's DATABASE is already in scope: the :tenantId router param put it
  // there around next() (see routes/superAdminRoutes.js). It cannot be done here
  // — this function returns across an await, and a context entered after an await
  // does not propagate back to the caller.
  return tenant;
};

const superAdminController = {
  // List all police tenants (+ user counts)
  getAllTenants: async (req, res) => {
    try {
      // db_name is selected because resolving a tenant's database honours an
      // explicit db_name before falling back to deriving one from the slug;
      // without it a relocated tenant would be counted against the wrong
      // database. db_provisioned_at gates whether that database may be opened
      // at all — see below.
      const tenants = await Tenant.find()
        .select('id slug type name status plan client_name client_email created_at db_name db_provisioned_at')
        .sort({ created_at: -1 });

      // Each tenant's users live in that tenant's own database, so the count has
      // to be taken inside that tenant's context rather than from one shared
      // users collection.
      //
      // Only tenants that have actually been provisioned are opened. Opening a
      // tenant's database compiles every model onto it, and Mongoose builds each
      // model's indexes on compile — which creates the collections. So merely
      // opening a database to look at it brings the whole thing into existence.
      // For a tenant that was never provisioned that is not a harmless read: a
      // listing would silently materialise a full database for every tenant on
      // the page. Unprovisioned tenants report 0, which is the true count.
      const withStats = await Promise.all(
        tenants.map(async (t) => {
          let user_count = 0;
          if (!isPerTenant() || t.db_provisioned_at) {
            try {
              user_count = await runWithTenant(
                { tenant: t, tenantId: t.id, connection: forTenant(t) },
                () => User.countDocuments({ tenant_id: t.id })
              );
            } catch (err) {
              console.warn(`[police.getAllTenants] user count unavailable for ${t.slug}:`, err.message);
            }
          }
          return { ...t.toObject(), user_count };
        })
      );

      res.json({ ok: true, total: withStats.length, tenants: withStats });
    } catch (error) {
      console.error('[police.getAllTenants]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Tenant detail (+ admin users)
  getTenantDetail: async (req, res) => {
    try {
      const { tenantId } = req.params;
      // The users being counted live in this tenant's own database, so resolve
      // the tenant through actAsTenant — it puts that database in scope.
      const tenant = await actAsTenant(req, tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const user_count = await User.countDocuments({ tenant_id: tenant.id });
      const admin_users = await User.find({ tenant_id: tenant.id, role: 'admin' }).select('id email full_name');

      res.json({ ok: true, tenant: { ...tenant.toObject(), user_count, admin_users } });
    } catch (error) {
      console.error('[police.getTenantDetail]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Per-tenant usage stats
  getTenantStats: async (req, res) => {
    try {
      const { tenantId } = req.params;
      // buildTenantStats reads this tenant's alerts, grievances and events, all
      // of which live in its own database — actAsTenant puts that in scope.
      const tenant = await actAsTenant(req, tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const { platform, category, handle, event, only } = req.query || {};
      const allowedOnly = ['alerts', 'grievances', 'events'];
      const stats = await buildTenantStats(tenantId, {
        filters: { platform, category, handle, event },
        only: allowedOnly.includes(only) ? only : null
      });
      res.json({ ok: true, stats });
    } catch (error) {
      console.error('[police.getTenantStats]', error);
      res.status(500).json({ message: error.message });
    }
  },

  getTenantActivity: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      let activity = [];
      try {
        activity = await AuditLog.find({ tenant_id: tenantId })
          .sort({ created_at: -1, timestamp: -1, _id: -1 })
          .limit(limit)
          .lean();
      } catch (_) { activity = []; }
      res.json({ ok: true, activity });
    } catch (error) {
      console.error('[police.getTenantActivity]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Update tenant configuration
  updateTenant: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const allowed = ['name', 'plan', 'client_name', 'client_email', 'client_phone',
        'branding', 'police_config', 'political_config', 'location_config', 'ai_config', 'feature_flags'];
      const update = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) update[key] = req.body[key];
      }

      // Subdomain (slug) edit — validate format + enforce global uniqueness
      // (excluding this tenant). The tenant_id (UUID) is the real isolation key, so
      // changing the slug only changes the access URL; existing sessions/data are safe.
      if (req.body.slug !== undefined) {
        const s = String(req.body.slug || '').toLowerCase().trim();
        if (!SLUG_RE.test(s)) {
          return res.status(400).json({ message: 'Invalid subdomain. Use 3–40 lowercase letters, numbers and hyphens (no leading/trailing hyphen).' });
        }
        const clash = await Tenant.findOne({ slug: s, id: { $ne: tenantId } });
        if (clash) return res.status(409).json({ message: 'That subdomain is already taken by another tenant.' });
        update.slug = s;

        // Move `domain` along with the slug, but ONLY while it still holds the
        // host the old slug implied. A domain that differs was set deliberately —
        // a vanity host, or "localhost" for development — and renaming the
        // subdomain is no reason to silently take it away.
        const current = await Tenant.findOne({ id: tenantId }).select('slug domain').lean();
        if (current && (!current.domain || current.domain === domainForSlug(current.slug))) {
          update.domain = domainForSlug(s);
        }
      }

      update.updated_at = new Date();

      const tenant = await Tenant.findOneAndUpdate({ id: tenantId }, { $set: update }, { new: true });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      // Drop the cached tenant context so config edits (e.g. the AI classification
      // prompt in ai_config) take effect on the NEXT analysis instead of after the TTL.
      try { require('../services/pipeline/tenantContextService').invalidate(tenantId); } catch (_) {}

      res.json({ ok: true, message: 'Tenant updated', tenant });
    } catch (error) {
      console.error('[police.updateTenant]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/default-prompts
  // Returns the built-in DEFAULT LLM prompt(s) for this tenant (runtime placeholders
  // like {{CATEGORIES}}/{{CONTENT}} kept intact) so the Super Admin "AI Prompts" editor
  // can pre-fill the box. The tenant's saved override (if any) lives in ai_config.
  getTenantDefaultPrompts: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const tenant = await Tenant.findOne({ id: tenantId });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      const { getDefaultPrompts } = require('../services/promptTemplateService');
      res.json(getDefaultPrompts()); // { classification_prompt }
    } catch (error) {
      console.error('[police.getTenantDefaultPrompts]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Update the tenant's PRIMARY ACCOUNT: app name + the admin (login) user's email
  // and/or password. Lets the super admin reset/manage the tenant's main
  // credentials. Scoped by tenant id; the admin user's UUID is resolved server-side.
  // Body: { app_name?, email?, password? }.
  updateTenantPrimaryAccount: async (req, res) => {
    try {
      const { tenantId } = req.params;
      // The admin user being edited lives in this tenant's own database, so
      // resolve through actAsTenant — it puts that database in scope.
      const tenant = await actAsTenant(req, tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const { app_name, email, password } = req.body;

      let adminUser = null;
      if (tenant.admin_user_id) {
        adminUser = await User.findOne({ tenant_id: tenantId, id: tenant.admin_user_id });
      }
      if (!adminUser) {
        adminUser = await User.findOne({ tenant_id: tenantId, role: 'admin' }).sort({ created_at: 1 });
      }

      if (app_name !== undefined && String(app_name).trim()) {
        const name = String(app_name).trim();
        tenant.name = name;
        if (!tenant.branding) tenant.branding = {};
        tenant.branding.app_name = name;
        tenant.markModified('branding');
      }

      if (email !== undefined && String(email).trim()) {
        const normEmail = String(email).trim().toLowerCase();
        const taken = await User.findOne({ email: normEmail, id: { $ne: adminUser?.id || '__none__' } });
        if (taken) return res.status(400).json({ message: 'A user with this email already exists' });
        if (adminUser) adminUser.email = normEmail;
        tenant.client_email = normEmail;
      }

      if (password !== undefined && String(password).trim()) {
        if (!adminUser) return res.status(404).json({ message: 'No admin user found for this tenant' });
        adminUser.password = await bcrypt.hash(String(password), 10);
      }

      if (adminUser) await adminUser.save();
      await tenant.save();

      res.json({
        ok: true,
        message: 'Primary account updated',
        app_name: tenant.branding?.app_name || tenant.name,
        email: adminUser?.email || tenant.client_email
      });
    } catch (error) {
      console.error('[police.updateTenantPrimaryAccount]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/branding-upload
  // Stores a base64 data-URL image on this saga's public folder; returns the URL.
  // Body: { image: 'data:image/...;base64,...', kind: 'logo' | 'photo' }
  uploadTenantBranding: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const tenant = await Tenant.findOne({ id: tenantId });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const { image, kind } = req.body;
      const k = ['logo', 'photo'].includes(kind) ? kind : 'logo';
      const m = /^data:(image\/(png|jpe?g|webp|gif|avif|svg\+xml));base64,(.+)$/i.exec(image || '');
      if (!m) return res.status(400).json({ message: 'Invalid image data' });

      const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : (m[2].toLowerCase() === 'svg+xml' ? 'svg' : m[2].toLowerCase());
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ message: 'Image too large (max 5MB)' });

      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '../../public/uploads/branding');
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${tenantId}-${k}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(dir, filename), buf);

      // Store a RELATIVE url so the asset resolves against whatever tenant
      // subdomain the browser is on (https://<slug>.<domain>/uploads/...). This
      // upload runs server-to-server (super-admin → this backend), so req.host
      // would be the internal address (localhost:8001) — never use it here.
      res.json({ ok: true, url: `/uploads/branding/${filename}` });
    } catch (error) {
      console.error('[police.uploadTenantBranding]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/branding  (targeted branding $set)
  updateTenantBranding: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const set = { updated_at: new Date() };
      ['logo_url', 'politician_photo_url', 'favicon_url', 'primary_color', 'secondary_color', 'accent_color', 'app_name', 'tagline']
        .forEach((key) => { if (req.body[key] !== undefined) set[`branding.${key}`] = req.body[key]; });

      const tenant = await Tenant.findOneAndUpdate({ id: tenantId }, { $set: set }, { new: true });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      res.json({ ok: true, branding: tenant.branding });
    } catch (error) {
      console.error('[police.updateTenantBranding]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Update tenant status
  updateTenantStatus: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { status } = req.body;
      if (!['trial', 'active', 'suspended', 'terminated'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      const tenant = await Tenant.findOneAndUpdate({ id: tenantId }, { $set: { status } }, { new: true });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      res.json({ ok: true, message: `Tenant status updated to ${status}`, tenant });
    } catch (error) {
      console.error('[police.updateTenantStatus]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Delete a tenant (+ optional data purge)
  deleteTenant: async (req, res) => {
    try {
      const { tenantId } = req.params;
      const tenant = await Tenant.findOne({ id: tenantId });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const purge = String(req.query.purge || 'false') === 'true';
      let purged = {};
      if (purge) {
        if (isPerTenant()) {
          // The tenant owns an entire database, so purging it means dropping
          // that database. Deleting row by row would clear six collections and
          // silently leave the other forty-odd behind, and an emptied database
          // still occupies the cluster's collection budget.
          const connection = forTenant(tenant);
          const dbName = connection.name;
          await connection.dropDatabase();
          purged = { database: dbName, dropped: true };
        } else {
          const [users, alerts, content, grievances, keywords, settings] = await Promise.all([
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => User.deleteMany({ tenant_id: tenantId })),
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => Alert.deleteMany({ tenant_id: tenantId })),
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => Content.deleteMany({ tenant_id: tenantId })),
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => Grievance.deleteMany({ tenant_id: tenantId })),
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => Keyword.deleteMany({ tenant_id: tenantId })),
            runWithTenant({ tenant, tenantId, connection: forTenant(tenant) }, () => Settings.deleteMany({ tenant_id: tenantId }))
          ]);
          purged = {
            users: users.deletedCount, alerts: alerts.deletedCount, content: content.deletedCount,
            grievances: grievances.deletedCount, keywords: keywords.deletedCount, settings: settings.deletedCount
          };
        }
      }

      await Tenant.deleteOne({ id: tenantId });

      // Release the cached connection. After a purge this is required for
      // correctness, not hygiene: the handle points at a database that no
      // longer exists, and re-creating a tenant with the same slug would
      // otherwise be handed that dead connection instead of opening the new
      // database. Without a purge it still frees the tenant's compiled models,
      // which the cache would otherwise hold for the life of the process.
      evictTenant(tenant);

      res.json({ ok: true, message: purge ? 'Tenant and all its data deleted' : 'Tenant deleted (data retained)', purged });
    } catch (error) {
      console.error('[police.deleteTenant]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // Create a police tenant (single-shot onboarding)
  completeOnboarding: async (req, res) => {
    try {
      const d = req.body;
      const appName = d.app_name || d.name || d.client_name;
      if (!d.client_email || !appName) {
        return res.status(400).json({ message: 'Name and email are required' });
      }
      // Normalize the admin/client email so it matches the login lookup (lowercase + trim).
      // Used for the uniqueness check, the tenant record, and the created admin user below.
      d.client_email = String(d.client_email).toLowerCase().trim();

      // Resolve a unique subdomain slug
      const base = (d.subdomain || appName || d.client_email.split('@')[0])
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
      let slug = base;
      let n = 1;
      while (await Tenant.findOne({ slug })) { slug = `${base}-${n++}`; }

      // Once every tenant has its own database there is no single users collection
      // left to scan, and an email only has to be unique inside the tenant that
      // owns it — a brand-new tenant's database is empty, so nothing can collide.
      // What still has to be unique is the admin email being onboarded, and that
      // lives on the tenant registry in the control-plane database.
      const emailTaken = isPerTenant()
        ? await Tenant.findOne({ client_email: d.client_email })
        : await User.findOne({ email: d.client_email });
      if (emailTaken) return res.status(400).json({ message: 'A user with this email already exists' });

      const providedPassword = (d.password || '').trim();
      const adminPassword = providedPassword || (uuidv4().split('-')[0].toUpperCase() + Math.random().toString(36).substr(2, 9));
      const hashedPassword = await bcrypt.hash(adminPassword, 10);

      const tenantId = uuidv4();
      const tenant = new Tenant({
        id: tenantId,
        slug,
        // The host this tenant answers on. Seeded from the subdomain convention;
        // edit it later to point the tenant at any other host.
        domain: domainForSlug(slug),
        type: 'police',
        name: appName,
        status: 'active',
        plan: d.plan || 'starter',
        client_name: d.client_name || appName,
        client_email: d.client_email,
        client_phone: d.client_phone || '',
        branding: {
          app_name: appName,
          tagline: d.tagline || 'Intelligence & Monitoring',
          logo_url: d.logo_url || '',
          favicon_url: d.favicon_url || '',
          primary_color: d.primary_color || '#0052CC',
          secondary_color: d.secondary_color || '#1F2937',
          accent_color: d.accent_color || '#F59E0B',
          dark_mode_default: d.dark_mode_default || false
        },
        // The Super Admin onboarding form sends these under a nested police_config
        // object; older/flat callers send them at the top level. Accept both.
        police_config: {
          department_name: d.police_config?.department_name || d.department_name || '',
          department_aliases: d.police_config?.department_aliases || d.department_aliases || [],
          state: d.police_config?.state || d.state || '',
          districts: d.police_config?.districts || d.districts || [],
          commandant_name: d.police_config?.commandant_name || d.commandant_name || '',
          jurisdiction_type: d.police_config?.jurisdiction_type || d.jurisdiction_type || '',
          ai_context: d.police_config?.ai_context || d.ai_context || ''
        },
        location_config: {
          region_type: d.region_type || 'state',
          region_name: d.region_name || d.state_name || '',
          state_name: d.state_name || d.state || '',
          state_code: d.state_code || '',
          districts: d.districts || [],
          constituencies: d.constituencies || [],
          city_to_district_map: d.city_to_district_map || {},
          geojson_url: d.geojson_url || ''
        },
        ai_config: {
          model: d.model || 'gpt-4',
          temperature: d.temperature !== undefined ? d.temperature : 0.7,
          max_tokens: d.max_tokens || 2000,
          system_prompt: d.system_prompt || 'You are a law-enforcement intelligence analyst.',
          sentiment_context: d.sentiment_context || '',
          analysis_focus_areas: d.analysis_focus_areas || []
        },
        feature_flags: {
          enable_location_tagging: d.enable_location_tagging !== false,
          enable_ai_analysis: d.enable_ai_analysis !== false,
          enable_sentiment_analysis: d.enable_sentiment_analysis !== false,
          enable_map_visualization: d.enable_map_visualization !== false,
          enable_grievance_workflow: d.enable_grievance_workflow !== false,
          enable_real_time_alerts: d.enable_real_time_alerts !== false,
          enable_report_generation: d.enable_report_generation !== false
        },
        onboarding: {
          wizard_completed: true,
          branding_set: !!d.logo_url,
          location_set: !!d.state_name,
          ai_set: !!d.system_prompt,
          first_login_done: false,
          tutorials_dismissed: []
        },
        trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
      await tenant.save();

      // Build this tenant's own database (collections + indexes) before anything
      // is seeded into it. In shared mode this is a no-op. Onboarding runs on a
      // super-admin route, which sits above tenantMiddleware and therefore has no
      // tenant in scope — so everything seeded below has to declare it, or the
      // models would refuse to resolve a database.
      //
      // If either the database build or the admin-user seed fails, the tenant
      // record is removed again. A tenant that exists but has no database and no
      // admin user cannot be logged into and cannot be created a second time —
      // its slug and client email are already taken — so leaving it behind turns
      // a retryable failure into one that needs manual cleanup in the database.
      let adminUserId;
      // Whether this tenant's database already existed before we touched it. If it
      // did, a failed provision must NOT drop it — that database belongs to
      // something else (a re-used slug, a restored backup) and its contents are
      // not ours to discard. Only a database this request brought into existence
      // is safe to remove on rollback.
      let dbPreexisted = false;
      if (isPerTenant()) {
        try {
          const targetDb = dbNameFor(tenant);
          const { databases } = await mongoose.connection.db.admin().listDatabases({ nameOnly: true });
          dbPreexisted = databases.some((db) => db.name === targetDb);
        } catch (e) {
          // Cannot tell — assume it existed, so rollback stays conservative.
          dbPreexisted = true;
          console.warn('[police.completeOnboarding] could not check for an existing database, rollback will not drop:', e.message);
        }
      }

      try {
        await provisionTenantDatabase(tenant.toObject ? tenant.toObject() : tenant);

        adminUserId = await runWithTenant(
          { tenant, tenantId, connection: forTenant(tenant) },
          async () => {
            const adminUser = new User({
              id: uuidv4(),
              email: d.client_email,
              password: hashedPassword,
              full_name: d.client_name || 'Admin',
              role: 'admin',
              tenant_id: tenantId,
              // State is stored for every user (including admins), from the tenant's
              // assigned state — admins aren't district-scoped, so districts stays [].
              state: tenant.police_config.state,
              is_active: true
            });
            await adminUser.save();

            // Per-tenant settings (best-effort; never block tenant creation)
            try {
              await new Settings({ id: uuidv4(), tenant_id: tenantId, alert_emails: [d.client_email] }).save();
            } catch (e) {
              console.warn('[police.completeOnboarding] settings seed skipped:', e.message);
            }

            // Seed default keywords (best-effort). Category is 'other': the
            // schema's categories are risk classifications (violence/threat/hate)
            // and onboarding keywords are general monitoring terms, not a risk
            // judgement. Passing a category outside the enum fails validation,
            // and because this seed is best-effort that failure is swallowed —
            // the tenant would simply come up with no keywords at all.
            try {
              if (Array.isArray(d.default_keywords) && d.default_keywords.length) {
                await Promise.all(d.default_keywords.map((kw) =>
                  new Keyword({ id: uuidv4(), tenant_id: tenantId, keyword: kw, category: 'other', weight: 1 }).save()
                ));
              }
            } catch (e) {
              console.warn('[police.completeOnboarding] keyword seed skipped:', e.message);
            }

            return adminUser.id;
          }
        );
      } catch (err) {
        await Tenant.deleteOne({ id: tenantId }).catch((e) =>
          console.error('[police.completeOnboarding] rollback failed, tenant record left behind:', e.message));

        // Provisioning may have created collections before it failed. Those hold no
        // data anyone wants, but they do occupy the cluster's collection budget
        // permanently with nothing pointing at them, so drop what we made.
        let droppedDb = null;
        if (isPerTenant() && !dbPreexisted) {
          const targetDb = dbNameFor(tenant);
          try {
            // Evict BEFORE dropping, and drop through the raw driver rather than
            // forTenant(). forTenant() compiles every model onto the connection, and
            // autoIndex turns that into collection creation that finishes
            // asynchronously — those writes land after the drop and rebuild the very
            // database we are removing. The driver handle creates nothing.
            evictTenant(tenant);
            const client = mongoose.connection.getClient();
            await client.db(targetDb).dropDatabase();

            // Index builds already in flight from the failed provisioning attempt can
            // still recreate collections just after the drop, so confirm and repeat
            // once rather than trusting the first call.
            const stillThere = async () => {
              const { databases } = await mongoose.connection.db.admin().listDatabases({ nameOnly: true });
              return databases.some((db) => db.name === targetDb);
            };
            if (await stillThere()) {
              await new Promise((r) => setTimeout(r, 500));
              await client.db(targetDb).dropDatabase();
            }
            droppedDb = (await stillThere()) ? null : targetDb;
            if (!droppedDb) {
              console.error(`[police.completeOnboarding] "${targetDb}" survived two drop attempts — remove it manually`);
            }
          } catch (e) {
            droppedDb = null;
            console.error('[police.completeOnboarding] could not drop the partial database:', e.message);
          }
        }

        console.error(`[police.completeOnboarding] provisioning failed for "${slug}", tenant rolled back` +
          `${droppedDb ? ` (dropped partial database "${droppedDb}")` : ''}:`, err.message);
        return res.status(500).json({ message: `Could not provision the tenant's database: ${err.message}` });
      }

      // The tenant record itself lives in the control-plane database, so this
      // write belongs outside the tenant scope above.
      tenant.admin_user_id = adminUserId;
      await tenant.save();

      res.json({
        ok: true,
        message: 'Police tenant created successfully',
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, type: tenant.type, status: tenant.status },
        admin_credentials: { email: d.client_email, password: adminPassword, temporary: !providedPassword, note: providedPassword ? 'Password set by admin' : 'Change password on first login' },
        subdomain_url: `https://${slug}.${TENANT_BASE_DOMAIN}`,
        slug
      });
    } catch (error) {
      console.error('[police.completeOnboarding]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Profile Management (monitoring profiles / sources + linked POI)
  //
  // These endpoints let the super admin configure a tenant's monitoring profiles
  // on the tenant's behalf. They impersonate the tenant (actAsTenant) and then
  // delegate to the SAME sourceController functions the tenant app uses, so the
  // behaviour is identical: Source creation + POI auto-link/create + background
  // profile fetch & initial scan + audit logging — all scoped to the tenant.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/profiles
  // Server-side paginated, tenant-scoped list of monitoring profiles (sources)
  // plus aggregate counts (per-platform totals/active + risk levels) so the admin
  // UI can render metrics & platform badges without loading every record.
  // Query: ?platform=&search=&category=&status=&page=&limit=
  listTenantProfiles: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const { platform, search, category, status } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const skip = (page - 1) * limit;

      const query = { ...withTenant(req) };
      if (platform && platform !== 'all') query.platform = platform;
      if (category && category !== 'all') query.category = String(category).toLowerCase();
      if (status === 'active') query.is_active = true;
      else if (status === 'paused') query.is_active = false;
      if (search) {
        const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = { $regex: esc, $options: 'i' };
        query.$or = [{ identifier: rx }, { display_name: rx }];
      }

      // Counts query: tenant-scoped, honours search/category/status but NOT platform.
      const countsQuery = { ...withTenant(req) };
      if (category && category !== 'all') countsQuery.category = String(category).toLowerCase();
      if (status === 'active') countsQuery.is_active = true;
      else if (status === 'paused') countsQuery.is_active = false;
      if (search) {
        const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = { $regex: esc, $options: 'i' };
        countsQuery.$or = [{ identifier: rx }, { display_name: rx }];
      }

      const [data, total, byPlatform] = await Promise.all([
        Source.find(query).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
        Source.countDocuments(query),
        Source.aggregate([
          { $match: countsQuery },
          {
            $group: {
              _id: '$platform',
              total: { $sum: 1 },
              active: { $sum: { $cond: ['$is_active', 1, 0] } },
              high: { $sum: { $cond: [{ $in: ['$risk_level', ['high', 'critical']] }, 1, 0] } },
              medium: { $sum: { $cond: [{ $eq: ['$risk_level', 'medium'] }, 1, 0] } }
            }
          }
        ])
      ]);

      const platformCounts = {};
      for (const p of byPlatform) {
        platformCounts[p._id] = { total: p.total, active: p.active, high: p.high, medium: p.medium };
      }

      res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) || 1, platformCounts });
    } catch (error) {
      console.error('[listTenantProfiles]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/profiles
  createTenantProfile: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return sourceController.createSource(req, res);
    } catch (error) {
      console.error('[createTenantProfile]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/profiles/:id
  updateTenantProfile: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return sourceController.updateSource(req, res);
    } catch (error) {
      console.error('[updateTenantProfile]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/profiles/:id
  deleteTenantProfile: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return sourceController.deleteSource(req, res);
    } catch (error) {
      console.error('[deleteTenantProfile]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/profiles/:id/toggle
  toggleTenantProfile: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return sourceController.toggleSourceStatus(req, res);
    } catch (error) {
      console.error('[toggleTenantProfile]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/profiles/:id/scan
  scanTenantProfile: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return sourceController.scanNow(req, res);
    } catch (error) {
      console.error('[scanTenantProfile]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/profiles/:id/poi
  // Returns the POI linked to a source (used to populate the edit form, mirrors
  // the tenant app's /poi/by-source/:sourceId call).
  getTenantProfilePOI: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      req.params.sourceId = req.params.id;
      return poiController.getPoiBySourceId(req, res);
    } catch (error) {
      console.error('[getTenantProfilePOI]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Keyword Management — detected-keyword matching in alert content from
  // profile monitoring. Impersonates the tenant and delegates to the SAME
  // keywordController the tenant app uses (identical behaviour & tenant scoping).
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/keywords
  listTenantKeywords: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return keywordController.getKeywords(req, res);
    } catch (error) {
      console.error('[listTenantKeywords]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/keywords
  createTenantKeyword: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return keywordController.createKeyword(req, res);
    } catch (error) {
      console.error('[createTenantKeyword]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/keywords/:id
  deleteTenantKeyword: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return keywordController.deleteKeyword(req, res);
    } catch (error) {
      console.error('[deleteTenantKeyword]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/keywords/scan
  scanTenantKeywords: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return keywordController.triggerRescan(req, res);
    } catch (error) {
      console.error('[scanTenantKeywords]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Report-Template Management. Impersonates the tenant and delegates to
  // the SAME templatesController the tenant app uses, so templates created/edited
  // from the super admin are tenant-scoped (tenant_id) and behave identically
  // (DOCX parse, default toggle, {{PLACEHOLDER}} interpolation) to tenant-created
  // ones. These are the report templates selected during escalation report gen.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/templates
  listTenantTemplates: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return templatesController.getTemplates(req, res);
    } catch (error) {
      console.error('[listTenantTemplates]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/templates/:id
  getTenantTemplate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return templatesController.getTemplate(req, res);
    } catch (error) {
      console.error('[getTenantTemplate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/templates
  // Body: { name, platform?, is_default?, file_base64 } where file_base64 is the
  // DOCX (raw base64 or a data: URL). We synthesize req.file so the delegated
  // uploadTemplate runs its exact DOCX-parse + tenant-scoped create path.
  createTenantTemplate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const raw = req.body?.file_base64 || req.body?.file || '';
      if (!raw) return res.status(400).json({ message: 'file_base64 (DOCX) is required' });
      const b64 = String(raw).includes(',') ? String(raw).split(',').pop() : String(raw);
      req.file = { buffer: Buffer.from(b64, 'base64') };
      return templatesController.uploadTemplate(req, res);
    } catch (error) {
      console.error('[createTenantTemplate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/templates/parse
  // Body: { file_base64 } (raw base64 or data: URL). Converts the uploaded DOCX to
  // HTML so the super admin can edit it before saving (the "Parse & Edit" flow),
  // delegating to the SAME templatesController.parseTemplate the tenant app uses.
  // No DB write — pure DOCX→HTML — but we still validate the tenant exists.
  parseTenantTemplate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

      const raw = req.body?.file_base64 || req.body?.file || '';
      if (!raw) return res.status(400).json({ message: 'file_base64 (DOCX) is required' });
      const b64 = String(raw).includes(',') ? String(raw).split(',').pop() : String(raw);
      req.file = { buffer: Buffer.from(b64, 'base64') };
      return templatesController.parseTemplate(req, res);
    } catch (error) {
      console.error('[parseTenantTemplate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/templates/:id/content
  updateTenantTemplateContent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return templatesController.updateTemplateContent(req, res);
    } catch (error) {
      console.error('[updateTenantTemplateContent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/templates/:id/default
  setTenantTemplateDefault: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return templatesController.setDefaultTemplate(req, res);
    } catch (error) {
      console.error('[setTenantTemplateDefault]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/templates/:id
  deleteTenantTemplate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return templatesController.deleteTemplate(req, res);
    } catch (error) {
      console.error('[deleteTenantTemplate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Policy-Mapping Management (Policy Manager). Impersonates the tenant and
  // delegates to the SAME policyController the tenant app uses, so category →
  // legal-section + platform-policy mappings created/edited from the super admin are
  // tenant-scoped (tenant_id) and drive that tenant's analysis (mappingService is
  // tenant-aware). policyController reads the policy _id from req.params.id.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/policies
  listTenantPolicies: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return policyController.getPolicies(req, res);
    } catch (error) {
      console.error('[listTenantPolicies]', error.message);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/policies/:id
  getTenantPolicy: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return policyController.getPolicy(req, res);
    } catch (error) {
      console.error('[getTenantPolicy]', error.message);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/policies
  createTenantPolicy: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return policyController.createPolicy(req, res);
    } catch (error) {
      console.error('[createTenantPolicy]', error.message);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/policies/:id
  updateTenantPolicy: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return policyController.updatePolicy(req, res);
    } catch (error) {
      console.error('[updateTenantPolicy]', error.message);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/policies/:id
  deleteTenantPolicy: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return policyController.deletePolicy(req, res);
    } catch (error) {
      console.error('[deleteTenantPolicy]', error.message);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Event Management (event-based monitoring: name, location, date range,
  // multilingual keywords + polling interval). Impersonates the tenant and
  // delegates to the SAME eventController the tenant app uses, so behaviour,
  // payload normalization, status lifecycle and tenant scoping are identical.
  //
  // NOTE: the tenant eventController reads the event id from req.params.id, so
  // these routes must use :id (not :eventId).
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/events  (?status=)
  listTenantEvents: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.listEvents(req, res);
    } catch (error) {
      console.error('[listTenantEvents]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/events
  createTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.createEvent(req, res);
    } catch (error) {
      console.error('[createTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/events/:id
  updateTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.updateEvent(req, res);
    } catch (error) {
      console.error('[updateTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/events/:id
  deleteTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.deleteEvent(req, res);
    } catch (error) {
      console.error('[deleteTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/events/:id/pause
  pauseTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.pauseEvent(req, res);
    } catch (error) {
      console.error('[pauseTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/events/:id/resume
  resumeTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.resumeEvent(req, res);
    } catch (error) {
      console.error('[resumeTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/events/:id/archive
  archiveTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.archiveEvent(req, res);
    } catch (error) {
      console.error('[archiveTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/events/:id/scan
  // Manually fetch & analyse new content for the event ("Fetch Now").
  scanTenantEvent: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return eventController.runEventScan(req, res);
    } catch (error) {
      console.error('[scanTenantEvent]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Grievance Management (POLICE).
  //
  // CONFIG = the monitored government "mention handles" (GrievanceSource records)
  // used for grievance content fetching. The rest is read-only analytics for the
  // grievance visuals (total, pending, escalated, closed, FIR, platform-wise).
  //
  // NOTE on divergence: the police grievance module is workflow-status driven
  // (pending/escalated/closed/FIR) and does NOT expose sentiment / category /
  // topic analytics like the political module — so only stats + dashboard are
  // delegated here. Impersonates the tenant and delegates to the SAME
  // grievanceController the tenant app uses (source id read from req.params.id).
  // ───────────────────────────────────────────────────────────────────────────

  // ── BluGate credentials ────────────────────────────────────────────────
  // BluGate issues ONE API key + client code per tenant; the same pair serves
  // every platform. Stored in the tenant's own database, write-only over the
  // wire: responses say whether a credential is set, never what it is.

  // GET /api/super-admin/tenants/:tenantId/blugate
  getTenantBlugate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return blugateConfigController.get(req, res);
    } catch (error) {
      console.error('[getTenantBlugate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/blugate
  updateTenantBlugate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return blugateConfigController.upsert(req, res);
    } catch (error) {
      console.error('[updateTenantBlugate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/blugate
  deleteTenantBlugate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return blugateConfigController.remove(req, res);
    } catch (error) {
      console.error('[deleteTenantBlugate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/blugate/test/:slug
  testTenantBlugate: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return blugateConfigController.test(req, res);
    } catch (error) {
      console.error('[testTenantBlugate]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/grievance-sources  (?platform=)
  listTenantGrievanceSources: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.getSources(req, res);
    } catch (error) {
      console.error('[listTenantGrievanceSources]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/grievance-sources
  createTenantGrievanceSource: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.addSource(req, res);
    } catch (error) {
      console.error('[createTenantGrievanceSource]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/grievance-sources/:id
  updateTenantGrievanceSource: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.updateSource(req, res);
    } catch (error) {
      console.error('[updateTenantGrievanceSource]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/grievance-sources/:id
  deleteTenantGrievanceSource: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.deleteSource(req, res);
    } catch (error) {
      console.error('[deleteTenantGrievanceSource]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/grievance-stats
  // Returns { total, pending, escalated, closed, converted_to_fir, byCategory, ... }.
  getTenantGrievanceStats: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.getStats(req, res);
    } catch (error) {
      console.error('[getTenantGrievanceStats]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/grievance-dashboard  (platform-wise)
  getTenantGrievanceDashboard: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return grievanceController.getDashboardStats(req, res);
    } catch (error) {
      console.error('[getTenantGrievanceDashboard]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Threshold / Configuration Management.
  //
  // Lets the super admin control a tenant's monitoring configuration: the
  // per-platform/per-category monitoring frequency matrix, events & grievance
  // intervals + on/off switches, risk levels (all in Settings.api_config), and
  // the per-platform viral velocity thresholds (AlertThreshold). Impersonates the
  // tenant and delegates to the SAME settings / alert-threshold controllers the
  // tenant app uses — identical behaviour and tenant scoping.
  //
  // The tenant settings/threshold controllers gate writes on a superadmin/analyst
  // role, so we elevate the synthetic actor's role accordingly before delegating.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/settings
  getTenantSettings: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return settingsController.getSettings(req, res);
    } catch (error) {
      console.error('[getTenantSettings]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/settings
  updateTenantSettings: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      req.user.role = 'superadmin'; // pass the controller's role gate
      return settingsController.updateSettings(req, res);
    } catch (error) {
      console.error('[updateTenantSettings]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/alert-thresholds
  getTenantAlertThresholds: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return alertThresholdController.getAlertThresholds(req, res);
    } catch (error) {
      console.error('[getTenantAlertThresholds]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/alert-thresholds/bulk
  updateTenantAlertThresholds: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      req.user.role = 'superadmin'; // pass the controller's role gate
      return alertThresholdController.bulkUpdateThresholds(req, res);
    } catch (error) {
      console.error('[updateTenantAlertThresholds]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Tenant Access Management (officers/users + page/feature permissions).
  //
  // Lets the super admin create application users for a tenant and assign
  // page/feature-level permissions. Impersonates the tenant (actAsTenant) and
  // delegates to the SAME rbacController / authController the tenant app uses, so
  // every read/write is tenant-scoped (withTenant + tenant_id binding) exactly
  // like the tenant's own Access Management page.
  //
  // NOTE: rbac handlers read the user id from req.params.userId.
  // ───────────────────────────────────────────────────────────────────────────

  // GET /api/super-admin/tenants/:tenantId/users
  listTenantUsers: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.getAllUsers(req, res);
    } catch (error) {
      console.error('[listTenantUsers]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/access-pages
  getTenantAccessPages: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.getAllPages(req, res);
    } catch (error) {
      console.error('[getTenantAccessPages]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/users
  // actAsTenant sets req.tenantId from the URL, and rbacController.createUser binds
  // the new user to req.tenantId — so the user can only belong to the targeted tenant.
  createTenantUser: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.createUser(req, res);
    } catch (error) {
      console.error('[createTenantUser]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/users/:userId
  updateTenantUser: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.updateUser(req, res);
    } catch (error) {
      console.error('[updateTenantUser]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // DELETE /api/super-admin/tenants/:tenantId/users/:userId
  deleteTenantUser: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.deleteUser(req, res);
    } catch (error) {
      console.error('[deleteTenantUser]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // GET /api/super-admin/tenants/:tenantId/users/:userId/permissions
  getTenantUserPermissions: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.getUserPermissions(req, res);
    } catch (error) {
      console.error('[getTenantUserPermissions]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/tenants/:tenantId/users/:userId/permissions
  updateTenantUserPermissions: async (req, res) => {
    try {
      const tenant = await actAsTenant(req, req.params.tenantId);
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      return rbacController.updateUserPermissions(req, res);
    } catch (error) {
      console.error('[updateTenantUserPermissions]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ── Viral Campaign requests (cross-tenant; service-key only) ───────────────
  // The orchestrator aggregates requests from every tenant of this vertical so the
  // super admin can validate them. This is intentionally NOT tenant-scoped — it is
  // reachable only via the service-key super-admin routes, never the tenant JWT.

  // GET /api/super-admin/viral-campaigns?status=
  listAllViralCampaigns: async (req, res) => {
    try {
      const ViralCampaign = require('../models/ViralCampaign');
      const query = {};
      if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
      const requests = await ViralCampaign.find(query).sort({ created_at: -1 }).lean();
      const tenantIds = [...new Set(requests.map((r) => r.tenant_id).filter(Boolean))];
      const tenants = await Tenant.find({ id: { $in: tenantIds } }).select('id name slug').lean();
      const nameById = new Map(tenants.map((t) => [t.id, t.name || t.slug || t.id]));
      res.json({ ok: true, requests: requests.map((r) => ({ ...r, tenant_name: nameById.get(r.tenant_id) || r.tenant_id })) });
    } catch (error) {
      console.error('[listAllViralCampaigns]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/viral-campaigns/:id
  updateViralCampaignAdmin: async (req, res) => {
    try {
      const ViralCampaign = require('../models/ViralCampaign');
      const campaign = await ViralCampaign.findOne({ id: req.params.id });
      if (!campaign) return res.status(404).json({ message: 'Viral campaign not found' });
      const allowed = ['status', 'approved_budget', 'offer_type', 'fixed_amount', 'linked_campaign_id', 'rejection_reason', 'results'];
      allowed.forEach((f) => { if (req.body[f] !== undefined) campaign[f] = req.body[f]; });
      await campaign.save();
      res.json({ ok: true, campaign });
    } catch (error) {
      console.error('[updateViralCampaignAdmin]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // ── AI Campaign Suggestions (cross-tenant; service-key only) ───────────────
  // Generated on demand from a single tenant's own grievances + alerts.

  // GET /api/super-admin/campaign-suggestions?status=
  listAllCampaignSuggestions: async (req, res) => {
    try {
      const CampaignSuggestion = require('../models/CampaignSuggestion');
      const query = {};
      if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
      else if (!req.query.status) query.status = 'new';
      const suggestions = await CampaignSuggestion.find(query)
        .sort({ impact_score: -1, urgency_score: -1, created_at: -1 }).lean();
      const tenantIds = [...new Set(suggestions.map((s) => s.tenant_id).filter(Boolean))];
      const tenants = await Tenant.find({ id: { $in: tenantIds } }).select('id name slug').lean();
      const nameById = new Map(tenants.map((t) => [t.id, t.name || t.slug || t.id]));
      res.json({ ok: true, suggestions: suggestions.map((s) => ({ ...s, tenant_name: nameById.get(s.tenant_id) || s.tenant_id })) });
    } catch (error) {
      console.error('[listAllCampaignSuggestions]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // POST /api/super-admin/tenants/:tenantId/campaign-suggestions/generate
  generateCampaignSuggestions: async (req, res) => {
    try {
      const tenant = await Tenant.findOne({ id: req.params.tenantId });
      if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
      const { generateForTenant } = require('../services/campaignSuggestionService');
      const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 30);
      const suggestions = await generateForTenant(tenant.id, { days });
      res.json({ ok: true, suggestions });
    } catch (error) {
      if (error.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ message: error.message });
      console.error('[generateCampaignSuggestions]', error);
      res.status(500).json({ message: error.message });
    }
  },

  // PUT /api/super-admin/campaign-suggestions/:id  (status / linked_campaign_id)
  updateCampaignSuggestion: async (req, res) => {
    try {
      const CampaignSuggestion = require('../models/CampaignSuggestion');
      const suggestion = await CampaignSuggestion.findOne({ id: req.params.id });
      if (!suggestion) return res.status(404).json({ message: 'Suggestion not found' });
      ['status', 'linked_campaign_id'].forEach((f) => { if (req.body[f] !== undefined) suggestion[f] = req.body[f]; });
      await suggestion.save();
      res.json({ ok: true, suggestion });
    } catch (error) {
      console.error('[updateCampaignSuggestion]', error);
      res.status(500).json({ message: error.message });
    }
  }
};

module.exports = superAdminController;
