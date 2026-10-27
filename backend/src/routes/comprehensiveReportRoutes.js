const express = require('express');
const router = express.Router();
const service = require('../services/comprehensiveReportService');
const { generateComprehensiveReportPdf } = require('../services/comprehensiveReportPdfService');
const { protect } = require('../middleware/authMiddleware');
const { loadUserPermissions, hasPageAccess, denyPageAccess, authorize } = require('../middleware/rbacMiddleware');

const requireAccess = (req, res, next) => {
  if (hasPageAccess(req, '/reports') || hasPageAccess(req, '/unified-reports') || hasPageAccess(req, '/intelligence-dashboard')) return next();
  return denyPageAccess(res, ['/reports', '/unified-reports', '/intelligence-dashboard']);
};

// Comprehensive/Soceye reports are whole-tenant (state-wide) summary artifacts,
// cached/persisted per tenant+date — there is no per-district variant of these
// documents. Restricted to admin (the State Admin role) so a district officer
// can never pull tenant-wide data through this endpoint; officers use the
// already district-scoped reportService.js reports instead.
router.use(protect, loadUserPermissions, requireAccess, authorize('admin'));

router.post('/generate', async (req, res) => {
  try {
    const { targetDate } = req.body;
    const report = await service.generateComprehensiveReport(targetDate, req.tenantId);
    res.status(201).json({ success: true, message: 'Comprehensive report generated', report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/latest', async (req, res) => {
  try {
    const reports = await service.getAllReports(1, req.tenantId);
    if (!reports.length) return res.status(404).json({ success: false, message: 'No reports found' });
    res.json({ success: true, report: reports[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const reports = await service.getAllReports(limit, req.tenantId);
    res.json({ success: true, count: reports.length, reports });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/by-date/:dateKey', async (req, res) => {
  try {
    const report = await service.getReportByDate(req.params.dateKey, req.tenantId);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/download/:dateKey', async (req, res) => {
  try {
    let report = await service.getReportByDate(req.params.dateKey, req.tenantId);
    if (!report) report = await service.generateComprehensiveReport(req.params.dateKey, req.tenantId);
    if (report.status !== 'completed') return res.status(400).json({ success: false, message: 'Report not ready' });
    const pdf = await generateComprehensiveReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Comprehensive_Report_${req.params.dateKey}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/preview/:dateKey', async (req, res) => {
  try {
    let report = await service.getReportByDate(req.params.dateKey, req.tenantId);
    if (!report) report = await service.generateComprehensiveReport(req.params.dateKey, req.tenantId);
    if (report.status !== 'completed') return res.status(400).json({ success: false, message: 'Report not ready' });
    const pdf = await generateComprehensiveReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Live Soceye Report — past N hours (default 24). Persists a daily snapshot.
router.get('/soceye-live', async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 24));
    const report = await service.generateLiveSoceyeReport(hours, req.tenantId);
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List past Soceye snapshots (most recent first).
router.get('/soceye-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 60;
    const snapshots = await service.listSoceyeSnapshots(limit, req.tenantId);
    res.json({ success: true, snapshots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fetch a specific past snapshot by id.
router.get('/soceye-history/:id', async (req, res) => {
  try {
    const snap = await service.getSoceyeSnapshotById(req.params.id, req.tenantId);
    if (!snap) return res.status(404).json({ success: false, message: 'Snapshot not found' });
    res.json({ success: true, snapshot: snap, report: snap.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const reports = await service.getAllReports(7, req.tenantId);
    const stats = { total_reports: reports.length, latest_report_date: reports[0]?.date_key || null,
      avg_dial100: 0, avg_grievances: 0, avg_alerts: 0, avg_threat_rate: 0 };
    if (reports.length) {
      stats.avg_dial100 = Math.round(reports.reduce((s, r) => s + r.dial100_calls.total_count, 0) / reports.length);
      stats.avg_grievances = Math.round(reports.reduce((s, r) => s + r.grievances.total_count, 0) / reports.length);
      stats.avg_alerts = Math.round(reports.reduce((s, r) => s + r.alerts.total_count, 0) / reports.length);
      stats.avg_threat_rate = Math.round(reports.reduce((s, r) => s + r.summary_statistics.threat_rate_percentage, 0) / reports.length);
    }
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:dateKey', async (req, res) => {
  try {
    const ComprehensiveReport = require('../models/ComprehensiveReport');
    const result = await ComprehensiveReport.deleteOne({ tenant_id: req.tenantId, date_key: req.params.dateKey });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
