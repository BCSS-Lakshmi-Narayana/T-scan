const ComprehensiveReport = require('../models/ComprehensiveReport');
const SoceyeReportSnapshot = require('../models/SoceyeReportSnapshot');
const Dial100Incident = require('../models/Dial100Incident');
const Grievance = require('../models/Grievance');
const Alert = require('../models/Alert');
const Content = require('../models/Content');
const POI = require('../models/POI');
const Event = require('../models/Event');
const Report = require('../models/Report');

const getDateRange = (targetDate) => {
  const end = targetDate ? new Date(targetDate) : new Date();
  end.setHours(6, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  start.setHours(6, 0, 0, 0);
  return { start, end };
};

const getPrevRange = (start, end) => {
  const duration = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(prevEnd.getTime() - duration);
  return { start: prevStart, end: prevEnd };
};

const getDateKey = (date) => date.toISOString().split('T')[0];

const calcTrend = (current, previous) => {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
};

// ─── A. Dial-100 Calls ───
const collectDial100 = async (tenantId, start, end, prevStart, prevEnd) => {
  const [current, previous] = await Promise.all([
    Dial100Incident.find({ tenant_id: tenantId, createdAt: { $gte: start, $lt: end } }),
    Dial100Incident.find({ tenant_id: tenantId, createdAt: { $gte: prevStart, $lt: prevEnd } })
  ]);
  const byCategory = {}, byJurisdiction = {};
  let totalRT = 0, rtCount = 0, critical = 0;
  current.forEach(i => {
    if (i.category) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    if (i.zoneJurisdiction) byJurisdiction[i.zoneJurisdiction] = (byJurisdiction[i.zoneJurisdiction] || 0) + 1;
    if (i.responseTimeForAssignedToVehicleReached) { totalRT += i.responseTimeForAssignedToVehicleReached; rtCount++; }
    if (i.priority === 'Critical' || i.priority === 'High') critical++;
  });
  const trend = calcTrend(current.length, previous.length);
  return {
    total_count: current.length,
    trend_percentage: trend,
    by_category: Object.entries(byCategory).map(([c, n]) => ({ category: c, count: n })).sort((a, b) => b.count - a.count),
    by_jurisdiction: Object.entries(byJurisdiction).map(([j, n]) => ({ jurisdiction: j, count: n })),
    response_time_avg: rtCount > 0 ? Math.round(totalRT / rtCount) : 0,
    critical_incidents: critical,
    ai_summary: `Total ${current.length} Dial-100 calls received in period. ${critical} critical incidents flagged. Average response time: ${rtCount > 0 ? Math.round(totalRT / rtCount) : 0} minutes. Trend: ${trend >= 0 ? '↑' : '↓'}${Math.abs(trend)}% vs previous period.`
  };
};

// ─── B. Grievances ───
// Each Grievance document represents a post that tagged a monitored gov account.
// Conversion to a workflow (criticism / suggestion / grievance / query) is tracked
// by sub-doc `report_id` fields. Workflow lifecycle status lives in `workflow_status`.
const collectGrievances = async (tenantId, start, end, prevStart, prevEnd) => {
  const grievances = await Grievance.find({ tenant_id: tenantId, created_at: { $gte: start, $lt: end } });
  const prevCount = prevStart && prevEnd
    ? await Grievance.countDocuments({ tenant_id: tenantId, created_at: { $gte: prevStart, $lt: prevEnd } })
    : 0;
  const byType = { criticism: 0, suggestion: 0, grievance: 0, query: 0 };
  const byPlatform = {}, byStatus = {}, tagged = {};
  let underReview = 0, pending = 0, closed = 0;

  grievances.forEach(g => {
    // Conversion buckets — driven by which workflow sub-doc has a report_id.
    if (g.criticism?.report_id) byType.criticism++;
    if (g.suggestion?.report_id) byType.suggestion++;
    if (g.grievance_workflow?.report_id) byType.grievance++;
    if (g.query_workflow?.report_id) byType.query++;

    if (g.platform) byPlatform[g.platform] = (byPlatform[g.platform] || 0) + 1;

    // Workflow status (received / reviewed / action_taken / closed / converted_to_fir)
    const st = (g.workflow_status || '').toLowerCase();
    byStatus[g.workflow_status || 'unknown'] = (byStatus[g.workflow_status || 'unknown'] || 0) + 1;
    if (st === 'reviewed') underReview++;
    else if (st === 'closed' || st === 'converted_to_fir') closed++;
    else pending++; // received + action_taken treated as in-flight

    if (g.tagged_account) tagged[g.tagged_account] = (tagged[g.tagged_account] || 0) + 1;
  });

  // All-time pending/closed counts for the "All Time" panel.
  const [allTimePending, allTimeClosed] = await Promise.all([
    Grievance.countDocuments({ tenant_id: tenantId, workflow_status: { $nin: ['closed', 'converted_to_fir'] } }),
    Grievance.countDocuments({ tenant_id: tenantId, workflow_status: { $in: ['closed', 'converted_to_fir'] } })
  ]);

  const converted = byType.criticism + byType.suggestion + byType.grievance + byType.query;

  return {
    total_count: grievances.length, // posts that tagged us in window
    trend_percentage: calcTrend(grievances.length, prevCount),
    converted_count: converted,
    under_review: underReview, pending, closed,
    all_time_pending: allTimePending,
    all_time_closed: allTimeClosed,
    by_type: byType,
    by_platform: Object.entries(byPlatform).map(([p, c]) => ({ platform: p, count: c })),
    by_status: Object.entries(byStatus).map(([s, c]) => ({ status: s, count: c })),
    top_tagged_accounts: Object.entries(tagged).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a, c]) => ({ account: a, count: c })),
    ai_summary: `${grievances.length} posts tagged us. ${converted} converted to workflows: ${byType.grievance} grievances, ${byType.criticism} criticism, ${byType.suggestion} suggestions, ${byType.query} queries. All-time pending: ${allTimePending}, closed: ${allTimeClosed}.`
  };
};

// ─── C. Events ───
// Events are configured monitoring targets (Event model); the content they
// pull in lives in the Content collection keyed by `event_ids`. The report
// shows: which events are active/recent and how much activity each saw in
// the window.
const collectEvents = async (tenantId, start, end, prevStart, prevEnd) => {
  // Pull events that are either monitoring-active or were touched in the window.
  // We include archived events whose end_date falls inside the window so post-event
  // reporting still shows up.
  const events = await Event.find({
    tenant_id: tenantId,
    $or: [
      { status: { $in: ['active', 'planned'] } },
      { last_polled_at: { $gte: start, $lt: end } },
      { created_at: { $gte: start, $lt: end } },
      { end_date: { $gte: start, $lt: end } }
    ]
  }).lean();
  const prevEventsCount = prevStart && prevEnd
    ? await Event.countDocuments({
        tenant_id: tenantId,
        $or: [
          { last_polled_at: { $gte: prevStart, $lt: prevEnd } },
          { created_at: { $gte: prevStart, $lt: prevEnd } }
        ]
      })
    : 0;

  let humanTrafficking = 0, publicUnrest = 0, otherCat = 0;
  const byPlatform = {};

  // Per-event content aggregation over the window.
  const perEvent = await Promise.all(events.map(async (e) => {
    const name = (e.name || '').toLowerCase();
    if (name.includes('trafficking') || name.includes('human')) humanTrafficking++;
    else if (name.includes('unrest') || name.includes('protest') || name.includes('riot')) publicUnrest++;
    else otherCat++;

    // Pull all content linked to this event (events span weeks/months, so a
    // window filter would zero-out events whose content was ingested earlier).
    // Match the pattern used by /events/report so numbers stay consistent.
    const eventContent = await Content.find({ tenant_id: tenantId, event_ids: e.id })
      .select('platform engagement risk_level published_at')
      .lean();

    const inWindowCount = eventContent.filter((c) => {
      const ts = c.published_at ? new Date(c.published_at) : null;
      return ts && ts >= start && ts < end;
    }).length;

    const platformsWithContent = new Set();
    let views = 0, likes = 0, comments = 0, shares = 0;
    let highRisk = 0;
    eventContent.forEach((c) => {
      if (c.platform) {
        platformsWithContent.add(c.platform);
        if (!byPlatform[c.platform]) byPlatform[c.platform] = { fetched: 0, relevant: 0 };
        byPlatform[c.platform].fetched++;
        if (c.risk_level === 'high' || c.risk_level === 'critical') byPlatform[c.platform].relevant++;
      }
      views += c.engagement?.views || 0;
      likes += c.engagement?.likes || 0;
      comments += c.engagement?.comments || 0;
      shares += c.engagement?.retweets || 0;
      if (c.risk_level === 'high' || c.risk_level === 'critical') highRisk++;
    });

    // Fall back to event.platforms if no content has been ingested yet.
    const platforms = platformsWithContent.size > 0
      ? Array.from(platformsWithContent)
      : (e.platforms || []);

    return {
      event_id: e.id,
      event_name: e.name || e.id,
      content_count: eventContent.length,
      window_content_count: inWindowCount,
      platforms,
      event_type: e.origin === 'master_calendar' ? 'calendar' : 'monitored',
      timestamp: e.start_date || e.created_at || new Date(),
      source_platforms: platforms,
      reach: views,
      risk_score: eventContent.length === 0
        ? 0
        : Math.min(Math.round((highRisk / eventContent.length) * 100) + Math.min(eventContent.length, 20), 100),
      geo_location: e.location || '',
      related_profiles: [],
      media_preview: '',
      engagement_metrics: { views, likes, shares, comments }
    };
  }));

  const topEvents = perEvent
    .sort((a, b) => b.content_count - a.content_count || b.risk_score - a.risk_score)
    .slice(0, 20);

  const relevantCount = perEvent.filter(e => e.content_count > 0).length;
  return {
    total_count: events.length,
    trend_percentage: calcTrend(events.length, prevEventsCount),
    human_trafficking: humanTrafficking,
    public_unrest: publicUnrest,
    other_categorized: otherCat,
    by_platform: Object.entries(byPlatform).map(([p, d]) => ({ platform: p, fetched: d.fetched, relevant: d.relevant })),
    top_events: topEvents,
    ai_insights: `${events.length} events under monitoring: ${humanTrafficking} human trafficking, ${publicUnrest} public unrest, ${otherCat} other. ${relevantCount} events captured activity in this window.`,
    ai_observations: `Key patterns: ${topEvents.slice(0, 3).map(e => e.event_name).filter(Boolean).join(', ') || 'no recent activity'} trending. Recommend enhanced monitoring of high-risk event categories.`
  };
};

// ─── D. Alerts ───
const collectAlerts = async (tenantId, start, end, prevStart, prevEnd) => {
  const alerts = await Alert.find({ tenant_id: tenantId, created_at: { $gte: start, $lt: end } }).sort({ created_at: -1 });
  const prevAlertCount = prevStart && prevEnd
    ? await Alert.countDocuments({ tenant_id: tenantId, created_at: { $gte: prevStart, $lt: prevEnd } })
    : 0;
  const byCategory = {}, byPlatform = {}, byStatus = {};
  let high = 0, medium = 0, low = 0, escalated = 0, resolved = 0;

  // Hourly distribution: rolling 24-buckets ending at `end`. Each bucket is
  // an hour. Useful to render the alert-volume timeline / sparkline on the
  // frontend.
  const HOURS = 24;
  const bucketMs = (end.getTime() - start.getTime()) / HOURS;
  const hourly = Array.from({ length: HOURS }, (_, i) => ({
    bucket: i,
    start: new Date(start.getTime() + i * bucketMs),
    count: 0,
    high: 0
  }));

  alerts.forEach(a => {
    // By risk level. Alert.priority holds viral priority, which must not read as risk.
    const p = (a.risk_level || '').toLowerCase() === 'critical' ? 'high' : (a.risk_level || '').toLowerCase();
    if (p === 'high') high++; else if (p === 'medium') medium++; else low++;
    if (a.source_category) byCategory[a.source_category] = (byCategory[a.source_category] || 0) + 1;
    if (a.platform) byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;
    const st = (a.status || 'active').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (st === 'escalated') escalated++;
    if (st === 'resolved' || st === 'closed') resolved++;

    // Drop into hourly bucket
    if (a.created_at) {
      const t = new Date(a.created_at).getTime();
      const idx = Math.max(0, Math.min(HOURS - 1, Math.floor((t - start.getTime()) / bucketMs)));
      hourly[idx].count++;
      if (p === 'high') hourly[idx].high++;
    }
  });
  const top5Critical = alerts.filter(a => ['high', 'critical'].includes((a.risk_level || '').toLowerCase())).slice(0, 5).map(a => ({
    alert_id: a.id, title: a.title || 'Untitled Alert', priority: a.priority || 'HIGH',
    category: a.source_category || 'Unknown', risk_score: a.threat_details?.risk_score ?? 0,
    created_at: a.created_at, platform: a.platform || 'Unknown', status: a.status || 'active'
  }));
  // Aggregate per-author so each profile appears once (highest priority/risk wins).
  const profileMap = new Map();
  alerts.forEach(a => {
    const key = a.author_handle || a.author;
    if (!key) return;
    const existing = profileMap.get(key);
    if (!existing) {
      profileMap.set(key, {
        profile_id: a.source_id || key,
        name: a.author || key,
        handle: a.author_handle || a.author,
        platform: a.platform || 'unknown',
        category: a.source_category || 'General',
        alert_count: 1,
        content_url: a.content_url || '',
        threat_score: a.threat_details?.risk_score ?? 0
      });
    } else {
      existing.alert_count += 1;
      const score = a.threat_details?.risk_score;
      if (score && score > existing.threat_score) existing.threat_score = score;
    }
  });
  const topProfiles = Array.from(profileMap.values())
    .sort((a, b) => b.alert_count - a.alert_count || b.threat_score - a.threat_score)
    .slice(0, 10)
    .map(p => ({ ...p, influence_score: Math.min(100, 40 + p.alert_count * 8) }));
  // Real engagement from the post itself; virality is display-only and never feeds risk.
  const viralAlerts = alerts.filter(a => a.velocity_data?.threshold_triggered).slice(0, 10);
  const viralContent = viralAlerts.length
    ? await Content.find({ tenant_id: tenantId, id: { $in: viralAlerts.map(a => a.content_id).filter(Boolean) } })
      .select('id engagement').lean()
    : [];
  const engagementById = new Map(viralContent.map(c => [c.id, c.engagement || {}]));
  const viralPosts = viralAlerts.map(a => {
    const e = engagementById.get(a.content_id) || {};
    return {
      post_id: a.content_id || a.id, content_preview: (a.title || 'Post content preview').substring(0, 100),
      platform: a.platform || 'Unknown',
      engagement: { views: e.views || 0, likes: e.likes || 0, shares: e.retweets || 0, comments: e.comments || 0 },
      virality_score: a.velocity_data?.velocity ? Math.min(a.velocity_data.velocity * 10, 100) : 0,
      ai_explanation: 'High engagement velocity detected. Content spreading rapidly across platform with significant user interaction.'
    };
  });
  const alertSummaries = alerts.slice(0, 50).map(a => ({
    alert_id: a.id, title: a.title || 'Untitled Alert', category: a.source_category || 'General',
    ai_summary: `Alert triggered for ${a.source_category || 'suspicious activity'}. Risk level: ${a.risk_level || 'medium'}. Priority: ${a.priority || 'MEDIUM'}.`,
    threat_level: a.risk_level || 'medium', related_keywords: a.matched_keywords_normalized || [],
    related_profiles: [a.author || 'Unknown'], timestamp: a.created_at,
    status: a.status || 'active', analyst_remarks: a.threat_details?.reasons?.join('; ') || 'Pending review'
  }));
  // Raw alert IDs so frontend can hydrate full alert cards via /api/alerts/bulk
  const top_alert_ids = alerts.slice(0, 50).map(a => a.id).filter(Boolean);
  const viral_alert_ids = alerts
    .filter(a => a.velocity_data?.threshold_triggered)
    .slice(0, 20)
    .map(a => a.id)
    .filter(Boolean);

  return {
    total_count: alerts.length,
    trend_percentage: calcTrend(alerts.length, prevAlertCount),
    top_5_critical: top5Critical,
    priority_scoring: { high, medium, low },
    by_category: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ category: c, count: n })),
    by_platform: Object.entries(byPlatform).map(([p, n]) => ({ platform: p, count: n })),
    by_status: Object.entries(byStatus).map(([s, n]) => ({ status: s, count: n })),
    escalated_count: escalated,
    resolved_count: resolved,
    resolution_rate: alerts.length > 0 ? Math.round((resolved / alerts.length) * 100) : 0,
    hourly_distribution: hourly.map(h => ({ start: h.start, count: h.count, high: h.high })),
    ai_intelligence_summary: `${alerts.length} total alerts: ${high} HIGH, ${medium} MEDIUM, ${low} LOW priority. ${escalated} escalated. Top categories: ${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c).join(', ')}.`,
    top_profiles: topProfiles, viral_posts: viralPosts, alert_summaries: alertSummaries,
    top_alert_ids, viral_alert_ids
  };
};

// ─── E. Escalated to Investigation ───
const collectEscalations = async (tenantId, start, end) => {
  const reports = await Report.find({ tenant_id: tenantId, generated_at: { $gte: start, $lt: end } });
  const byStatus = {};
  let underAction = 0, pending = 0, closed = 0;
  reports.forEach(r => {
    const st = (r.status || '').toLowerCase();
    byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
    if (st === 'sent_to_intermediary' || st === 'sent') underAction++;
    else if (st === 'closed' || st === 'resolved') closed++;
    else pending++;
  });
  return {
    total_count: reports.length, under_action: underAction, pending, closed,
    by_status: Object.entries(byStatus).map(([s, c]) => ({ status: s, count: c })),
    ai_recommendation: `${reports.length} cases escalated. ${underAction} under active investigation, ${pending} pending, ${closed} closed. Priority review needed for ${pending} pending cases. Recommend expediting high-priority escalations.`
  };
};

// ─── F. Profiles ───
const collectProfiles = async (tenantId, start, end) => {
  const [allActive, added, deleted, highRisk] = await Promise.all([
    POI.find({ tenant_id: tenantId, status: 'active' }),
    POI.find({ tenant_id: tenantId, createdAt: { $gte: start, $lt: end } }),
    POI.find({ tenant_id: tenantId, status: 'archived', updatedAt: { $gte: start, $lt: end } }),
    POI.find({ tenant_id: tenantId, status: 'active', escalatedToIntermediariesCount: { $gt: 0 } })
  ]);
  const byPlatform = {}, byCategory = {};
  allActive.forEach(p => {
    if (p.socialMedia && Array.isArray(p.socialMedia)) {
      p.socialMedia.forEach(sm => {
        if (sm.platform) {
          if (!byPlatform[sm.platform]) byPlatform[sm.platform] = { active: 0, deleted: 0 };
          byPlatform[sm.platform].active++;
        }
        if (sm.category) byCategory[sm.category] = (byCategory[sm.category] || 0) + 1;
      });
    }
  });
  const highRiskProfiles = highRisk.sort((a, b) => b.escalatedToIntermediariesCount - a.escalatedToIntermediariesCount).slice(0, 10).map(p => {
    const sm = p.socialMedia?.[0] || {};
    return { poi_id: p._id.toString(), name: p.name, platform: sm.platform || 'Unknown', handle: sm.handle || 'Unknown', alert_count: p.escalatedToIntermediariesCount, profile_image: sm.profile_image_url || '' };
  });
  return {
    added_count: added.length, deleted_count: deleted.length,
    newly_active: added.length, high_risk: highRisk.length,
    total_monitoring: allActive.length,
    by_platform: Object.entries(byPlatform).map(([p, d]) => ({ platform: p, active: d.active, deleted: d.deleted })),
    by_category: Object.entries(byCategory).map(([c, n]) => ({ category: c, count: n })),
    high_risk_profiles: highRiskProfiles
  };
};

// ─── G. Top Keywords / Trends ───
// risk_factors is an ARRAY of { keyword, weight, category, context } — iterate it.
// Falls back to the Alert.matched_keywords_normalized field when Content has no risk_factors.
const collectKeywords = async (tenantId, start, end) => {
  const [contents, alerts] = await Promise.all([
    Content.find({ tenant_id: tenantId, created_at: { $gte: start, $lt: end } }).limit(5000),
    Alert.find({ tenant_id: tenantId, created_at: { $gte: start, $lt: end } }).select('matched_keywords_normalized platform risk_level').limit(5000)
  ]);
  const kwCounts = {};
  const bump = (kw, platform, sentiment) => {
    if (!kw) return;
    const key = String(kw).trim().toLowerCase();
    if (!key) return;
    if (!kwCounts[key]) kwCounts[key] = { count: 0, platforms: new Set(), sentiments: { positive: 0, negative: 0, neutral: 0 } };
    kwCounts[key].count++;
    if (platform) kwCounts[key].platforms.add(platform);
    const sent = (sentiment || 'neutral').toLowerCase();
    if (kwCounts[key].sentiments[sent] !== undefined) kwCounts[key].sentiments[sent]++;
  };

  contents.forEach(c => {
    if (Array.isArray(c.risk_factors)) {
      c.risk_factors.forEach(rf => bump(rf?.keyword, c.platform, c.sentiment));
    }
  });
  alerts.forEach(a => {
    (a.matched_keywords_normalized || []).forEach(kw => bump(kw, a.platform, null));
  });

  return Object.entries(kwCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([kw, d]) => {
      const dominantSent = Object.entries(d.sentiments).sort((a, b) => b[1] - a[1])[0][0];
      return {
        keyword: kw,
        frequency: d.count,
        sentiment: dominantSent,
        trend: d.count > 30 ? 'rising' : d.count > 10 ? 'stable' : 'declining',
        platforms: Array.from(d.platforms),
        risk_level: d.count > 30 ? 'high' : d.count > 10 ? 'medium' : 'low'
      };
    });
};

// ─── Summary Statistics ───
const collectSummaryStats = async (tenantId, start, end) => {
  // Risk and sentiment only exist once analysed; unanalysed posts hold schema defaults.
  const [totalContent, analysedContent, highRiskContent, viralPosts] = await Promise.all([
    Content.countDocuments({ tenant_id: tenantId, created_at: { $gte: start, $lt: end } }),
    Content.countDocuments({ tenant_id: tenantId, created_at: { $gte: start, $lt: end }, analysis_status: 'done' }),
    Content.countDocuments({ tenant_id: tenantId, created_at: { $gte: start, $lt: end }, analysis_status: 'done', risk_level: 'high' }),
    Content.countDocuments({ tenant_id: tenantId, created_at: { $gte: start, $lt: end }, 'velocity_data.threshold_triggered': true })
  ]);
  const sentimentCounts = await Content.aggregate([
    { $match: { tenant_id: tenantId, created_at: { $gte: start, $lt: end }, analysis_status: 'done' } },
    { $group: { _id: '$sentiment', count: { $sum: 1 } } }
  ]);
  const sentiment = { positive: 0, negative: 0, neutral: 0 };
  sentimentCounts.forEach(({ _id, count }) => {
    const s = (_id || 'neutral').toLowerCase();
    if (sentiment[s] !== undefined) sentiment[s] = count;
  });
  return { total_content_processed: totalContent, threat_rate_percentage: analysedContent > 0 ? Math.round((highRiskContent / analysedContent) * 100) : 0, sentiment_breakdown: sentiment, viral_posts_count: viralPosts };
};

// ─── Main Generate Function ───
const generateComprehensiveReport = async (targetDate = null, tenantId) => {
  if (!tenantId) throw new Error('tenantId is required to generate a comprehensive report');
  const reportDate = targetDate ? new Date(targetDate) : new Date();
  const dateKey = getDateKey(reportDate);
  const existing = await ComprehensiveReport.findOne({ tenant_id: tenantId, date_key: dateKey });
  if (existing && existing.status === 'completed') return existing;
  const { start, end } = getDateRange(targetDate);
  const prev = getPrevRange(start, end);
  try {
    const [dial100, grievances, events, alerts, escalations, profiles, keywords, summaryStats] = await Promise.all([
      collectDial100(tenantId, start, end, prev.start, prev.end),
      collectGrievances(tenantId, start, end, prev.start, prev.end),
      collectEvents(tenantId, start, end, prev.start, prev.end),
      collectAlerts(tenantId, start, end, prev.start, prev.end),
      collectEscalations(tenantId, start, end),
      collectProfiles(tenantId, start, end),
      collectKeywords(tenantId, start, end),
      collectSummaryStats(tenantId, start, end)
    ]);
    const reportData = {
      tenant_id: tenantId,
      report_date: reportDate, date_key: dateKey,
      date_range: { start, end },
      dial100_calls: dial100, grievances, events, alerts,
      escalations, profiles, keywords_trends: keywords,
      summary_statistics: summaryStats, status: 'completed',
      executive_summary: `Comprehensive Intelligence Report covering ${start.toLocaleDateString('en-IN')} to ${end.toLocaleDateString('en-IN')}. ${dial100.total_count} Dial-100 calls, ${grievances.total_count} grievances, ${events.total_count} events, ${alerts.total_count} alerts, ${escalations.total_count} escalations. ${profiles.total_monitoring} profiles under monitoring. Threat rate: ${summaryStats.threat_rate_percentage}%.`,
      threat_highlights: `HIGH priority alerts: ${alerts.priority_scoring.high}. Critical incidents: ${dial100.critical_incidents}. High-risk profiles: ${profiles.high_risk}. Viral posts: ${summaryStats.viral_posts_count}.`,
      escalation_recommendations: `1. Prioritize ${alerts.priority_scoring.high} HIGH priority alerts. 2. Review ${escalations.pending} pending escalations. 3. Monitor ${profiles.high_risk} high-risk profiles. 4. Track ${events.total_count} events for escalation. 5. Analyze ${summaryStats.viral_posts_count} viral posts.`,
      intelligence_observations: `Key trends: ${keywords.slice(0, 3).map(k => k.keyword).join(', ')} are top keywords. ${events.ai_insights} Sentiment: ${summaryStats.sentiment_breakdown.negative} negative, ${summaryStats.sentiment_breakdown.positive} positive.`
    };
    if (existing) { Object.assign(existing, reportData); await existing.save(); return existing; }
    const report = new ComprehensiveReport(reportData);
    await report.save();
    return report;
  } catch (error) {
    console.error('Error generating comprehensive report:', error);
    if (existing) { existing.status = 'failed'; await existing.save(); }
    throw error;
  }
};

const getReportByDate = async (dateKey, tenantId) => ComprehensiveReport.findOne({ tenant_id: tenantId, date_key: dateKey });
const getAllReports = async (limit = 30, tenantId) => ComprehensiveReport.find({ tenant_id: tenantId, status: 'completed' }).sort({ report_date: -1 }).limit(limit);

// ─── Live Soceye Report ───
// Generates a fresh report over the last `windowHours` hours and upserts a
// daily snapshot so officers can revisit any past day's report.
const generateLiveSoceyeReport = async (windowHours = 24, tenantId, options = {}) => {
  if (!tenantId) throw new Error('tenantId is required to generate a Soceye report');
  const end = new Date();
  const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(prevEnd.getTime() - windowHours * 60 * 60 * 1000);

  const [dial100, grievances, events, alerts, escalations, profiles, keywords, summaryStats] = await Promise.all([
    collectDial100(tenantId, start, end, prevStart, prevEnd),
    collectGrievances(tenantId, start, end, prevStart, prevEnd),
    collectEvents(tenantId, start, end, prevStart, prevEnd),
    collectAlerts(tenantId, start, end, prevStart, prevEnd),
    collectEscalations(tenantId, start, end),
    collectProfiles(tenantId, start, end),
    collectKeywords(tenantId, start, end),
    collectSummaryStats(tenantId, start, end)
  ]);

  // ── Threat level: signals-based heuristic. Officers see CRITICAL/HIGH/
  // ELEVATED/NORMAL in the report header so they can triage at a glance.
  const threatScore =
    // Risk signals only — virality is reported separately and never raises threat level.
    (alerts.priority_scoring?.high || 0) * 3 +
    (alerts.escalated_count || 0) * 2 +
    (dial100.critical_incidents || 0) * 4 +
    (profiles.high_risk || 0) * 1;
  let threat_level = 'NORMAL';
  if (threatScore >= 60) threat_level = 'CRITICAL';
  else if (threatScore >= 30) threat_level = 'HIGH';
  else if (threatScore >= 10) threat_level = 'ELEVATED';

  // ── Actionable recommendations (array form so frontend can render as a
  // checklist with deep-links). Each item: title, detail, action (frontend
  // route), tone.
  const recommendations = [];
  if (alerts.priority_scoring?.high > 0) {
    recommendations.push({
      title: `Review ${alerts.priority_scoring.high} HIGH-priority alert${alerts.priority_scoring.high > 1 ? 's' : ''}`,
      detail: 'Triage and acknowledge before they age out of the window.',
      action: '/alerts?risk=high',
      tone: 'red'
    });
  }
  if (summaryStats.viral_posts_count > 0) {
    recommendations.push({
      title: `Investigate ${summaryStats.viral_posts_count} viral post${summaryStats.viral_posts_count > 1 ? 's' : ''}`,
      detail: 'Engagement velocity crossed the configured threshold.',
      action: '/alerts?viral=true',
      tone: 'orange'
    });
  }
  if (escalations.pending > 0) {
    recommendations.push({
      title: `${escalations.pending} pending escalation${escalations.pending > 1 ? 's' : ''}`,
      detail: 'Cases awaiting intermediary action — push them forward.',
      action: '/reports',
      tone: 'amber'
    });
  }
  if (grievances.pending > 0) {
    recommendations.push({
      title: `${grievances.pending} grievance${grievances.pending > 1 ? 's' : ''} in flight`,
      detail: 'Posts tagging us still need workflow assignment.',
      action: '/grievances',
      tone: 'blue'
    });
  }
  if (profiles.high_risk > 0) {
    recommendations.push({
      title: `${profiles.high_risk} high-risk profile${profiles.high_risk > 1 ? 's' : ''} active`,
      detail: 'Profiles with prior intermediary escalations — keep watching.',
      action: '/profiles?risk=high',
      tone: 'violet'
    });
  }
  if (keywords.length > 0 && keywords[0].risk_level === 'high') {
    recommendations.push({
      title: `Trending narrative: "${keywords[0].keyword}"`,
      detail: `${keywords[0].frequency} mentions, dominant sentiment ${keywords[0].sentiment}.`,
      action: `/alerts?search=${encodeURIComponent(keywords[0].keyword)}`,
      tone: 'emerald'
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      title: 'No critical action items',
      detail: 'Monitoring continues — nothing requires immediate response.',
      tone: 'green'
    });
  }

  const report = {
    tenant_id: tenantId,
    window_hours: windowHours,
    generated_at: new Date(),
    date_range: { start, end },
    prev_date_range: { start: prevStart, end: prevEnd },
    threat_level,
    threat_score: threatScore,
    dial100_calls: dial100,
    grievances,
    events,
    alerts,
    escalations,
    profiles,
    keywords_trends: keywords,
    summary_statistics: summaryStats,
    recommendations,
    executive_summary: `Soceye Live Report — last ${windowHours}h. ${dial100.total_count} Dial-100 calls, ${grievances.total_count} grievances, ${events.total_count} events, ${alerts.total_count} alerts. ${profiles.total_monitoring} profiles under monitoring. Threat rate: ${summaryStats.threat_rate_percentage}%.`,
    threat_highlights: `${alerts.priority_scoring?.high || 0} HIGH alerts · ${dial100.critical_incidents || 0} critical incidents · ${profiles.high_risk || 0} high-risk profiles · ${summaryStats.viral_posts_count || 0} viral posts.`,
    intelligence_observations: keywords.length
      ? `Top trending: ${keywords.slice(0, 3).map(k => k.keyword).join(', ')}. Sentiment skew: ${summaryStats.sentiment_breakdown.negative} negative vs ${summaryStats.sentiment_breakdown.positive} positive across ${summaryStats.total_content_processed} posts.`
      : `${summaryStats.total_content_processed} posts processed. No dominant narrative this window.`
  };

  // Persist a daily snapshot (one per date_key + window_hours). Best-effort —
  // a write failure must NOT break the live response.
  if (options.persist !== false) {
    try {
      const dateKey = getDateKey(end);
      await SoceyeReportSnapshot.findOneAndUpdate(
        { tenant_id: tenantId, date_key: dateKey, window_hours: windowHours },
        {
          $set: {
            generated_at: report.generated_at,
            date_range: report.date_range,
            data: report
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (err) {
      console.warn('[soceye-snapshot] persist failed:', err.message);
    }
  }

  return report;
};

const listSoceyeSnapshots = async (limit = 60, tenantId) => {
  const lim = Math.max(1, Math.min(365, Number(limit) || 60));
  return SoceyeReportSnapshot.find({ tenant_id: tenantId })
    .sort({ generated_at: -1 })
    .limit(lim)
    .select('id date_key window_hours generated_at date_range');
};

const getSoceyeSnapshotById = async (id, tenantId) => {
  return SoceyeReportSnapshot.findOne({ id, ...(tenantId ? { tenant_id: tenantId } : {}) });
};

module.exports = {
  generateComprehensiveReport,
  getReportByDate,
  getAllReports,
  generateLiveSoceyeReport,
  listSoceyeSnapshots,
  getSoceyeSnapshotById
};