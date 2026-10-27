const ViralCampaign = require('../models/ViralCampaign');
const { withTenant } = require('../utils/tenantFilter');
const { createAuditLog } = require('../services/auditService');
const { logHistory } = require('../services/historyLogService');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');

// This app's vertical.
const SAGA_TYPE = 'police';

// Tenant-facing viral-campaign requests. A tenant raises a request ("trend this for me");
// it lands as `pending` for the Super Admin to validate. Every query is tenant-scoped
// via withTenant(req, ...) so a tenant only ever sees its own requests.

// GET /api/viral-campaigns
const listMyRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const query = { ...withTenant(req, scopedDistrictQuery(req)) };
    if (status && status !== 'all') query.status = status;
    const requests = await ViralCampaign.find(query).sort({ created_at: -1 });
    res.status(200).json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/viral-campaigns/:id
const getRequest = async (req, res) => {
  try {
    const request = await ViralCampaign.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!request) return res.status(404).json({ message: 'Request not found' });
    res.status(200).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/viral-campaigns
const createRequest = async (req, res) => {
  try {
    const { title, description, content_type, content_url, target_platforms, target_reach, budget, location, deadline, state, districts } = req.body;
    if (!title) return res.status(400).json({ message: 'title is required' });

    const districtCheck = validateScopedDistricts(req, districts);
    if (!districtCheck.ok) {
      return res.status(400).json({ message: districtErrorMessage(districtCheck) });
    }

    const request = await ViralCampaign.create({
      ...withTenant(req),
      type: SAGA_TYPE,
      requested_by: req.user?.email || req.user?.id || 'tenant',
      title,
      description: description || '',
      content_type: ['post', 'video', 'reel', 'story'].includes(content_type) ? content_type : undefined,
      content_url: content_url || undefined,
      target_platforms: Array.isArray(target_platforms) ? target_platforms.filter(Boolean) : [],
      target_reach: Number(target_reach) || undefined,
      budget: Number(budget) || undefined,
      location: location || undefined,
      state: state || undefined,
      districts: districtCheck.districts,
      deadline: deadline ? new Date(deadline) : undefined,
      status: 'pending',
    });

    await createAuditLog(req.user, 'create', 'viral_campaign', request.id, { title: request.title }, req.tenantId);
    logHistory(req, { module: 'viral_campaigns', action: 'create', recordId: request.id, recordLabel: request.title, state: request.state, districts: request.districts, changes: { title, content_type, target_reach, budget } });
    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /api/viral-campaigns/:id/cancel — tenant withdraws a request that is still pending.
const cancelRequest = async (req, res) => {
  try {
    const request = await ViralCampaign.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Only a pending request can be cancelled' });
    }
    request.status = 'cancelled';
    request.updated_by = req.user?.email || req.user?.id || '';
    await request.save();
    await createAuditLog(req.user, 'cancel', 'viral_campaign', request.id, null, req.tenantId);
    logHistory(req, { module: 'viral_campaigns', action: 'update', recordId: request.id, recordLabel: request.title, state: request.state, districts: request.districts, changes: { status: 'cancelled' } });
    res.status(200).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { listMyRequests, getRequest, createRequest, cancelRequest };
