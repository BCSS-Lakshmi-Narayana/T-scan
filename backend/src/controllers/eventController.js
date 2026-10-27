const Event = require('../models/Event');
const Content = require('../models/Content');
const Alert = require('../models/Alert');
const Settings = require('../models/Settings');
const { createAuditLog } = require('../services/auditService');
const { logHistory } = require('../services/historyLogService');
const { scanEventOnce } = require('../services/eventMonitorService');
const { generateEventKeywords } = require('../services/keywordGenService');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');
const { checkEventActivation, checkKeywordCount, isCappedRole } = require('../utils/monitoringLimits');

const normalizeEventPayload = (body) => {
  const payload = { ...body };

  if (payload.start_date) payload.start_date = new Date(payload.start_date);
  if (payload.end_date) payload.end_date = new Date(payload.end_date);

  if (typeof payload.location === 'string') payload.location = payload.location.trim();

  const normalizeKeywordInput = (value, fallbackLanguage = 'all') => {
    if (!value) return [];
    const allowedLanguages = new Set(['en', 'hi', 'te', 'all']);
    const items = Array.isArray(value)
      ? value
      : String(value).split(/\n|,|;/g).map((s) => s.trim()).filter(Boolean);

    return items
      .map((k) => {
        if (typeof k === 'string') {
          return { keyword: k.trim(), language: fallbackLanguage };
        }
        if (!k) return null;
        const language = String(k.language || fallbackLanguage).toLowerCase();
        return {
          keyword: String(k.keyword || '').trim(),
          language: allowedLanguages.has(language) ? language : fallbackLanguage
        };
      })
      .filter((k) => k && k.keyword);
  };

  const keywordBuckets = [];
  keywordBuckets.push(...normalizeKeywordInput(payload.keywords, 'all'));
  keywordBuckets.push(...normalizeKeywordInput(payload.keywords_all, 'all'));
  keywordBuckets.push(...normalizeKeywordInput(payload.keywords_en, 'en'));
  keywordBuckets.push(...normalizeKeywordInput(payload.keywords_hi, 'hi'));
  keywordBuckets.push(...normalizeKeywordInput(payload.keywords_te, 'te'));

  if (keywordBuckets.length > 0) {
    const dedup = new Map();
    for (const kw of keywordBuckets) {
      const key = `${kw.language}::${kw.keyword.toLowerCase()}`;
      if (!dedup.has(key)) dedup.set(key, kw);
    }
    payload.keywords = Array.from(dedup.values());
  }

  if (Array.isArray(payload.platforms)) {
    payload.platforms = payload.platforms.filter(Boolean);
  }

  return payload;
};

// @desc    List events
// @route   GET /api/events
// @access  Private
const listEvents = async (req, res) => {
  try {
    const { status, district } = req.query;
    const query = withTenant(req, scopedDistrictQuery(req));
    if (district && district !== 'all') {
      if (req.user?.role !== 'admin' && !(req.user?.districts || []).includes(district)) {
        return res.status(403).json({ message: 'District not assigned to you' });
      }
      query.districts = district;
    }
    if (status && status !== 'all') query.status = status;

    const events = await Event.find(query).sort({ start_date: -1 });
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get one event
// @route   GET /api/events/:id
// @access  Private
const getEvent = async (req, res) => {
  try {
    const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create event
// @route   POST /api/events
// @access  Private (Admin/Analyst)
const createEvent = async (req, res) => {
  try {
    const payload = normalizeEventPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ message: 'name is required' });
    }

    if (payload.start_date && payload.end_date && payload.end_date < payload.start_date) {
      return res.status(400).json({ message: 'end_date must be after start_date' });
    }

    const districtCheck = validateScopedDistricts(req, payload.districts);
    if (!districtCheck.ok) {
      return res.status(400).json({ message: districtErrorMessage(districtCheck) });
    }
    payload.districts = districtCheck.districts;

    // New events start active so the engine picks them up immediately.
    // The user can still pause from the UI if they don't want monitoring yet.
    payload.status = payload.status || 'active';
    payload.auto_archive = false;

    // Officers may NOT self-declare a calendar origin — that would exempt the
    // event from the active-manual-events cap. Their created events are always
    // 'manual'. (Calendar-origin events are materialised by the sync service,
    // never through this officer-facing endpoint.)
    if (isCappedRole(req.user?.role)) payload.origin = 'manual';

    // Keyword-per-event cap (District Officers only; admins exempt). Rejected up
    // front so the officer can trim before saving — never silently truncated.
    if (Array.isArray(payload.keywords)) {
      const kc = checkKeywordCount(req.user, payload.keywords.length);
      if (!kc.ok) return res.status(400).json({ message: kc.message });
    }

    // Active manual-events cap: if activating this event would exceed the
    // officer's cap, STAGE it paused instead of rejecting (consistent with
    // profiles — create always succeeds, activation is what's capped). Only
    // manual events count; calendar-origin recurring events are exempt.
    let eventLimitNote = null;
    if (payload.status === 'active' && (payload.origin || 'manual') === 'manual') {
      const ec = await checkEventActivation(req, Event);
      if (!ec.ok) {
        payload.status = 'paused';
        eventLimitNote = ec.message;
      }
    }

    const event = await Event.create({
      ...payload,
      tenant_id: req.tenantId,
      created_by: req.user?.email || req.user?.id || 'system'
    });

    await createAuditLog(req.user, 'create', 'event', event.id, { name: event.name });
    logHistory(req, { module: 'events', action: 'create', recordId: event.id, recordLabel: event.name, state: event.state, districts: event.districts, changes: { name: event.name, location: event.location, start_date: event.start_date, end_date: event.end_date } });

    const eventBody = event.toObject ? event.toObject() : event;
    if (eventLimitNote) eventBody.limit_note = eventLimitNote;
    res.status(201).json(eventBody);

    // Fire an initial scan in the background (tenant-scoped) so the dashboard
    // isn't empty when the user lands on the new event. Errors are logged but
    // never block the create response.
    if (event.status === 'active') {
      (async () => {
        try {
          const settings = await Settings.findOne({ tenant_id: req.tenantId, district: '' });
          await scanEventOnce({ event, settings });
        } catch (err) {
          console.warn(`[Events] Initial scan failed for ${event.id}: ${err.message}`);
        }
      })();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update event
// @route   PUT /api/events/:id
// @access  Private (Admin/Analyst)
const updateEvent = async (req, res) => {
  try {
    const existing = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!existing) return res.status(404).json({ message: 'Event not found' });

    const payload = normalizeEventPayload(req.body);

    if (payload.start_date && payload.end_date && payload.end_date < payload.start_date) {
      return res.status(400).json({ message: 'end_date must be after start_date' });
    }

    // Officers cannot rewrite an event's origin (which would dodge the cap) —
    // strip any client-supplied origin so the stored value is preserved.
    if (isCappedRole(req.user?.role)) delete payload.origin;

    // Keyword-per-event cap (officers only), enforced ONLY when the keyword set
    // GROWS relative to what's stored. This still blocks adding keywords past
    // the cap, but doesn't block unrelated edits (or keyword reductions) on an
    // event that is already over an admin-lowered cap.
    if (Array.isArray(payload.keywords) && payload.keywords.length > (existing.keywords?.length || 0)) {
      const kc = checkKeywordCount(req.user, payload.keywords.length);
      if (!kc.ok) return res.status(400).json({ message: kc.message });
    }

    // Active manual-events cap when this update flips a manual event to active.
    if (payload.status === 'active' && existing.status !== 'active' && existing.origin === 'manual') {
      const ec = await checkEventActivation(req, Event, { excludeId: existing.id });
      if (!ec.ok) return res.status(400).json({ message: ec.message });
    }

    const updated = await Event.findOneAndUpdate(
      withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }),
      { ...payload, updated_by: req.user?.email || req.user?.id || '', updated_at: new Date() },
      { new: true }
    );

    await createAuditLog(req.user, 'update', 'event', req.params.id, { name: updated.name });
    logHistory(req, { module: 'events', action: 'update', recordId: req.params.id, recordLabel: updated.name, state: updated.state, districts: updated.districts, changes: payload });

    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Archive event
// @route   POST /api/events/:id/archive
// @access  Private (Admin/Analyst)
const archiveEvent = async (req, res) => {
  try {
    const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    event.status = 'archived';
    event.archived_at = new Date();
    await event.save();

    await createAuditLog(req.user, 'archive', 'event', req.params.id, { name: event.name });

    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Pause event
// @route   POST /api/events/:id/pause
// @access  Private (Admin/Analyst)
const pauseEvent = async (req, res) => {
  try {
    const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    event.status = 'paused';
    await event.save();

    await createAuditLog(req.user, 'pause', 'event', req.params.id, { name: event.name });

    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Resume event
// @route   POST /api/events/:id/resume
// @access  Private (Admin/Analyst)
const resumeEvent = async (req, res) => {
  try {
    const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Active manual-events cap: resuming to active must not exceed the officer's
    // cap. Only manual events are capped; calendar-origin events resume freely.
    if (event.origin === 'manual' && event.status !== 'active') {
      const ec = await checkEventActivation(req, Event, { excludeId: event.id });
      if (!ec.ok) return res.status(400).json({ message: ec.message });
    }

    // Resume always sets status to 'active' — no date-based auto-computation
    event.status = 'active';

    await event.save();

    await createAuditLog(req.user, 'resume', 'event', req.params.id, { name: event.name });

    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete event
// @route   DELETE /api/events/:id
// @access  Private (Admin/Analyst)
const deleteEvent = async (req, res) => {
  try {
    const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
    if (!event) return res.status(404).json({ message: 'Event not found' });

    await Event.deleteOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));

    await createAuditLog(req.user, 'delete', 'event', req.params.id, { name: event.name });
    logHistory(req, { module: 'events', action: 'delete', recordId: req.params.id, recordLabel: event.name, state: event.state, districts: event.districts, changes: { name: event.name, location: event.location } });

    res.status(200).json({ message: 'Event deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  archiveEvent,
  pauseEvent,
  resumeEvent,
  deleteEvent,
  // Extra endpoints for dashboard
  getEventDashboard: async (req, res) => {
    try {
      const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
      if (!event) return res.status(404).json({ message: 'Event not found' });

      // Stats via aggregation (no full content load into memory)
      const [contentTotal, platformStats, alerts] = await Promise.all([
        Content.countDocuments(withTenant(req, { event_ids: event.id })),
        Content.aggregate([
          { $match: withTenant(req, { event_ids: event.id }) },
          { $group: { _id: { $ifNull: ['$platform', 'unknown'] }, count: { $sum: 1 } } }
        ]),
        Alert.find(withTenant(req, { event_id: event.id })).sort({ created_at: -1 }).lean()
      ]);

      const byPlatform = platformStats.reduce((acc, s) => {
        acc[s._id] = s.count;
        return acc;
      }, {});

      const priorityAlerts = alerts.filter((a) => a.is_priority).length;
      const activeAlerts = alerts.filter((a) => a.status === 'active').length;

      res.status(200).json({
        event,
        stats: {
          content_total: contentTotal,
          alerts_total: alerts.length,
          alerts_active: activeAlerts,
          alerts_priority: priorityAlerts,
          content_by_platform: byPlatform
        },
        // Content is now fetched via paginated /api/events/:id/content endpoint
        recent_content: [],
        recent_alerts: alerts
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },
  runEventScan: async (req, res) => {
    try {
      const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
      if (!event) return res.status(404).json({ message: 'Event not found' });

      const settings = await Settings.findOne({ tenant_id: req.tenantId, district: '' });
      const result = await scanEventOnce({ event, settings });

      await createAuditLog(req.user, 'run', 'event', req.params.id, { action: 'manual_scan', result });

      res.status(200).json({ message: 'Event scan completed', ...result });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // ── Paginated content for an event (lazy-load / infinite scroll) ──
  getEventContent: async (req, res) => {
    try {
      const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
      if (!event) return res.status(404).json({ message: 'Event not found' });

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
      const platform = req.query.platform || 'all';
      const skip = (page - 1) * limit;

      const matchQuery = withTenant(req, { event_ids: event.id });
      if (platform !== 'all') matchQuery.platform = platform;

      const [content, total] = await Promise.all([
        Content.find(matchQuery)
          .sort({ published_at: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Content.countDocuments(matchQuery)
      ]);

      res.status(200).json({
        content,
        page,
        limit,
        total,
        has_more: skip + content.length < total
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },
  generateKeywords: async (req, res) => {
    try {
      const result = await generateEventKeywords(req.body);
      if (!result) {
        return res.status(502).json({ error: 'Keyword generation failed. Check that GROQ_API_KEY is set and valid.' });
      }
      res.status(200).json(result);
    } catch (error) {
      console.error('[GenerateKeywords] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  // ── Monitoring interval (accessible from Events page) ──
  getMonitoringInterval: async (req, res) => {
    try {
      let settings = await Settings.findOne({ tenant_id: req.tenantId, district: '' });
      if (!settings) settings = await Settings.create({ tenant_id: req.tenantId });
      const events = settings.api_config?.events || {};
      res.status(200).json({
        x: events.x ?? 60,
        instagram: events.instagram ?? 60,
        facebook: events.facebook ?? 60,
        youtube: events.youtube ?? 60,
        enabled: events.enabled !== false
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  updateMonitoringInterval: async (req, res) => {
    try {
      const { x, instagram, facebook, youtube, enabled } = req.body;
      const update = {};
      if (x != null) update['api_config.events.x'] = Math.max(5, Math.min(1440, Number(x) || 60));
      if (instagram != null) update['api_config.events.instagram'] = Math.max(5, Math.min(1440, Number(instagram) || 60));
      if (facebook != null) update['api_config.events.facebook'] = Math.max(5, Math.min(1440, Number(facebook) || 60));
      if (youtube != null) update['api_config.events.youtube'] = Math.max(5, Math.min(1440, Number(youtube) || 60));
      if (enabled != null) update['api_config.events.enabled'] = Boolean(enabled);
      update.updated_at = new Date();

      const settings = await Settings.findOneAndUpdate(
        { tenant_id: req.tenantId, district: '' },
        { $set: update },
        { new: true, upsert: true }
      );
      const events = settings.api_config?.events || {};
      await createAuditLog(req.user, 'update', 'settings', 'global_settings', {
        events: { x: events.x, instagram: events.instagram, facebook: events.facebook, youtube: events.youtube, enabled: events.enabled }
      });
      res.status(200).json({
        x: events.x ?? 60,
        instagram: events.instagram ?? 60,
        facebook: events.facebook ?? 60,
        youtube: events.youtube ?? 60,
        enabled: events.enabled !== false
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // ── Events Report: enrich events with discovered hashtags from content ──
  getEventsReport: async (req, res) => {
    try {
      const { district } = req.query;
      const query = withTenant(req, scopedDistrictQuery(req));
      if (district && district !== 'all') {
        if (req.user?.role !== 'admin' && !(req.user?.districts || []).includes(district)) {
          return res.status(403).json({ message: 'District not assigned to you' });
        }
        query.districts = district;
      }
      const events = await Event.find(query).sort({ start_date: -1 }).lean();
      const HASHTAG_RE = /#[\w\u0C00-\u0C7F\u0900-\u097F]+/g;

      const enriched = await Promise.all(
        events.map(async (evt) => {
          // Get all content linked to this event
          const content = await Content.find(withTenant(req, { event_ids: evt.id }))
            .select('text')
            .lean();

          // Extract all hashtags from post text
          const allHashtags = new Set();
          content.forEach((c) => {
            const matches = (c.text || '').match(HASHTAG_RE) || [];
            matches.forEach((h) => allHashtags.add(h.toLowerCase()));
          });

          // Get the original monitoring keywords (lowercase for comparison)
          const originalKw = new Set(
            (evt.keywords || []).map((k) => k.keyword?.toLowerCase().replace(/^#/, ''))
          );

          // New keywords = hashtags found in posts NOT in original keywords
          const newKeywords = Array.from(allHashtags).filter((h) => {
            const stripped = h.replace(/^#/, '');
            return !originalKw.has(stripped) && !originalKw.has(h);
          });

          return {
            id: evt.id,
            name: evt.name,
            start_date: evt.start_date,
            end_date: evt.end_date,
            location: evt.location,
            status: evt.status,
            origin: evt.origin,
            origin_calendar_id: evt.origin_calendar_id,
            keywords: evt.keywords,
            content_count: content.length,
            all_hashtags: Array.from(allHashtags).slice(0, 50),
            discovered_hashtags: newKeywords.slice(0, 30),
            report_pdf_url: evt.report_pdf_url || null
          };
        })
      );

      res.status(200).json(enriched);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },

  // ── Generate PDF report for a single event and upload to S3 ──
  generateEventReportPdf: async (req, res) => {
    try {
      const event = await Event.findOne(withTenant(req, { id: req.params.id, ...scopedDistrictQuery(req) }));
      if (!event) return res.status(404).json({ message: 'Event not found' });

      const content = await Content.find(withTenant(req, { event_ids: event.id }))
        .sort({ published_at: -1 })
        .limit(200)
        .lean();

      const alerts = await Alert.find(withTenant(req, { event_id: event.id }))
        .sort({ created_at: -1 })
        .limit(100)
        .lean();

      // Stats
      const byPlatform = content.reduce((acc, c) => {
        acc[c.platform || 'unknown'] = (acc[c.platform || 'unknown'] || 0) + 1;
        return acc;
      }, {});
      const highRiskCount = content.filter(c => c.risk_level === 'high' || c.risk_level === 'critical').length;

      // ── Prepare on-prem, tenant-isolated storage key ──
      // The PDF embeds a QR of its own URL, so build an ABSOLUTE url from the
      // request (its subdomain resolves to this tenant's /files folder).
      const nodePath = require('path');
      const nodeFs = require('fs');
      const STORAGE_DIR = process.env.FILE_STORAGE_DIR || nodePath.join(__dirname, '..', '..', 'storage');
      const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');
      const safeEventName = (event.name || 'event').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      const key = `event-reports/${event.id}-${safeEventName}-${Date.now()}.pdf`;
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
      const pdfUrl = `${proto}://${req.get('host')}/files/${key.split('/').map(encodeURIComponent).join('/')}`;

      // ── Build HTML ──
      const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const qrUrl = (value) => value
        ? `https://quickchart.io/qr?size=140&margin=1&text=${encodeURIComponent(String(value))}`
        : '';

      const kwStr = (event.keywords || []).map(k => esc(k.keyword)).join(', ') || '—';
      const startStr = event.start_date
        ? new Date(event.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : '—';
      const endStr = event.end_date
        ? new Date(event.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : '—';
      const monitoringRange = event.start_date && event.end_date
        ? `${new Date(event.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(event.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
        : '—';

      const contentRows = content.slice(0, 50).map((c, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(c.author_handle || c.author)}</td>
          <td>${c.platform || '—'}</td>
          <td style="max-width:350px;word-wrap:break-word">${esc((c.text || '').slice(0, 200))}</td>
          <td>${c.risk_level || 'low'}</td>
          <td>${c.published_at ? new Date(c.published_at).toLocaleDateString('en-IN') : '—'}</td>
        </tr>
      `).join('');

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; color: #1a1a2e; font-size: 11px; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1a1a2e; padding-bottom: 12px; margin-bottom: 16px; }
  .header h1 { font-size: 20px; margin: 0; }
  .header .sub { font-size: 10px; color: #666; }
  .qr-section { text-align: center; }
  .qr-section img { width: 100px; height: 100px; }
  .qr-section .label { font-size: 8px; color: #666; margin-top: 2px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .meta-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; }
  .meta-box .label { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
  .meta-box .value { font-size: 13px; font-weight: 600; margin-top: 3px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .stat { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 8px; text-align: center; }
  .stat .num { font-size: 18px; font-weight: 700; color: #0369a1; }
  .stat .lbl { font-size: 8px; color: #64748b; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { background: #1a1a2e; color: #fff; padding: 6px 8px; font-size: 9px; text-align: left; }
  td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; font-size: 10px; }
  tr:nth-child(even) { background: #f8fafc; }
  .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; }
</style></head><body>
  <div class="header">
    <div>
      <h1>${esc(event.name)}</h1>
      <div class="sub">Event Intelligence Report • Generated: ${new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}</div>
    </div>
    <div class="qr-section">
      <img src="${qrUrl(pdfUrl)}" alt="QR" />
      <div class="label">Scan to download</div>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-box"><div class="label">Event Date</div><div class="value">${esc(startStr)}</div></div>
    <div class="meta-box"><div class="label">Monitoring Range</div><div class="value">${esc(monitoringRange)}</div></div>
    <div class="meta-box"><div class="label">Status</div><div class="value">${event.status || '—'}</div></div>
    <div class="meta-box"><div class="label">Keywords</div><div class="value" style="font-size:10px">${kwStr}</div></div>
    <div class="meta-box"><div class="label">Location</div><div class="value">${esc(event.location || '—')}</div></div>
    <div class="meta-box"><div class="label">Platforms</div><div class="value">${(event.platforms || []).join(', ') || '—'}</div></div>
  </div>

  <div class="stats-grid">
    <div class="stat"><div class="num">${content.length}</div><div class="lbl">Total Posts</div></div>
    <div class="stat"><div class="num">${alerts.length}</div><div class="lbl">Alerts</div></div>
    <div class="stat"><div class="num">${highRiskCount}</div><div class="lbl">High Risk</div></div>
    <div class="stat"><div class="num">${Object.keys(byPlatform).length}</div><div class="lbl">Platforms</div></div>
  </div>

  ${content.length > 0 ? `
  <h3 style="font-size:13px;margin-bottom:6px;">Recent Posts (${Math.min(content.length, 50)} of ${content.length})</h3>
  <table>
    <thead><tr><th>#</th><th>Author</th><th>Platform</th><th>Content</th><th>Risk</th><th>Date</th></tr></thead>
    <tbody>${contentRows}</tbody>
  </table>` : '<p style="color:#94a3b8;text-align:center;padding:20px;">No posts collected for this event yet.</p>'}

  <div class="footer">
    <span>Confidential — Events Intelligence Report</span>
    <span>${new Date().toLocaleDateString('en-IN')}</span>
  </div>
</body></html>`;

      // ── Render with Puppeteer ──
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' }
      });
      await browser.close();

      // ── Write to on-prem disk under the tenant's namespace ──
      const absPath = nodePath.join(STORAGE_DIR, safeTenant(req.tenantId), key);
      nodeFs.mkdirSync(nodePath.dirname(absPath), { recursive: true });
      await nodeFs.promises.writeFile(absPath, pdfBuffer);

      // ── Save URL on Event record ──
      await Event.updateOne(
        withTenant(req, { id: event.id }),
        { $set: { report_pdf_url: pdfUrl, updated_at: new Date() } }
      );

      res.status(200).json({ pdf_url: pdfUrl });
    } catch (error) {
      console.error('[EventReportPdf] Error:', error.message);
      res.status(500).json({ message: error.message });
    }
  }
};
