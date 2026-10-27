const axios = require('axios');

// RAG pipeline FastAPI service URL
const RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:8100';

const ragApi = axios.create({
  baseURL: RAG_API_URL,
  timeout: 300000, // 5 min — generation can be slow on CPU
  headers: { 'Content-Type': 'application/json' },
});

// Every RAG call MUST carry the caller's tenant_id so the Python service can scope
// its MongoDB reads + vector retrieval to that tenant only (no cross-tenant answers).
// Sent both as a header (X-Tenant-Id) and in the body/query for robustness.
const tenantHeaders = (req) => ({ headers: { 'X-Tenant-Id': req.tenantId || '' } });

// SECOND-level isolation on top of tenant_id: a District Officer's own
// assigned districts (null for a State Admin, or an officer with no districts
// assigned — the Python service treats null/empty as "unrestricted", so this
// must never be sent as [] for an admin). The Python service additionally
// excludes any other district's alerts/grievances/content/etc from RAG answers.
const districtsFor = (req) => (req.user?.role === 'admin' ? null : (req.user?.districts || []));

// Encode districtsFor(req) for a GET query param: omitted (undefined) = admin
// (unrestricted); the literal "__none__" = an officer with ZERO districts
// assigned (fail-closed, NOT the same as admin); otherwise a comma-joined list.
// Distinguishing [] from null matters — conflating them would let a
// districtless officer see the whole tenant instead of nothing.
const districtsQueryParam = (req) => {
  const d = districtsFor(req);
  if (d === null) return undefined;
  return d.length ? d.join(',') : '__none__';
};

// GET /api/rag/health
exports.health = async (req, res) => {
  try {
    const { data } = await ragApi.get('/api/rag/health');
    res.json(data);
  } catch (error) {
    console.error('[RAG] Health check failed:', error.message);
    res.status(503).json({
      healthy: false,
      error: 'RAG pipeline service is not reachable. Is api_server.py running?',
    });
  }
};

// GET /api/rag/collections
exports.collections = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get('/api/rag/collections', { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Collections fetch failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch collections from RAG service' });
  }
};

// POST /api/rag/query  { question, collection, top_k }
exports.query = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { question, collection, top_k, time_window_days, use_db } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    const { data } = await ragApi.post('/api/rag/query', {
      question: question.trim(),
      collection: collection || null,
      top_k: top_k || 5,
      time_window_days: time_window_days ?? 7,
      use_db: use_db ?? true,
      tenant_id: req.tenantId,
      districts: districtsFor(req),
    }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Query failed:', error.message);
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'RAG query failed';
    res.status(status).json({ error: detail });
  }
};

// POST /api/rag/scan  { question, deep }
// On-demand concept scan (filter -> recall -> rerank -> LLM judge). /query
// starts one itself when a question names an untagged concept; this is the
// explicit entry, used by the "deep scan" button.
exports.scanStart = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { question, deep } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    const { data } = await ragApi.post('/api/rag/scan', {
      question: String(question).trim(),
      deep: !!deep,
      tenant_id: req.tenantId,
      districts: districtsFor(req),
    }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Scan start failed:', error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'RAG scan failed' });
  }
};

// GET /api/rag/scan/:id — the caller's tenant AND district scope must match
// the scope the scan was started under, or the service answers 404.
exports.scanStatus = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get(`/api/rag/scan/${encodeURIComponent(req.params.id)}`, {
      params: { tenant_id: req.tenantId, districts: districtsQueryParam(req) },
      ...tenantHeaders(req),
      timeout: 15000,
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'Failed to fetch scan' });
  }
};

// DELETE /api/rag/scan/:id
exports.scanCancel = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.delete(`/api/rag/scan/${encodeURIComponent(req.params.id)}`, {
      params: { tenant_id: req.tenantId, districts: districtsQueryParam(req) },
      ...tenantHeaders(req),
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'Failed to cancel scan' });
  }
};

// POST /api/rag/query/async  { question, collection, top_k }
exports.queryAsync = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { question, collection, top_k, time_window_days } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    const { data } = await ragApi.post('/api/rag/query/async', {
      question: question.trim(),
      collection: collection || null,
      top_k: top_k || 12,
      time_window_days: time_window_days ?? 7,
      tenant_id: req.tenantId,
      districts: districtsFor(req),
    }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Async query failed:', error.message);
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'RAG async query failed';
    res.status(status).json({ error: detail });
  }
};

// GET /api/rag/jobs/:id
exports.getJob = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get(`/api/rag/jobs/${encodeURIComponent(req.params.id)}`, {
      params: { tenant_id: req.tenantId }, ...tenantHeaders(req)
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'Failed to fetch job';
    res.status(status).json({ error: detail });
  }
};

// GET /api/rag/jobs?collection=&limit=&status=
exports.listJobs = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get('/api/rag/jobs', {
      params: { ...req.query, tenant_id: req.tenantId }, ...tenantHeaders(req)
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'Failed to list jobs';
    res.status(status).json({ error: detail });
  }
};

// DELETE /api/rag/jobs/:id
exports.deleteJob = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.delete(`/api/rag/jobs/${encodeURIComponent(req.params.id)}`, {
      params: { tenant_id: req.tenantId }, ...tenantHeaders(req)
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'Failed to delete job';
    res.status(status).json({ error: detail });
  }
};

// POST /api/rag/ingest  { collection }
exports.ingest = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { collection, force } = req.body;
    if (!collection) {
      return res.status(400).json({ error: 'collection is required' });
    }
    const { data } = await ragApi.post('/api/rag/ingest', {
      collection, tenant_id: req.tenantId, force: !!force
    }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Ingest failed:', error.message);
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'RAG ingestion failed';
    res.status(status).json({ error: detail });
  }
};

// GET /api/rag/stats
exports.stats = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get('/api/rag/stats', {
      params: { tenant_id: req.tenantId }, ...tenantHeaders(req)
    });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Stats failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch RAG stats' });
  }
};

// POST /api/rag/top-alerts/by-category
exports.topAlertsByCategory = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.post('/api/rag/top-alerts/by-category',
      { ...(req.body || {}), tenant_id: req.tenantId, districts: districtsFor(req) }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Top alerts by category failed:', error.message);
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'Failed to fetch top alerts by category';
    res.status(status).json({ error: detail });
  }
};

// GET /api/rag/top-alerts/cached
exports.topAlertsCached = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get('/api/rag/top-alerts/cached', {
      params: { ...req.query, tenant_id: req.tenantId, districts: districtsQueryParam(req) }, ...tenantHeaders(req)
    });
    res.json(data);
  } catch (error) {
    console.error('[RAG] Cached top alerts failed:', error.message);
    const status = error.response?.status || 500;
    const detail = error.response?.data?.detail || 'Failed to fetch cached top alerts';
    res.status(status).json({ error: detail });
  }
};

// ---------------------------------------------------------------------------
// v2 assistant (feature-flagged in the Python service; 404 there until enabled)
//
// The authenticated caller travels with every v2 request: tenant, user id,
// role, district scope and the RBAC permissions req.rbac resolved. It is
// spread LAST, so nothing in the request body can replace any of it.
// ---------------------------------------------------------------------------
const v2Caller = (req) => ({
  tenant_id: req.tenantId,
  user_id: req.user?.id,
  role: req.user?.role,
  districts: districtsFor(req),
  permissions: req.rbac?.permissions || {},
});
exports.v2Caller = v2Caller;

exports.v2QueryBody = (req) => {
  const { question, conversation_id, requested_districts } = req.body || {};
  return {
    question: String(question || '').trim(),
    conversation_id: conversation_id || null,
    requested_districts: Array.isArray(requested_districts) ? requested_districts : null,
    ...v2Caller(req),
  };
};

// GET /api/rag/v2/status
exports.v2Status = async (req, res) => {
  try {
    const { data } = await ragApi.get('/api/rag/v2/status', { ...tenantHeaders(req) });
    res.json({ enabled: !!data?.enabled });
  } catch (error) {
    res.json({ enabled: false });
  }
};

// POST /api/rag/v2/query  { question, conversation_id?, requested_districts? }
exports.queryV2 = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    if (!req.user?.id) return res.status(401).json({ error: 'user context required' });
    const body = exports.v2QueryBody(req);
    if (!body.question) return res.status(400).json({ error: 'question is required' });
    const { data } = await ragApi.post('/api/rag/v2/query', body, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    console.error('[RAG v2] Query failed:', error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'AI assistant query failed' });
  }
};

// GET /api/rag/v2/analysis/:id — progress and findings for the deep reading
// behind an answer. Scoped to the caller's tenant AND districts, exactly like
// /scan/:id: the job id alone must never reach another officer's scope.
exports.v2AnalysisStatus = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.get(
      `/api/rag/v2/analysis/${encodeURIComponent(req.params.id)}`, {
        params: { tenant_id: req.tenantId, districts: districtsQueryParam(req) },
        ...tenantHeaders(req),
        timeout: 15000,
      });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'Failed to fetch analysis' });
  }
};

// DELETE /api/rag/v2/analysis/:id
exports.v2AnalysisCancel = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { data } = await ragApi.delete(
      `/api/rag/v2/analysis/${encodeURIComponent(req.params.id)}`, {
        params: { tenant_id: req.tenantId, districts: districtsQueryParam(req) },
        ...tenantHeaders(req),
      });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'Failed to cancel analysis' });
  }
};

// POST /api/rag/v2/feedback  { kind, target, verdict?, correct_labels?, reason? }
exports.v2Feedback = async (req, res) => {
  try {
    if (!req.tenantId) return res.status(403).json({ error: 'tenant context required' });
    const { kind, target, verdict, correct_labels, reason } = req.body || {};
    const { data } = await ragApi.post('/api/rag/v2/feedback', {
      kind, target, verdict: verdict || null,
      correct_labels: Array.isArray(correct_labels) ? correct_labels : [],
      reason: String(reason || '').slice(0, 1000),
      tenant_id: req.tenantId,
      user_id: req.user?.id,
    }, { ...tenantHeaders(req) });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.response?.data?.detail || 'feedback failed' });
  }
};
