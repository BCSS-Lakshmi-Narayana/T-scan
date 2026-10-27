const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');

// Service-to-service guard: the Super Admin orchestrator calls these endpoints
// with a shared service key. No tenant/user JWT is involved here.
const serviceKeyAuth = (req, res, next) => {
  const provided = req.headers['x-service-key'];
  const expected = process.env.SUPER_ADMIN_SERVICE_KEY;
  if (!expected) {
    return res.status(500).json({ message: 'SUPER_ADMIN_SERVICE_KEY not configured on this server' });
  }
  if (!provided || provided !== expected) {
    return res.status(403).json({ message: 'Invalid or missing service key' });
  }
  next();
};

router.use(serviceKeyAuth);

// Every route below that names a :tenantId acts on that tenant's data, and that
// data lives in the tenant's own database. These routes are mounted ABOVE
// tenantMiddleware — a super admin arrives without a tenant subdomain — so
// nothing else puts a database in scope, and the tenant models would refuse to
// resolve one.
//
// This is deliberately a router param rather than a helper the handlers call:
// the context has to be established around next(), so that every handler, and
// everything it awaits, runs inside it. A helper that returns after an await
// cannot do that — AsyncLocalStorage.enterWith does not propagate back to the
// caller across the await boundary.
//
// An unresolvable tenant is passed through untouched so each handler still
// answers with its own 404 shape.
const Tenant = require('../models/Tenant');
const { runWithTenant } = require('../config/tenantContext');
const { forTenant } = require('../config/tenantConnections');

router.param('tenantId', async (req, res, next, tenantId) => {
  try {
    const tenant = await Tenant.findOne({ id: tenantId });
    if (!tenant) return next();
    req.superAdminTenant = tenant;
    runWithTenant({ tenant, tenantId: tenant.id, connection: forTenant(tenant) }, next);
  } catch (error) {
    console.error(`[police.superAdminRoutes] tenant scope for ${tenantId}:`, error.message);
    next(error);
  }
});

router.get('/tenants', superAdminController.getAllTenants);
router.get('/tenants/:tenantId', superAdminController.getTenantDetail);
router.get('/tenants/:tenantId/stats', superAdminController.getTenantStats);
router.get('/tenants/:tenantId/activity', superAdminController.getTenantActivity);
router.put('/tenants/:tenantId', superAdminController.updateTenant);
router.put('/tenants/:tenantId/account', superAdminController.updateTenantPrimaryAccount);
router.get('/tenants/:tenantId/default-prompts', superAdminController.getTenantDefaultPrompts);
router.post('/tenants/:tenantId/branding-upload', superAdminController.uploadTenantBranding);
router.put('/tenants/:tenantId/branding', superAdminController.updateTenantBranding);
router.put('/tenants/:tenantId/status', superAdminController.updateTenantStatus);
router.delete('/tenants/:tenantId', superAdminController.deleteTenant);
router.post('/onboarding/complete', superAdminController.completeOnboarding);

// Tenant Profile Management (monitoring profiles / sources + linked POI).
// Delegates to the same controllers the tenant app uses, scoped to :tenantId.
router.get('/tenants/:tenantId/profiles', superAdminController.listTenantProfiles);
router.get('/tenants/:tenantId/profiles/:id/poi', superAdminController.getTenantProfilePOI);
router.post('/tenants/:tenantId/profiles', superAdminController.createTenantProfile);
router.put('/tenants/:tenantId/profiles/:id', superAdminController.updateTenantProfile);
router.delete('/tenants/:tenantId/profiles/:id', superAdminController.deleteTenantProfile);
router.put('/tenants/:tenantId/profiles/:id/toggle', superAdminController.toggleTenantProfile);
router.post('/tenants/:tenantId/profiles/:id/scan', superAdminController.scanTenantProfile);

// Tenant Keyword Management. Delegates to the same controllers the tenant app
// uses, scoped to :tenantId.
router.get('/tenants/:tenantId/keywords', superAdminController.listTenantKeywords);
router.post('/tenants/:tenantId/keywords', superAdminController.createTenantKeyword);
router.post('/tenants/:tenantId/keywords/scan', superAdminController.scanTenantKeywords);
router.delete('/tenants/:tenantId/keywords/:id', superAdminController.deleteTenantKeyword);

// Tenant Event Management. Delegates to the same eventController the tenant app
// uses, scoped to :tenantId. (eventController reads the event id from :id.)
router.get('/tenants/:tenantId/events', superAdminController.listTenantEvents);
router.post('/tenants/:tenantId/events', superAdminController.createTenantEvent);
router.put('/tenants/:tenantId/events/:id', superAdminController.updateTenantEvent);
router.delete('/tenants/:tenantId/events/:id', superAdminController.deleteTenantEvent);
router.post('/tenants/:tenantId/events/:id/pause', superAdminController.pauseTenantEvent);
router.post('/tenants/:tenantId/events/:id/resume', superAdminController.resumeTenantEvent);
router.post('/tenants/:tenantId/events/:id/archive', superAdminController.archiveTenantEvent);
router.post('/tenants/:tenantId/events/:id/scan', superAdminController.scanTenantEvent);

// Tenant BluGate credentials. One API key + client code per tenant, shared by
// every platform, stored encrypted in that tenant's own database. Write-only —
// reads report "set / not set" only.
router.get('/tenants/:tenantId/blugate', superAdminController.getTenantBlugate);
router.put('/tenants/:tenantId/blugate', superAdminController.updateTenantBlugate);
router.delete('/tenants/:tenantId/blugate', superAdminController.deleteTenantBlugate);
router.post('/tenants/:tenantId/blugate/test/:slug', superAdminController.testTenantBlugate);

// Tenant Grievance Management (POLICE). Config = monitored "mention handles"
// (GrievanceSource); the rest are read-only analytics (workflow-status driven:
// total / pending / escalated / closed / FIR + platform-wise). No sentiment or
// category analytics here — that is a political-only feature.
router.get('/tenants/:tenantId/grievance-sources', superAdminController.listTenantGrievanceSources);
router.post('/tenants/:tenantId/grievance-sources', superAdminController.createTenantGrievanceSource);
router.put('/tenants/:tenantId/grievance-sources/:id', superAdminController.updateTenantGrievanceSource);
router.delete('/tenants/:tenantId/grievance-sources/:id', superAdminController.deleteTenantGrievanceSource);
router.get('/tenants/:tenantId/grievance-stats', superAdminController.getTenantGrievanceStats);
router.get('/tenants/:tenantId/grievance-dashboard', superAdminController.getTenantGrievanceDashboard);

// Tenant Threshold / Configuration Management. Delegates to the same settings &
// alert-threshold controllers the tenant app uses (api_config + viral thresholds).
router.get('/tenants/:tenantId/settings', superAdminController.getTenantSettings);
router.put('/tenants/:tenantId/settings', superAdminController.updateTenantSettings);
router.get('/tenants/:tenantId/alert-thresholds', superAdminController.getTenantAlertThresholds);
router.put('/tenants/:tenantId/alert-thresholds/bulk', superAdminController.updateTenantAlertThresholds);

// Tenant Report-Template Management. Delegates to the same templatesController the
// tenant app uses (DOCX upload/parse, edit content, set default, delete), scoped to
// :tenantId. These are the report templates selected during escalation report gen.
// (templatesController reads the template id from :id.)
router.get('/tenants/:tenantId/templates', superAdminController.listTenantTemplates);
router.get('/tenants/:tenantId/templates/:id', superAdminController.getTenantTemplate);
router.post('/tenants/:tenantId/templates/parse', superAdminController.parseTenantTemplate);
router.post('/tenants/:tenantId/templates', superAdminController.createTenantTemplate);
router.put('/tenants/:tenantId/templates/:id/content', superAdminController.updateTenantTemplateContent);
router.put('/tenants/:tenantId/templates/:id/default', superAdminController.setTenantTemplateDefault);
router.delete('/tenants/:tenantId/templates/:id', superAdminController.deleteTenantTemplate);

// Tenant Policy-Mapping Management (Policy Manager). Delegates to the same
// policyController the tenant app uses (category → legal sections + platform policies),
// scoped to :tenantId. (policyController reads the policy _id from :id.)
router.get('/tenants/:tenantId/policies', superAdminController.listTenantPolicies);
router.get('/tenants/:tenantId/policies/:id', superAdminController.getTenantPolicy);
router.post('/tenants/:tenantId/policies', superAdminController.createTenantPolicy);
router.put('/tenants/:tenantId/policies/:id', superAdminController.updateTenantPolicy);
router.delete('/tenants/:tenantId/policies/:id', superAdminController.deleteTenantPolicy);

// Tenant Access Management. Delegates to the same rbac/auth controllers the tenant
// app uses (users + page/feature permissions), scoped to :tenantId.
router.get('/tenants/:tenantId/access-pages', superAdminController.getTenantAccessPages);
router.get('/tenants/:tenantId/users', superAdminController.listTenantUsers);
router.post('/tenants/:tenantId/users', superAdminController.createTenantUser);
router.put('/tenants/:tenantId/users/:userId', superAdminController.updateTenantUser);
router.delete('/tenants/:tenantId/users/:userId', superAdminController.deleteTenantUser);
router.get('/tenants/:tenantId/users/:userId/permissions', superAdminController.getTenantUserPermissions);
router.put('/tenants/:tenantId/users/:userId/permissions', superAdminController.updateTenantUserPermissions);

// Viral Campaign requests (cross-tenant). The orchestrator lists all tenants' requests
// to validate them, and updates review fields (status / money / offer type / link).
router.get('/viral-campaigns', superAdminController.listAllViralCampaigns);
router.put('/viral-campaigns/:id', superAdminController.updateViralCampaignAdmin);

// AI Campaign Suggestions (cross-tenant). Generated on demand from a tenant's own
// grievances + alerts; the orchestrator lists, triggers generation, and updates status.
router.get('/campaign-suggestions', superAdminController.listAllCampaignSuggestions);
router.post('/tenants/:tenantId/campaign-suggestions/generate', superAdminController.generateCampaignSuggestions);
router.put('/campaign-suggestions/:id', superAdminController.updateCampaignSuggestion);

module.exports = router;
