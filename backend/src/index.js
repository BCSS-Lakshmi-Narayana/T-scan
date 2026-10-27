require('dotenv').config();
const express = require('express');
const { initTrendsQueue } = require('./queues/trendsQueue');
const { registerWorker } = require('./workers/trendsWorker');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const connectDB = require('./config/db');
const { startMonitoring } = require('./services/monitorService');
const { startTempContentProcessor } = require('./services/tempContentProcessor');
const { seedDefaultThresholds } = require('./services/velocityAlertService');
const grievanceService = require('./services/grievanceService');
const User = require('./models/User');
const Settings = require('./models/Settings');
const Source = require('./models/Source');
const Content = require('./models/Content');
const Report = require('./models/Report');
const GrievanceSource = require('./models/GrievanceSource');
const SearchHistory = require('./models/SearchHistory');
const { buildYouTubeClient } = require('./services/youtube.service');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { seedRecurringEvents } = require('./controllers/masterCalendarController');
const { syncCalendarToEvents } = require('./services/calendarEventSyncService');
const fs = require('fs');
const tenantMiddleware = require('./middleware/tenantMiddleware');
const jwtMiddleware = require('./middleware/jwtMiddleware');
const tenantValidationMiddleware = require('./middleware/tenantValidationMiddleware');
const { isPerTenant } = require('./config/tenantConnections');

const app = express();

// Trust proxy for proper protocol detection behind nginx/load balancer
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'x-requested-with', 'X-Tenant-Slug', 'X-District-Filter']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(mongoSanitize());

// Never let the browser's HTTP cache serve one user's API response to another.
// Without this, the private browser cache keys GET responses by URL alone (it
// does not vary on the Authorization header), so switching accounts in the same
// browser tab/session (e.g. testing multiple district officers) can silently
// replay a previous user's tenant/district-scoped JSON for an identical GET URL
// (e.g. GET /api/alerts?limit=20) — this looks exactly like a server-side data
// leak but is purely a client cache-header gap. Every /api/* response is
// per-user and must always be revalidated.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Serve static files from public directory
app.use(express.static(require('path').join(__dirname, '../public')));

// Health check (public, used by Super Admin orchestrator)
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'police-saga', time: new Date().toISOString() }));

// Super Admin (service-to-service) routes — guarded by a shared service key,
// registered BEFORE tenant resolution so they don't require a tenant subdomain.
app.use('/api/super-admin', require('./routes/superAdminRoutes'));

// Media proxy/streaming — mounted BEFORE the tenant + JWT gates because native
// <img>/<video> elements cannot attach an Authorization or X-Tenant-Slug header,
// so they would otherwise 401 at the global JWT gate. Safe because:
//  - the streaming endpoints (/stream, /downloads, /proxy, /status) enforce a CDN
//    host allowlist (no open proxy) and carry no tenant-scoped data;
//  - the mutating endpoints (/download, /download-video, /resolve, ...) self-protect
//    via `protect` + RBAC at the route level (protect sets req.user/req.tenantId
//    from the Bearer token independently).
app.use('/api/media', require('./routes/media.routes'));

// Tenant resolution (all requests)
app.use(tenantMiddleware);

// Put the resolved tenant's database in scope. A no-op while TENANT_DB_MODE is
// "shared"; once flipped to "per-tenant" every model below reads that tenant's
// own database. Must sit directly after tenantMiddleware, which sets req.tenant.
app.use(require('./middleware/tenantDbMiddleware'));

// ── On-prem file serving (tenant-isolated) — replaces AWS S3 hosting ──
// Mounted AFTER tenantMiddleware (so req.tenantId is set from the subdomain)
// but BEFORE the JWT gate (so native <img>/<video>/<a>/QR requests, which can't
// send an Authorization header, still load). Each request is served ONLY from
// storage/<tenant_id>/… — the tenant comes from the request, never the URL, so
// a file URL is meaningless outside its own tenant subdomain and one tenant can
// never read another tenant's files.
{
  const filePath = require('path');
  const fileFs = require('fs');
  const FILE_STORAGE_DIR = process.env.FILE_STORAGE_DIR || filePath.join(__dirname, '..', 'storage');
  const safeTenantSeg = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');
  const serveTenantFile = (req, res) => {
    if (!req.tenantId) return res.status(403).end();
    let rel;
    try { rel = decodeURIComponent(req.params[0] || ''); } catch (_) { return res.status(400).end(); }
    const tenantRoot = filePath.join(FILE_STORAGE_DIR, safeTenantSeg(req.tenantId));
    const abs = filePath.join(tenantRoot, rel);
    // Path-traversal guard: resolved path must stay inside this tenant's folder.
    if (!filePath.resolve(abs).startsWith(filePath.resolve(tenantRoot))) return res.status(400).end();
    if (!fileFs.existsSync(abs) || !fileFs.statSync(abs).isFile()) return res.status(404).end();
    if (abs.toLowerCase().endsWith('.pdf')) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filePath.basename(abs)}"`);
    }
    return res.sendFile(abs);
  };
  // Both /files and /api/files (the latter so reverse proxies that only forward
  // /api still expose stored files).
  app.get('/files/*', serveTenantFile);
  app.get('/api/files/*', serveTenantFile);
}

// Public routes (no auth required)
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/tenant', require('./routes/tenantRoutes')); // Includes public /public-config endpoint

// Protected routes (auth required)
app.use(jwtMiddleware);
app.use(tenantValidationMiddleware);
// REMOVED: queryScopingMiddleware - use withTenant() utility instead for explicit filtering.
// The global Query.prototype monkey-patch was unsafe: it shared a per-request tenantId across
// the global mongoose prototype (cross-tenant leakage under concurrency), re-wrapped the prototype
// on every request (memory/perf leak), and did not cover aggregate/countDocuments/create. All
// controllers now scope explicitly via withTenant(req, ...).

// Routes
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/sources', require('./routes/sourceRoutes'));
app.use('/api/content', require('./routes/contentRoutes'));
app.use('/api/alerts', require('./routes/alertRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/command-center', require('./routes/commandCenterRoutes'));
app.use('/api/intelligence', require('./routes/intelligenceDashboardRoutes'));
app.use('/api/keywords', require('./routes/keywordRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));
app.use('/api/history-logs', require('./routes/historyLogRoutes'));
app.use('/api/youtube', require('./routes/youtube.routes'));
app.use('/api/x', require('./routes/x.routes'));
// NOTE: '/api/media' is mounted earlier (before the JWT gate) so media elements can load.
app.use('/api/search', require('./routes/searchRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/viral-campaigns', require('./routes/viralCampaignRoutes'));
app.use('/api/alert-thresholds', require('./routes/alertThresholdRoutes'));
app.use('/api/maigret', require('./routes/maigretRoutes'));
app.use('/api/wmn', require('./routes/wmnRoutes'));
app.use('/api/osint-tools', require('./routes/osintToolsRoutes'));

app.use('/api/grievances', require('./routes/grievanceRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/ongoing-events', require('./routes/ongoingEventRoutes'));
app.use('/api/daily-programmes', require('./routes/dailyProgrammeRoutes'));
app.use('/api/export', require('./routes/exportRoutes'));
app.use('/api/uploads', require('./routes/uploadRoutes'));
// Tenant-facing branding image upload removed (branding managed via Super Admin).
app.use('/api/instagram-stories', require('./routes/instagramStoryRoutes'));
app.use('/api/dial100-incidents', require('./routes/dial100IncidentRoutes'));
app.use('/api/criticism', require('./routes/criticismRoutes'));
app.use('/api/grievance-workflow', require('./routes/grievanceWorkflowRoutes'));
app.use('/api/query-workflow', require('./routes/queryRoutes'));
app.use('/api/suggestion', require('./routes/suggestionRoutes'));
app.use('/api/suggestions', require('./routes/suggestionRoutes'));
app.use('/api/policies', require('./routes/policyRoutes'));
app.use('/api/templates', require('./routes/templatesRoutes'));
app.use('/api/poi', require('./routes/poiRoutes'));
app.use('/api/master-calendar', require('./routes/masterCalendarRoutes'));
app.use('/api/rag', require('./routes/ragRoutes'));
app.use('/api/daily-intelligence-report', require('./routes/dailyIntelligenceReportRoutes'));
app.use('/api/comprehensive-report', require('./routes/comprehensiveReportRoutes'));
app.use('/api/search-trends', require('./routes/searchTrends'));
app.use('/api/post-location', require('./routes/postLocationRoutes'));
app.use('/api/police-news',   require('./routes/policeNewsRoutes'));


app.get('/api/verify-v2', (req, res) => res.json({ status: 'ok', version: 'v2-diagnostic', timestamp: new Date() }));
app.use('/api/rbac', require('./routes/rbacRoutes'));

// Catch-all 404 handler for debugging untracked routes
app.use((req, res, next) => {
  console.log(`[404] Path NOT FOUND: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ message: `Path ${req.originalUrl} not found` });
});

// Default Admin User
const createDefaultAdmin = async () => {
  try {
    const adminEmail = 'admin@blurahub.com';
    const adminExists = await User.findOne({ email: adminEmail });

    if (!adminExists) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('admin123', salt);

      await User.create({
        email: adminEmail,
        password: hashedPassword,
        full_name: 'System Administrator',
        role: 'superadmin'
      });
      //console.log('Default admin user created: admin@blurahub.com / admin123');
    }
  } catch (error) {
    //console.error(`Error creating default admin: ${error.message}`);
  }
};

const seedSources = async () => {
  try {
    const sourcesList = require('./data/sources_list.json');
    const youtube = buildYouTubeClient();

    //console.log(`Seeding ${sourcesList.length} sources...`);

    for (const source of sourcesList) {
      // Check if exists by identifier or display name
      const existing = await Source.findOne({
        $or: [
          { identifier: source.identifier },
          { display_name: source.display_name, platform: source.platform }
        ]
      });

      if (existing) continue;

      let identifier = source.identifier;

      // Resolve YouTube handle/name to Channel ID if needed
      if (source.platform === 'youtube' && !identifier.startsWith('UC') && youtube) {
        try {
          const response = await youtube.search.list({
            part: 'snippet',
            q: identifier,
            type: 'channel',
            maxResults: 1
          });

          if (response.data.items && response.data.items.length > 0) {
            identifier = response.data.items[0].id.channelId;
            // Also try to get stats here if possible, to avoid 0s
            // But doing it for all might hit quota.
            // We will rely on user Sync for seeded data to save quota.
            //console.log(`Resolved ${source.identifier} to ${identifier}`);
          } else {
            //console.warn(`Could not resolve YouTube handle: ${source.identifier}`);
          }
        } catch (err) {
          //console.error(`Error resolving ${source.identifier}: ${err.message}`);
        }
      }

      try {
        await Source.create({
          platform: source.platform,
          identifier: identifier,
          display_name: source.display_name,
          category: source.category,
          created_by: 'system_seed',
          is_active: true
        });
        //console.log(`Seeded source: ${source.display_name} (${source.platform})`);
      } catch (err) {
        if (err.code !== 11000) { // Ignore duplicate key errors
          //console.error(`Failed to seed ${source.display_name}: ${err.message}`);
        }
      }
    }
    //console.log('Seeding completed.');
  } catch (error) {
    //console.error('Error seeding sources:', error);
  }
};

const fixIndexes = async () => {
  try {
    const indexes = await Content.collection.indexes();
    const keyIndex = indexes.find(idx => idx.name === 'key_1');
    if (keyIndex) {
      //console.log('Dropping invalid index key_1 from contents collection...');
      await Content.collection.dropIndex('key_1');
      //console.log('Index dropped.');
    }

    const legacyContentIdIndex = indexes.find(idx => idx.name === 'content_id_1');
    if (legacyContentIdIndex) {
      //console.log('Dropping legacy unique index content_id_1 from contents collection...');
      await Content.collection.dropIndex('content_id_1');
      //console.log('Legacy index dropped.');
    }

    // Migrate the Content uniqueness from a GLOBAL (platform, content_id) key to a
    // TENANT-SCOPED (tenant_id, platform, content_id) key, so the same public post
    // can exist once per tenant and each tenant keeps its own isolated copy.
    const oldGlobalUnique = 'platform_1_content_id_1';
    if (indexes.find(idx => idx.name === oldGlobalUnique)) {
      try {
        await Content.collection.dropIndex(oldGlobalUnique);
        console.log('[fixIndexes] Dropped old GLOBAL Content unique index platform_1_content_id_1');
      } catch (e) {
        if (e.code !== 27) console.warn('[fixIndexes] Could not drop platform_1_content_id_1:', e.message);
      }
    }

    const tenantScopedUnique = 'tenant_id_1_platform_1_content_id_1';
    if (!indexes.find(idx => idx.name === tenantScopedUnique)) {
      await Content.collection.createIndex(
        { tenant_id: 1, platform: 1, content_id: 1 },
        { unique: true, name: tenantScopedUnique }
      );
      console.log('[fixIndexes] Created tenant-scoped Content unique index tenant_id_1_platform_1_content_id_1');
    }
  } catch (error) {
    if (error.code !== 27) {
      console.error('Error fixing indexes:', error.message);
    }
  }
};

const ensureSearchHistoryIndexes = async () => {
  try {
    const indexes = await SearchHistory.collection.indexes();
    const desiredTextIndexName = 'user_id_1_query_text_results_search_text_text';

    for (const idx of indexes) {
      const hasTextKey = Object.values(idx.key || {}).includes('text');
      if (!hasTextKey) continue;

      const isDesired = idx.name === desiredTextIndexName;
      if (!isDesired) {
        try {
          await SearchHistory.collection.dropIndex(idx.name);
          console.log(`[SearchHistory] Dropped legacy text index: ${idx.name}`);
        } catch (dropErr) {
          console.warn(`[SearchHistory] Could not drop index ${idx.name}: ${dropErr.message}`);
        }
      }
    }

    await SearchHistory.createIndexes();
    console.log('[SearchHistory] Indexes ensured');
  } catch (error) {
    console.error('[SearchHistory] Failed to ensure indexes:', error.message);
  }

  // Fix AlertThreshold index: was a GLOBAL unique on `platform` (only one threshold
  // per platform across ALL tenants — breaks multitenancy), now tenant-scoped
  // unique on { tenant_id, platform } so each tenant has its own viral thresholds.
  try {
    const AlertThreshold = require('./models/AlertThreshold');
    const atIndexes = await AlertThreshold.collection.indexes();
    if (atIndexes.find(idx => idx.name === 'platform_1')) {
      await AlertThreshold.collection.dropIndex('platform_1');
      console.log('[fixIndexes] Dropped old AlertThreshold global platform unique index');
    }
    if (!atIndexes.find(idx => idx.name === 'tenant_id_1_platform_1')) {
      await AlertThreshold.collection.createIndex(
        { tenant_id: 1, platform: 1 },
        { unique: true, name: 'tenant_id_1_platform_1' }
      );
      console.log('[fixIndexes] Created tenant-scoped AlertThreshold unique index');
    }
  } catch (error) {
    if (error.code !== 27) {
      console.error('Error fixing AlertThreshold indexes:', error.message);
    }
  }

  // Fix GrievanceSource index: was GLOBAL unique on { platform, handle } (only one
  // tenant could ever monitor a given handle). Now tenant-scoped so each tenant can
  // monitor the same government handle independently.
  try {
    const GrievanceSource = require('./models/GrievanceSource');
    const gsIndexes = await GrievanceSource.collection.indexes();
    if (gsIndexes.find(idx => idx.name === 'platform_1_handle_1')) {
      await GrievanceSource.collection.dropIndex('platform_1_handle_1');
      console.log('[fixIndexes] Dropped old GLOBAL GrievanceSource unique index platform_1_handle_1');
    }
    if (!gsIndexes.find(idx => idx.name === 'tenant_id_1_platform_1_handle_1')) {
      await GrievanceSource.collection.createIndex(
        { tenant_id: 1, platform: 1, handle: 1 },
        { unique: true, name: 'tenant_id_1_platform_1_handle_1' }
      );
      console.log('[fixIndexes] Created tenant-scoped GrievanceSource unique index tenant_id_1_platform_1_handle_1');
    }
  } catch (error) {
    if (error.code !== 27) {
      console.error('Error fixing GrievanceSource indexes:', error.message);
    }
  }
};

const ensureReportIndexes = async () => {
  try {
    await Report.createIndexes();
    console.log('[Report] Indexes ensured');
  } catch (error) {
    console.error('[Report] Failed to ensure indexes:', error.message);
  }
};

// Migrate report-style collections from GLOBAL unique keys to TENANT-SCOPED ones.
// These reports used to be a single global daily document; they are now per-tenant.
// Drop the stale global unique indexes so each tenant can own its own daily report,
// then (re)build the tenant-scoped compound unique indexes from the schemas.
const migrateReportTenantIndexes = async () => {
  const ComprehensiveReport = require('./models/ComprehensiveReport');
  const DailyIntelligenceReport = require('./models/DailyIntelligenceReport');
  const SoceyeReportSnapshot = require('./models/SoceyeReportSnapshot');
  const PoliceNewsArticle = require('./models/PoliceNewsArticle');
  const PoliceRssKeyword = require('./models/PoliceRssKeyword');
  const targets = [
    { model: ComprehensiveReport, stale: ['date_key_1'] },
    { model: DailyIntelligenceReport, stale: ['date_key_1'] },
    { model: SoceyeReportSnapshot, stale: ['date_key_1_window_hours_1'] },
    // Police news: move from GLOBAL unique (source_url / keyword) to TENANT-SCOPED
    // compound uniques so tenants can independently hold the same URL/keyword.
    { model: PoliceNewsArticle, stale: ['source_url_1'] },
    { model: PoliceRssKeyword, stale: ['keyword_1'] },
  ];
  for (const { model, stale } of targets) {
    try {
      const existing = await model.collection.indexes();
      for (const name of stale) {
        if (existing.find(idx => idx.name === name)) {
          try {
            await model.collection.dropIndex(name);
            console.log(`[fixIndexes] Dropped stale global unique index ${name} on ${model.collection.collectionName}`);
          } catch (e) {
            if (e.code !== 27) console.warn(`[fixIndexes] Could not drop ${name}:`, e.message);
          }
        }
      }
      await model.createIndexes(); // builds the new tenant-scoped compound unique index
    } catch (error) {
      console.error(`[fixIndexes] Report index migration failed for ${model.modelName}:`, error.message);
    }
  }
  console.log('[fixIndexes] Report collections migrated to tenant-scoped unique indexes');
};

const buildSearchHistoryResultsText = (results) => {
  if (!Array.isArray(results) || results.length === 0) return '';

  const snippets = [];
  for (const item of results.slice(0, 300)) {
    if (!item || typeof item !== 'object') continue;

    const parts = [
      item.text,
      item.title,
      item.description,
      item.author,
      item.author_handle,
      item.channelTitle,
      item.screen_name,
      item.name,
      item.url,
      item.content_url
    ]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean);

    if (parts.length > 0) snippets.push(parts.join(' '));
  }

  return snippets.join(' ').slice(0, 20000).toLowerCase();
};

const backfillSearchHistoryResultsText = async () => {
  try {
    const docs = await SearchHistory.find({
      $or: [
        { results_search_text: { $exists: false } },
        { results_search_text: '' }
      ]
    })
      .select('_id results')
      .limit(2000)
      .lean();

    if (!docs.length) return;

    const bulkOps = docs.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { results_search_text: buildSearchHistoryResultsText(doc.results) } }
      }
    }));

    if (bulkOps.length > 0) {
      await SearchHistory.bulkWrite(bulkOps, { ordered: false });
      console.log(`[SearchHistory] Backfilled results_search_text for ${bulkOps.length} records`);
    }
  } catch (error) {
    console.error('[SearchHistory] Backfill failed:', error.message);
  }
};

// Grievance Auto-Fetch Scheduler — tenant-aware (one job per active tenant per tick,
// run in parallel + isolated by the shared tenant worker pool).
const { scheduleTenantPipeline } = require('./services/pipeline/tenantScheduler');

// Per-tenant grievance fetch (source-based), scoped to this tenant's grievance sources.
const grievanceFetchTenant = async (tenant) => {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  await grievanceService.fetchAllGrievances(todayStr, todayStr, tenant.id);
};

const startGrievanceScheduler = () => {
  const intervalMs = Math.max(60000, (Number(process.env.GRIEVANCE_INTERVAL_MIN) || 60) * 60 * 1000);
  const jobTimeoutMs = Number(process.env.TENANT_JOB_TIMEOUT_MS) || 30 * 60 * 1000;
  scheduleTenantPipeline({
    name: 'grievance',
    intervalMs,
    startDelayMs: 30000,
    jobFn: grievanceFetchTenant,
    timeoutMs: jobTimeoutMs,
  });
  console.log(`[Grievance] Tenant-aware grievance fetch started (interval=${intervalMs / 60000}m, tenant-concurrency=${process.env.TENANT_CONCURRENCY || 3})`);
};

// ─── Content Availability Checker ──────────────────────────────────────────
let availabilityCheckerRunning = false;

const startAvailabilityChecker = () => {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  // Run first check 2 minutes after startup
  setTimeout(async () => {
    await runAvailabilityCheckOnce();
  }, 2 * 60 * 1000);

  setInterval(async () => {
    await runAvailabilityCheckOnce();
  }, INTERVAL_MS);
};

const runAvailabilityCheckOnce = async () => {
  if (availabilityCheckerRunning) return;
  availabilityCheckerRunning = true;
  try {
    const { runFullAvailabilityCheck } = require('./services/availabilityCheckerService');
    const { forEachTenant } = require('./config/tenantContext');
    const { getActiveTenants } = require('./services/pipeline/tenantScheduler');

    // The content and stories this checks belong to individual tenants, so the
    // sweep runs once per tenant in that tenant's own scope. Under
    // TENANT_DB_MODE=per-tenant the models refuse to resolve without one, and
    // the failure would be swallowed by the catch below rather than surfacing.
    const results = await forEachTenant(await getActiveTenants(), async () => {
      return runFullAvailabilityCheck();
    });

    const failed = results.filter((r) => r.error).length;
    console.log(
      `[AvailabilityChecker] Scheduled check complete across ${results.length} tenant(s)` +
      (failed ? ` — ${failed} failed` : '')
    );
  } catch (err) {
    console.error('[AvailabilityChecker] Scheduled check error:', err.message);
  } finally {
    availabilityCheckerRunning = false;
  }
};

const startServer = async () => {
  // Connect to database
  await connectDB();

  // One-off maintenance against the single shared database: seeds, index repairs
  // and backfills that every tenant's data used to share. None of it applies once
  // each tenant has its own database — there is no shared collection left to
  // repair, the tenant a boot-time seed would belong to is ambiguous, and every
  // tenant database is built from the current schemas by provisioning
  // (services/tenantProvisioningService → tenantSchemas.syncAllIndexes), so its
  // indexes are correct from the moment it exists. Running these anyway would
  // reach for a tenant model with no tenant in scope, which is exactly what
  // tenantModel refuses to resolve.
  if (!isPerTenant()) {
    // Create default admin
    await createDefaultAdmin();

    // NOTE: legacy global `global_settings` seed removed — Settings are per-tenant
    // (created on demand by settingsController, scoped by tenant_id).

    // Seed sources
    // await seedSources();

    // Fix indexes
    await fixIndexes();
    await ensureReportIndexes();
    await migrateReportTenantIndexes();
    await ensureSearchHistoryIndexes();
    await backfillSearchHistoryResultsText();

    // Seed default velocity alert thresholds
    await seedDefaultThresholds();
  } else {
    console.log('[Server] TENANT_DB_MODE=per-tenant — skipping shared-database boot maintenance; ' +
      'tenant databases get their collections and indexes from provisioning.');
  }

  // Master calendar seed disabled — events are created manually only
  // await seedRecurringEvents();

  // Auto-creation from master calendar disabled — events are now created manually only
  // await syncCalendarToEvents();

  // Start Monitoring Service OR temp content processor (engine mode)
  const useEngine = String(process.env.USE_ENGINE || 'false').toLowerCase() === 'true';
  if (useEngine) {
    console.log('[Server] USE_ENGINE=true -> starting temp content processor and skipping direct monitoring fetch loops');
    startTempContentProcessor();
  } else {
    console.log('[Server] USE_ENGINE=false -> starting existing monitoring service');
    startMonitoring();
  }

  // Start Grievance Auto-Fetch Scheduler only in legacy mode.
  if (!useEngine) {
    startGrievanceScheduler();
  } else {
    console.log('[Server] USE_ENGINE=true -> skipping backend Grievance Auto-Fetch (handled by engine)');
  }

  // Start Content Availability Checker
  startAvailabilityChecker();

  // Retweet Sync Scheduler — DISABLED (now on-demand via Frequent Engagers button)
  // try {
  //   const { startRetweetSyncScheduler } = require('./services/retweetNetworkService');
  //   startRetweetSyncScheduler();
  // } catch (err) {
  //   console.warn('[Server] Could not initialize Retweet Sync Scheduler:', err.message);
  // }

  await initTrendsQueue();
  registerWorker();

  const PORT = process.env.PORT || 8000;

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();
