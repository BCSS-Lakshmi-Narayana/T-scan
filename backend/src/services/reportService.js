const Report = require('../models/Report');
const Alert = require('../models/Alert');
const Content = require('../models/Content');
const Analysis = require('../models/Analysis');
const Source = require('../models/Source');
const cacheService = require('./cacheService');
const { withTenant } = require('../utils/tenantFilter');
const { requestedDistrictFrom, districtScopeSignature, resolveScopedSourceIds } = require('../utils/scopedDistricts');

// Resolve which districts a Report query should be restricted to.
//  - officer: their assigned districts, narrowed to the selected one when it's
//    within their set (an officer can never widen — an out-of-scope selection
//    resolves to a no-match sentinel).
//  - admin:   [] (whole tenant) unless a district is globally selected.
// Filtering happens through the source join (`source_data.districts`) so it also
// works for reports created before Report carried its own `districts` field.
const resolveReportDistricts = (req) => {
    // No request/user context at all = an internal or scheduled system call
    // (these signatures default req to null). Those are not district-scoped;
    // treating them as "an officer with zero districts" would silently return
    // nothing. This is NOT a security hole: every user-facing path goes through
    // an authenticated route, so req.user is always present there.
    if (!req || !req.user) return [];

    const isAdmin = req.user.role === 'admin';
    const requested = requestedDistrictFrom(req);
    if (isAdmin) return requested ? [requested] : [];
    const own = req.user.districts || [];
    if (!own.length) return ['__none__'];
    if (requested) return own.includes(requested) ? [requested] : ['__none__'];
    return own;
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Generate a unique serial number for a report.
 * Format: PLATFORM-SN-MM-DD-YYYY
 */
const generateSerialNumber = async (platform, tenantId) => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();

    const platformCode = platform.toUpperCase().substring(0, 1); // X, Y, F, I
    const dateStr = `${dd}${mm}${yyyy}`; // ddmmyyyy

    // Count this tenant's reports for this platform (per-tenant serial sequence)
    const count = await Report.countDocuments({
        tenant_id: tenantId,
        platform: platform.toLowerCase()
    });

    const sn = String(count + 1).padStart(4, '0'); // 0001
    return `${platformCode}${sn}-${dateStr}`; // x0001-ddmmyyyy
};

/**
 * Create a new report based on an alert.
 * Tenant-scoped: the alert must belong to `tenantId`, so one tenant can never
 * escalate another tenant's alert (alert ids are global UUIDs).
 * District-scoped: when `req` is a real authenticated request (not an internal/
 * scheduled call), a District Officer may only escalate an alert whose linked
 * Source belongs to one of their own districts — Alert has no `districts`
 * field of its own, so this is checked via the Source it came from.
 */
const createReportFromAlert = async (alertId, tenantId, req = null) => {
    if (!tenantId) throw new Error('tenantId is required');

    const alert = await Alert.findOne({ id: alertId, tenant_id: tenantId });
    if (!alert) throw new Error('Alert not found');

    if (req?.user) {
        const scopedSourceIds = await resolveScopedSourceIds(req, Source, withTenant);
        if (scopedSourceIds && !scopedSourceIds.includes(alert.source_id)) {
            throw new Error('Alert not found');
        }
    }

    const content = await Content.findOne({ id: alert.content_id, tenant_id: tenantId });
    const analysis = await Analysis.findOne({ id: alert.analysis_id, tenant_id: tenantId });

    // Check if report already exists (scoped to this tenant)
    const existingReport = await Report.findOne({ alert_id: alertId, tenant_id: tenantId });
    if (existingReport) {
        return existingReport;
    }

    const serialNumber = await generateSerialNumber(alert.platform, alert.tenant_id);

    const reportData = {
        tenant_id: alert.tenant_id,
        serial_number: serialNumber,
        alert_id: alertId,
        // Inherit district(s) from the underlying content/source for per-district
        // scoping of report analytics.
        districts: content?.districts || [],
        platform: alert.platform,
        target_user_details: {
            name: alert.author || 'Unknown',
            handle: content?.author_handle || alert.author,
            profile_url: `https://x.com/${(content?.author_handle || alert.author).replace('@', '')}`,
            avatar_url: content?.original_author_avatar || '',
            is_verified: false // Source model would have this
        },
        content_summary: content?.text || alert.description,
        media_links: content?.media?.map(m => m.url) || [],
        legal_sections: alert.legal_sections || [],
        violated_policies: alert.violated_policies || [],
        status: 'sent_to_intermediary'
    };

    const report = new Report(reportData);
    await report.save();

    // Update alert status to escalated
    alert.status = 'escalated';
    await alert.save();
    await cacheService.invalidatePrefix('reports:stats:v1');
    await cacheService.invalidatePrefix('dashboard:v2');
    await cacheService.invalidatePrefix('alerts:stats:v2');

    // --- ML FEEDBACK LOOP ---
    // Recording report generation as confirmed escalation (HIGH risk)
    try {
        const feedbackService = require('./feedbackService');
        if (content && content.text) {
            await feedbackService.recordFeedback({
                text: content.text,
                category: alert.category_id || 'Abusive',
                legal_sections: alert.legal_sections,
                review_status: 'escalated',
                current_risk: 'HIGH'
            });
            console.log(`[ReportService] Recorded feedback for report: ${alertId}`);
        }
    } catch (fbError) {
        console.error('[ReportService] Feedback recording failed:', fbError);
    }

    return report;
};

/**
 * Get all reports with filtering and pagination.
 */
const getAllReports = async (filters = {}, tenantId, req = null) => {
    if (!tenantId) throw new Error('tenantId is required');
    const { platform, status, search, startDate, endDate, page = 1, limit = 20, keyword, alert_type, risk_level, category, district } = filters;
    // Tenant scope is the base of every query path (optimized + legacy pipelines
    // both spread `query` into their $match), so reports never leak across tenants.
    const query = { tenant_id: tenantId };

    if (platform && platform !== 'all') query.platform = platform;
    if (status && status !== 'all') query.status = status;
    if (startDate || endDate) {
        query.generated_at = {};
        if (startDate) query.generated_at.$gte = new Date(startDate);
        if (endDate) query.generated_at.$lte = new Date(endDate);
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Officers only see reports whose alert is linked to a Source tagged with one
    // of their assigned districts; admins see every report in the tenant unless a
    // district is selected globally (navbar) or explicitly for this page.
    // resolveReportDistricts folds both together and clamps officers.
    const officerDistricts = resolveReportDistricts(req);
    const requestedDistrict = requestedDistrictFrom(req, district);
    const needsDistrictJoin = officerDistricts.length > 0 || !!requestedDistrict;

    const needsJoinsForFiltering = (category && category !== 'all') ||
        (keyword && keyword !== 'all') ||
        (risk_level && risk_level !== 'all') ||
        (alert_type && alert_type !== 'all') ||
        needsDistrictJoin;

    const normalizedSearch = String(search || '').trim();

    let dataPipeline = [];
    let countFilter = null; // for fast parallel count

    if (!needsJoinsForFiltering) {
        // ── Optimized path: $text index for search, paginate Report collection first ──
        const matchFilter = { ...query };

        if (normalizedSearch) {
            // Use the compound text index { serial_number, target_user_details.name, target_user_details.handle }
            matchFilter.$text = { $search: normalizedSearch };
        }

        countFilter = matchFilter; // countDocuments can use same filter

        dataPipeline.push({ $match: matchFilter });

        // Sort: text-score relevance when searching, otherwise newest first
        if (normalizedSearch) {
            dataPipeline.push({ $sort: { score: { $meta: 'textScore' }, generated_at: -1 } });
        } else {
            dataPipeline.push({ $sort: { generated_at: -1 } });
        }

        dataPipeline.push({ $skip: skip });
        dataPipeline.push({ $limit: limitNum });

        // Lookups run on paginated slice only (max limitNum docs)
        dataPipeline.push(
            {
                $lookup: {
                    from: 'alerts',
                    localField: 'alert_id',
                    foreignField: 'id',
                    as: 'alert_data'
                }
            },
            { $unwind: { path: '$alert_data', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'contents',
                    localField: 'alert_data.content_id',
                    foreignField: 'id',
                    as: 'content_data'
                }
            },
            { $unwind: { path: '$content_data', preserveNullAndEmptyArrays: true } }
        );
    } else {
        // ── Legacy path: Joins happen before filtering ──
        dataPipeline = [
            { $match: query },
            {
                $lookup: {
                    from: 'alerts',
                    localField: 'alert_id',
                    foreignField: 'id',
                    as: 'alert_data'
                }
            },
            { $unwind: { path: '$alert_data', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'contents',
                    localField: 'alert_data.content_id',
                    foreignField: 'id',
                    as: 'content_data'
                }
            },
            { $unwind: { path: '$content_data', preserveNullAndEmptyArrays: true } }
        ];

        if ((category && category !== 'all') || needsDistrictJoin) {
            dataPipeline.push(
                {
                    $lookup: {
                        from: 'sources',
                        localField: 'content_data.source_id',
                        foreignField: 'id',
                        as: 'source_data'
                    }
                },
                { $unwind: { path: '$source_data', preserveNullAndEmptyArrays: true } }
            );

            if (category && category !== 'all') {
                dataPipeline.push({ $match: { $or: [{ 'alert_data.source_category': category }, { 'source_data.category': category }] } });
            }

            if (officerDistricts.length > 0) {
                dataPipeline.push({ $match: { 'source_data.districts': { $in: officerDistricts } } });
            }

            if (requestedDistrict) {
                dataPipeline.push({ $match: { 'source_data.districts': requestedDistrict } });
            }
        }

        if (keyword && keyword !== 'all') {
            dataPipeline.push({
                $match: {
                    'content_data.risk_factors.keyword': { $regex: `^${escapeRegex(keyword)}`, $options: 'i' }
                }
            });
        }

        if (risk_level && risk_level !== 'all') {
            dataPipeline.push({ $match: { 'alert_data.risk_level': risk_level } });
        }

        if (alert_type && alert_type !== 'all') {
            if (alert_type === 'risk') {
                dataPipeline.push({ $match: { 'alert_data.alert_type': { $in: ['keyword_risk', 'ai_risk', null] } } });
            } else {
                dataPipeline.push({ $match: { 'alert_data.alert_type': alert_type } });
            }
        }

        if (normalizedSearch) {
            const searchPattern = escapeRegex(normalizedSearch);
            dataPipeline.push({
                $match: {
                    $or: [
                        { serial_number: { $regex: searchPattern, $options: 'i' } },
                        { 'target_user_details.name': { $regex: searchPattern, $options: 'i' } },
                        { 'target_user_details.handle': { $regex: searchPattern, $options: 'i' } },
                        { 'content_data.text': { $regex: searchPattern, $options: 'i' } }
                    ]
                }
            });
        }

        dataPipeline.push(
            { $sort: { generated_at: -1 } },
            { $skip: skip },
            { $limit: limitNum }
        );
    }

    // Source lookup for category column (runs on paginated slice only)
    dataPipeline.push(
        {
            $lookup: {
                from: 'sources',
                localField: 'content_data.source_id',
                foreignField: 'id',
                as: 'source_data'
            }
        },
        { $unwind: { path: '$source_data', preserveNullAndEmptyArrays: true } },
        {
            $addFields: {
                id: '$_id',
                joined_content_url: '$alert_data.content_url',
                source_category: {
                    $ifNull: ['$alert_data.source_category', '$source_data.category']
                }
            }
        }
    );

    // ── Run data + count in parallel ──
    let items, total;

    if (countFilter) {
        // Optimized path: fast countDocuments (uses index)
        [items, total] = await Promise.all([
            Report.aggregate(dataPipeline),
            Report.countDocuments(countFilter)
        ]);
    } else {
        // Legacy path: count via separate aggregation (same filters, no skip/limit/lookups-after-filter)
        const countPipeline = dataPipeline
            .filter(stage => !stage.$skip && !stage.$limit && !stage.$addFields && !stage.$sort)
            .filter(stage => {
                // Keep $match, $lookup, $unwind stages needed for filtering — exclude final source lookup
                if (stage.$lookup && stage.$lookup.from === 'sources' && !needsJoinsForFiltering) return false;
                return true;
            });
        countPipeline.push({ $count: 'total' });

        const [dataResult, countResult] = await Promise.all([
            Report.aggregate(dataPipeline),
            Report.aggregate(countPipeline).catch(() => [])
        ]);
        items = dataResult;
        total = countResult[0]?.total || 0;
    }

    return {
        items,
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.max(Math.ceil(total / limitNum), 1)
        }
    };
};
const updateReport = async (alertId, updateData = {}, tenantId) => {
    if (!tenantId) throw new Error('tenantId is required');
    // Never allow the client payload to move a report to another tenant or change its ids.
    const { tenant_id, id, _id, ...safeUpdate } = updateData;
    const report = await Report.findOneAndUpdate(
        { alert_id: alertId, tenant_id: tenantId },
        {
            $set: safeUpdate
        },
        { new: true }
    );
    if (!report) throw new Error('Report not found');
    await cacheService.invalidatePrefix('reports:stats:v1');
    await cacheService.invalidatePrefix('dashboard:v2');
    return report;
};

const getReportStats = async (tenantId, req = null) => {
    if (!tenantId) throw new Error('tenantId is required');
    // Per-tenant AND per-district-scope cache key — without the scope suffix, an
    // officer scoped to one district could be served another user's cached
    // (differently-scoped) stats for the same tenant.
    // Includes the globally-selected district, so switching districts in the
    // navbar can't serve the previous selection's cached stats.
    const scopeSignature = districtScopeSignature(req);
    const cacheKey = `reports:stats:v1:${tenantId}:${scopeSignature}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const matchStage = { tenant_id: tenantId };
    const pipeline = [{ $match: matchStage }];

    const officerDistricts = resolveReportDistricts(req);
    if (officerDistricts.length > 0) {
        pipeline.push(
            { $lookup: { from: 'alerts', localField: 'alert_id', foreignField: 'id', as: 'alert_data' } },
            { $unwind: { path: '$alert_data', preserveNullAndEmptyArrays: true } },
            { $lookup: { from: 'contents', localField: 'alert_data.content_id', foreignField: 'id', as: 'content_data' } },
            { $unwind: { path: '$content_data', preserveNullAndEmptyArrays: true } },
            { $lookup: { from: 'sources', localField: 'content_data.source_id', foreignField: 'id', as: 'source_data' } },
            { $unwind: { path: '$source_data', preserveNullAndEmptyArrays: true } },
            { $match: { 'source_data.districts': { $in: officerDistricts } } }
        );
    }

    pipeline.push({
        $group: {
            _id: { platform: '$platform', status: '$status' },
            count: { $sum: 1 }
        }
    });

    const grouped = await Report.aggregate(pipeline);

    const normalizePlatform = (platform) => (platform === 'x' ? 'twitter' : platform);
    const statuses = ['generated', 'printed', 'sent', 'sent_to_intermediary', 'awaiting_reply', 'closed'];
    const platforms = ['all', 'twitter', 'youtube', 'facebook', 'instagram', 'whatsapp'];
    const byPlatform = {};
    const byStatus = Object.fromEntries(statuses.map((s) => [s, 0]));
    const totals = { total: 0 };

    platforms.forEach((p) => {
        byPlatform[p] = { total: 0 };
        statuses.forEach((s) => {
            byPlatform[p][s] = 0;
        });
    });

    grouped.forEach(({ _id, count }) => {
        const platform = normalizePlatform(_id.platform || 'unknown');
        const status = _id.status;
        if (!statuses.includes(status)) return;
        if (!byPlatform[platform]) {
            byPlatform[platform] = { total: 0 };
            statuses.forEach((s) => {
                byPlatform[platform][s] = 0;
            });
        }
        byPlatform[platform][status] += count;
        byPlatform[platform].total += count;
        byPlatform.all[status] += count;
        byPlatform.all.total += count;
        byStatus[status] += count;
        totals.total += count;
    });

    const payload = { byPlatform, byStatus, totals };
    await cacheService.set(cacheKey, payload, 30);
    return payload;
};

module.exports = {
    generateSerialNumber,
    createReportFromAlert,
    getAllReports,
    updateReport,
    getReportStats
};
