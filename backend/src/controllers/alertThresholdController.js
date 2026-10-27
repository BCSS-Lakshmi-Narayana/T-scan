const AlertThreshold = require('../models/AlertThreshold');
const { createAuditLog } = require('../services/auditService');
const { withTenant } = require('../utils/tenantFilter');
const { ensureTenantThresholds } = require('../services/velocityAlertService');

// @desc    Get all alert thresholds
// @route   GET /api/alert-thresholds
// @access  Private
const getAlertThresholds = async (req, res) => {
    try {
        const { platform } = req.query;
        const query = withTenant(req);

        if (platform) query.platform = platform;

        // Lazily seed this tenant's default thresholds on first read so the Viral
        // Alerts config always shows all platform rows (tenant-scoped).
        if (req.tenantId) {
            const count = await AlertThreshold.countDocuments(withTenant(req));
            if (count === 0) await ensureTenantThresholds(req.tenantId);
        }

        const thresholds = await AlertThreshold.find(query).sort({ platform: 1 }).lean();
        res.status(200).json(thresholds);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create new alert threshold
// @route   POST /api/alert-thresholds
// @access  Private (Admin/Analyst)
const createAlertThreshold = async (req, res) => {
    try {
        if (!['superadmin', 'admin', 'analyst'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const { platform, low_threshold, medium_threshold, high_threshold, time_window_minutes } = req.body;

        // Check if threshold already exists for this platform
        const existing = await AlertThreshold.findOne(withTenant(req, { platform }));
        if (existing) {
            return res.status(400).json({ message: 'Threshold already exists for this platform. Use PUT to update.' });
        }

        const threshold = new AlertThreshold({
            tenant_id: req.tenantId,
            platform,
            low_threshold: low_threshold || 100,
            medium_threshold: medium_threshold || 500,
            high_threshold: high_threshold || 1000,
            time_window_minutes: time_window_minutes || 60
        });

        await threshold.save();
        await createAuditLog(req.user, 'create', 'alert_threshold', threshold.id, req.body);

        res.status(201).json(threshold);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update alert threshold
// @route   PUT /api/alert-thresholds/:id
// @access  Private (Admin/Analyst)
const updateAlertThreshold = async (req, res) => {
    try {
        if (!['superadmin', 'admin', 'analyst'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const threshold = await AlertThreshold.findOne(withTenant(req, { id: req.params.id }));

        if (!threshold) {
            return res.status(404).json({ message: 'Threshold not found' });
        }

        const updateDoc = {
            ...req.body,
            updated_at: new Date()
        };

        const updatedThreshold = await AlertThreshold.findOneAndUpdate(
            withTenant(req, { id: req.params.id }),
            updateDoc,
            { new: true }
        );

        await createAuditLog(req.user, 'update', 'alert_threshold', req.params.id, updateDoc);

        res.status(200).json(updatedThreshold);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete alert threshold
// @route   DELETE /api/alert-thresholds/:id
// @access  Private (Admin/Analyst)
const deleteAlertThreshold = async (req, res) => {
    try {
        if (!['superadmin', 'admin', 'analyst'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const threshold = await AlertThreshold.findOne(withTenant(req, { id: req.params.id }));

        if (!threshold) {
            return res.status(404).json({ message: 'Threshold not found' });
        }

        await AlertThreshold.findOneAndDelete(withTenant(req, { id: req.params.id }));
        await createAuditLog(req.user, 'delete', 'alert_threshold', req.params.id, {});

        res.status(200).json({ message: 'Threshold deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Bulk upsert thresholds (for Settings UI convenience)
// @route   PUT /api/alert-thresholds/bulk
// @access  Private (Admin/Analyst)
const bulkUpdateThresholds = async (req, res) => {
    try {
        // 'admin' is the tenant's full-access role (per rbacMiddleware) and MUST be able to
        // edit its own thresholds; 'superadmin' is the orchestrator/legacy alias; 'analyst' retained.
        if (!['superadmin', 'admin', 'analyst'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const { thresholds } = req.body;

        if (!Array.isArray(thresholds)) {
            return res.status(400).json({ message: 'thresholds must be an array' });
        }

        const results = [];

        for (const t of thresholds) {
            const updateDoc = {
                low_threshold: t.low_threshold,
                medium_threshold: t.medium_threshold,
                high_threshold: t.high_threshold,
                time_window_minutes: t.time_window_minutes || 60,
                is_active: t.is_active !== undefined ? t.is_active : true,
                updated_at: new Date()
            };

            // Now using platform-only matching (no metric field)
            const updated = await AlertThreshold.findOneAndUpdate(
                withTenant(req, { platform: t.platform }),
                { $set: updateDoc, $setOnInsert: { platform: t.platform, tenant_id: req.tenantId } },
                { new: true, upsert: true }
            );

            results.push(updated);
        }

        await createAuditLog(req.user, 'bulk_update', 'alert_threshold', 'bulk', { count: results.length });

        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getAlertThresholds,
    createAlertThreshold,
    updateAlertThreshold,
    deleteAlertThreshold,
    bulkUpdateThresholds
};
