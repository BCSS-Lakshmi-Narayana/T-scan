const Source = require('../models/Source');
const Content = require('../models/Content');
const Alert = require('../models/Alert');
const Analysis = require('../models/Analysis');
const Report = require('../models/Report');
const Keyword = require('../models/Keyword');
const Grievance = require('../models/Grievance');
const GrievanceSource = require('../models/GrievanceSource');
const GrievanceWorkflowReport = require('../models/GrievanceWorkflowReport');
const SuggestionReport = require('../models/SuggestionReport');
const CriticismReport = require('../models/CriticismReport');
const POI = require('../models/POI');
const { withTenant } = require('../utils/tenantFilter');
const { scopedDistrictMatch, scopedGrievanceIdsForDistrict, scopedDistrictQuery } = require('../utils/scopedDistricts');

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
const endOfDay = (date) => { const d = new Date(date); d.setHours(23, 59, 59, 999); return d; };
const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };
const toISODate = (date) => startOfDay(date).toISOString().slice(0, 10);

const parseDateParam = (value, { end = false } = {}) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return end ? endOfDay(d) : startOfDay(d);
};

const safePct = (cur, prev) => {
  if (!prev) return cur ? 100 : 0;
  return Number((((cur - prev) / prev) * 100).toFixed(1));
};

/* ═══════════════════════════════════════════════════════════════════
   ALERTS INTELLIGENCE
   ═══════════════════════════════════════════════════════════════════ */
const getAlertsIntelligence = async (req, res) => {
  try {
    const now = new Date();
    const from = parseDateParam(req.query.from) || addDays(startOfDay(now), -29);
    const to = parseDateParam(req.query.to, { end: true }) || endOfDay(now);

    // District scoping: Source carries `districts` directly. Alert/Content have
    // no district field of their own, so we resolve the set of alerts linked to
    // an in-scope Source (via source_id) and filter every Alert/Report query by
    // that set — alerts with no source_id are excluded from officer views, same
    // as the Reports-list fix.
    const districtMatch = scopedDistrictMatch(req, req.query.district);
    const sourceQuery = (extra = {}) => withTenant(req, districtMatch ? { ...extra, ...districtMatch } : extra);
    let scopedAlertIds = null;
    if (districtMatch) {
      const scopedSourceIds = await Source.find(sourceQuery()).distinct('id');
      scopedAlertIds = await Alert.find(withTenant(req, { source_id: { $in: scopedSourceIds } })).distinct('id');
    }
    const alertQuery = (extra = {}) => withTenant(req, scopedAlertIds ? { ...extra, id: { $in: scopedAlertIds } } : extra);
    const reportQuery = (extra = {}) => withTenant(req, scopedAlertIds ? { ...extra, alert_id: { $in: scopedAlertIds } } : extra);

    // ── Total Accounts (Sources) ──
    const [totalSources, activeSources] = await Promise.all([
      Source.countDocuments(sourceQuery()),
      Source.countDocuments(sourceQuery({ is_active: true }))
    ]);

    // ── Accounts added in date range by category & platform ──
    const sourcesInRange = await Source.aggregate([
      { $match: sourceQuery({ created_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { platform: '$platform', category: '$category' },
          count: { $sum: 1 }
        }
      }
    ]);

    const sourcesByPlatform = {};
    const sourcesByCategory = {};
    let totalSourcesInRange = 0;
    sourcesInRange.forEach(({ _id, count }) => {
      const p = _id.platform || 'unknown';
      const c = _id.category || 'unknown';
      sourcesByPlatform[p] = (sourcesByPlatform[p] || 0) + count;
      sourcesByCategory[c] = (sourcesByCategory[c] || 0) + count;
      totalSourcesInRange += count;
    });

    // ── Accounts trend (daily) ──
    const accountsTrend = await Source.aggregate([
      { $match: sourceQuery({ created_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Risk Distribution ──
    const riskDistribution = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: '$risk_level', count: { $sum: 1 } } }
    ]);

    const riskByPlatform = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: { platform: '$platform', risk_level: '$risk_level' }, count: { $sum: 1 } } }
    ]);

    const riskByCategory = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: { category: '$source_category', risk_level: '$risk_level' }, count: { $sum: 1 } } }
    ]);

    // ── Alert Types Distribution ──
    const alertTypesDist = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: '$alert_type', count: { $sum: 1 } } }
    ]);

    // ── Platform-wise alerts ──
    const alertsByPlatform = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);

    // ── Escalations (status-based) ──
    const escalationStats = await Report.aggregate([
      { $match: reportQuery() },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const escalationByPlatform = await Report.aggregate([
      { $match: reportQuery() },
      { $group: { _id: { platform: '$platform', status: '$status' }, count: { $sum: 1 } } }
    ]);

    // ── Actions (reports generated/sent in date range) ──
    const actionsTrend = await Report.aggregate([
      { $match: reportQuery({ generated_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { platform: '$platform' },
          count: { $sum: 1 }
        }
      }
    ]);

    // ── All-time reports by platform (for Actions by Platform chart) ──
    const allReportsByPlatform = await Report.aggregate([
      { $match: reportQuery() },
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);

    const actionsTimeline = await Report.aggregate([
      { $match: reportQuery({ generated_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$generated_at' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Top Active Accounts (most alerts) ──
    const topActiveAccounts = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { author: '$author', handle: '$author_handle', platform: '$platform' },
          alertCount: { $sum: 1 },
          highRisk: { $sum: { $cond: [{ $eq: ['$risk_level', 'high'] }, 1, 0] } },
          mediumRisk: { $sum: { $cond: [{ $eq: ['$risk_level', 'medium'] }, 1, 0] } },
          lowRisk: { $sum: { $cond: [{ $eq: ['$risk_level', 'low'] }, 1, 0] } },
          latestAlert: { $max: '$created_at' }
        }
      },
      { $sort: { alertCount: -1 } },
      { $limit: 15 }
    ]);

    // ── Keywords analytics ──
    const keywordStats = await Keyword.aggregate([
      { $match: { ...withTenant(req), ...scopedDistrictQuery(req) } },
      {
        $group: {
          _id: '$category',
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$is_active', 1, 0] } },
          avgWeight: { $avg: '$weight' }
        }
      }
    ]);

    const keywordsByLanguage = await Keyword.aggregate([
      { $match: { ...withTenant(req), ...scopedDistrictQuery(req) } },
      { $group: { _id: '$language', count: { $sum: 1 } } }
    ]);

    const topMatchedKeywords = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $unwind: '$matched_keywords_normalized' },
      { $group: { _id: '$matched_keywords_normalized', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);

    // ── Format & Share (Reports generated/shared) ──
    const reportStatusDist = await Report.aggregate([
      { $match: reportQuery({ generated_at: { $gte: from, $lte: to } }) },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const reportsByMonth = await Report.aggregate([
      { $match: reportQuery({ generated_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$generated_at' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Daily alerts trend ──
    const alertsDailyTrend = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
            risk_level: '$risk_level'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);

    // Build daily trend with risk levels
    const daysMap = {};
    const totalDays = Math.min(Math.ceil((to - from) / DAY_MS) + 1, 366);
    for (let i = 0; i < totalDays; i++) {
      const dk = toISODate(addDays(from, i));
      daysMap[dk] = { date: dk, high: 0, medium: 0, low: 0, total: 0 };
    }
    alertsDailyTrend.forEach(({ _id, count }) => {
      if (daysMap[_id.date]) {
        daysMap[_id.date][_id.risk_level] = (daysMap[_id.date][_id.risk_level] || 0) + count;
        daysMap[_id.date].total += count;
      }
    });

    // ── Alert status summary ──
    const alertStatusSummary = await Alert.aggregate([
      { $match: alertQuery({ created_at: { $gte: from, $lte: to } }) },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    // Previous period for comparison
    const periodLength = Math.ceil((to - from) / DAY_MS);
    const prevFrom = addDays(from, -periodLength);
    const prevTo = endOfDay(addDays(from, -1));

    const [currentAlerts, prevAlerts, currentReports, prevReports] = await Promise.all([
      Alert.countDocuments(alertQuery({ created_at: { $gte: from, $lte: to } })),
      Alert.countDocuments(alertQuery({ created_at: { $gte: prevFrom, $lte: prevTo } })),
      Report.countDocuments(reportQuery({ generated_at: { $gte: from, $lte: to } })),
      Report.countDocuments(reportQuery({ generated_at: { $gte: prevFrom, $lte: prevTo } }))
    ]);

    res.status(200).json({
      generatedAt: now.toISOString(),
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      accounts: {
        total: totalSources,
        active: activeSources,
        addedInRange: totalSourcesInRange,
        byPlatform: sourcesByPlatform,
        byCategory: sourcesByCategory,
        trend: accountsTrend.map(r => ({ date: r._id, count: r.count }))
      },
      riskAnalysis: {
        distribution: riskDistribution.map(r => ({ level: r._id, count: r.count })),
        byPlatform: riskByPlatform.map(r => ({
          platform: r._id.platform, riskLevel: r._id.risk_level, count: r.count
        })),
        byCategory: riskByCategory.map(r => ({
          category: r._id.category || 'Unknown', riskLevel: r._id.risk_level, count: r.count
        }))
      },
      alertTypes: alertTypesDist.map(r => ({ type: r._id || 'unknown', count: r.count })),
      platformDistribution: alertsByPlatform.map(r => ({ platform: r._id, count: r.count })),
      escalations: {
        statusDistribution: escalationStats.map(r => ({ status: r._id, count: r.count })),
        byPlatform: escalationByPlatform.map(r => ({
          platform: r._id.platform, status: r._id.status, count: r.count
        }))
      },
      actions: {
        byPlatform: actionsTrend.map(r => ({ platform: r._id.platform, count: r.count })),
        allTimeByPlatform: allReportsByPlatform.map(r => ({ platform: r._id, count: r.count })),
        timeline: actionsTimeline.map(r => ({ date: r._id, count: r.count })),
        total: currentReports,
        previousTotal: prevReports,
        changePct: safePct(currentReports, prevReports)
      },
      topActiveAccounts: topActiveAccounts.map(r => ({
        author: r._id.author,
        handle: r._id.handle,
        platform: r._id.platform,
        alertCount: r.alertCount,
        highRisk: r.highRisk,
        mediumRisk: r.mediumRisk,
        lowRisk: r.lowRisk,
        latestAlert: r.latestAlert
      })),
      keywords: {
        byCategory: keywordStats.map(r => ({
          category: r._id, total: r.total, active: r.active, avgWeight: Number((r.avgWeight || 0).toFixed(1))
        })),
        byLanguage: keywordsByLanguage.map(r => ({ language: r._id, count: r.count })),
        topMatched: topMatchedKeywords.map(r => ({ keyword: r._id, count: r.count }))
      },
      reportsFormatShare: {
        statusDistribution: reportStatusDist.map(r => ({ status: r._id, count: r.count })),
        byMonth: reportsByMonth.map(r => ({ month: r._id, count: r.count }))
      },
      alertsTrend: Object.values(daysMap),
      alertStatusSummary: alertStatusSummary.map(r => ({ status: r._id, count: r.count })),
      comparison: {
        alerts: { current: currentAlerts, previous: prevAlerts, changePct: safePct(currentAlerts, prevAlerts) },
        reports: { current: currentReports, previous: prevReports, changePct: safePct(currentReports, prevReports) }
      }
    });
  } catch (error) {
    console.error('Alerts intelligence error:', error);
    res.status(500).json({ message: error.message });
  }
};

/* ═══════════════════════════════════════════════════════════════════
   GRIEVANCES INTELLIGENCE
   ═══════════════════════════════════════════════════════════════════ */
const getGrievancesIntelligence = async (req, res) => {
  try {
    const now = new Date();
    const from = parseDateParam(req.query.from) || addDays(startOfDay(now), -29);
    const to = parseDateParam(req.query.to, { end: true }) || endOfDay(now);
    const dateMatch = { post_date: { $gte: from, $lte: to } };

    // District scoping: Grievance carries `districts` directly; the report
    // sub-models (workflow/suggestion/criticism) link back via grievance_id.
    const districtMatch = scopedDistrictMatch(req, req.query.district);
    const grievanceQuery = (extra = {}) => withTenant(req, districtMatch ? { ...extra, ...districtMatch } : extra);
    const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, req.query.district, withTenant);
    const reportSubQuery = (extra = {}) => withTenant(req, scopedGrievanceIds ? { ...extra, grievance_id: { $in: scopedGrievanceIds } } : extra);

    // ── Total Grievances ──
    const [totalGrievances, grievancesInRange] = await Promise.all([
      Grievance.countDocuments(grievanceQuery({ is_active: true })),
      Grievance.countDocuments(grievanceQuery({ is_active: true, ...dateMatch }))
    ]);

    // ── Platform Distribution ──
    const byPlatform = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);

    // ── Workflow Status Distribution ──
    const workflowStatusDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      { $group: { _id: '$workflow_status', count: { $sum: 1 } } }
    ]);

    // ── Classification Distribution ──
    const classificationDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      { $group: { _id: '$classification', count: { $sum: 1 } } }
    ]);

    // ── Priority Distribution (complaints) ──
    const priorityDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, classification: 'complaint', ...dateMatch }) },
      { $group: { _id: '$complaint.priority', count: { $sum: 1 } } }
    ]);

    // ── Grievance Workflow Reports by Status ──
    const gwrStatusDist = await GrievanceWorkflowReport.aggregate([
      { $match: reportSubQuery() },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    // ── Grievance Workflow Reports by Category ──
    const gwrCategoryDist = await GrievanceWorkflowReport.aggregate([
      { $match: reportSubQuery() },
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);

    // ── Suggestion Reports category ──
    const suggCategoryDist = await SuggestionReport.aggregate([
      { $match: reportSubQuery() },
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);

    // ── Criticism Reports category ──
    const critCategoryDist = await CriticismReport.aggregate([
      { $match: reportSubQuery() },
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);

    // ── Daily trend ──
    const dailyTrend = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$post_date' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Platform + workflow status cross-tab ──
    const platformWorkflowCross = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      { $group: { _id: { platform: '$platform', status: '$workflow_status' }, count: { $sum: 1 } } }
    ]);

    // ── Escalation count distribution ──
    const escalationCountDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, escalation_count: { $gt: 0 }, ...dateMatch }) },
      { $group: { _id: '$escalation_count', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    // ── Tagged account distribution (top) ──
    const taggedAccountDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      { $group: { _id: '$tagged_account_normalized', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]);

    // ── Engagement metrics aggregation ──
    const engagementAgg = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, ...dateMatch }) },
      {
        $group: {
          _id: null,
          totalLikes: { $sum: '$engagement.likes' },
          totalRetweets: { $sum: '$engagement.retweets' },
          totalReplies: { $sum: '$engagement.replies' },
          totalViews: { $sum: '$engagement.views' },
          avgLikes: { $avg: '$engagement.likes' },
          avgViews: { $avg: '$engagement.views' }
        }
      }
    ]);

    // ── Sentiment distribution (from analysis) ──
    const sentimentDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, 'analysis.sentiment': { $exists: true }, ...dateMatch }) },
      { $group: { _id: '$analysis.sentiment', count: { $sum: 1 } } }
    ]);

    // ── Urgency distribution ──
    const urgencyDist = await Grievance.aggregate([
      { $match: grievanceQuery({ is_active: true, 'analysis.urgency': { $exists: true }, ...dateMatch }) },
      { $group: { _id: '$analysis.urgency', count: { $sum: 1 } } }
    ]);

    // ── Sentiment per monitored account, and per complainant ──
    // Both drive the dashboard's drill-down tables: a row links to the
    // grievances list filtered by that account/poster and sentiment.
    const sentimentSplit = () => ({ positive: 0, neutral: 0, negative: 0, total: 0 });
    const foldSentiment = (rows, keyOf) => {
      const map = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        if (!key) continue;
        const entry = map.get(key) || { key, platform: row._id.platform || 'x', ...sentimentSplit() };
        const sentiment = String(row._id.sentiment || '').toLowerCase();
        if (sentiment in entry) entry[sentiment] += row.count;
        entry.total += row.count;
        map.set(key, entry);
      }
      // Most negative first: that is what an officer needs to look at.
      return [...map.values()].sort((a, b) => b.negative - a.negative || b.total - a.total);
    };

    const [sentimentByAccountRaw, sentimentByPosterRaw] = await Promise.all([
      Grievance.aggregate([
        { $match: grievanceQuery({ is_active: true, 'analysis.sentiment': { $exists: true }, ...dateMatch }) },
        { $group: { _id: { account: '$tagged_account_normalized', platform: '$platform', sentiment: '$analysis.sentiment' }, count: { $sum: 1 } } }
      ]),
      Grievance.aggregate([
        { $match: grievanceQuery({ is_active: true, 'analysis.sentiment': { $exists: true }, ...dateMatch }) },
        { $group: { _id: { poster: '$posted_by.handle', platform: '$platform', sentiment: '$analysis.sentiment' }, count: { $sum: 1 } } }
      ])
    ]);

    const byAccount = foldSentiment(sentimentByAccountRaw, (r) => r._id.account).slice(0, 200);
    const byPoster = foldSentiment(sentimentByPosterRaw, (r) => r._id.poster).slice(0, 300);

    // Display name and avatar come from the monitored source, when it still exists.
    const sources = byAccount.length
      ? await GrievanceSource.find(withTenant(req, {})).select('handle display_name profile_image_url department platform').lean()
      : [];
    const sourceByHandle = new Map(sources.map((src) => [String(src.handle || '').replace(/^@/, '').toLowerCase(), src]));
    const sentimentByProfile = byAccount.map((row) => {
      const src = sourceByHandle.get(row.key) || {};
      return {
        account: row.key,
        display_name: src.display_name || row.key,
        profile_image_url: src.profile_image_url || '',
        department: src.department || '',
        platform: row.platform,
        positive: row.positive,
        neutral: row.neutral,
        negative: row.negative,
        total: row.total
      };
    });
    const postersBySentiment = byPoster.map((row) => ({
      poster: row.key,
      platform: row.platform,
      positive: row.positive,
      neutral: row.neutral,
      negative: row.negative,
      total: row.total
    }));

    // ── Reports shared (grievance workflow shared_at exists) ──
    const [gwrTotal, gwrShared, gwrPending, gwrEscalated, gwrClosed] = await Promise.all([
      GrievanceWorkflowReport.countDocuments(reportSubQuery()),
      GrievanceWorkflowReport.countDocuments(reportSubQuery({ shared_at: { $exists: true, $ne: null } })),
      GrievanceWorkflowReport.countDocuments(reportSubQuery({ status: 'PENDING' })),
      GrievanceWorkflowReport.countDocuments(reportSubQuery({ status: 'ESCALATED' })),
      GrievanceWorkflowReport.countDocuments(reportSubQuery({ status: 'CLOSED' }))
    ]);

    const [suggTotal, suggShared, critTotal, critShared] = await Promise.all([
      SuggestionReport.countDocuments(reportSubQuery()),
      SuggestionReport.countDocuments(reportSubQuery({ shared_at: { $exists: true, $ne: null } })),
      CriticismReport.countDocuments(reportSubQuery()),
      CriticismReport.countDocuments(reportSubQuery({ shared_at: { $exists: true, $ne: null } }))
    ]);

    // Previous period comparison
    const periodLength = Math.ceil((to - from) / DAY_MS);
    const prevFrom = addDays(from, -periodLength);
    const prevTo = endOfDay(addDays(from, -1));
    const [currentCount, prevCount] = await Promise.all([
      Grievance.countDocuments(grievanceQuery({ is_active: true, ...dateMatch })),
      Grievance.countDocuments(grievanceQuery({ is_active: true, post_date: { $gte: prevFrom, $lte: prevTo } }))
    ]);

    res.status(200).json({
      generatedAt: now.toISOString(),
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total: totalGrievances,
        inRange: grievancesInRange,
        changePct: safePct(currentCount, prevCount)
      },
      byPlatform: byPlatform.map(r => ({ platform: r._id, count: r.count })),
      workflowStatus: workflowStatusDist.map(r => ({ status: r._id, count: r.count })),
      classification: classificationDist.map(r => ({ type: r._id, count: r.count })),
      priority: priorityDist.map(r => ({ level: r._id, count: r.count })),
      grievanceReports: {
        statusDistribution: gwrStatusDist.map(r => ({ status: r._id, count: r.count })),
        categoryDistribution: gwrCategoryDist.map(r => ({ category: r._id || 'Uncategorized', count: r.count })),
        total: gwrTotal,
        shared: gwrShared,
        pending: gwrPending,
        escalated: gwrEscalated,
        closed: gwrClosed
      },
      suggestions: {
        total: suggTotal,
        shared: suggShared,
        categoryDistribution: suggCategoryDist.map(r => ({ category: r._id || 'Uncategorized', count: r.count }))
      },
      criticism: {
        total: critTotal,
        shared: critShared,
        categoryDistribution: critCategoryDist.map(r => ({ category: r._id || 'Uncategorized', count: r.count }))
      },
      dailyTrend: dailyTrend.map(r => ({ date: r._id, count: r.count })),
      platformWorkflowCross: platformWorkflowCross.map(r => ({
        platform: r._id.platform, status: r._id.status, count: r.count
      })),
      escalationDistribution: escalationCountDist.map(r => ({ escalations: r._id, count: r.count })),
      topTaggedAccounts: taggedAccountDist.map(r => ({ account: r._id, count: r.count })),
      engagement: engagementAgg[0] || {},
      sentiment: sentimentDist.map(r => ({ sentiment: r._id, count: r.count })),
      urgency: urgencyDist.map(r => ({ level: r._id, count: r.count })),
      sentimentByProfile,
      postersBySentiment,
      comparison: {
        current: currentCount,
        previous: prevCount,
        changePct: safePct(currentCount, prevCount)
      }
    });
  } catch (error) {
    console.error('Grievances intelligence error:', error);
    res.status(500).json({ message: error.message });
  }
};

/* ═══════════════════════════════════════════════════════════════════
   PROFILES (POI) INTELLIGENCE
   ═══════════════════════════════════════════════════════════════════ */
const getProfilesIntelligence = async (req, res) => {
  try {
    const now = new Date();
    const from = parseDateParam(req.query.from) || addDays(startOfDay(now), -29);
    const to = parseDateParam(req.query.to, { end: true }) || endOfDay(now);

    // District scoping: officers only see profiles tagged with their assigned
    // districts; admins see all unless they explicitly pick one via ?district=.
    const districtMatch = scopedDistrictMatch(req, req.query.district);
    const poiQuery = (extra = {}) => withTenant(req, districtMatch ? { ...extra, ...districtMatch } : extra);

    // ── Total Profiles ──
    const [totalProfiles, activeProfiles, archivedProfiles] = await Promise.all([
      POI.countDocuments(poiQuery()),
      POI.countDocuments(poiQuery({ status: 'active' })),
      POI.countDocuments(poiQuery({ status: 'archived' }))
    ]);

    // ── Profiles added in date range ──
    const profilesInRange = await POI.countDocuments(poiQuery({
      createdAt: { $gte: from, $lte: to }
    }));

    // ── Profiles trend ──
    const profilesTrend = await POI.aggregate([
      { $match: poiQuery({ createdAt: { $gte: from, $lte: to } }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Platform distribution (count social media entries) ──
    const platformDist = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      { $unwind: '$socialMedia' },
      { $group: { _id: '$socialMedia.platform', count: { $sum: 1 } } }
    ]);

    // ── Platform × Category matrix (profile entries per platform broken
    //    down by category — fuels the profile-summary table). ──
    const platformCategoryAgg = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      { $unwind: '$socialMedia' },
      {
        $group: {
          _id: {
            platform: '$socialMedia.platform',
            category: { $ifNull: ['$socialMedia.category', 'others'] }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    // ── District/Commisionerate distribution ──
    const districtDist = await POI.aggregate([
      { $match: poiQuery({ status: 'active', districtCommisionerate: { $ne: '' } }) },
      { $group: { _id: '$districtCommisionerate', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]);

    // ── Profiles with FIR details ──
    const profilesWithFIR = await POI.countDocuments(poiQuery({
      status: 'active',
      'firDetails.0': { $exists: true }
    }));

    // ── Profiles with reports (s3ReportUrl) ──
    const profilesWithReports = await POI.countDocuments(poiQuery({
      status: 'active',
      s3ReportUrl: { $ne: '' }
    }));

    // ── Social media coverage (profiles with linked platforms) ──
    const socialCoverageAgg = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      {
        $project: {
          linkedPlatforms: { $size: { $ifNull: ['$socialMedia', []] } }
        }
      },
      {
        $group: {
          _id: '$linkedPlatforms',
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // ── Profiles with deleted profiles tracked ──
    const profilesWithDeleted = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      {
        $project: {
          hasDeleted: {
            $gt: [
              {
                $add: [
                  { $size: { $ifNull: ['$previouslyDeletedProfiles.x', []] } },
                  { $size: { $ifNull: ['$previouslyDeletedProfiles.facebook', []] } },
                  { $size: { $ifNull: ['$previouslyDeletedProfiles.instagram', []] } },
                  { $size: { $ifNull: ['$previouslyDeletedProfiles.youtube', []] } },
                  { $size: { $ifNull: ['$previouslyDeletedProfiles.whatsapp', []] } }
                ]
              },
              0
            ]
          }
        }
      },
      { $match: { hasDeleted: true } },
      { $count: 'count' }
    ]);

    // ── Profiles by creator ──
    const profilesByCreator = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      { $group: { _id: '$createdBy', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // ── Monthly creation trend ──
    const monthlyTrend = await POI.aggregate([
      { $match: poiQuery() },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 12 }
    ]);

    // ── Cross-reference: POI linked alerts ──
    // Get all social media handles from POIs and count alerts against them
    const poiHandles = await POI.aggregate([
      { $match: poiQuery({ status: 'active' }) },
      { $unwind: '$socialMedia' },
      {
        $project: {
          handle: '$socialMedia.handle',
          platform: '$socialMedia.platform',
          poiName: '$name'
        }
      }
    ]);

    // ── Previous period comparison ──
    const periodLength = Math.ceil((to - from) / DAY_MS);
    const prevFrom = addDays(from, -periodLength);
    const prevTo = endOfDay(addDays(from, -1));
    const prevProfilesInRange = await POI.countDocuments(poiQuery({
      createdAt: { $gte: prevFrom, $lte: prevTo }
    }));

    res.status(200).json({
      generatedAt: now.toISOString(),
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total: totalProfiles,
        active: activeProfiles,
        archived: archivedProfiles,
        addedInRange: profilesInRange,
        withFIR: profilesWithFIR,
        withReports: profilesWithReports,
        withDeletedProfiles: profilesWithDeleted[0]?.count || 0
      },
      trend: profilesTrend.map(r => ({ date: r._id, count: r.count })),
      monthlyTrend: monthlyTrend.map(r => ({ month: r._id, count: r.count })),
      platformDistribution: platformDist.map(r => ({ platform: r._id, count: r.count })),
      platformCategoryMatrix: platformCategoryAgg.map(r => ({
        platform: r._id.platform,
        category: r._id.category,
        count: r.count
      })),
      districtDistribution: districtDist.map(r => ({ district: r._id, count: r.count })),
      socialCoverage: socialCoverageAgg.map(r => ({ linkedPlatforms: r._id, count: r.count })),
      profilesByCreator: profilesByCreator.map(r => ({ creator: r._id || 'system', count: r.count })),
      comparison: {
        current: profilesInRange,
        previous: prevProfilesInRange,
        changePct: safePct(profilesInRange, prevProfilesInRange)
      }
    });
  } catch (error) {
    console.error('Profiles intelligence error:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAlertsIntelligence,
  getGrievancesIntelligence,
  getProfilesIntelligence
};
