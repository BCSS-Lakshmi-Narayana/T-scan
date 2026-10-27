const PolicyMapping = require('../models/PolicyMapping');
const mappingService = require('../services/mappingService');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');
const { logHistory } = require('../services/historyLogService');

// @desc    Get all policy mappings
// @route   GET /api/policies
// @access  Private (Admin)
exports.getPolicies = async (req, res) => {
    try {
        const policies = await PolicyMapping.find(withTenant(req, scopedDistrictQuery(req))).sort({ category_id: 1 });
        res.status(200).json({ success: true, count: policies.length, data: policies });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// @desc    Get single policy mapping
// @route   GET /api/policies/:id
// @access  Private (Admin)
exports.getPolicy = async (req, res) => {
    try {
        const policy = await PolicyMapping.findOne(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));
        if (!policy) {
            return res.status(404).json({ success: false, error: 'Policy not found' });
        }
        res.status(200).json({ success: true, data: policy });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// @desc    Create new policy mapping
// @route   POST /api/policies
// @access  Private (Admin)
exports.createPolicy = async (req, res) => {
    try {
        // Never let the client pick the tenant/id — tenant is always the caller's tenant.
        const { tenant_id, _id, id, ...body } = req.body || {};

        const districtCheck = validateScopedDistricts(req, body.districts);
        if (!districtCheck.ok) {
            return res.status(400).json({ success: false, error: districtErrorMessage(districtCheck) });
        }

        const policy = await PolicyMapping.create({
            ...body,
            tenant_id: req.tenantId,
            districts: districtCheck.districts,
            created_by: req.user?.email || req.user?.id || ''
        });
        // Refresh cache
        await mappingService.forceRefresh();
        logHistory(req, { module: 'policies', action: 'create', recordId: policy._id, recordLabel: policy.category_id, changes: { category_id: policy.category_id, severity_level: policy.severity_level } });
        res.status(201).json({ success: true, data: policy });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ success: false, error: 'Category ID already exists' });
        }
        res.status(500).json({ success: false, error: err.message });
    }
};

// @desc    Update policy mapping
// @route   PUT /api/policies/:id
// @access  Private (Admin)
exports.updatePolicy = async (req, res) => {
    try {
        // Strip immutable/tenant fields so an update can never move a policy to another tenant.
        const { tenant_id, _id, id, ...body } = req.body || {};
        const policy = await PolicyMapping.findOneAndUpdate(
            withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }),
            { ...body, updated_by: req.user?.email || req.user?.id || '', updated_at: new Date() },
            { new: true, runValidators: true }
        );
        if (!policy) {
            return res.status(404).json({ success: false, error: 'Policy not found' });
        }
        // Refresh cache
        await mappingService.forceRefresh();
        logHistory(req, { module: 'policies', action: 'update', recordId: policy._id, recordLabel: policy.category_id, changes: body });
        res.status(200).json({ success: true, data: policy });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// @desc    Bulk upload policy mappings from a JSON file (e.g. the reference
//          BNS/policy template). Each entry is upserted per tenant+category_id:
//          a brand-new category is created scoped to the caller's chosen
//          districts; a category that already exists in this tenant (e.g.
//          another district officer uploaded the same reference file first)
//          just gets the caller's districts merged into its existing districts
//          array, so multiple officers can share the same file without
//          clobbering each other's district scoping or a 409 collision.
// @route   POST /api/policies/bulk-upload
// @access  Private (Admin / Officer — district-scoped)
exports.bulkUploadPolicies = async (req, res) => {
    try {
        const rawList = Array.isArray(req.body?.policies)
            ? req.body.policies
            : (Array.isArray(req.body) ? req.body : null);

        if (!rawList || rawList.length === 0) {
            return res.status(400).json({ success: false, error: 'No policies found in upload (expected { "policies": [...] })' });
        }

        const districtCheck = validateScopedDistricts(req, req.body?.districts);
        if (!districtCheck.ok) {
            return res.status(400).json({ success: false, error: districtErrorMessage(districtCheck) });
        }

        const actor = req.user?.email || req.user?.id || '';
        const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };

        for (const entry of rawList) {
            const category_id = String(entry?.category_id || '').trim();
            const definition = String(entry?.definition || '').trim();
            if (!category_id || !definition) {
                results.skipped++;
                results.errors.push({ category_id: category_id || '(missing)', error: 'category_id and definition are required' });
                continue;
            }

            try {
                const existing = await PolicyMapping.findOne(withTenant(req, { category_id }));
                if (existing) {
                    const mergedDistricts = Array.from(new Set([...(existing.districts || []), ...districtCheck.districts]));
                    const alreadyCovered = mergedDistricts.length === (existing.districts || []).length;
                    if (alreadyCovered) {
                        results.skipped++;
                        continue;
                    }
                    existing.districts = mergedDistricts;
                    existing.updated_by = actor;
                    existing.updated_at = new Date();
                    await existing.save();
                    results.updated++;
                } else {
                    await PolicyMapping.create({
                        category_id,
                        definition,
                        legal_sections: Array.isArray(entry.legal_sections) ? entry.legal_sections : [],
                        platform_policies: entry.platform_policies || {},
                        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
                        severity_level: entry.severity_level || 'Medium',
                        is_active: entry.is_active !== false,
                        tenant_id: req.tenantId,
                        districts: districtCheck.districts,
                        created_by: actor
                    });
                    results.inserted++;
                }
            } catch (itemErr) {
                results.skipped++;
                results.errors.push({ category_id, error: itemErr.code === 11000 ? 'Duplicate category_id' : itemErr.message });
            }
        }

        await mappingService.forceRefresh();
        logHistory(req, { module: 'policies', action: 'bulk_upload', recordLabel: `${results.inserted + results.updated} categories`, changes: results });

        res.status(200).json({ success: true, data: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// @desc    Delete policy mapping
// @route   DELETE /api/policies/:id
// @access  Private (Admin)
exports.deletePolicy = async (req, res) => {
    try {
        const policy = await PolicyMapping.findOneAndDelete(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));
        if (!policy) {
            return res.status(404).json({ success: false, error: 'Policy not found' });
        }
        // Refresh cache
        await mappingService.forceRefresh();
        logHistory(req, { module: 'policies', action: 'delete', recordId: policy._id, recordLabel: policy.category_id, changes: { category_id: policy.category_id } });
        res.status(200).json({ success: true, data: {} });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};
