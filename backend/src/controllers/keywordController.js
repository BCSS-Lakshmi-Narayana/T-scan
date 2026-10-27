const Keyword = require('../models/Keyword');
const { createAuditLog } = require('../services/auditService');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');
const { logHistory } = require('../services/historyLogService');

// @desc    Get keywords
// @route   GET /api/keywords
// @access  Private
const getKeywords = async (req, res) => {
  try {
    const { category } = req.query;
    const query = withTenant(req, scopedDistrictQuery(req));

    if (category) query.category = category;

    const keywords = await Keyword.find(query).limit(1000).lean();
    res.status(200).json(keywords);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create keyword
// @route   POST /api/keywords
// @access  Private
const createKeyword = async (req, res) => {
  try {
    const districtCheck = validateScopedDistricts(req, req.body.districts);
    if (!districtCheck.ok) {
      return res.status(400).json({ message: districtErrorMessage(districtCheck) });
    }

    const payload = { ...req.body, tenant_id: req.tenantId, districts: districtCheck.districts, created_by: req.user?.email || req.user?.id || '' };
    if (typeof payload.keyword === 'string') payload.keyword = payload.keyword.trim();
    if (!payload.keyword) return res.status(400).json({ message: 'Keyword text is required' });
    if (!payload.category) payload.category = 'other';

    const keyword = await Keyword.create(payload);
    await createAuditLog(req.user, 'create', 'keyword', keyword.id, { keyword: keyword.keyword });
    logHistory(req, { module: 'keywords', action: 'create', recordId: keyword.id, recordLabel: keyword.keyword, state: keyword.state, districts: keyword.districts, changes: { keyword: keyword.keyword, category: keyword.category, language: keyword.language } });
    res.status(201).json(keyword);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: `Keyword "${req.body?.keyword}" already exists` });
    }
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete keyword
// @route   DELETE /api/keywords/:id
// @access  Private
const deleteKeyword = async (req, res) => {
  try {
    const keyword = await Keyword.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));

    if (!keyword) {
      return res.status(404).json({ message: 'Keyword not found' });
    }

    await keyword.deleteOne();
    await createAuditLog(req.user, 'delete', 'keyword', req.params.id, {});
    logHistory(req, { module: 'keywords', action: 'delete', recordId: req.params.id, recordLabel: keyword.keyword, state: keyword.state, districts: keyword.districts, changes: { keyword: keyword.keyword } });

    res.status(204).json(null);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Import rescan service
const { rescanContent } = require('../services/monitorService');

// ... existing code ...

const triggerRescan = async (req, res) => {
  try {
    // An officer may only rescan their OWN district's content; admins rescan the
    // whole tenant (empty list = no district restriction).
    const districts = req.user?.role === 'admin' ? [] : (req.user?.districts || ['__none__']);
    const result = await rescanContent(req.tenantId, districts);
    await createAuditLog(req.user, 'scan', 'content', 'retroactive', { count: result.scanned });
    res.status(200).json({ message: 'Retroactive scan started', result });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getKeywords,
  createKeyword,
  deleteKeyword,
  triggerRescan
};
