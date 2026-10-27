const Source = require('../models/Source');
const Content = require('../models/Content');
const Alert = require('../models/Alert');
const Analysis = require('../models/Analysis');
const Report = require('../models/Report');
const GrievanceWorkflowReport = require('../models/GrievanceWorkflowReport');
const SuggestionReport = require('../models/SuggestionReport');
const CriticismReport = require('../models/CriticismReport');
const QueryReport = require('../models/QueryReport');
const Grievance = require('../models/Grievance');
const { withTenant } = require('../utils/tenantFilter');
const { scopedDistrictQuery, scopedGrievanceIdsForDistrict } = require('../utils/scopedDistricts');

// Resolve the three district-scope filters needed across analytics domains, once
// per request. Returns match fragments to merge into each model's query:
//  - districtScope: for models that carry `districts` (Source/Content/Analysis/Report)
//  - alertScope:    for Alert (no districts field) — via its Source's district
//  - reportScope:   for grievance-derived reports (GWR/Suggestion/Criticism/Query) — via grievance
// Each is {} for admins (no extra filter) and a fail-closed filter for officers.
const resolveScopes = async (req) => {
  const districtScope = scopedDistrictQuery(req); // {} | {districts:{$in}} | {districts:'__none__'}

  let alertScope = {};
  if (districtScope.districts) {
    const sourceIds = await Source.find(withTenant(req, districtScope)).distinct('id');
    alertScope = { source_id: { $in: sourceIds } };
  }

  const scopedGrievanceIds = await scopedGrievanceIdsForDistrict(req, Grievance, req.query.district, withTenant);
  const reportScope = scopedGrievanceIds ? { grievance_id: { $in: scopedGrievanceIds } } : {};

  return { districtScope, alertScope, reportScope };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_STATUSES = ['generated', 'printed', 'sent', 'sent_to_intermediary', 'awaiting_reply', 'closed'];
const DOMAIN_KEYS = ['alerts', 'grievance', 'suggestion', 'criticism', 'query'];

// `scope` names which resolved filter (from resolveScopes) applies to each domain:
// Report carries `districts` directly; the grievance-derived reports scope via grievance.
const domainConfigs = {
  alerts: { model: Report, dateField: 'generated_at', scope: 'districtScope' },
  grievance: { model: GrievanceWorkflowReport, dateField: 'created_at', scope: 'reportScope' },
  suggestion: { model: SuggestionReport, dateField: 'created_at', scope: 'reportScope' },
  criticism: { model: CriticismReport, dateField: 'created_at', scope: 'reportScope' },
  query: { model: QueryReport, dateField: 'created_at', scope: 'reportScope' }
};

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const toISODate = (date) => startOfDay(date).toISOString().slice(0, 10);

const parseDateParam = (value, { end = false } = {}) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return end ? endOfDay(d) : startOfDay(d);
};

const buildDateQuery = (dateField, start, end) => {
  const query = {};
  if (!start && !end) return query;

  query[dateField] = {};
  if (start) query[dateField].$gte = start;
  if (end) query[dateField].$lte = end;
  return query;
};

const safePctChange = (current, previous) => {
  if (!previous) return current ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

const countByRange = (model, dateField, start, end, req, extra = {}) =>
  model.countDocuments(withTenant(req, { ...buildDateQuery(dateField, start, end), ...extra }));

const getDailySeries = async (model, dateField, start, end, req, extra = {}) => {
  const rows = await model.aggregate([
    { $match: withTenant(req, { ...buildDateQuery(dateField, start, end), ...extra }) },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: `$${dateField}`
          }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
};

const getAlertsStatus = async (req, extra = {}) => {
  const grouped = await Report.aggregate([
    { $match: withTenant(req, extra) },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  const status = Object.fromEntries(ALERT_STATUSES.map((key) => [key, 0]));
  grouped.forEach(({ _id, count }) => {
    if (_id && Object.prototype.hasOwnProperty.call(status, _id)) {
      status[_id] = count;
    }
  });
  return status;
};

const getGrievanceStatus = async (req, extra = {}) => {
  const [pending, escalated, closed, fir] = await Promise.all([
    GrievanceWorkflowReport.countDocuments(withTenant(req, { ...extra, status: 'PENDING' })),
    GrievanceWorkflowReport.countDocuments(withTenant(req, { ...extra, status: 'ESCALATED' })),
    GrievanceWorkflowReport.countDocuments(withTenant(req, { ...extra, status: 'CLOSED' })),
    GrievanceWorkflowReport.countDocuments(withTenant(req, { ...extra, fir_status: { $nin: ['', 'No', null] } }))
  ]);

  return { pending, escalated, closed, fir };
};

const getQueryStatus = async (req, extra = {}) => {
  const [pending, closed] = await Promise.all([
    QueryReport.countDocuments(withTenant(req, { ...extra, status: 'PENDING' })),
    QueryReport.countDocuments(withTenant(req, { ...extra, status: 'CLOSED' }))
  ]);

  return { pending, closed };
};

const getActionedStatus = async (model, req, extra = {}) => {
  const [total, actionTaken] = await Promise.all([
    model.countDocuments(withTenant(req, extra)),
    model.countDocuments(withTenant(req, { ...extra, action_taken_at: { $exists: true, $ne: null } }))
  ]);

  return {
    action_taken: actionTaken,
    pending_action: Math.max(total - actionTaken, 0)
  };
};

const getAlertPlatformBreakdown = async (req, extra = {}) => {
  const grouped = await Report.aggregate([
    { $match: withTenant(req, extra) },
    { $group: { _id: '$platform', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(grouped.map(({ _id, count }) => [_id || 'unknown', count]));
};

const getGrievanceCategoryBreakdown = async (req, extra = {}) => {
  const grouped = await GrievanceWorkflowReport.aggregate([
    { $match: withTenant(req, extra) },
    { $group: { _id: '$category', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(grouped.map(({ _id, count }) => [_id || 'Uncategorized', count]));
};

const getWeeklyHourlyActivity = async (req, extra = {}) => {
  const now = new Date();
  const weekAgo = addDays(startOfDay(now), -6);
  const rows = await Report.aggregate([
    { $match: withTenant(req, { ...extra, generated_at: { $gte: weekAgo } }) },
    {
      $group: {
        _id: { $dayOfWeek: '$generated_at' },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return dayNames.map((name, idx) => ({
    day: name,
    count: rows.find((r) => r._id === idx + 1)?.count || 0
  }));
};

// @desc    Get analytics overview
// @route   GET /api/analytics/overview
// @access  Private
const getAnalyticsOverview = async (req, res) => {
  try {
    const { districtScope, alertScope } = await resolveScopes(req);
    const [
      totalSources,
      activeSources,
      totalContent,
      activeAlerts,
      totalAlerts,
      riskDist
    ] = await Promise.all([
      Source.countDocuments(withTenant(req, districtScope)),
      Source.countDocuments(withTenant(req, { ...districtScope, is_active: true })),
      Content.countDocuments(withTenant(req, districtScope)),
      Alert.countDocuments(withTenant(req, { ...alertScope, status: 'active' })),
      Alert.countDocuments(withTenant(req, alertScope)),
      Analysis.aggregate([
        { $match: withTenant(req, districtScope) },
        {
          $group: {
            _id: '$risk_level',
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    res.status(200).json({
      total_sources: totalSources,
      active_sources: activeSources,
      total_content: totalContent,
      active_alerts: activeAlerts,
      total_alerts: totalAlerts,
      risk_distribution: riskDist
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get trends
// @route   GET /api/analytics/trends
// @access  Private
const getTrends = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { districtScope, alertScope } = await resolveScopes(req);

    const contentTrend = await Content.aggregate([
      { $match: withTenant(req, { ...districtScope, created_at: { $gte: startDate } }) },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const alertTrend = await Alert.aggregate([
      { $match: withTenant(req, { ...alertScope, created_at: { $gte: startDate } }) },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
            risk_level: "$risk_level"
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.date": 1 } }
    ]);

    res.status(200).json({
      content_trend: contentTrend,
      alert_trend: alertTrend
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Unified reports analytics (weekly, monthly, overall)
// @route   GET /api/analytics/unified-reports
// @access  Private
const getUnifiedReportsAnalytics = async (req, res) => {
  try {
    const scopes = await resolveScopes(req);
    const now = new Date();
    const todayStart = startOfDay(now);
    const nowEnd = endOfDay(now);

    const customStart = parseDateParam(req.query.from, { end: false });
    const customEnd = parseDateParam(req.query.to, { end: true });
    const hasCustomRange = Boolean(customStart && customEnd && customStart <= customEnd);

    const weeklyStart = addDays(todayStart, -6);
    const previousWeeklyStart = addDays(weeklyStart, -7);
    const previousWeeklyEnd = endOfDay(addDays(weeklyStart, -1));

    const monthlyStart = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const currentMonthDayIndex = Math.floor((todayStart.getTime() - monthlyStart.getTime()) / DAY_MS);
    const previousMonthStart = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const previousMonthDays = new Date(
      previousMonthStart.getFullYear(),
      previousMonthStart.getMonth() + 1,
      0
    ).getDate();
    const previousMonthlyEnd = endOfDay(
      new Date(
        previousMonthStart.getFullYear(),
        previousMonthStart.getMonth(),
        Math.min(currentMonthDayIndex + 1, previousMonthDays)
      )
    );

    const trendStart = hasCustomRange ? customStart : addDays(todayStart, -29);
    const trendEnd = hasCustomRange ? customEnd : nowEnd;

    const customRangeDays = hasCustomRange
      ? Math.floor((startOfDay(customEnd).getTime() - startOfDay(customStart).getTime()) / DAY_MS) + 1
      : 0;

    const previousCustomEnd = hasCustomRange ? endOfDay(addDays(customStart, -1)) : null;
    const previousCustomStart = hasCustomRange ? startOfDay(addDays(customStart, -customRangeDays)) : null;

    const windows = {
      weekly: { start: weeklyStart, end: nowEnd },
      monthly: { start: monthlyStart, end: nowEnd },
      overall: { start: null, end: nowEnd },
      custom: hasCustomRange ? { start: customStart, end: customEnd } : null
    };

    const totals = {
      weekly: {},
      monthly: {},
      overall: {},
      custom: {}
    };

    const dailyMaps = {};
    const delta = {};

    await Promise.all(
      DOMAIN_KEYS.map(async (domainKey) => {
        const { model, dateField, scope } = domainConfigs[domainKey];
        const dScope = scopes[scope] || {};

        const [
          weeklyCount,
          monthlyCount,
          overallCount,
          customCount,
          previousWeeklyCount,
          previousMonthlyCount,
          previousCustomCount,
          dailySeries
        ] = await Promise.all([
          countByRange(model, dateField, windows.weekly.start, windows.weekly.end, req, dScope),
          countByRange(model, dateField, windows.monthly.start, windows.monthly.end, req, dScope),
          countByRange(model, dateField, windows.overall.start, windows.overall.end, req, dScope),
          hasCustomRange ? countByRange(model, dateField, windows.custom.start, windows.custom.end, req, dScope) : Promise.resolve(0),
          countByRange(model, dateField, previousWeeklyStart, previousWeeklyEnd, req, dScope),
          countByRange(model, dateField, previousMonthStart, previousMonthlyEnd, req, dScope),
          hasCustomRange ? countByRange(model, dateField, previousCustomStart, previousCustomEnd, req, dScope) : Promise.resolve(0),
          getDailySeries(model, dateField, trendStart, trendEnd, req, dScope)
        ]);

        totals.weekly[domainKey] = weeklyCount;
        totals.monthly[domainKey] = monthlyCount;
        totals.overall[domainKey] = overallCount;
        totals.custom[domainKey] = customCount;

        dailyMaps[domainKey] = dailySeries;
        delta[domainKey] = {
          weeklyPct: safePctChange(weeklyCount, previousWeeklyCount),
          monthlyPct: safePctChange(monthlyCount, previousMonthlyCount),
          customPct: hasCustomRange ? safePctChange(customCount, previousCustomCount) : 0
        };
      })
    );

    totals.weekly.all = DOMAIN_KEYS.reduce((sum, key) => sum + (totals.weekly[key] || 0), 0);
    totals.monthly.all = DOMAIN_KEYS.reduce((sum, key) => sum + (totals.monthly[key] || 0), 0);
    totals.overall.all = DOMAIN_KEYS.reduce((sum, key) => sum + (totals.overall[key] || 0), 0);
    totals.custom.all = DOMAIN_KEYS.reduce((sum, key) => sum + (totals.custom[key] || 0), 0);

    const trendDaily = [];
    const totalTrendDays = Math.min(
      Math.max(Math.floor((startOfDay(trendEnd).getTime() - startOfDay(trendStart).getTime()) / DAY_MS) + 1, 1),
      366
    );
    for (let i = 0; i < totalTrendDays; i += 1) {
      const date = addDays(trendStart, i);
      const dateKey = toISODate(date);

      const row = {
        date: dateKey,
        alerts: dailyMaps.alerts?.[dateKey] || 0,
        grievance: dailyMaps.grievance?.[dateKey] || 0,
        suggestion: dailyMaps.suggestion?.[dateKey] || 0,
        criticism: dailyMaps.criticism?.[dateKey] || 0,
        query: dailyMaps.query?.[dateKey] || 0
      };
      row.all = row.alerts + row.grievance + row.suggestion + row.criticism + row.query;
      trendDaily.push(row);
    }

    const [
      alertsStatus,
      grievanceStatus,
      suggestionStatus,
      criticismStatus,
      queryStatus,
      alertPlatformBreakdown,
      grievanceCategoryBreakdown,
      weeklyActivity
    ] = await Promise.all([
      getAlertsStatus(req, scopes.districtScope),
      getGrievanceStatus(req, scopes.reportScope),
      getActionedStatus(SuggestionReport, req, scopes.reportScope),
      getActionedStatus(CriticismReport, req, scopes.reportScope),
      getQueryStatus(req, scopes.reportScope),
      getAlertPlatformBreakdown(req, scopes.districtScope),
      getGrievanceCategoryBreakdown(req, scopes.reportScope),
      getWeeklyHourlyActivity(req, scopes.districtScope)
    ]);

    res.status(200).json({
      generatedAt: now.toISOString(),
      windows: {
        weekly: {
          start: windows.weekly.start.toISOString(),
          end: windows.weekly.end.toISOString()
        },
        monthly: {
          start: windows.monthly.start.toISOString(),
          end: windows.monthly.end.toISOString()
        },
        overall: {
          start: null,
          end: windows.overall.end.toISOString()
        },
        custom: windows.custom
          ? {
            start: windows.custom.start.toISOString(),
            end: windows.custom.end.toISOString()
          }
          : null
      },
      totals,
      trend: {
        daily: trendDaily,
        delta
      },
      status: {
        alerts: alertsStatus,
        grievance: grievanceStatus,
        suggestion: suggestionStatus,
        criticism: criticismStatus,
        query: queryStatus
      },
      breakdowns: {
        alertPlatform: alertPlatformBreakdown,
        grievanceCategory: grievanceCategoryBreakdown,
        weeklyActivity
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAnalyticsOverview,
  getTrends,
  getUnifiedReportsAnalytics
};
