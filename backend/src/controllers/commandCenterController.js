// ── Command Center ────────────────────────────────────────────────────────
// One aggregated payload behind the analytical dashboard, for BOTH roles:
//
//   State Admin (role 'admin')  → the whole tenant, optionally narrowed to one
//                                 district via the global X-District-Filter.
//                                 Gets the cross-district comparison table.
//   District Officer ('level-1')→ hard-clamped to req.user.districts. Sees the
//                                 same widgets, computed only over their own
//                                 district(s), and no cross-district comparison.
//
// Every figure here is derived from data we actually store. Widgets with no
// backing data (cameras, cyber-case categories, crowd counts, predictions) are
// deliberately absent rather than faked.
//
// Scoping rules (all fail-closed via the shared helpers):
//   * tenant   — withTenant() on every single query.
//   * district — models carrying `districts` use scopedDistrictQuery(); Alert has
//                no districts field of its own, so it is scoped through its
//                parent Source (same pattern as analyticsController).
const Content = require('../models/Content');
const Analysis = require('../models/Analysis');
const Alert = require('../models/Alert');
const Source = require('../models/Source');
const Event = require('../models/Event');
const Grievance = require('../models/Grievance');
const Keyword = require('../models/Keyword');
const Report = require('../models/Report');
const Tenant = require('../models/Tenant');
const AuditLog = require('../models/AuditLog');
const { withTenant } = require('../utils/tenantFilter');
const { scopedDistrictQuery, districtScopeSignature } = require('../utils/scopedDistricts');
const geoService = require('../services/geoService');

let queueStats = () => null;
try {
  // Optional: the sentiment dispatcher powers the "engine" health tile. Never fatal.
  queueStats = require('../services/sentiment').dispatcherStats;
} catch (_) { /* module unavailable — health tile degrades gracefully */ }

const DAY_MS = 24 * 60 * 60 * 1000;
const RISK_ORDER = ['critical', 'high', 'medium', 'low'];

// ── One analysis per post ──────────────────────────────────────────────────
// A post can be analysed more than once (the retry sweep re-runs anything that
// previously failed or was rejected by backpressure), so the Analysis
// collection holds several rows for the same content_id. Counting rows would
// count those posts repeatedly and inflate every figure derived from them —
// sentiment, risk averages, intent volumes, per-district totals.
//
// These stages collapse to the MOST RECENT analysis per post, which is also the
// correct one: a re-analysis supersedes the earlier attempt.
// _id is the tie-breaker so the pick is deterministic when two rows share a
// timestamp (bulk re-analysis writes can land in the same millisecond).
//
// $top picks the winner inside the group rather than sorting the whole
// collection first. A leading $sort is a blocking stage that buffers every
// matched document and dies at 32MB, and allowDiskUse cannot rescue it: this
// Atlas tier refuses external sorting.
const LATEST_PER_POST = [
  {
    $group: {
      _id: '$content_id',
      doc: { $top: { sortBy: { analyzed_at: -1, _id: -1 }, output: '$$ROOT' } }
    }
  },
  { $replaceRoot: { newRoot: '$doc' } }
];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// Percentage change vs the previous comparable window. null when there is no
// prior baseline, so the UI can omit the delta instead of printing a fake +100%.
const delta = (current, previous) => {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
};

const countsToObject = (rows, keys) => {
  const out = {};
  keys.forEach((k) => { out[k] = 0; });
  rows.forEach((r) => {
    const key = String(r._id || '').toLowerCase();
    if (key) out[key] = r.count;
  });
  return out;
};

// ── The officer's / admin's visible district list ────────────────────────────
// Admin  → every district configured on the tenant (narrowed if a global filter
//          is active). Officer → only their assigned districts.
const resolveVisibleDistricts = async (req) => {
  const isAdmin = req.user?.role === 'admin';
  const scope = scopedDistrictQuery(req);

  // An explicit single-district selection (admin global filter, or an officer
  // viewing one of their own) narrows everything to exactly that district.
  if (typeof scope.districts === 'string') {
    return scope.districts === '__none__' ? [] : [scope.districts];
  }
  if (scope.districts?.$in) return scope.districts.$in;

  if (!isAdmin) return req.user?.districts || [];

  // Admin, unfiltered: the tenant's configured district list. police_config is
  // the one the onboarding flow actually populates; location_config is the
  // newer generic block and is often still empty, so check both.
  const tenant = await Tenant.findOne({ $or: [{ id: req.tenantId }, { tenant_id: req.tenantId }] })
    .select('police_config.districts location_config.districts')
    .lean();
  const configured = (tenant?.police_config?.districts?.length
    ? tenant.police_config.districts
    : tenant?.location_config?.districts) || [];
  if (configured.length) return configured;

  // Fallback: a tenant may not have location_config populated yet. Derive the
  // list from the districts actually present on their data + officer accounts,
  // so the dashboard still works instead of rendering an empty table.
  const [fromSources, fromOfficers] = await Promise.all([
    Source.distinct('districts', withTenant(req, {})),
    require('../models/User').distinct('districts', withTenant(req, { role: 'level-1' }))
  ]);
  return [...new Set([...(fromSources || []), ...(fromOfficers || [])])].filter(Boolean).sort();
};

const getOverview = async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const districtScope = scopedDistrictQuery(req);
    const visibleDistricts = await resolveVisibleDistricts(req);

    const today = startOfToday();
    const yesterday = new Date(today.getTime() - DAY_MS);
    const trendFrom = new Date(today.getTime() - 13 * DAY_MS);

    // ── District-tagged only ────────────────────────────────────────────
    // Every figure on this board is meant to roll up to a district. Records
    // with no district tag would inflate the tenant-wide totals while being
    // absent from the map and the district table, so the page would not add up.
    // When no explicit district is selected we therefore still require a tag,
    // rather than falling back to "everything in the tenant".
    const TAGGED = { districts: { $exists: true, $not: { $size: 0 } } };
    const scopeOf = (extra = {}) => withTenant(req, {
      ...districtScope,
      ...(districtScope.districts ? {} : TAGGED),
      ...extra
    });

    // Alert has no `districts` of its own — it inherits its parent Source's.
    // Restricting to sources that carry a district keeps alerts on the same
    // basis as everything else.
    const sourceFilter = withTenant(req, districtScope.districts ? districtScope : TAGGED);
    const sources = await Source.find(sourceFilter).select('id districts platform is_active').lean();
    const alertScope = { source_id: { $in: sources.map((s) => s.id) } };
    const sourceDistricts = new Map(sources.map((s) => [s.id, s.districts || []]));

    const contentScope = scopeOf();
    const analysisScope = scopeOf();
    const eventScope = scopeOf();
    const grievanceScope = scopeOf();

    const [
      postsToday, postsYesterday, postsTotal,
      alertRiskRows, alertStatusRows, alertTypeRows, alertsToday, alertsYesterday,
      sentimentRows, riskLevelRows, riskAverages,
      platformRows, platformAlertRows,
      grievanceStatusRows, grievanceToday, grievanceYesterday, grievanceCategoryRows,
      eventRows, liveEvents,
      trendContent, trendAlerts,
      topicRows,
      districtContentRows, districtGrievanceRows, districtAlertRows, districtRiskRows,
      districtSentimentRows, intentRows,
      recentAlerts, recentAudit,
      reportRows,
      analysedRows, analysedByPlatformRows, configuredKeywords
    ] = await Promise.all([
      Content.countDocuments({ ...contentScope, created_at: { $gte: today } }),
      Content.countDocuments({ ...contentScope, created_at: { $gte: yesterday, $lt: today } }),
      Content.countDocuments(contentScope),

      Alert.aggregate([
        { $match: withTenant(req, alertScope) },
        { $group: { _id: '$risk_level', count: { $sum: 1 } } }
      ]),
      Alert.aggregate([
        { $match: withTenant(req, alertScope) },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Alert.aggregate([
        { $match: withTenant(req, alertScope) },
        { $group: { _id: '$alert_type', count: { $sum: 1 } } }
      ]),
      Alert.countDocuments(withTenant(req, { ...alertScope, created_at: { $gte: today } })),
      Alert.countDocuments(withTenant(req, { ...alertScope, created_at: { $gte: yesterday, $lt: today } })),

      Analysis.aggregate([
        { $match: analysisScope },
        ...LATEST_PER_POST,
        { $group: { _id: '$sentiment', count: { $sum: 1 } } }
      ]),
      Analysis.aggregate([
        { $match: analysisScope },
        ...LATEST_PER_POST,
        { $group: { _id: '$risk_level', count: { $sum: 1 } } }
      ]),
      Analysis.aggregate([
        { $match: analysisScope },
        ...LATEST_PER_POST,
        {
          $group: {
            _id: null,
            risk: { $avg: '$risk_score' },
            violence: { $avg: '$violence_score' },
            threat: { $avg: '$threat_score' },
            hate: { $avg: '$hate_score' },
            n: { $sum: 1 }
          }
        }
      ]),

      Content.aggregate([
        { $match: contentScope },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ]),
      Alert.aggregate([
        { $match: withTenant(req, alertScope) },
        { $lookup: { from: 'contents', localField: 'content_id', foreignField: 'id', as: 'c' } },
        { $unwind: { path: '$c', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: '$c.platform',
            count: { $sum: 1 },
            // Distinct posts that alerted — a single post can raise more than
            // one alert (e.g. an ai_risk AND a velocity alert), so alert count
            // and alerting-post count are different questions.
            posts: { $addToSet: '$content_id' }
          }
        }
      ]),

      Grievance.aggregate([
        { $match: grievanceScope },
        { $group: { _id: '$workflow_status', count: { $sum: 1 } } }
      ]),
      Grievance.countDocuments({ ...grievanceScope, post_date: { $gte: today } }),
      Grievance.countDocuments({ ...grievanceScope, post_date: { $gte: yesterday, $lt: today } }),
      Grievance.aggregate([
        { $match: grievanceScope },
        { $group: { _id: '$escalation.category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 }
      ]),

      Event.find({ ...eventScope, status: { $in: ['active', 'planned'] } })
        .select('name districts status start_date end_date keywords location last_polled_at origin')
        .sort({ start_date: -1 })
        .limit(8)
        .lean(),
      Event.countDocuments({ ...eventScope, status: 'active' }),

      Content.aggregate([
        { $match: { ...contentScope, created_at: { $gte: trendFrom } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Alert.aggregate([
        { $match: withTenant(req, { ...alertScope, created_at: { $gte: trendFrom } }) },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),

      // Trending keywords WITH their district attribution, so the panel can show
      // where each term is actually surfacing rather than a single state-wide
      // number. Counting distinct content_ids (not rows) keeps a post that
      // carries two districts from being counted twice in the keyword total.
      Analysis.aggregate([
        { $match: { ...analysisScope, analyzed_at: { $gte: trendFrom } } },
        ...LATEST_PER_POST,
        { $unwind: '$triggered_keywords' },
        { $unwind: '$districts' },
        {
          $group: {
            _id: { keyword: '$triggered_keywords', district: '$districts' },
            posts: { $addToSet: '$content_id' }
          }
        }
      ]),

      // ── Per-district rollups (drive the comparison table) ──
      Content.aggregate([
        { $match: contentScope },
        { $unwind: '$districts' },
        { $group: { _id: '$districts', posts: { $sum: 1 } } }
      ]),
      Grievance.aggregate([
        { $match: grievanceScope },
        { $unwind: '$districts' },
        { $group: { _id: '$districts', grievances: { $sum: 1 } } }
      ]),
      // Grouped by source AND risk so alerts can be split high/medium/low per
      // district (Alert carries no district of its own — it comes via Source).
      Alert.aggregate([
        { $match: withTenant(req, alertScope) },
        { $group: { _id: { source: '$source_id', risk: '$risk_level' }, count: { $sum: 1 } } }
      ]),
      // Per-district risk composition, counted straight from Analysis.risk_level
      // — no derived index, just how many posts landed in each band.
      Analysis.aggregate([
        { $match: analysisScope },
        ...LATEST_PER_POST,
        { $unwind: '$districts' },
        {
          $group: {
            _id: '$districts',
            critical: { $sum: { $cond: [{ $eq: ['$risk_level', 'critical'] }, 1, 0] } },
            high: { $sum: { $cond: [{ $eq: ['$risk_level', 'high'] }, 1, 0] } },
            medium: { $sum: { $cond: [{ $eq: ['$risk_level', 'medium'] }, 1, 0] } },
            low: { $sum: { $cond: [{ $eq: ['$risk_level', 'low'] }, 1, 0] } },
            n: { $sum: 1 }
          }
        }
      ]),

      // District-level sentiment: the State Admin's main read of "how is each
      // district feeling", and the map's second colour mode.
      Analysis.aggregate([
        { $match: analysisScope },
        ...LATEST_PER_POST,
        { $unwind: '$districts' },
        { $group: { _id: { d: '$districts', s: '$sentiment' }, c: { $sum: 1 } } }
      ]),
      // Threat categories actually observed, rather than a hardcoded taxonomy —
      // this keeps the risk panel correct for any tenant's own keyword set.
      Analysis.aggregate([
        { $match: { ...analysisScope, intent: { $nin: [null, ''] } } },
        ...LATEST_PER_POST,
        {
          $group: {
            _id: '$intent',
            count: { $sum: 1 },
            avgRisk: { $avg: '$risk_score' },
            high: { $sum: { $cond: [{ $in: ['$risk_level', ['high', 'critical']] }, 1, 0] } }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]),

      Alert.find(withTenant(req, alertScope))
        .select('id risk_level alert_type status created_at threat_details source_id')
        .sort({ created_at: -1 })
        .limit(12)
        .lean(),
      AuditLog.find(withTenant(req, {}))
        .select('action resource_type user_name timestamp')
        .sort({ timestamp: -1 })
        .limit(8)
        .lean(),

      Report.aggregate([
        { $match: withTenant(req, districtScope) },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),

      // Distinct POSTS analysed, not analysis rows.
      Analysis.aggregate([
        { $match: analysisScope },
        { $group: { _id: '$content_id' } },
        { $count: 'n' }
      ]),

      // Distinct posts analysed per platform — lets the UI show the real
      // funnel (collected → analysed → alerted) instead of putting a post
      // count and an alert count side by side as if they shared a denominator.
      Analysis.aggregate([
        { $match: analysisScope },
        { $group: { _id: '$content_id' } },
        { $lookup: { from: 'contents', localField: '_id', foreignField: 'id', as: 'c' } },
        { $unwind: { path: '$c', preserveNullAndEmptyArrays: false } },
        { $group: { _id: '$c.platform', count: { $sum: 1 } } }
      ]),

      // The tenant's OWN configured watch list. District rule mirrors the
      // matching engine in monitorService: a keyword with no districts is
      // tenant-wide, one with districts applies only to those districts.
      Keyword.find(withTenant(req, {
        is_active: true,
        ...(districtScope.districts
          ? { $or: [{ districts: { $size: 0 } }, { districts: { $exists: false } }, districtScope] }
          : {})
      })).select('keyword category language districts weight').lean()
    ]);

    // ── Assemble ──────────────────────────────────────────────────────────
    const alertsByRisk = countsToObject(alertRiskRows, ['low', 'medium', 'high']);
    const alertsByStatus = countsToObject(alertStatusRows, ['active', 'acknowledged', 'resolved', 'escalated', 'false_positive']);
    const alertsByType = countsToObject(alertTypeRows, ['keyword_risk', 'ai_risk', 'velocity', 'new_post']);
    const sentiment = countsToObject(sentimentRows, ['positive', 'neutral', 'negative']);
    const riskLevels = countsToObject(riskLevelRows, RISK_ORDER);
    const avg = riskAverages[0] || {};

    // Fold source-level alert counts up to districts, keeping the risk split.
    const alertsByDistrict = {};
    const alertRiskByDistrict = {};
    districtAlertRows.forEach((row) => {
      const risk = String(row._id.risk || '').toLowerCase();
      (sourceDistricts.get(row._id.source) || []).forEach((d) => {
        alertsByDistrict[d] = (alertsByDistrict[d] || 0) + row.count;
        if (!alertRiskByDistrict[d]) alertRiskByDistrict[d] = { high: 0, medium: 0, low: 0 };
        if (risk in alertRiskByDistrict[d]) alertRiskByDistrict[d][risk] += row.count;
      });
    });

    const contentByDistrict = Object.fromEntries(districtContentRows.map((r) => [r._id, r.posts]));
    const grievanceByDistrict = Object.fromEntries(districtGrievanceRows.map((r) => [r._id, r.grievances]));
    const riskByDistrict = Object.fromEntries(districtRiskRows.map((r) => [r._id, r]));

    const eventCountByDistrict = {};
    const allEventRows = await Event.aggregate([
      { $match: { ...eventScope, status: 'active' } },
      { $unwind: '$districts' },
      { $group: { _id: '$districts', count: { $sum: 1 } } }
    ]);
    allEventRows.forEach((r) => { eventCountByDistrict[r._id] = r.count; });

    // Sentiment per district, plus a single net score (+100 all-positive →
    // -100 all-negative) so districts can be ranked and colour-scaled by mood.
    const sentimentByDistrict = {};
    districtSentimentRows.forEach((row) => {
      const d = row._id.d;
      const s = row._id.s || 'neutral';
      if (!sentimentByDistrict[d]) sentimentByDistrict[d] = { positive: 0, neutral: 0, negative: 0 };
      sentimentByDistrict[d][s] = (sentimentByDistrict[d][s] || 0) + row.c;
    });

    const districts = visibleDistricts.map((name) => {
      const r = riskByDistrict[name] || {};
      const s = sentimentByDistrict[name] || { positive: 0, neutral: 0, negative: 0 };
      const sTotal = s.positive + s.neutral + s.negative;
      const ar = alertRiskByDistrict[name] || { high: 0, medium: 0, low: 0 };
      // Three levels, matching Alert.risk_level (low/medium/high). Analysis also
      // has a 'critical' level, which is folded into high rather than shown as a
      // fourth band — otherwise the post panel and the alert panel would use
      // different scales and an almost-always-zero row would sit on screen.
      const analysed = r.n || 0;
      const rl = {
        high: (r.critical || 0) + (r.high || 0),
        medium: r.medium || 0,
        low: r.low || 0
      };
      const severe = rl.high;
      return {
        district: name,
        posts: contentByDistrict[name] || 0,
        alerts: alertsByDistrict[name] || 0,
        // Alerts split by severity — the district's actual risk mix.
        alertRisk: ar,
        highRiskAlerts: ar.high,
        events: eventCountByDistrict[name] || 0,
        grievances: grievanceByDistrict[name] || 0,
        analysed,
        // Analysis risk levels, counted directly — no derived index.
        riskLevels: rl,
        highRisk: severe,
        // The worst level actually observed here. One critical post matters
        // operationally, so this reports the peak rather than an average that
        // would dilute it away. null when nothing has been analysed.
        riskBand: analysed
          ? (rl.high ? 'high' : rl.medium ? 'medium' : 'low')
          : null,
        highRiskShare: analysed ? Math.round((severe / analysed) * 100) : null,
        sentiment: s,
        sentimentTotal: sTotal,
        // null (not 0) when nothing was analysed — "no data" and "perfectly
        // balanced" must not render the same way.
        netSentiment: sTotal ? Math.round(((s.positive - s.negative) / sTotal) * 100) : null,
        positivePct: sTotal ? Math.round((s.positive / sTotal) * 100) : null
      };
    }).sort((a, b) =>
      (b.riskLevels.critical - a.riskLevels.critical)
      || (b.riskLevels.high - a.riskLevels.high)
      || (b.alerts - a.alerts));

    // 14-day trend, zero-filled so the axis is continuous.
    const contentByDay = Object.fromEntries(trendContent.map((r) => [r._id, r.count]));
    const alertsByDay = Object.fromEntries(trendAlerts.map((r) => [r._id, r.count]));
    const trend = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(today.getTime() - i * DAY_MS);
      const key = d.toISOString().slice(0, 10);
      trend.push({ date: key, posts: contentByDay[key] || 0, alerts: alertsByDay[key] || 0 });
    }

    const platformCounts = Object.fromEntries(platformRows.map((r) => [r._id, r.count]));
    const platformAlerts = Object.fromEntries(platformAlertRows.map((r) => [r._id, r.count]));
    const platformAnalysed = Object.fromEntries(analysedByPlatformRows.map((r) => [r._id, r.count]));
    const platforms = ['x', 'instagram', 'facebook', 'youtube'].map((p) => {
      const posts = platformCounts[p] || 0;
      const analysed = platformAnalysed[p] || 0;
      return {
        platform: p,
        posts,
        analysed,
        alerts: platformAlerts[p] || 0,
        share: pct(posts, postsTotal)
      };
    });

    const analysedTotal = analysedRows[0]?.n || 0;

    // ── Watch-list performance ────────────────────────────────────────────
    // Report the tenant's OWN configured keywords and how many posts each one
    // matched — including the ones that matched nothing, which is the useful
    // half of the picture.
    //
    // Detections come from Analysis.triggered_keywords, which mixes two
    // sources: the tenant's configured keywords (merged in by monitorService's
    // Layer 3) and a hardcoded lexicon inside mappingService. Intersecting
    // against the configured list keeps only the former, so nothing the officer
    // never configured can appear here.
    const detected = new Map();      // normalised keyword -> { posts:Set, districts:{} }
    topicRows.forEach((r) => {
      const key = String(r._id.keyword || '').toLowerCase().trim();
      if (!key) return;
      if (!detected.has(key)) detected.set(key, { posts: new Set(), districts: {} });
      const e = detected.get(key);
      r.posts.forEach((p) => e.posts.add(p));
      e.districts[r._id.district] = (e.districts[r._id.district] || 0) + r.posts.length;
    });

    const topics = configuredKeywords
      .map((k) => {
        const hit = detected.get(String(k.keyword || '').toLowerCase().trim());
        return {
          keyword: k.keyword,
          category: k.category,
          language: k.language,
          // Where the officer scoped this keyword ([] = tenant-wide)
          scope: k.districts || [],
          count: hit ? hit.posts.size : 0,
          districts: hit
            ? Object.entries(hit.districts)
                .map(([district, count]) => ({ district, count }))
                .sort((a, b) => b.count - a.count)
            : []
        };
      })
      // Matched first, then alphabetical so the silent ones stay in a stable order
      .sort((a, b) => b.count - a.count || String(a.keyword).localeCompare(String(b.keyword)));

    const keywordStats = {
      configured: topics.length,
      matched: topics.filter((t) => t.count > 0).length,
      silent: topics.filter((t) => t.count === 0).length
    };

    const activeSources = sources.filter((s) => s.is_active).length;
    const q = (() => { try { return queueStats(); } catch (_) { return null; } })();

    res.status(200).json({
      generated_at: new Date().toISOString(),
      scope: {
        role: req.user?.role,
        isStateAdmin: isAdmin,
        districtCount: visibleDistricts.length,
        districts: visibleDistricts,
        // Non-null when the view is pinned to exactly one district.
        activeDistrict: typeof districtScope.districts === 'string' && districtScope.districts !== '__none__'
          ? districtScope.districts
          : null,
        signature: districtScopeSignature(req)
      },
      kpis: {
        districts: { total: visibleDistricts.length },
        posts: {
          today: postsToday,
          // District-tagged only, so this reconciles with the district table.
          total: postsTotal,
          delta: delta(postsToday, postsYesterday)
        },
        analysed: { total: analysedTotal },
        alerts: {
          active: alertsByStatus.active || 0,
          total: alertRiskRows.reduce((s, r) => s + r.count, 0),
          today: alertsToday,
          delta: delta(alertsToday, alertsYesterday)
        },
        escalated: { total: alertsByStatus.escalated || 0 },
        events: { live: liveEvents, upcoming: eventRows.filter((e) => e.status === 'planned').length },
        grievances: {
          today: grievanceToday,
          pending: grievanceStatusRows.find((r) => r._id === 'received')?.count || 0,
          delta: delta(grievanceToday, grievanceYesterday)
        },
        // Risk straight from Analysis.risk_level counts — no synthesised index.
        // Three bands to match Alert.risk_level; 'critical' folds into high.
        risk: {
          high: (riskLevels.critical || 0) + (riskLevels.high || 0),
          medium: riskLevels.medium || 0,
          low: riskLevels.low || 0,
          severe: (riskLevels.critical || 0) + (riskLevels.high || 0),
          analysed: analysedTotal
        },
        engine: {
          sourcesActive: activeSources,
          sourcesTotal: sources.length,
          queueActive: q?.active ?? null,
          queueDepth: q?.queued ?? null
        }
      },
      alerts: { byRisk: alertsByRisk, byStatus: alertsByStatus, byType: alertsByType },
      sentiment,
      riskLevels,
      riskProfile: {
        // Analysis stores violence/threat/hate on a 0–1000 scale; normalise to 0–100
        // so the three read on one comparable axis.
        violence: Math.round((avg.violence || 0) / 10),
        threat: Math.round((avg.threat || 0) / 10),
        hate: Math.round((avg.hate || 0) / 10),
        sampled: avg.n || 0
      },
      platforms,
      trend,
      intents: intentRows.map((r) => ({
        intent: r._id,
        count: r.count,
        highRisk: r.high,
        avgRisk: Math.round(r.avgRisk || 0)
      })),
      topics,
      keywordStats,
      grievances: {
        byStatus: countsToObject(grievanceStatusRows, ['received', 'reviewed', 'action_taken', 'closed', 'converted_to_fir']),
        byCategory: grievanceCategoryRows.filter((r) => r._id).map((r) => ({ category: r._id, count: r.count }))
      },
      reports: countsToObject(reportRows, ['pending', 'generated', 'sent']),
      districts,
      events: eventRows.map((e) => ({
        id: e.id,
        name: e.name,
        districts: e.districts || [],
        status: e.status,
        origin: e.origin,
        location: e.location,
        keywords: (e.keywords || []).length,
        start_date: e.start_date,
        last_polled_at: e.last_polled_at
      })),
      feed: [
        ...recentAlerts.map((a) => ({
          kind: 'alert',
          at: a.created_at,
          severity: a.risk_level,
          title: a.threat_details?.intent || a.alert_type?.replace(/_/g, ' ') || 'Alert',
          detail: (a.threat_details?.reasons || [])[0] || null,
          districts: sourceDistricts.get(a.source_id) || []
        })),
        ...recentAudit.map((l) => ({
          kind: 'activity',
          at: l.timestamp,
          severity: null,
          title: `${l.action || 'action'} · ${l.resource_type || ''}`.trim(),
          detail: l.user_name || null,
          districts: []
        }))
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/command-center/geo ────────────────────────────────────────────
// District boundaries for the tenant's own state, restricted to the districts
// this caller may see (an officer gets only their own outlines, so the map can
// never expose a district they have no access to).
//
// `coverage` is the honest part: bundled boundary files are AC-level and can
// predate district reorganisation, so some tenants will have districts with no
// polygon. Those are reported, never approximated.
const getGeo = async (req, res) => {
  try {
    const tenant = await Tenant.findOne({ $or: [{ id: req.tenantId }, { tenant_id: req.tenantId }] })
      .select('police_config.state police_config.districts location_config')
      .lean();

    const stateName = tenant?.police_config?.state
      || tenant?.location_config?.state_name
      || tenant?.location_config?.region_name;

    // The map draws the caller's FULL permitted area, deliberately ignoring the
    // global district filter. That filter is a view preference — narrowing the
    // geometry to one district would leave the map with a single shape and no
    // surrounding context, which is the opposite of what a map is for. The
    // selected district is highlighted client-side instead.
    //
    // Access is still clamped: an officer only ever gets their own districts,
    // and an unassigned officer gets none.
    const isAdmin = req.user?.role === 'admin';
    let visible;
    if (isAdmin) {
      visible = (tenant?.police_config?.districts?.length
        ? tenant.police_config.districts
        : tenant?.location_config?.districts) || [];
      if (!visible.length) visible = await resolveVisibleDistricts(req);
    } else {
      visible = req.user?.districts || [];
    }

    if (!stateName) {
      return res.status(200).json({
        available: false,
        reason: 'no_state_configured',
        message: 'No state is configured for this tenant, so district boundaries cannot be resolved.',
        states: geoService.listAvailableStates()
      });
    }

    const geo = geoService.loadState(stateName);
    if (!geo) {
      return res.status(200).json({
        available: false,
        reason: 'no_boundary_file',
        state: stateName,
        message: `No boundary file is bundled for ${stateName}.`,
        states: geoService.listAvailableStates()
      });
    }

    const { matched, unmapped } = geoService.matchDistricts(geo, visible);
    const keep = new Set(matched.map((m) => m.key));
    // Label each polygon with the TENANT's spelling, so the frontend can join
    // it to the metrics without repeating the normalisation rules.
    const labelByKey = Object.fromEntries(matched.map((m) => [m.key, m.district]));

    const features = geo.districts
      .filter((d) => keep.has(d.key))
      .map((d) => ({ district: labelByKey[d.key], key: d.key, polygons: d.polygons, bbox: d.bbox }));

    // Fit the viewport to what is actually drawn (an officer viewing one
    // district should see that district, not the whole state).
    let bbox = geo.bbox;
    if (features.length && features.length < geo.districts.length) {
      const xs = features.flatMap((f) => [f.bbox[0], f.bbox[2]]);
      const ys = features.flatMap((f) => [f.bbox[1], f.bbox[3]]);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    res.status(200).json({
      available: features.length > 0,
      state: stateName,
      bbox,
      features,
      coverage: {
        drawn: features.length,
        requested: visible.length,
        missing: unmapped,
        complete: unmapped.length === 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getOverview, getGeo };
