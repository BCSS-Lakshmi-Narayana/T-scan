const express = require('express');
const router = express.Router();
const reportService = require('../services/reportService');
const { renderReportPdf } = require('../services/reportPdfService');
const Alert = require('../models/Alert');
const Source = require('../models/Source');
const cacheService = require('../services/cacheService');
const { withTenant } = require('../utils/tenantFilter');
const { resolveScopedSourceIds } = require('../utils/scopedDistricts');
const { protect } = require('../middleware/authMiddleware');
const {
    loadUserPermissions,
    hasPageAccess,
    hasFeatureAccess,
    denyPageAccess,
    denyFeatureAccess,
    requireAnyPageAccess
} = require('../middleware/rbacMiddleware');

const requireReportsAccess = (req, res, next) => {
    if (hasPageAccess(req, '/reports') || hasPageAccess(req, '/unified-reports')) {
        return next();
    }
    if (hasPageAccess(req, '/alerts') && hasFeatureAccess(req, '/alerts', 'reports')) {
        return next();
    }
    if (!hasPageAccess(req, '/reports') && !hasPageAccess(req, '/unified-reports') && hasPageAccess(req, '/alerts')) {
        return denyFeatureAccess(res, '/alerts', 'reports');
    }
    return denyPageAccess(res, ['/reports', '/unified-reports', '/alerts']);
};

// Dashboard-shared READ: the Dashboard widget reads report stats. Allow /dashboard access
// (in addition to the report/alerts pages) here, BEFORE the stricter requireReportsAccess
// gate below, so a dashboard-only user isn't 403'd. Report writes/exports stay protected.
router.get('/stats', protect, requireAnyPageAccess(['/reports', '/unified-reports', '/alerts', '/dashboard']), async (req, res) => {
    try {
        const stats = await reportService.getReportStats(req.tenantId, req);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.use(protect, loadUserPermissions, requireReportsAccess);

/**
 * Get all generated reports.
 */
router.get('/', async (req, res) => {
    try {
        const reports = await reportService.getAllReports(req.query, req.tenantId, req);
        res.json(reports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Escalate an alert and generate a report.
 */
router.post('/escalate/:id', async (req, res) => {
    try {
        const report = await reportService.createReportFromAlert(req.params.id, req.tenantId, req);
        res.status(201).json(report);
    } catch (error) {
        const status = error.message === 'Alert not found' ? 404 : 500;
        res.status(status).json({ error: error.message });
    }
});

/**
 * Update alert status (Ack, False Positive).
 */
router.post('/status/:id', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['acknowledged', 'false_positive', 'resolved'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        // District scoping: Alert has no districts field of its own — it's
        // scoped via its linked Source's district, same as alertController.js's
        // updateAlert. This route is a second write path onto Alert.status that
        // was bypassing that check entirely.
        const existing = await Alert.findOne({ id: req.params.id, tenant_id: req.tenantId });
        if (!existing) return res.status(404).json({ error: 'Alert not found' });

        const scopedSourceIds = await resolveScopedSourceIds(req, Source, withTenant);
        if (scopedSourceIds && !scopedSourceIds.includes(existing.source_id)) {
            return res.status(404).json({ error: 'Alert not found' });
        }

        const alert = await Alert.findOneAndUpdate(
            { id: req.params.id, tenant_id: req.tenantId },
            { status },
            { new: true }
        );
        await cacheService.invalidatePrefix('alerts:list:v2');
        await cacheService.invalidatePrefix('alerts:stats:v2');
        await cacheService.invalidatePrefix('dashboard:v2');

        if (!alert) return res.status(404).json({ error: 'Alert not found' });
        res.json(alert);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update a report's content (save edits).
 */
router.put('/:id', async (req, res) => {
    try {
        const report = await reportService.updateReport(req.params.id, req.body, req.tenantId);
        res.json(report);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/reports/:id/pdf — Render the live report HTML to a PDF with a
 * "RefNo:<serial>" footer and no browser-injected headers/footers.
 *
 * Body: { headHtml: string, bodyHtml: string, serialNumber?: string }
 */
router.post('/:id/pdf', async (req, res) => {
    try {
        const { headHtml = '', bodyHtml = '', templateHtml = '', serialNumber = '' } = req.body || {};
        if (!templateHtml && !bodyHtml) {
            return res.status(400).json({ error: 'templateHtml or bodyHtml is required' });
        }

        const serial = serialNumber || `report-${req.params.id}`;
        const pdf = await renderReportPdf({ headHtml, bodyHtml, templateHtml, serialNumber: serial });

        const safeName = String(serial).replace(/[^A-Za-z0-9_\-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Official_Notice_${safeName}.pdf"`);
        res.setHeader('Content-Length', pdf.length);
        return res.end(pdf);
    } catch (error) {
        console.error('PDF generation failed:', error);
        return res.status(500).json({ error: error.message || 'PDF generation failed' });
    }
});

module.exports = router;
