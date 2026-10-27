// tenantStatsService (POLICE saga)
// ---------------------------------------------------------------------------
// Builds a comprehensive, module-wise usage snapshot for a single tenant, used
// by the Super Admin dashboard "Stats" tab. Every metric is tenant-scoped
// ({ tenant_id }) and every query is defensive: a missing model or a failed
// aggregation degrades that one metric to 0 / [] instead of failing the whole
// response.
//
// SYNC GUARANTEE: the Alerts module groups Alert by `status` with the SAME
// tenant_id filter the tenant's own endpoints use (alertController.getAlertSummary
// / buildAlertStats), so the numbers shown to the operator MATCH the numbers the
// tenant sees on their Alerts Center. Sentiment comes from the linked Content doc
// (Content.sentiment: negative→Negative, neutral→Moderate, positive→Positive),
// joined exactly like alertController does (Content.id OR Content.content_id), so
// sentiment buckets reconcile to the status totals.
//
// Generic module contract (shared with the political saga frontend):
//   { key, label, icon, total,
//     cards:      [{ label, value }],
//     tables:     [{ title, columns:[...], rows:[{ label, values:[...] }] }],   (optional)
//     breakdowns: [{ title, items:[{ label, value }] }] }

const safeRequire = (path) => {
  try { return require(path); } catch (_) { return null; }
};

const User = safeRequire('../models/User');
const Alert = safeRequire('../models/Alert');
const Content = safeRequire('../models/Content');
const Source = safeRequire('../models/Source');
const Keyword = safeRequire('../models/Keyword');
const Grievance = safeRequire('../models/Grievance');
const Event = safeRequire('../models/Event');
const OngoingEvent = safeRequire('../models/OngoingEvent');
const MasterCalendarEvent = safeRequire('../models/MasterCalendarEvent');
const DailyProgramme = safeRequire('../models/DailyProgramme');
const Dial100Incident = safeRequire('../models/Dial100Incident');
const Analysis = safeRequire('../models/Analysis');
const POI = safeRequire('../models/POI');
const EngagerAnalysis = safeRequire('../models/EngagerAnalysis');
const Report = safeRequire('../models/Report');
const ComprehensiveReport = safeRequire('../models/ComprehensiveReport');
const CriticismReport = safeRequire('../models/CriticismReport');
const QueryReport = safeRequire('../models/QueryReport');
const SuggestionReport = safeRequire('../models/SuggestionReport');
const DailyIntelligenceReport = safeRequire('../models/DailyIntelligenceReport');
const GrievanceWorkflowReport = safeRequire('../models/GrievanceWorkflowReport');
const TwitterAccount = safeRequire('../models/TwitterAccount');
const InstagramStory = safeRequire('../models/InstagramStory');
const YouTubeTranscript = safeRequire('../models/YouTubeTranscript');
const PolicyMapping = safeRequire('../models/PolicyMapping');
const LegalSection = safeRequire('../models/LegalSection');
const PlatformPolicy = safeRequire('../models/PlatformPolicy');
const Template = safeRequire('../models/Template');
const AuditLog = safeRequire('../models/AuditLog');

// ── defensive query helpers ────────────────────────────────────────────────
async function safeCount(model, filter) {
  if (!model) return 0;
  try { return await model.countDocuments(filter); } catch (_) { return 0; }
}

async function safeRecentCount(model, filter, dateField, days) {
  if (!model) return 0;
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return await model.countDocuments({ ...filter, [dateField]: { $gte: since } });
  } catch (_) { return 0; }
}

const toItems = (rows, remap = null) =>
  (rows || [])
    .filter((r) => r._id !== null && r._id !== undefined && r._id !== '')
    .map((r) => ({ label: remap ? (remap[String(r._id)] || String(r._id)) : String(r._id), value: r.count }));

async function safeGroup(model, filter, field, limit = 12) {
  if (!model) return [];
  try {
    const rows = await model.aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]);
    return toItems(rows);
  } catch (_) { return []; }
}

// Sentiment is stored on Content as negative/neutral/positive; surfaced to the
// operator as Negative / Moderate / Positive (same as the tenant Alerts Center).
const SENTIMENTS = [
  { key: 'negative', label: 'Negative' },
  { key: 'neutral', label: 'Moderate' },
  { key: 'positive', label: 'Positive' }
];
// The status columns the spec asks for, in order. `active` is included for context.
const STATUS_COLUMNS = [
  { key: 'active', label: 'Active' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'false_positive', label: 'False Positive' },
  { key: 'escalated', label: 'Escalated' }
];

// Filter dropdown option lists (sent to the frontend so it renders them generically).
const ALERT_PLATFORM_OPTIONS = [
  { value: 'all', label: 'All Platforms' },
  { value: 'x', label: 'X (Twitter)' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' }
];
const ALERT_CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'political', label: 'Political' },
  { value: 'communal', label: 'Communal' },
  { value: 'trouble_makers', label: 'Trouble Makers' },
  { value: 'defamation', label: 'Defamation' },
  { value: 'narcotics', label: 'Narcotics' },
  { value: 'history_sheeters', label: 'History Sheeters' },
  { value: 'others', label: 'Others' }
];

// ── ALERTS (headline module) ────────────────────────────────────────────────
// total + per-status counts (synced) + sentiment×status matrix + platform + category.
// `filters` = { platform, category } — optional, mirror the tenant Alerts Center.
async function buildAlertBreakdowns(tenantId, filters = {}) {
  const empty = {
    total: 0,
    byStatus: { active: 0, acknowledged: 0, escalated: 0, false_positive: 0, resolved: 0 },
    bySentiment: [],
    sentimentMatrix: [],
    byPlatform: [],
    byCategory: []
  };
  if (!Alert) return empty;
  try {
    const contentColl = (Content && Content.collection && Content.collection.name) || 'contents';

    // ── optional filters (Platform / Category) ──────────────────────────────
    // These mirror the tenant Alerts Center filters so the operator sees the
    // SAME numbers the tenant sees when they apply the same filter.
    const match = { tenant_id: tenantId };
    if (filters.platform && filters.platform !== 'all') match.platform = filters.platform;
    if (filters.category && filters.category !== 'all') {
      // Resolve category → sources → content ids, exactly like alertController:
      // an alert matches if its content belongs to a source in that category OR
      // its source_category was stamped directly.
      let catSourceIds = [];
      try {
        const catSources = Source
          ? await Source.find({ tenant_id: tenantId, category: filters.category }).select('id').lean()
          : [];
        catSourceIds = catSources.map((s) => s.id);
      } catch (_) { catSourceIds = []; }
      let catContentIds = [];
      if (catSourceIds.length && Content) {
        try {
          catContentIds = await Content.distinct('id', { tenant_id: tenantId, source_id: { $in: catSourceIds } });
        } catch (_) { catContentIds = []; }
      }
      if (catContentIds.length) {
        match.$or = [{ content_id: { $in: catContentIds } }, { source_category: filters.category }];
      } else {
        match.source_category = filters.category;
      }
    }

    const rows = await Alert.aggregate([
      { $match: match },
      {
        // Join the alert's content to read its persisted sentiment, matching
        // Content.id OR Content.content_id exactly like alertController does.
        $lookup: {
          from: contentColl,
          let: { aId: '$content_id' },
          pipeline: [
            { $match: { $expr: { $or: [{ $eq: ['$id', '$$aId'] }, { $eq: ['$content_id', '$$aId'] }] } } },
            { $project: { sentiment: 1 } },
            { $limit: 1 }
          ],
          as: 'c'
        }
      },
      { $addFields: { _sentiment: { $ifNull: [{ $arrayElemAt: ['$c.sentiment', 0] }, 'neutral'] } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byPlatform: [{ $group: { _id: '$platform', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byCategory: [{ $group: { _id: '$source_category', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          sentimentStatus: [{ $group: { _id: { s: '$_sentiment', st: '$status' }, count: { $sum: 1 } } }]
        }
      }
    ]).allowDiskUse(true);

    const f = rows[0] || {};
    const num = (arr) => (arr && arr[0] && arr[0].n) || 0;

    // Status totals (across all sentiments) — these match the tenant dashboard.
    const byStatus = { active: 0, acknowledged: 0, escalated: 0, false_positive: 0, resolved: 0 };
    (f.byStatus || []).forEach((r) => { if (r._id && byStatus.hasOwnProperty(r._id)) byStatus[r._id] = r.count; });

    // Build the sentiment × status matrix from the grouped pairs.
    const matrixIndex = {};        // sentimentKey -> { statusKey: count }
    SENTIMENTS.forEach((s) => { matrixIndex[s.key] = {}; });
    (f.sentimentStatus || []).forEach((r) => {
      const s = (r._id && r._id.s) || 'neutral';
      const st = r._id && r._id.st;
      if (!matrixIndex[s]) matrixIndex[s] = {};
      if (st) matrixIndex[s][st] = (matrixIndex[s][st] || 0) + r.count;
    });

    const sentimentMatrix = SENTIMENTS.map((s) => {
      const counts = matrixIndex[s.key] || {};
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const row = { sentiment: s.label, total };
      STATUS_COLUMNS.forEach((c) => { row[c.key] = counts[c.key] || 0; });
      return row;
    });

    const bySentiment = sentimentMatrix.map((r) => ({ label: r.sentiment, value: r.total }));

    return {
      total: num(f.total),
      byStatus,
      bySentiment,
      sentimentMatrix,
      byPlatform: toItems(f.byPlatform),
      byCategory: toItems(f.byCategory)
    };
  } catch (_) {
    return empty;
  }
}

// Build the Alerts module object (the headline) from the raw breakdowns.
function alertsModule(a) {
  return {
    key: 'alerts',
    label: 'Alerts',
    icon: 'alert',
    total: a.total,
    cards: [
      { label: 'Total Alerts', value: a.total },
      { label: 'Active', value: a.byStatus.active },
      { label: 'Acknowledged', value: a.byStatus.acknowledged },
      { label: 'False Positive', value: a.byStatus.false_positive },
      { label: 'Escalated', value: a.byStatus.escalated }
    ],
    // Sentiment × status: rows = Negative/Moderate/Positive, columns = Total + statuses.
    tables: [
      {
        title: 'By Sentiment × Status',
        columns: ['Total', ...STATUS_COLUMNS.map((c) => c.label)],
        rows: a.sentimentMatrix.map((r) => ({
          label: r.sentiment,
          values: [r.total, ...STATUS_COLUMNS.map((c) => r[c.key] || 0)]
        }))
      }
    ],
    // Platform/Category are available as FILTERS in the header; no separate
    // breakdown bars (kept compact — just the sentiment×status table).
    breakdowns: [],
    // Tells the frontend to render the Platform / Category filter bar.
    filterable: true,
    filterControls: [
      { key: 'platform', options: ALERT_PLATFORM_OPTIONS },
      { key: 'category', options: ALERT_CATEGORY_OPTIONS }
    ]
  };
}

// ── GRIEVANCES ───────────────────────────────────────────────────────────────
// Replicates grievanceController.getStats / tabToWorkflowQuery EXACTLY so the
// operator's numbers match the tenant's Grievance Management dashboard.
//   • Base = { is_active: true }  → matches the tenant "Total".
//   • Pending / Escalated / Closed / FIR blend the newer `grievance_workflow.status`
//     (PENDING/ESCALATED/CLOSED) with the legacy `workflow_status`
//     (closed / converted_to_fir) for older records.
//   • Criticism / Suggestion = records with a `criticism.report_id` /
//     `suggestion.report_id` (same condition the tenant's tabs use).
//   • Handle filter = the tagged government account (`tagged_account`).
async function buildGrievanceBreakdowns(tenantId, filters = {}) {
  const empty = {
    total: 0, pending: 0, escalated: 0, closed: 0, fir: 0,
    criticism: 0, suggestion: 0,
    byHandle: [], byPlatform: [], byClassification: [], handleOptions: []
  };
  if (!Grievance) return empty;
  try {
    const base = { tenant_id: tenantId, is_active: true };
    const match = { ...base };
    // Handle filter: exact tagged_account (the dropdown values come from the same
    // field's distinct list below, so filter and options stay consistent).
    if (filters.handle && filters.handle !== 'all') match.tagged_account = filters.handle;

    const exists = { $exists: true, $ne: null };

    const [rows, handleRows] = await Promise.all([
      Grievance.aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'n' }],
            workflow: [{ $group: { _id: '$workflow_status', count: { $sum: 1 } } }],
            gWorkflow: [{ $group: { _id: '$grievance_workflow.status', count: { $sum: 1 } } }],
            classification: [{ $group: { _id: '$classification', count: { $sum: 1 } } }],
            criticism: [{ $match: { 'criticism.report_id': exists } }, { $count: 'n' }],
            suggestion: [{ $match: { 'suggestion.report_id': exists } }, { $count: 'n' }],
            byHandle: [{ $group: { _id: '$tagged_account', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 12 }],
            byPlatform: [{ $group: { _id: '$platform', count: { $sum: 1 } } }, { $sort: { count: -1 } }]
          }
        }
      ]).allowDiskUse(true),
      // Handle dropdown options — always the FULL (unfiltered) list so the operator
      // can switch handles regardless of the current selection.
      Grievance.aggregate([
        { $match: base },
        { $group: { _id: '$tagged_account', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ])
    ]);

    const f = rows[0] || {};
    const num = (arr) => (arr && arr[0] && arr[0].n) || 0;
    const total = num(f.total);
    const workflowMap = Object.fromEntries((f.workflow || []).map((i) => [i._id || 'received', i.count]));
    const gWorkflowMap = Object.fromEntries((f.gWorkflow || []).map((i) => [i._id, i.count]));

    const gPending = gWorkflowMap.PENDING || 0;
    const gEscalated = gWorkflowMap.ESCALATED || 0;
    const gClosed = gWorkflowMap.CLOSED || 0;
    const noGWorkflowCount = gWorkflowMap.null || gWorkflowMap['null'] || 0;
    const legacyClosed = workflowMap.closed || 0;
    const legacyFir = workflowMap.converted_to_fir || 0;
    const legacyPending = Math.max(0, noGWorkflowCount - legacyClosed - legacyFir);

    return {
      total,
      pending: gPending + legacyPending,
      escalated: gEscalated,
      closed: gClosed + legacyClosed,
      fir: legacyFir,
      criticism: num(f.criticism),
      suggestion: num(f.suggestion),
      byHandle: toItems(f.byHandle),
      byPlatform: toItems(f.byPlatform),
      byClassification: toItems(f.classification),
      handleOptions: toItems(handleRows)
    };
  } catch (_) {
    return empty;
  }
}

function grievancesModule(g) {
  // Handle filter dropdown options (All + each tagged account, count in the label).
  const handleOptions = [{ value: 'all', label: 'All Handles' }].concat(
    (g.handleOptions || []).map((h) => ({ value: h.label, label: `${h.label} (${h.value})` }))
  );
  return {
    key: 'grievances',
    label: 'Grievances',
    icon: 'message',
    total: g.total,
    // Category/type-wise tiles, matching the tenant's grievance tabs.
    cards: [
      { label: 'Total', value: g.total },
      { label: 'Pending', value: g.pending },
      { label: 'Escalated', value: g.escalated },
      { label: 'Closed', value: g.closed },
      { label: 'FIR', value: g.fir },
      { label: 'Criticism', value: g.criticism },
      { label: 'Suggestion', value: g.suggestion }
    ],
    breakdowns: [
      { title: 'By Handle (Tagged Account)', items: g.byHandle },
      { title: 'By Platform', items: g.byPlatform }
    ],
    filterable: true,
    filterControls: [{ key: 'handle', options: handleOptions }]
  };
}

// ── EVENTS ───────────────────────────────────────────────────────────────────
// Overview mode: counts by status (active/planned/paused/archived) + a dropdown
// of every event. When an event is selected (filters.event), it switches to that
// event's full stats, mirroring eventController.getEventDashboard:
//   • content linked via Content.event_ids (array contains the event id)
//   • alerts linked via Alert.event_id
//   • platform-wise = content grouped by platform
//   • keyword-wise = content's risk_factors.keyword distribution (indexed)
async function buildEventBreakdowns(tenantId, filters = {}) {
  const empty = {
    mode: 'overview', total: 0, active: 0, planned: 0, paused: 0, archived: 0,
    byStatus: [], eventOptions: []
  };
  if (!Event) return empty;
  try {
    // Full event list for the dropdown (id + name + status), newest first.
    const eventDocs = await Event.find({ tenant_id: tenantId })
      .select('id name status').sort({ created_at: -1 }).limit(200).lean();
    const eventOptions = eventDocs.map((e) => ({ id: e.id, name: e.name, status: e.status }));

    const selected = filters.event && filters.event !== 'all' ? filters.event : null;

    if (!selected) {
      // Accumulated content/alerts across ALL events (any content tagged with an
      // event, any alert carrying an event_id).
      const cMatch = { tenant_id: tenantId, 'event_ids.0': { $exists: true } };
      const [total, statusRows, contentTotal, platformRows, alerts] = await Promise.all([
        Event.countDocuments({ tenant_id: tenantId }),
        Event.aggregate([
          { $match: { tenant_id: tenantId } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),
        Content ? Content.countDocuments(cMatch) : 0,
        Content ? Content.aggregate([
          { $match: cMatch },
          { $group: { _id: { $ifNull: ['$platform', 'unknown'] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]) : [],
        Alert ? Alert.find({ tenant_id: tenantId, event_id: { $exists: true, $ne: null } }).select('status is_priority').lean() : []
      ]);
      const sMap = Object.fromEntries(statusRows.map((r) => [r._id, r.count]));
      return {
        mode: 'overview',
        total,
        active: sMap.active || 0,
        planned: sMap.planned || 0,
        paused: sMap.paused || 0,
        archived: sMap.archived || 0,
        byStatus: toItems(statusRows),
        contentTotal,
        alertsTotal: alerts.length,
        alertsActive: alerts.filter((a) => a.status === 'active').length,
        alertsPriority: alerts.filter((a) => a.is_priority).length,
        byPlatform: toItems(platformRows),
        eventOptions
      };
    }

    // ── selected-event stats ── (need the event's configured keywords too)
    const event = await Event.findOne({ tenant_id: tenantId, id: selected })
      .select('id name status keywords').lean();
    if (!event) return { ...empty, eventOptions };

    const cMatch = { tenant_id: tenantId, event_ids: selected };
    const [contentTotal, platformRows, alerts] = await Promise.all([
      Content ? Content.countDocuments(cMatch) : 0,
      Content ? Content.aggregate([
        { $match: cMatch },
        { $group: { _id: { $ifNull: ['$platform', 'unknown'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]) : [],
      Alert ? Alert.find({ tenant_id: tenantId, event_id: selected }).select('status is_priority').lean() : []
    ]);

    // Just the keyword strings configured on this event (no per-keyword metrics).
    const keywords = (event.keywords || [])
      .map((k) => (k && k.keyword ? String(k.keyword).trim() : ''))
      .filter(Boolean);

    return {
      mode: 'event',
      eventId: selected,
      eventName: event.name,
      eventStatus: event.status,
      total: contentTotal,
      contentTotal,
      alertsTotal: alerts.length,
      alertsActive: alerts.filter((a) => a.status === 'active').length,
      alertsPriority: alerts.filter((a) => a.is_priority).length,
      byPlatform: toItems(platformRows),
      keywords,
      eventOptions
    };
  } catch (_) {
    return empty;
  }
}

function eventsModule(e) {
  const eventOptions = [{ value: 'all', label: 'All Events' }].concat(
    (e.eventOptions || []).map((o) => ({ value: o.id, label: o.status ? `${o.name} · ${o.status}` : o.name }))
  );
  const filterControls = [{ key: 'event', options: eventOptions }];

  if (e.mode === 'event') {
    return {
      key: 'events',
      label: `Events — ${e.eventName}`,
      icon: 'calendar',
      total: e.contentTotal,
      cards: [
        { label: 'Content', value: e.contentTotal },
        { label: 'Alerts', value: e.alertsTotal },
        { label: 'Active Alerts', value: e.alertsActive },
        { label: 'Priority Alerts', value: e.alertsPriority }
      ],
      breakdowns: [
        { title: 'By Platform', items: e.byPlatform }
      ],
      // Plain keyword chips for this event (no metrics).
      lists: [{ title: 'Event Keywords', items: e.keywords || [] }],
      filterable: true,
      filterControls
    };
  }

  // Overview: event counts + accumulated content/alerts across ALL events.
  return {
    key: 'events',
    label: 'Events',
    icon: 'calendar',
    total: e.total,
    cards: [
      { label: 'Total Events', value: e.total },
      { label: 'Active', value: e.active },
      { label: 'Content (All Events)', value: e.contentTotal },
      { label: 'Alerts (All Events)', value: e.alertsTotal },
      { label: 'Active Alerts', value: e.alertsActive }
    ],
    breakdowns: [
      { title: 'Content by Platform (All Events)', items: e.byPlatform }
    ],
    filterable: true,
    filterControls
  };
}

// ── MONITORED SOURCES (platform × category matrix) ───────────────────────────
// Mirrors the tenant's "Profiles Being Monitored" popup: counts every monitored
// Source by platform (twitter→x) and category, bucketing any unknown/blank
// category into "Others" (same as the tenant's normalizeCategory). All canonical
// platforms are shown even with 0, plus an "All Platforms" totals row.
const SOURCE_CATEGORIES = [
  { key: 'political', label: 'Political' },
  { key: 'communal', label: 'Communal' },
  { key: 'trouble_makers', label: 'Trouble Makers' },
  { key: 'defamation', label: 'Defamation' },
  { key: 'narcotics', label: 'Narcotics' },
  { key: 'history_sheeters', label: 'History Sheeters' },
  { key: 'others', label: 'Others' }
];
const SOURCE_PLATFORMS = [
  { key: 'x', label: 'X' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' }
];

async function buildSourceBreakdowns(tenantId) {
  const catKeys = SOURCE_CATEGORIES.map((c) => c.key);
  const catSet = new Set(catKeys);
  const counts = {}; // platform -> { <cat>: n, total: n }
  const ensure = (p) => {
    if (!counts[p]) { counts[p] = { total: 0 }; catKeys.forEach((k) => { counts[p][k] = 0; }); }
    return counts[p];
  };
  SOURCE_PLATFORMS.forEach((p) => ensure(p.key)); // always show the canonical platforms

  let grandTotal = 0;
  if (Source) {
    try {
      const rows = await Source.aggregate([
        { $match: { tenant_id: tenantId } },
        { $group: { _id: { platform: '$platform', category: '$category' }, count: { $sum: 1 } } }
      ]);
      rows.forEach((r) => {
        let p = String((r._id && r._id.platform) || '').toLowerCase();
        if (p === 'twitter') p = 'x';
        if (!p) p = 'x';
        let c = String((r._id && r._id.category) || '').toLowerCase();
        if (!catSet.has(c)) c = 'others';
        const row = ensure(p);
        row[c] += r.count;
        row.total += r.count;
        grandTotal += r.count;
      });
    } catch (_) { /* leave zeros */ }
  }

  // Canonical platforms first, then any extra discovered platform (whatsapp/etc).
  const discovered = Object.keys(counts)
    .filter((p) => !SOURCE_PLATFORMS.some((sp) => sp.key === p))
    .sort();
  const ordered = [...SOURCE_PLATFORMS.map((p) => p.key), ...discovered];
  const labelFor = (p) => {
    const f = SOURCE_PLATFORMS.find((sp) => sp.key === p);
    return f ? f.label : p.charAt(0).toUpperCase() + p.slice(1);
  };

  const rows = ordered.map((p) => ({
    label: labelFor(p),
    values: [...catKeys.map((k) => counts[p][k] || 0), counts[p].total || 0]
  }));
  // "All Platforms" totals row (flagged so the frontend emphasises it).
  const totalsByCat = catKeys.map((k) => ordered.reduce((s, p) => s + (counts[p][k] || 0), 0));
  rows.push({ label: 'All Platforms', values: [...totalsByCat, grandTotal], total: true });

  return {
    grandTotal,
    columns: [...SOURCE_CATEGORIES.map((c) => c.label), 'Total'],
    rows
  };
}

function sourcesModule(s) {
  return {
    key: 'sources',
    label: 'Monitored Sources',
    icon: 'radar',
    total: s.grandTotal,
    cards: [],
    tables: [{ title: 'Platform × Category', rowHeader: 'Platform', columns: s.columns, rows: s.rows }],
    breakdowns: []
  };
}

// opts = { filters: { platform, category, handle, event }, only: <moduleKey> | null }
// `only:<key>` is a fast path used when the operator changes a module's filter —
// it recomputes ONLY that module instead of every module.
async function buildTenantStats(tenantId, opts = {}) {
  const { filters = {}, only = null } = opts;
  const stamp = () => new Date().toISOString();

  if (only === 'alerts') {
    const a = await buildAlertBreakdowns(tenantId, filters);
    return { generated_at: stamp(), system: 'police', only: 'alerts', summary: { alerts: a.total }, modules: [alertsModule(a)] };
  }
  if (only === 'grievances') {
    const g = await buildGrievanceBreakdowns(tenantId, filters);
    return { generated_at: stamp(), system: 'police', only: 'grievances', summary: { grievances: g.total }, modules: [grievancesModule(g)] };
  }
  if (only === 'events') {
    const e = await buildEventBreakdowns(tenantId, filters);
    return { generated_at: stamp(), system: 'police', only: 'events', summary: { events: e.total }, modules: [eventsModule(e)] };
  }

  const T = { tenant_id: tenantId };

  const [
    alertStats,
    users, usersByRole, usersActive,
    content, contentByPlatform, contentByType, content7d,
    sources, sourcesByPlatform, sourcesByPriority, keywords,
    grievanceStats,
    eventStats,
    sourceStats,
    incidents, incidentsByStatus, incidentsByCategory,
    analyses, analysesBySentiment, analysesByRisk, pois, engagerAnalyses,
    reports, reportsByStatus, comprehensiveReports, criticismReports,
    queryReports, suggestionReports, dailyIntelReports, grievanceWorkflowReports,
    twitterAccounts, instagramStories, youtubeTranscripts,
    policyMappings, legalSections, platformPolicies, templates,
    auditLogs, auditLogs7d
  ] = await Promise.all([
    buildAlertBreakdowns(tenantId, filters),

    safeCount(User, T), safeGroup(User, T, 'role'), safeCount(User, { ...T, is_active: true }),

    safeCount(Content, T), safeGroup(Content, T, 'platform'), safeGroup(Content, T, 'content_type'),
    safeRecentCount(Content, T, 'created_at', 7),
    safeCount(Source, T), safeGroup(Source, T, 'platform'), safeGroup(Source, T, 'priority'),
    safeCount(Keyword, T),

    buildGrievanceBreakdowns(tenantId, filters),

    buildEventBreakdowns(tenantId, filters),

    buildSourceBreakdowns(tenantId),

    safeCount(Dial100Incident, T), safeGroup(Dial100Incident, T, 'status'),
    safeGroup(Dial100Incident, T, 'category'),

    safeCount(Analysis, T), safeGroup(Analysis, T, 'sentiment'), safeGroup(Analysis, T, 'risk_level'),
    safeCount(POI, T), safeCount(EngagerAnalysis, T),

    safeCount(Report, T), safeGroup(Report, T, 'status'), safeCount(ComprehensiveReport, T),
    safeCount(CriticismReport, T), safeCount(QueryReport, T), safeCount(SuggestionReport, T),
    safeCount(DailyIntelligenceReport, T), safeCount(GrievanceWorkflowReport, T),

    safeCount(TwitterAccount, T), safeCount(InstagramStory, T), safeCount(YouTubeTranscript, T),

    safeCount(PolicyMapping, T), safeCount(LegalSection, T), safeCount(PlatformPolicy, T),
    safeCount(Template, T),

    safeCount(AuditLog, T), safeRecentCount(AuditLog, T, 'created_at', 7)
  ]);

  const modules = [
    alertsModule(alertStats),
    grievancesModule(grievanceStats),
    eventsModule(eventStats),
    sourcesModule(sourceStats),
    {
      key: 'users',
      label: 'Users & Access',
      icon: 'users',
      total: users,
      cards: [
        { label: 'Total Users', value: users },
        { label: 'Active', value: usersActive }
      ],
      breakdowns: [{ title: 'By Role', items: usersByRole }]
    },
    {
      key: 'reports',
      label: 'Reports',
      icon: 'file',
      total:
        reports + comprehensiveReports + criticismReports + queryReports +
        suggestionReports + dailyIntelReports + grievanceWorkflowReports,
      cards: [
        { label: 'Alert Reports', value: reports },
        { label: 'Comprehensive', value: comprehensiveReports },
        { label: 'Criticism', value: criticismReports },
        { label: 'Query', value: queryReports },
        { label: 'Suggestion', value: suggestionReports },
        { label: 'Daily Intelligence', value: dailyIntelReports },
        { label: 'Grievance Workflow', value: grievanceWorkflowReports }
      ],
      breakdowns: [{ title: 'Alert Reports by Status', items: reportsByStatus }]
    }
  ];

  const totalRecords = modules.reduce((sum, m) => sum + (Number(m.total) || 0), 0);

  return {
    generated_at: new Date().toISOString(),
    system: 'police',
    summary: {
      alerts: alertStats.total,
      users,
      content,
      grievances: grievanceStats.total,
      incidents,
      total_records: totalRecords
    },
    modules
  };
}

module.exports = { buildTenantStats, buildAlertBreakdowns, buildGrievanceBreakdowns, buildEventBreakdowns, buildSourceBreakdowns };
