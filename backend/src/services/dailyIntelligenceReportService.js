const DailyIntelligenceReport = require('../models/DailyIntelligenceReport');
const Dial100Incident = require('../models/Dial100Incident');
const Grievance = require('../models/Grievance');
const Alert = require('../models/Alert');
const Content = require('../models/Content');
const POI = require('../models/POI');
const Event = require('../models/Event');
const Keyword = require('../models/Keyword');

const getLast24HoursWindow = () => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    return { start, end };
};

const getDateKey = (date) => {
    return date.toISOString().split('T')[0];
};

const collectDial100Data = async (tenantId, start, end) => {
    const incidents = await Dial100Incident.find({
        tenant_id: tenantId,
        createdAt: { $gte: start, $lt: end }
    });

    const totalReceived = incidents.length;
    
    const byCategory = {};
    const byJurisdiction = {};
    let totalResponseTime = 0;
    let responseCount = 0;
    let criticalIncidents = 0;

    incidents.forEach(incident => {
        if (incident.category) {
            byCategory[incident.category] = (byCategory[incident.category] || 0) + 1;
        }
        
        if (incident.zoneJurisdiction) {
            byJurisdiction[incident.zoneJurisdiction] = (byJurisdiction[incident.zoneJurisdiction] || 0) + 1;
        }
        
        if (incident.responseTimeForAssignedToVehicleReached) {
            totalResponseTime += incident.responseTimeForAssignedToVehicleReached;
            responseCount++;
        }
        
        if (incident.priority === 'Critical' || incident.priority === 'High') {
            criticalIncidents++;
        }
    });

    return {
        total_received: totalReceived,
        by_category: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
        by_jurisdiction: Object.entries(byJurisdiction).map(([jurisdiction, count]) => ({ jurisdiction, count })),
        response_time_avg: responseCount > 0 ? Math.round(totalResponseTime / responseCount) : 0,
        critical_incidents: criticalIncidents
    };
};

const collectGrievanceData = async (tenantId, start, end) => {
    const grievances = await Grievance.find({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    });

    const totalGenerated = grievances.length;
    
    const byType = {
        criticism: 0,
        suggestion: 0,
        grievance: 0
    };
    
    const byPlatform = {};
    const byStatus = {};
    const taggedAccounts = {};

    grievances.forEach(grievance => {
        const category = (grievance.category || '').toLowerCase();
        if (category.includes('criticism')) {
            byType.criticism++;
        } else if (category.includes('suggestion')) {
            byType.suggestion++;
        } else {
            byType.grievance++;
        }
        
        if (grievance.platform) {
            byPlatform[grievance.platform] = (byPlatform[grievance.platform] || 0) + 1;
        }
        
        if (grievance.status) {
            byStatus[grievance.status] = (byStatus[grievance.status] || 0) + 1;
        }
        
        if (grievance.tagged_account) {
            taggedAccounts[grievance.tagged_account] = (taggedAccounts[grievance.tagged_account] || 0) + 1;
        }
    });

    const topTaggedAccounts = Object.entries(taggedAccounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([account, count]) => ({ account, count }));

    return {
        total_generated: totalGenerated,
        by_type: byType,
        by_platform: Object.entries(byPlatform).map(([platform, count]) => ({ platform, count })),
        by_status: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
        top_tagged_accounts: topTaggedAccounts
    };
};

const collectEventsData = async (tenantId, start, end) => {
    const events = await Event.find({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    });

    const totalFetched = events.length;
    const relevantCount = events.filter(e => e.is_relevant === true).length;
    
    const byPlatform = {};
    const eventCounts = {};

    events.forEach(event => {
        if (event.platform) {
            if (!byPlatform[event.platform]) {
                byPlatform[event.platform] = { fetched: 0, relevant: 0 };
            }
            byPlatform[event.platform].fetched++;
            if (event.is_relevant) {
                byPlatform[event.platform].relevant++;
            }
        }
        
        if (event.event_id) {
            if (!eventCounts[event.event_id]) {
                eventCounts[event.event_id] = {
                    event_id: event.event_id,
                    event_name: event.event_name || event.event_id,
                    count: 0,
                    platforms: new Set()
                };
            }
            eventCounts[event.event_id].count++;
            if (event.platform) {
                eventCounts[event.event_id].platforms.add(event.platform);
            }
        }
    });

    const topEvents = Object.values(eventCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map(e => ({
            event_id: e.event_id,
            event_name: e.event_name,
            content_count: e.count,
            platforms: Array.from(e.platforms)
        }));

    return {
        total_fetched: totalFetched,
        relevant_count: relevantCount,
        by_platform: Object.entries(byPlatform).map(([platform, data]) => ({
            platform,
            fetched: data.fetched,
            relevant: data.relevant
        })),
        top_events: topEvents
    };
};

const collectAlertsData = async (tenantId, start, end) => {
    const alerts = await Alert.find({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    }).sort({ created_at: -1 });

    const totalActive = alerts.filter(a => a.status === 'active' || a.status === 'open').length;
    
    const byPriority = {
        high: 0,
        medium: 0,
        low: 0
    };
    
    const byCategory = {};
    const byPlatform = {};
    let escalatedCount = 0;

    alerts.forEach(alert => {
        // Counted by risk level. Alert.priority holds viral priority, which must not read as risk.
        const priority = (alert.risk_level || '').toLowerCase();
        if (priority === 'high' || priority === 'critical') {
            byPriority.high++;
        } else if (priority === 'medium') {
            byPriority.medium++;
        } else {
            byPriority.low++;
        }
        
        if (alert.source_category) {
            byCategory[alert.source_category] = (byCategory[alert.source_category] || 0) + 1;
        }
        
        if (alert.platform) {
            byPlatform[alert.platform] = (byPlatform[alert.platform] || 0) + 1;
        }
        
        if (alert.status === 'escalated') {
            escalatedCount++;
        }
    });

    const top50Alerts = alerts.slice(0, 50).map(alert => ({
        alert_id: alert.id,
        title: alert.title || 'Untitled Alert',
        priority: alert.priority || 'MEDIUM',
        category: alert.source_category || 'Unknown',
        platform: alert.platform || 'Unknown',
        author: alert.author || 'Unknown',
        risk_score: alert.threat_details?.risk_score ?? 0,
        created_at: alert.created_at
    }));

    return {
        total_active: totalActive,
        by_priority: byPriority,
        by_category: Object.entries(byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([category, count]) => ({ category, count })),
        by_platform: Object.entries(byPlatform).map(([platform, count]) => ({ platform, count })),
        escalated_count: escalatedCount,
        top_50_alerts: top50Alerts
    };
};

const collectTopConcepts = async (tenantId, start, end) => {
    const contents = await Content.find({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    }).limit(10000);

    const conceptCounts = {};
    
    contents.forEach(content => {
        if (content.risk_factors && content.risk_factors.keyword) {
            const keyword = content.risk_factors.keyword;
            if (!conceptCounts[keyword]) {
                conceptCounts[keyword] = {
                    count: 0,
                    sentiment: { positive: 0, negative: 0, neutral: 0 },
                    riskLevels: { high: 0, medium: 0, low: 0 }
                };
            }
            conceptCounts[keyword].count++;
            
            const sentiment = (content.sentiment || 'neutral').toLowerCase();
            if (conceptCounts[keyword].sentiment[sentiment] !== undefined) {
                conceptCounts[keyword].sentiment[sentiment]++;
            }
            
            const riskLevel = (content.risk_level || 'low').toLowerCase();
            if (conceptCounts[keyword].riskLevels[riskLevel] !== undefined) {
                conceptCounts[keyword].riskLevels[riskLevel]++;
            }
        }
    });

    return Object.entries(conceptCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([concept, data]) => {
            const dominantSentiment = Object.entries(data.sentiment)
                .sort((a, b) => b[1] - a[1])[0][0];
            const dominantRisk = Object.entries(data.riskLevels)
                .sort((a, b) => b[1] - a[1])[0][0];
            
            return {
                concept,
                count: data.count,
                sentiment: dominantSentiment,
                risk_level: dominantRisk
            };
        });
};

const collectProfilesData = async (tenantId, start, end) => {
    const allProfiles = await POI.find({ tenant_id: tenantId, status: 'active' });
    const totalMonitoring = allProfiles.length;

    const deletedProfiles = await POI.find({
        tenant_id: tenantId,
        status: 'archived',
        updatedAt: { $gte: start, $lt: end }
    });
    const deletedLast24h = deletedProfiles.length;
    
    const byPlatform = {};
    const byCategory = {};
    
    allProfiles.forEach(profile => {
        if (profile.socialMedia && Array.isArray(profile.socialMedia)) {
            profile.socialMedia.forEach(sm => {
                if (sm.platform) {
                    if (!byPlatform[sm.platform]) {
                        byPlatform[sm.platform] = { active: 0, deleted: 0 };
                    }
                    byPlatform[sm.platform].active++;
                }
                
                if (sm.category) {
                    byCategory[sm.category] = (byCategory[sm.category] || 0) + 1;
                }
            });
        }
    });
    
    deletedProfiles.forEach(profile => {
        if (profile.socialMedia && Array.isArray(profile.socialMedia)) {
            profile.socialMedia.forEach(sm => {
                if (sm.platform && byPlatform[sm.platform]) {
                    byPlatform[sm.platform].deleted++;
                }
            });
        }
    });

    const highRiskProfiles = allProfiles
        .filter(p => p.escalatedToIntermediariesCount > 0)
        .sort((a, b) => b.escalatedToIntermediariesCount - a.escalatedToIntermediariesCount)
        .slice(0, 10)
        .map(profile => {
            const primarySocial = profile.socialMedia && profile.socialMedia[0];
            return {
                poi_id: profile._id.toString(),
                name: profile.name,
                platform: primarySocial?.platform || 'Unknown',
                handle: primarySocial?.handle || 'Unknown',
                alert_count: profile.escalatedToIntermediariesCount
            };
        });

    return {
        total_monitoring: totalMonitoring,
        deleted_last_24h: deletedLast24h,
        by_platform: Object.entries(byPlatform).map(([platform, data]) => ({
            platform,
            active: data.active,
            deleted: data.deleted
        })),
        by_category: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
        high_risk_profiles: highRiskProfiles
    };
};

const collectTopKeywords = async (tenantId, start, end) => {
    const contents = await Content.find({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    }).limit(10000);

    const keywordCounts = {};
    
    contents.forEach(content => {
        if (content.risk_factors && content.risk_factors.keyword) {
            const keyword = content.risk_factors.keyword;
            if (!keywordCounts[keyword]) {
                keywordCounts[keyword] = {
                    count: 0,
                    platforms: new Set()
                };
            }
            keywordCounts[keyword].count++;
            if (content.platform) {
                keywordCounts[keyword].platforms.add(content.platform);
            }
        }
    });

    return Object.entries(keywordCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([keyword, data]) => ({
            keyword,
            count: data.count,
            trend: data.count > 50 ? 'rising' : data.count > 20 ? 'stable' : 'declining',
            platforms: Array.from(data.platforms)
        }));
};

const collectSummaryStatistics = async (tenantId, start, end) => {
    const totalContent = await Content.countDocuments({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end }
    });

    // Risk and sentiment only exist once analysed; unanalysed posts hold schema defaults.
    const analysedContent = await Content.countDocuments({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end },
        analysis_status: 'done'
    });

    const highRiskContent = await Content.countDocuments({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end },
        analysis_status: 'done',
        risk_level: 'high'
    });

    const sentimentCounts = await Content.aggregate([
        { $match: { tenant_id: tenantId, created_at: { $gte: start, $lt: end }, analysis_status: 'done' } },
        { $group: { _id: '$sentiment', count: { $sum: 1 } } }
    ]);

    const sentimentBreakdown = {
        positive: 0,
        negative: 0,
        neutral: 0
    };

    sentimentCounts.forEach(({ _id, count }) => {
        const sentiment = (_id || 'neutral').toLowerCase();
        if (sentimentBreakdown[sentiment] !== undefined) {
            sentimentBreakdown[sentiment] = count;
        }
    });

    const viralPosts = await Content.countDocuments({
        tenant_id: tenantId,
        created_at: { $gte: start, $lt: end },
        'velocity_data.threshold_triggered': true
    });

    return {
        total_content_processed: totalContent,
        threat_rate_percentage: analysedContent > 0 ? Math.round((highRiskContent / analysedContent) * 100) : 0,
        sentiment_breakdown: sentimentBreakdown,
        viral_posts_count: viralPosts
    };
};

const generateDetailedSections = (data) => {
    const executiveSummary = `
Daily Intelligence Report Summary for ${data.date_key}

Total Dial 100 Calls: ${data.dial100_calls.total_received}
Total Grievances: ${data.grievances.total_generated}
Total Events Fetched: ${data.events.total_fetched} (${data.events.relevant_count} relevant)
Active Alerts: ${data.alerts.total_active} (${data.alerts.by_priority.high} HIGH priority)
Profiles Monitoring: ${data.profiles.total_monitoring}
Content Processed: ${data.summary_statistics.total_content_processed}
Threat Rate: ${data.summary_statistics.threat_rate_percentage}%
    `.trim();

    const dial100Analysis = `
Dial 100 Call Analysis:
- Total calls received: ${data.dial100_calls.total_received}
- Critical incidents: ${data.dial100_calls.critical_incidents}
- Average response time: ${data.dial100_calls.response_time_avg} minutes

Top Categories:
${data.dial100_calls.by_category.slice(0, 5).map((c, i) => `${i + 1}. ${c.category}: ${c.count} calls`).join('\n')}
    `.trim();

    const grievanceAnalysis = `
Grievance Analysis:
- Total generated: ${data.grievances.total_generated}
- Criticism: ${data.grievances.by_type.criticism}
- Suggestions: ${data.grievances.by_type.suggestion}
- Grievances: ${data.grievances.by_type.grievance}

Top Tagged Accounts:
${data.grievances.top_tagged_accounts.slice(0, 5).map((a, i) => `${i + 1}. ${a.account}: ${a.count} grievances`).join('\n')}
    `.trim();

    const eventsAnalysis = `
Events Analysis:
- Total fetched: ${data.events.total_fetched}
- Relevant events: ${data.events.relevant_count}
- Relevance rate: ${data.events.total_fetched > 0 ? Math.round((data.events.relevant_count / data.events.total_fetched) * 100) : 0}%

Top Events:
${data.events.top_events.slice(0, 5).map((e, i) => `${i + 1}. ${e.event_name}: ${e.content_count} items (${e.platforms.join(', ')})`).join('\n')}
    `.trim();

    const alertsAnalysis = `
Alerts Analysis:
- Total active: ${data.alerts.total_active}
- HIGH priority: ${data.alerts.by_priority.high}
- MEDIUM priority: ${data.alerts.by_priority.medium}
- Escalated: ${data.alerts.escalated_count}

Top Categories:
${data.alerts.by_category.slice(0, 5).map((c, i) => `${i + 1}. ${c.category}: ${c.count} alerts`).join('\n')}
    `.trim();

    const threatIntelligence = `
Threat Intelligence Summary:
- Viral posts detected: ${data.summary_statistics.viral_posts_count}
- Negative sentiment: ${data.summary_statistics.sentiment_breakdown.negative} items
- High-risk profiles: ${data.profiles.high_risk_profiles.length}

Top 5 Concepts:
${data.top_concepts.map((c, i) => `${i + 1}. ${c.concept}: ${c.count} mentions (${c.sentiment} sentiment, ${c.risk_level} risk)`).join('\n')}
    `.trim();

    const recommendations = `
Recommendations:
1. Monitor ${data.alerts.by_priority.high} HIGH priority alerts requiring immediate attention
2. Review ${data.grievances.total_generated} grievances for public sentiment analysis
3. Track ${data.events.relevant_count} relevant events for potential escalation
4. Investigate ${data.profiles.high_risk_profiles.length} high-risk profiles
5. Analyze ${data.summary_statistics.viral_posts_count} viral posts for misinformation
    `.trim();

    return {
        executive_summary: executiveSummary,
        dial100_analysis: dial100Analysis,
        grievance_analysis: grievanceAnalysis,
        events_analysis: eventsAnalysis,
        alerts_analysis: alertsAnalysis,
        threat_intelligence: threatIntelligence,
        recommendations: recommendations
    };
};

const generateDailyIntelligenceReport = async (targetDate = null, tenantId) => {
    if (!tenantId) throw new Error('tenantId is required to generate a daily intelligence report');
    const reportDate = targetDate ? new Date(targetDate) : new Date();
    const dateKey = getDateKey(reportDate);

    const existing = await DailyIntelligenceReport.findOne({ tenant_id: tenantId, date_key: dateKey });
    if (existing && existing.status === 'completed') {
        return existing;
    }

    const { start, end } = getLast24HoursWindow();

    try {
        const [
            dial100Data,
            grievanceData,
            eventsData,
            alertsData,
            topConcepts,
            profilesData,
            topKeywords,
            summaryStats
        ] = await Promise.all([
            collectDial100Data(tenantId, start, end),
            collectGrievanceData(tenantId, start, end),
            collectEventsData(tenantId, start, end),
            collectAlertsData(tenantId, start, end),
            collectTopConcepts(tenantId, start, end),
            collectProfilesData(tenantId, start, end),
            collectTopKeywords(tenantId, start, end),
            collectSummaryStatistics(tenantId, start, end)
        ]);

        const reportData = {
            tenant_id: tenantId,
            report_date: reportDate,
            date_key: dateKey,
            dial100_calls: dial100Data,
            grievances: grievanceData,
            events: eventsData,
            alerts: alertsData,
            top_concepts: topConcepts,
            profiles: profilesData,
            top_keywords: topKeywords,
            summary_statistics: summaryStats,
            status: 'completed'
        };

        reportData.detailed_sections = generateDetailedSections(reportData);

        if (existing) {
            Object.assign(existing, reportData);
            await existing.save();
            return existing;
        }

        const report = new DailyIntelligenceReport(reportData);
        await report.save();
        return report;

    } catch (error) {
        console.error('Error generating daily intelligence report:', error);
        
        if (existing) {
            existing.status = 'failed';
            await existing.save();
        }
        
        throw error;
    }
};

const getReportByDate = async (dateKey, tenantId) => {
    return await DailyIntelligenceReport.findOne({ tenant_id: tenantId, date_key: dateKey });
};

const getAllReports = async (limit = 30, tenantId) => {
    return await DailyIntelligenceReport.find({ tenant_id: tenantId, status: 'completed' })
        .sort({ report_date: -1 })
        .limit(limit);
};

module.exports = {
    generateDailyIntelligenceReport,
    getReportByDate,
    getAllReports
};
