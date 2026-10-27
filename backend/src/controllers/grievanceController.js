const GrievanceSource = require('../models/GrievanceSource');
const Grievance = require('../models/Grievance');
const GrievanceSettings = require('../models/GrievanceSettings');
const grievanceService = require('../services/grievanceService');
const rapidApiFacebookService = require('../services/rapidApiFacebookService');
const { generateComplaintCode } = require('../services/complaintCodeService');
const {
    applyWorkflowTransition,
    inferWorkflowStatusFromLegacy,
    legacyStatusToWorkflow,
    normalizeWorkflowStatus,
    syncLegacyFieldsFromWorkflow,
    tabToWorkflowQuery,
    canConvertToFir
} = require('../services/grievanceWorkflowService');
const { createAuditLog } = require('../services/auditService');
const { logHistory } = require('../services/historyLogService');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage, districtScopeSignature } = require('../utils/scopedDistricts');
const { withTenant } = require('../utils/tenantFilter');
const cacheService = require('../services/cacheService');
const crypto = require('crypto');

// Per-tenant cap, per platform. Telangana runs ~46 Facebook pages and ~33 X handles,
// so this is configurable rather than fixed at the original 5.
const MAX_SOURCES_PER_PLATFORM = Math.max(1, Number(process.env.GRIEVANCE_MAX_SOURCES_PER_PLATFORM) || 5);
const TWILIO_ACK_XML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const invalidateGrievanceCaches = async () => {
    await cacheService.invalidatePrefix('grievances:stats:v2');
    await cacheService.invalidatePrefix('grievances:dashboard:v1');
};

const logAudit = async (req, action, resourceType, resourceId, details = null) => {
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    if (!userId || !userEmail) return;

    await createAuditLog(
        {
            id: userId,
            email: userEmail,
            full_name: req.user?.full_name || req.user?.name
        },
        action,
        resourceType,
        resourceId,
        details
    );
};

const normalizePlatform = (value, defaultValue = null) => {
    const normalizedInput = value === undefined || value === null || value === '' ? defaultValue : value;
    if (normalizedInput === null || normalizedInput === undefined) return null;
    const p = String(normalizedInput).trim().toLowerCase();
    if (p === 'fb') return 'facebook';
    return p;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSearchRegex = (value) => new RegExp(escapeRegex(String(value || '').trim()), 'i');
const normalizeTaggedAccount = (value) => String(value || '').trim().replace(/^@/, '').toLowerCase();

const toIsoStart = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
};

const toIsoEnd = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    date.setHours(23, 59, 59, 999);
    return date;
};

const normalizeComplainant = (grievance) => {
    if (grievance.platform === 'whatsapp') {
        return {
            name: grievance.posted_by?.display_name || grievance.complainant_phone || 'WhatsApp User',
            handle: grievance.complainant_phone || grievance.posted_by?.handle || '',
            phone: grievance.complainant_phone || ''
        };
    }

    return {
        name: grievance.posted_by?.display_name || grievance.posted_by?.handle || 'Unknown',
        handle: grievance.posted_by?.handle || '',
        phone: grievance.complainant_phone || ''
    };
};

const normalizeGrievanceForList = (grievanceDoc) => {
    const grievance = grievanceDoc.toObject ? grievanceDoc.toObject() : grievanceDoc;
    const workflowStatus = inferWorkflowStatusFromLegacy(grievance);
    const complainant = normalizeComplainant(grievance);
    const contentText = grievance.content?.full_text || grievance.content?.text || '';
    const sourceSummary = {
        grievance_source_id: grievance.grievance_source_id || null,
        tagged_account: grievance.tagged_account || grievance.source_ref || null
    };

    return {
        ...grievance,
        complaint_code: grievance.complaint_code || grievance.id,
        workflow_status: workflowStatus,
        complainant,
        content_text: contentText,
        escalation_count: grievance.escalation_count || 0,
        can_convert_to_fir: canConvertToFir(grievance),
        source_summary: sourceSummary
    };
};

const mapLegacyFilterStatusToTab = (filterStatus) => {
    const normalized = String(filterStatus || '').trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'escalated') return 'escalated';
    if (normalized === 'closed') return 'closed';
    if (normalized === 'fir') return 'fir';
    return normalized || 'all';
};

const buildListQuery = (params = {}, options = {}) => {
    const {
        classification,
        status,
        tagged_account,
        handle,
        platform: platformQuery,
        tab,
        filterStatus,
        status_filter,
        search,
        from,
        to,
        source_id,
        category,
        sentiment,
        risk_level,
        poster_handle
    } = params;

    const { includeTab = true } = options;

    const platform = normalizePlatform(platformQuery, 'all');
    const normalizedTab = String(tab || '').trim().toLowerCase();
    const normalizedFilterStatus = String(filterStatus || status_filter || '').trim().toLowerCase();
    const mappedFilterTab = mapLegacyFilterStatusToTab(normalizedFilterStatus);
    
    // If a specific top navbar status filter is active, it should override or merge with tab
    const finalTab = (mappedFilterTab !== 'all' && mappedFilterTab !== 'total') ? mappedFilterTab : (normalizedTab || 'all');
    const query = { is_active: true };

    if (classification) query.classification = classification;
    if (status) query['complaint.status'] = status;
    const effectiveTaggedAccount = tagged_account || handle;
    if (effectiveTaggedAccount) {
        query.tagged_account_normalized = normalizeTaggedAccount(effectiveTaggedAccount);
    }
    if (source_id && source_id !== 'all') query.grievance_source_id = source_id;

    // Who complained (drill-down from the intelligence dashboard).
    const normalizedPoster = String(poster_handle || '').trim().replace(/^@/, '');
    if (normalizedPoster) query['posted_by.handle'] = normalizedPoster;

    if (platform && platform !== 'all') {
        query.platform = platform;
    }
    if (category && category !== 'all') {
        query.$or = [
            { 'grievance_workflow.category': category },
            { 'query_workflow.category': category },
            { 'criticism.category': category },
            { 'suggestion.category': category }
        ];
    }

    // Sentiment-service results (services/sentiment grievance target).
    const normalizedSentiment = String(sentiment || '').trim().toLowerCase();
    if (['positive', 'neutral', 'negative'].includes(normalizedSentiment)) {
        query['analysis.sentiment'] = normalizedSentiment;
    }
    const normalizedRiskLevel = String(risk_level || '').trim().toLowerCase();
    if (['low', 'medium', 'high'].includes(normalizedRiskLevel)) {
        query['analysis.risk_level'] = normalizedRiskLevel;
    }

    if (includeTab) {
        const tabFilter = tabToWorkflowQuery(finalTab);
        Object.assign(query, tabFilter);
    }

    const fromDate = toIsoStart(from);
    const toDate = toIsoEnd(to);
    if (fromDate || toDate) {
        query.post_date = {};
        if (fromDate) query.post_date.$gte = fromDate;
        if (toDate) query.post_date.$lte = toDate;
    }

    if (search) {
        const textRegex = normalizeSearchRegex(search);
        const searchOr = [
            { complaint_code: textRegex },
            { 'content.text': textRegex },
            { 'content.full_text': textRegex },
            { 'posted_by.display_name': textRegex },
            { 'posted_by.handle': textRegex },
            { complainant_phone: textRegex }
        ];

        if (query.$or) {
            query.$and = [{ $or: query.$or }, { $or: searchOr }];
            delete query.$or;
        } else {
            query.$or = searchOr;
        }
    }

    return query;
};

const workflowTimestampKeys = {
    received: 'received_at',
    reviewed: 'reviewed_at',
    action_taken: 'action_taken_at',
    closed: 'closed_at',
    converted_to_fir: 'fir_converted_at'
};

const ensureWorkflowInitialized = (grievance) => {
    const status = inferWorkflowStatusFromLegacy(grievance);
    syncLegacyFieldsFromWorkflow(grievance, status);
    if (!grievance.workflow_timestamps) grievance.workflow_timestamps = {};
    const tsKey = workflowTimestampKeys[status];
    if (tsKey && !grievance.workflow_timestamps[tsKey]) {
        grievance.workflow_timestamps[tsKey] = grievance.detected_date || grievance.post_date || new Date();
    }
};

const twilioSign = (url, params, authToken) => {
    const sortedKeys = Object.keys(params || {}).sort();
    let payload = url;
    for (const key of sortedKeys) {
        payload += key + params[key];
    }
    return crypto.createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
};

const safeEqual = (left, right) => {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const validateTwilioSignature = (req) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
        const err = new Error('TWILIO_AUTH_TOKEN is not configured');
        err.code = 'TWILIO_TOKEN_MISSING';
        throw err;
    }

    const provided = req.get('x-twilio-signature');
    if (!provided) return false;

    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('host');
    const requestUrl = process.env.TWILIO_WEBHOOK_URL || `${forwardedProto}://${host}${req.originalUrl}`;
    const expected = twilioSign(requestUrl, req.body || {}, authToken);

    return safeEqual(provided, expected);
};

const toWhatsAppPhone = (raw) => String(raw || '').replace(/^whatsapp:/i, '').trim();

const buildTwilioMessageUrl = (accountSid, messageSid) => {
    if (!accountSid || !messageSid) return `whatsapp:${messageSid || 'unknown'}`;
    return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}`;
};

const extractWhatsAppMedia = (reqBody) => {
    const media = [];
    const numMedia = Number.parseInt(reqBody?.NumMedia || '0', 10);
    if (!Number.isFinite(numMedia) || numMedia <= 0) return media;

    for (let index = 0; index < numMedia; index += 1) {
        const url = reqBody[`MediaUrl${index}`];
        const type = String(reqBody[`MediaContentType${index}`] || '').toLowerCase();
        if (!url) continue;

        let normalizedType = 'photo';
        if (type.startsWith('video/')) normalizedType = 'video';
        if (type === 'image/gif') normalizedType = 'animated_gif';

        media.push({
            type: normalizedType,
            url,
            video_url: normalizedType === 'video' ? url : undefined,
            preview_url: normalizedType === 'photo' ? url : undefined,
            original_url: url
        });
    }

    return media;
};

const sendTwilioAck = (res, statusCode = 200) => {
    res.set('Content-Type', 'text/xml');
    return res.status(statusCode).send(TWILIO_ACK_XML);
};

/**
 * @desc    Get all grievance sources
 * @route   GET /api/grievances/sources
 * @access  Private
 */
const getSources = async (req, res) => {
    try {
        const platform = normalizePlatform(req.query.platform, 'all');
        const query = withTenant(req, scopedDistrictQuery(req));
        if (platform && platform !== 'all') {
            query.platform = platform;
        }

        const sources = await GrievanceSource.find(query).sort({ created_at: -1 });
        res.status(200).json(sources);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Add a new grievance source (government X account)
 * @route   POST /api/grievances/sources
 * @access  Private
 */
const addSource = async (req, res) => {
    try {
        const { handle, display_name, department, designation, contact_number, state, districts } = req.body;
        const platform = normalizePlatform(req.body.platform, 'x');

        if (!handle) {
            return res.status(400).json({ message: 'Handle/ID is required' });
        }
        if (!['x', 'facebook'].includes(platform)) {
            return res.status(400).json({ message: 'Platform must be x or facebook' });
        }

        const districtCheck = validateScopedDistricts(req, districts);
        if (!districtCheck.ok) {
            return res.status(400).json({ message: districtErrorMessage(districtCheck) });
        }

        const currentCount = await GrievanceSource.countDocuments(withTenant(req, { platform }));
        if (currentCount >= MAX_SOURCES_PER_PLATFORM) {
            return res.status(400).json({
                message: `Maximum limit of ${MAX_SOURCES_PER_PLATFORM} ${platform} accounts reached. Remove an existing account to add a new one.`
            });
        }

        // Clean handle based on platform
        let cleanHandle = handle.trim();
        if (platform === 'x') {
            cleanHandle = handle.replace('@', '').trim();
        }

        // Check if already exists (same handle AND same platform)
        const existing = await GrievanceSource.findOne(withTenant(req, {
            handle: platform === 'x'
                ? { $regex: new RegExp(`^@?${escapeRegex(cleanHandle)}$`, 'i') }
                : { $regex: new RegExp(`^${escapeRegex(cleanHandle)}$`, 'i') },
            platform
        }));

        if (existing) {
            return res.status(400).json({ message: 'This account is already added' });
        }

        let profile = null;
        let finalHandle = cleanHandle;

        if (platform === 'x') {
            // Fetch profile from X
            try {
                profile = await grievanceService.fetchUserProfile(cleanHandle);
            } catch (err) {
                console.warn(`Failed to fetch X profile for ${cleanHandle}:`, err.message);
            }
            finalHandle = `@${cleanHandle}`;
        } else if (platform === 'facebook') {
            try {
                profile = await rapidApiFacebookService.fetchPageDetails(cleanHandle);
                if (profile?.id) {
                    finalHandle = profile.id;
                }
            } catch (err) {
                console.warn(`Failed to fetch Facebook profile for ${cleanHandle}:`, err.message);
            }
        }

        const existingByFinalHandle = await GrievanceSource.findOne(withTenant(req, {
            platform,
            handle: { $regex: new RegExp(`^${escapeRegex(finalHandle)}$`, 'i') }
        }));
        if (existingByFinalHandle) {
            return res.status(400).json({ message: 'This account is already added' });
        }

        const source = new GrievanceSource({
            tenant_id: req.tenantId,
            handle: finalHandle,
            display_name: display_name || profile?.name || cleanHandle,
            profile_image_url: profile?.profileImageUrl || profile?.image,
            x_user_id: platform === 'x' ? profile?.id : undefined,
            is_verified: profile?.isVerified || profile?.is_verified || false,
            department: department || 'Government',
            designation,
            contact_number,
            platform,
            state: state || '',
            districts: districtCheck.districts,
            created_by: req.user?.id || 'system'
        });

        await source.save();

        await logAudit(req, 'CREATE', 'GRIEVANCE_SOURCE', source.id, `Added grievance source: ${finalHandle} (${platform})`);
        logHistory(req, { module: 'grievances', action: 'create', recordId: source.id, recordLabel: `${finalHandle} (${platform})`, state: source.state, districts: source.districts, changes: { handle: finalHandle, platform, department, districts: districtCheck.districts } });

        res.status(201).json(source);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Search Facebook pages to add as grievance sources
 * @route   POST /api/grievances/sources/discover-facebook
 * @access  Private
 *
 * Facebook has no @handle lookup, so pages are found by name. Each search term
 * is one provider call; results are merged, deduped and marked with whether the
 * tenant already monitors them. Nothing is saved here.
 */
const discoverFacebookSources = async (req, res) => {
    try {
        const terms = Array.isArray(req.body?.queries) ? req.body.queries : [req.body?.query];
        const cleanTerms = [...new Set(terms.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 10);
        if (!cleanTerms.length) {
            return res.status(400).json({ message: 'At least one search term is required' });
        }

        const existing = await GrievanceSource.find(withTenant(req, { platform: 'facebook' })).select('handle').lean();
        const existingHandles = new Set(existing.map((s) => String(s.handle).toLowerCase()));

        const byId = new Map();
        let failed = 0;
        for (const term of cleanTerms) {
            try {
                const pages = await rapidApiFacebookService.searchPages(term, { limit: 5 });
                for (const page of pages || []) {
                    const id = String(page?.id || '').trim();
                    if (!id) continue;
                    const hit = byId.get(id) || {
                        id,
                        name: page.name || page.title || id,
                        url: page.url || `https://facebook.com/${id}`,
                        profile_image_url: page.image || page.profileImageUrl || '',
                        verified: Boolean(page.is_verified || page.isVerified),
                        followers: Number(page.followers || page.follower_count || 0),
                        already_added: existingHandles.has(id.toLowerCase()),
                        matched_queries: [],
                    };
                    if (!hit.matched_queries.includes(term)) hit.matched_queries.push(term);
                    byId.set(id, hit);
                }
            } catch (err) {
                failed += 1;
                console.warn(`[GrievanceDiscovery] "${term}" failed: ${err.message}`);
            }
        }

        // Verified pages first, then by reach: official handles outrank parody pages.
        const candidates = [...byId.values()].sort((a, b) => (Number(b.verified) - Number(a.verified)) || (b.followers - a.followers));
        res.status(200).json({ candidates, searched: cleanTerms, partial: failed > 0 });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Add discovered Facebook pages as grievance sources
 * @route   POST /api/grievances/sources/confirm-facebook
 * @access  Private
 *
 * Takes the pages the officer ticked, with the ids discovery already resolved,
 * so confirming costs no further provider calls.
 */
const confirmFacebookSources = async (req, res) => {
    try {
        const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
        if (!pages.length) {
            return res.status(400).json({ message: 'No pages selected' });
        }

        const districtCheck = validateScopedDistricts(req, req.body?.districts);
        if (!districtCheck.ok) {
            return res.status(400).json({ message: districtErrorMessage(districtCheck) });
        }

        const added = [];
        const skipped = [];
        for (const page of pages) {
            const handle = String(page?.id || '').trim();
            if (!handle) {
                skipped.push({ page, reason: 'missing page id' });
                continue;
            }

            const count = await GrievanceSource.countDocuments(withTenant(req, { platform: 'facebook' }));
            if (count >= MAX_SOURCES_PER_PLATFORM) {
                skipped.push({ page, reason: `maximum of ${MAX_SOURCES_PER_PLATFORM} facebook accounts reached` });
                continue;
            }

            const exists = await GrievanceSource.findOne(withTenant(req, {
                platform: 'facebook',
                handle: { $regex: new RegExp(`^${escapeRegex(handle)}$`, 'i') },
            }));
            if (exists) {
                skipped.push({ page, reason: 'already added' });
                continue;
            }

            const source = new GrievanceSource({
                tenant_id: req.tenantId,
                handle,
                display_name: page.name || handle,
                profile_image_url: page.profile_image_url || '',
                is_verified: Boolean(page.verified),
                department: page.department || 'Government',
                platform: 'facebook',
                state: req.body?.state || '',
                districts: districtCheck.districts,
                created_by: req.user?.id || 'system',
            });
            await source.save();
            added.push(source);

            await logAudit(req, 'CREATE', 'GRIEVANCE_SOURCE', source.id, `Added Facebook grievance source: ${source.display_name} (${handle})`);
            logHistory(req, {
                module: 'grievances', action: 'create', recordId: source.id,
                recordLabel: `${source.display_name} (facebook)`, state: source.state, districts: source.districts,
                changes: { handle, platform: 'facebook', districts: districtCheck.districts },
            });
        }

        res.status(201).json({ added, skipped, addedCount: added.length });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Update a grievance source
 * @route   PUT /api/grievances/sources/:id
 * @access  Private
 */
const updateSource = async (req, res) => {
    try {
        const { id } = req.params;
        const { display_name, department, designation, contact_number, is_active, state, districts } = req.body;

        const source = await GrievanceSource.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!source) {
            return res.status(404).json({ message: 'Source not found' });
        }

        if (districts !== undefined) {
            const districtCheck = validateScopedDistricts(req, districts);
            if (!districtCheck.ok) {
                return res.status(400).json({ message: districtErrorMessage(districtCheck) });
            }
            source.districts = districtCheck.districts;
        }
        if (state !== undefined) source.state = state;
        if (display_name) source.display_name = display_name;
        if (department) source.department = department;
        if (designation !== undefined) source.designation = designation;
        if (contact_number !== undefined) source.contact_number = contact_number;
        if (is_active !== undefined) source.is_active = is_active;
        source.updated_by = req.user?.email || req.user?.id || '';

        await source.save();

        await logAudit(req, 'UPDATE', 'GRIEVANCE_SOURCE', source.id, `Updated grievance source: ${source.handle}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: source.id, recordLabel: source.handle, state: source.state, districts: source.districts, changes: { display_name, department, is_active, districts: source.districts } });

        res.status(200).json(source);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Delete a grievance source
 * @route   DELETE /api/grievances/sources/:id
 * @access  Private
 */
const deleteSource = async (req, res) => {
    try {
        const { id } = req.params;

        const source = await GrievanceSource.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!source) {
            return res.status(404).json({ message: 'Source not found' });
        }

        await GrievanceSource.deleteOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));

        await logAudit(req, 'DELETE', 'GRIEVANCE_SOURCE', id, `Deleted grievance source: ${source.handle}`);
        logHistory(req, { module: 'grievances', action: 'delete', recordId: id, recordLabel: source.handle, state: source.state, districts: source.districts, changes: { handle: source.handle, platform: source.platform } });

        res.status(200).json({ message: 'Source deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Fetch grievances for a specific source
 * @route   POST /api/grievances/sources/:id/fetch
 * @access  Private
 */
const fetchSourceGrievances = async (req, res) => {
    try {
        const { id } = req.params;
        const { start_date, end_date } = req.body;

        const result = await grievanceService.fetchGrievancesForSource(id, start_date, end_date, req.tenantId);
        await invalidateGrievanceCaches();

        await logAudit(
            req,
            'FETCH',
            'GRIEVANCE',
            id,
            `Fetched ${result.newGrievances} new grievances for source${start_date ? ` from ${start_date}` : ''}${end_date ? ` to ${end_date}` : ''}`
        );

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Fetch all grievances from all sources
 * @route   POST /api/grievances/fetch-all
 * @access  Private
 */
const fetchAllGrievances = async (req, res) => {
    try {
        const { start_date, end_date } = req.body;

        // Tenant-scoped: without it this sweeps every tenant's sources.
        const result = await grievanceService.fetchAllGrievances(start_date, end_date, req.tenantId);
        await invalidateGrievanceCaches();

        await logAudit(
            req,
            'FETCH',
            'GRIEVANCE',
            'all',
            `Fetched ${result.newGrievances} new grievances from all sources${start_date ? ` from ${start_date}` : ''}${end_date ? ` to ${end_date}` : ''}`
        );

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Get all grievances with filtering
 * @route   GET /api/grievances
 * @access  Private
 */
const getGrievances = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            sort = '-post_date',
            cursor
        } = req.query;

        const query = buildListQuery(req.query);
        const limitNum = parseInt(limit, 10);
        const pageNum = parseInt(page, 10);
        const skip = (pageNum - 1) * limitNum;
        const findQuery = { ...withTenant(req, scopedDistrictQuery(req)), ...query };

        // Cursor format: "<post_date_iso>|<id>"
        if (cursor) {
            const [cursorDateRaw, cursorId] = String(cursor).split('|');
            const cursorDate = new Date(cursorDateRaw);
            if (!isNaN(cursorDate.getTime()) && cursorId) {
                findQuery.$or = [
                    { post_date: { $lt: cursorDate } },
                    { post_date: cursorDate, id: { $lt: cursorId } }
                ];
            }
        }

        const grievancesRaw = await Grievance.find(findQuery)
            .sort(cursor ? { post_date: -1, id: -1 } : sort)
            .skip(cursor ? 0 : skip)
            .limit(limitNum + 1)
            .lean();

        const hasMore = grievancesRaw.length > limitNum;
        const pageRows = hasMore ? grievancesRaw.slice(0, limitNum) : grievancesRaw;
        const nextCursor = hasMore && pageRows.length > 0
            ? `${new Date(pageRows[pageRows.length - 1].post_date).toISOString()}|${pageRows[pageRows.length - 1].id}`
            : null;

        const grievances = pageRows.map(normalizeGrievanceForList);
        const total = cursor ? undefined : await Grievance.countDocuments(withTenant(req, { ...query, ...scopedDistrictQuery(req) }));

        res.status(200).json({
            grievances,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: typeof total === 'number' ? Math.ceil(total / limitNum) : undefined,
                hasMore,
                nextCursor
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Get a single grievance
 * @route   GET /api/grievances/:id
 * @access  Private
 */
const getGrievance = async (req, res) => {
    try {
        const { id } = req.params;
        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));

        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        const payload = grievance.toObject();
        payload.workflow_status = inferWorkflowStatusFromLegacy(payload);
        payload.can_convert_to_fir = canConvertToFir(payload);
        payload.complainant = normalizeComplainant(payload);
        res.status(200).json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Acknowledge a grievance (mark as non-actionable)
 * @route   PUT /api/grievances/:id/acknowledge
 * @access  Private
 */
const acknowledgeGrievance = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, notes } = req.body;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        grievance.classification = 'acknowledged';
        grievance.acknowledgment = {
            reason: reason || 'No actionable complaint',
            acknowledged_by: req.user?.id,
            acknowledged_at: new Date(),
            notes
        };
        ensureWorkflowInitialized(grievance);
        applyWorkflowTransition(grievance, 'closed', {
            userId: req.user?.id,
            note: notes || reason || 'Acknowledged by officer'
        });

        await grievance.save();
        await invalidateGrievanceCaches();

        // Update source stats
        await GrievanceSource.findOneAndUpdate(
            { id: grievance.grievance_source_id },
            { $inc: { 'stats.acknowledged': 1 } }
        );

        await logAudit(req, 'ACKNOWLEDGE', 'GRIEVANCE', id, `Acknowledged grievance: ${reason || 'No reason provided'}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { classification: 'acknowledged', reason } });

        res.status(200).json(grievance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Mark grievance as complaint (requires action)
 * @route   PUT /api/grievances/:id/complaint
 * @access  Private
 */
const markAsComplaint = async (req, res) => {
    try {
        const { id } = req.params;
        const { priority, category, notes } = req.body;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        grievance.classification = 'complaint';
        grievance.complaint = {
            ...grievance.complaint,
            priority: priority || 'medium',
            status: 'pending',
            category,
            notes
        };
        ensureWorkflowInitialized(grievance);
        applyWorkflowTransition(grievance, 'reviewed', {
            userId: req.user?.id,
            note: notes || `Marked as complaint (${priority || 'medium'})`
        });

        await grievance.save();
        await invalidateGrievanceCaches();

        // Update source stats
        await GrievanceSource.findOneAndUpdate(
            { id: grievance.grievance_source_id },
            {
                $inc: {
                    'stats.complaints': 1,
                    'stats.pending': 1
                }
            }
        );

        await logAudit(req, 'MARK_COMPLAINT', 'GRIEVANCE', id, `Marked as complaint with priority: ${priority || 'medium'}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { classification: 'complaint', priority, category } });

        res.status(200).json(grievance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Update complaint status
 * @route   PUT /api/grievances/:id/status
 * @access  Private
 */
const updateComplaintStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, action_taken, notes } = req.body;

        const validStatuses = ['pending', 'sent', 'reviewed', 'case_booked'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        if (grievance.classification !== 'complaint') {
            return res.status(400).json({ message: 'Only complaints can have status updates' });
        }

        ensureWorkflowInitialized(grievance);
        const oldStatus = grievance.complaint.status;
        grievance.complaint.status = status;
        if (action_taken) grievance.complaint.action_taken = action_taken;
        if (notes) grievance.complaint.notes = notes;
        grievance.complaint.action_taken_by = req.user?.id;
        grievance.complaint.action_taken_at = new Date();

        const workflowByLegacyStatus = {
            pending: 'reviewed',
            sent: 'action_taken',
            reviewed: 'closed',
            case_booked: 'converted_to_fir'
        };
        const targetWorkflow = workflowByLegacyStatus[status] || legacyStatusToWorkflow(status);
        applyWorkflowTransition(grievance, targetWorkflow, {
            userId: req.user?.id,
            note: notes || action_taken || `Updated via legacy complaint status: ${status}`
        });

        await grievance.save();
        await invalidateGrievanceCaches();

        // Update source stats
        const updateObj = {};
        if (oldStatus) updateObj[`stats.${oldStatus}`] = -1;
        updateObj[`stats.${status === 'case_booked' ? 'resolved' : status}`] = 1;

        await GrievanceSource.findOneAndUpdate(
            { id: grievance.grievance_source_id },
            { $inc: updateObj }
        );

        await logAudit(req, 'UPDATE_STATUS', 'GRIEVANCE', id, `Updated status from ${oldStatus} to ${status}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { status, action_taken } });

        res.status(200).json(grievance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Update grievance workflow status (canonical workflow endpoint)
 * @route   PUT /api/grievances/:id/workflow
 * @access  Private
 */
const updateWorkflowStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { workflow_status: workflowStatusInput, note } = req.body;
        const workflowStatus = normalizeWorkflowStatus(workflowStatusInput);

        if (!workflowStatus) {
            return res.status(400).json({ message: 'Invalid workflow_status' });
        }

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        ensureWorkflowInitialized(grievance);

        try {
            applyWorkflowTransition(grievance, workflowStatus, {
                userId: req.user?.id,
                note: note || `Workflow updated to ${workflowStatus}`
            });
        } catch (transitionError) {
            if (transitionError.code === 'INVALID_WORKFLOW_TRANSITION' || transitionError.code === 'INVALID_WORKFLOW_STATUS') {
                return res.status(400).json({ message: transitionError.message });
            }
            throw transitionError;
        }

        await grievance.save();
        await invalidateGrievanceCaches();
        await logAudit(req, 'UPDATE_WORKFLOW', 'GRIEVANCE', id, `Workflow updated to ${workflowStatus}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { workflow_status: workflowStatus, note } });

        res.status(200).json(normalizeGrievanceForList(grievance));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Convert grievance to FIR
 * @route   POST /api/grievances/:id/convert-to-fir
 * @access  Private
 */
const convertToFir = async (req, res) => {
    try {
        const { id } = req.params;
        const { note, fir_number: firNumberInput } = req.body;
        const firNumber = firNumberInput ? String(firNumberInput).trim() : undefined;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        ensureWorkflowInitialized(grievance);
        if (!canConvertToFir(grievance)) {
            return res.status(400).json({ message: 'Grievance is already converted to FIR' });
        }

        try {
            applyWorkflowTransition(grievance, 'converted_to_fir', {
                userId: req.user?.id,
                note: note || 'Converted to FIR',
                firNumber
            });
        } catch (transitionError) {
            if (transitionError.code === 'INVALID_WORKFLOW_TRANSITION') {
                return res.status(400).json({ message: transitionError.message });
            }
            throw transitionError;
        }

        if (firNumber) grievance.fir_number = firNumber;

        await grievance.save();
        await invalidateGrievanceCaches();
        await logAudit(
            req,
            'CONVERT_TO_FIR',
            'GRIEVANCE',
            id,
            `Converted grievance to FIR${firNumber ? ` (${firNumber})` : ''}`
        );
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { workflow_status: 'converted_to_fir', fir_number: firNumber } });

        res.status(200).json(normalizeGrievanceForList(grievance));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Escalate grievance
 * @route   POST /api/grievances/:id/escalate
 * @access  Private
 */
const escalateGrievance = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, note } = req.body;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        grievance.escalation_count = (grievance.escalation_count || 0) + 1;
        grievance.escalation_history = grievance.escalation_history || [];
        grievance.escalation_history.push({
            reason: reason || 'Manual escalation',
            note,
            by: req.user?.id,
            at: new Date()
        });

        await grievance.save();
        await invalidateGrievanceCaches();
        await logAudit(req, 'ESCALATE', 'GRIEVANCE', id, reason || 'Manual escalation');
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { escalation_count: grievance.escalation_count, reason } });

        res.status(200).json({
            id: grievance.id,
            escalation_count: grievance.escalation_count,
            escalation_history: grievance.escalation_history,
            workflow_status: inferWorkflowStatusFromLegacy(grievance)
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Public Twilio WhatsApp webhook for grievance intake
 * @route   POST /api/grievances/whatsapp/webhook
 * @access  Public (signature protected)
 */
const ingestWhatsAppWebhook = async (req, res) => {
    try {
        const validSignature = validateTwilioSignature(req);
        if (!validSignature) {
            return res.status(403).json({ message: 'Invalid Twilio signature' });
        }

        const messageSid = String(req.body?.MessageSid || '').trim();
        if (!messageSid) {
            return res.status(400).json({ message: 'MessageSid is required' });
        }

        // Idempotency check is intentionally NOT tenant-scoped: this is an inbound
        // Twilio webhook (no authenticated tenant context), and MessageSid is a
        // globally-unique Twilio identifier, so a global dedup is correct here.
        // The grievance itself is tenant-tagged below via the resolved grievance source.
        const existing = await Grievance.findOne({ whatsapp_message_sid: messageSid });
        if (existing) {
            return sendTwilioAck(res, 200);
        }

        const fromPhone = toWhatsAppPhone(req.body?.From);
        const toPhone = toWhatsAppPhone(req.body?.To);
        const accountSid = String(req.body?.AccountSid || '').trim();
        const profileName = String(req.body?.ProfileName || '').trim();
        const bodyText = String(req.body?.Body || '').trim();
        const media = extractWhatsAppMedia(req.body);
        const contentText = bodyText || (media.length > 0 ? '[Media attachment]' : '[Empty message]');
        const now = new Date();

        const grievance = new Grievance({
            complaint_code: await generateComplaintCode(),
            tweet_id: `whatsapp:${messageSid}`,
            tagged_account: toPhone || 'whatsapp',
            platform: 'whatsapp',
            complainant_phone: fromPhone || undefined,
            source_ref: toPhone || req.body?.MessagingServiceSid || 'whatsapp',
            whatsapp_message_sid: messageSid,
            posted_by: {
                handle: fromPhone || `whatsapp_user_${messageSid.slice(-6)}`,
                display_name: profileName || fromPhone || 'WhatsApp User',
                profile_image_url: '',
                is_verified: false,
                follower_count: 0
            },
            content: {
                text: contentText,
                full_text: contentText,
                media
            },
            tweet_url: buildTwilioMessageUrl(accountSid, messageSid),
            engagement: {
                likes: 0,
                retweets: 0,
                replies: 0,
                views: 0,
                quotes: 0
            },
            post_date: now,
            detected_date: now,
            workflow_status: 'received',
            workflow_timestamps: {
                received_at: now
            },
            escalation_count: 0
        });

        syncLegacyFieldsFromWorkflow(grievance, 'received');

        try {
            await grievance.save();
            // Created pending; start this tenant's analysis run now.
            require('../services/sentiment').kick();
            await invalidateGrievanceCaches();
        } catch (saveError) {
            // Dedupe on concurrent webhook retries.
            if (saveError?.code === 11000) {
                return sendTwilioAck(res, 200);
            }
            throw saveError;
        }

        console.info(`[GrievanceWebhook] Ingested WhatsApp grievance ${grievance.id} (${messageSid})`);
        return sendTwilioAck(res, 200);
    } catch (error) {
        if (error.code === 'TWILIO_TOKEN_MISSING') {
            return res.status(500).json({ message: error.message });
        }
        console.error('[GrievanceWebhook] Failed to ingest WhatsApp message:', error.message);
        return res.status(500).json({ message: 'Failed to process webhook' });
    }
};

/**
 * @desc    Generate PDF report for a complaint
 * @route   GET /api/grievances/:id/report
 * @access  Private
 */
const generateReport = async (req, res) => {
    try {
        const { id } = req.params;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        if (grievance.classification !== 'complaint') {
            return res.status(400).json({ message: 'Reports can only be generated for complaints' });
        }

        const { buffer, filename, reportNumber } = await grievanceService.generatePDFReport(id, req.tenantId);

        await logAudit(req, 'GENERATE_REPORT', 'GRIEVANCE', id, `Generated PDF report: ${reportNumber}`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Record sharing of report
 * @route   POST /api/grievances/:id/share
 * @access  Private
 */
const recordShare = async (req, res) => {
    try {
        const { id } = req.params;
        const { contact_number, method } = req.body;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        if (!grievance.complaint.shared_with) {
            grievance.complaint.shared_with = [];
        }

        grievance.complaint.shared_with.push({
            contact_number,
            shared_at: new Date(),
            shared_by: req.user?.id,
            method: method || 'whatsapp'
        });

        await grievance.save();
        await invalidateGrievanceCaches();

        await logAudit(req, 'SHARE_REPORT', 'GRIEVANCE', id, `Shared report via ${method} to ${contact_number}`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { shared_via: method, contact_number } });

        res.status(200).json(grievance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Get grievance statistics
 * @route   GET /api/grievances/stats
 * @access  Private
 */
const getStats = async (req, res) => {
    try {
        const cacheKey = `grievances:stats:v2:tenant=${req.tenantId}:scope=${districtScopeSignature(req)}:${JSON.stringify(req.query || {})}`;
        const cached = await cacheService.get(cacheKey);
        if (cached) return res.status(200).json(cached);

        const baseQuery = buildListQuery(req.query, { includeTab: false });

        const [facetRows, activeSources] = await Promise.all([
            Grievance.aggregate([
                { $match: withTenant(req, { ...baseQuery, ...scopedDistrictQuery(req) }) },
                {
                    $facet: {
                        total: [{ $count: 'count' }],
                        workflow: [{ $group: { _id: '$workflow_status', count: { $sum: 1 } } }],
                        gWorkflow: [{ $group: { _id: '$grievance_workflow.status', count: { $sum: 1 } } }],
                        classification: [{ $group: { _id: '$classification', count: { $sum: 1 } } }],
                        complaintStatus: [
                            { $match: { classification: 'complaint' } },
                            { $group: { _id: '$complaint.status', count: { $sum: 1 } } }
                        ],
                        byCategory: [
                            {
                                $project: {
                                    cat: {
                                        $setUnion: [
                                            { $cond: [{ $ifNull: ['$grievance_workflow.category', false] }, ['$grievance_workflow.category'], []] },
                                            { $cond: [{ $ifNull: ['$query_workflow.category', false] }, ['$query_workflow.category'], []] },
                                            { $cond: [{ $ifNull: ['$criticism.category', false] }, ['$criticism.category'], []] },
                                            { $cond: [{ $ifNull: ['$suggestion.category', false] }, ['$suggestion.category'], []] }
                                        ]
                                    }
                                }
                            },
                            { $unwind: '$cat' },
                            { $group: { _id: '$cat', count: { $sum: 1 } } }
                        ]
                    }
                }
            ]),
            GrievanceSource.countDocuments(withTenant(req, {
                is_active: true,
                ...scopedDistrictQuery(req),
                ...(req.query.platform && req.query.platform !== 'all' ? { platform: normalizePlatform(req.query.platform) } : {})
            }))
        ]);

        const facet = facetRows[0] || {};
        const total = facet.total?.[0]?.count || 0;
        const workflowMap = Object.fromEntries((facet.workflow || []).map((i) => [i._id || 'received', i.count]));
        const gWorkflowMap = Object.fromEntries((facet.gWorkflow || []).map((i) => [i._id, i.count]));
        const classMap = Object.fromEntries((facet.classification || []).map((i) => [i._id, i.count]));
        const complaintStatusMap = Object.fromEntries((facet.complaintStatus || []).map((i) => [i._id, i.count]));

        // Count pending: G-workflow PENDING + those without G-workflow that are in legacy pending states
        const gPending = gWorkflowMap['PENDING'] || 0;
        const gEscalated = gWorkflowMap['ESCALATED'] || 0;
        const gClosed = gWorkflowMap['CLOSED'] || 0;
        // Grievances that have no G-workflow status (null/undefined key in gWorkflowMap)
        const noGWorkflowCount = gWorkflowMap[null] || gWorkflowMap[undefined] || gWorkflowMap['null'] || 0;
        // Legacy counts for grievances without G-workflow
        const legacyClosed = workflowMap.closed || 0;
        const legacyFir = workflowMap.converted_to_fir || 0;
        // Legacy pending = those without G-workflow minus legacy closed & fir
        const legacyPending = Math.max(0, noGWorkflowCount - legacyClosed - legacyFir);

        const payload = {
            total,
            total_complaints: total,
            pending: gPending + legacyPending,
            escalated: gEscalated,
            closed: gClosed + legacyClosed,
            converted_to_fir: legacyFir,
            unclassified: classMap.unclassified || 0,
            acknowledged: classMap.acknowledged || 0,
            complaints: classMap.complaint || 0,
            byStatus: {
                pending: complaintStatusMap.pending || 0,
                sent: complaintStatusMap.sent || 0,
                reviewed: complaintStatusMap.reviewed || 0,
                case_booked: complaintStatusMap.case_booked || 0
            },
            byCategory: Object.fromEntries((facet.byCategory || []).map(i => [i._id, i.count])),
            activeSources
        };

        await cacheService.set(cacheKey, payload, 20);
        res.status(200).json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getDashboardStats = async (req, res) => {
    try {
        const cacheKey = `grievances:dashboard:v1:tenant=${req.tenantId}:scope=${districtScopeSignature(req)}`;
        const cached = await cacheService.get(cacheKey);
        if (cached) return res.status(200).json(cached);

        const rows = await Grievance.aggregate([
            { $match: { ...withTenant(req, scopedDistrictQuery(req)), is_active: true } },
            {
                $group: {
                    _id: '$platform',
                    total: { $sum: 1 },
                    resolved: {
                        $sum: {
                            $cond: [{ $eq: ['$workflow_status', 'closed'] }, 1, 0]
                        }
                    },
                    pending: {
                        $sum: {
                            $cond: [{ $in: ['$workflow_status', ['received', 'reviewed', 'action_taken']] }, 1, 0]
                        }
                    }
                }
            }
        ]);

        const byPlatform = { all: { total: 0, pending: 0, resolved: 0 }, x: { total: 0, pending: 0, resolved: 0 }, facebook: { total: 0, pending: 0, resolved: 0 }, whatsapp: { total: 0, pending: 0, resolved: 0 } };
        rows.forEach((r) => {
            const p = r._id || 'x';
            if (!byPlatform[p]) byPlatform[p] = { total: 0, pending: 0, resolved: 0 };
            byPlatform[p].total += r.total || 0;
            byPlatform[p].pending += r.pending || 0;
            byPlatform[p].resolved += r.resolved || 0;
            byPlatform.all.total += r.total || 0;
            byPlatform.all.pending += r.pending || 0;
            byPlatform.all.resolved += r.resolved || 0;
        });

        const payload = {
            byPlatform,
            totals: {
                total: byPlatform.all.total,
                pending: byPlatform.all.pending,
                resolved: byPlatform.all.resolved
            }
        };
        await cacheService.set(cacheKey, payload, 20);
        res.status(200).json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Get grievance settings
 * @route   GET /api/grievances/settings
 * @access  Private
 */
const getSettings = async (req, res) => {
    try {
        let settings = await GrievanceSettings.findOne(withTenant(req));
        if (!settings) {
            settings = await GrievanceSettings.create({ tenant_id: req.tenantId });
        }
        res.status(200).json(settings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Update grievance settings
 * @route   PUT /api/grievances/settings
 * @access  Private
 */
const updateSettings = async (req, res) => {
    try {
        const updates = req.body;
        updates.updated_by = req.user?.id;

        // Never let the request body reassign tenant/identity ownership.
        delete updates.tenant_id;
        delete updates._id;
        delete updates.id;

        // The filter's tenant_id is auto-applied to the document on upsert/insert.
        let settings = await GrievanceSettings.findOneAndUpdate(
            withTenant(req),
            updates,
            { new: true, upsert: true }
        );

        await logAudit(req, 'UPDATE', 'GRIEVANCE_SETTINGS', 'grievance_settings', 'Updated grievance settings');

        res.status(200).json(settings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Revert grievance to unclassified
 * @route   PUT /api/grievances/:id/revert
 * @access  Private
 */
const revertGrievance = async (req, res) => {
    try {
        const { id } = req.params;

        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        const previousClassification = grievance.classification;
        const previousWorkflow = inferWorkflowStatusFromLegacy(grievance);
        grievance.classification = 'unclassified';
        grievance.acknowledgment = {};
        grievance.complaint = {
            priority: 'medium',
            status: 'pending',
            shared_with: []
        };
        syncLegacyFieldsFromWorkflow(grievance, 'received');
        grievance.workflow_timestamps = grievance.workflow_timestamps || {};
        grievance.workflow_timestamps.received_at = grievance.workflow_timestamps.received_at || new Date();
        grievance.workflow_history = grievance.workflow_history || [];
        grievance.workflow_history.push({
            from: previousWorkflow,
            to: 'received',
            at: new Date(),
            by: req.user?.id,
            note: 'Reverted grievance to received'
        });

        await grievance.save();
        await invalidateGrievanceCaches();

        await logAudit(req, 'REVERT', 'GRIEVANCE', id, `Reverted grievance from ${previousClassification} to unclassified`);
        logHistory(req, { module: 'grievances', action: 'update', recordId: id, recordLabel: grievance.complaint_code || id, state: grievance.state, districts: grievance.districts, changes: { classification: 'unclassified', previous: previousClassification } });

        res.status(200).json(grievance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc    Enrich grievance context by re-fetching missing parent / quoted tweet content
 * @route   POST /api/grievances/:id/enrich-context
 * @access  Private
 *
 * When a grievance is a reply to another tweet but the backend wasn't able to
 * fetch the parent tweet at scrape time, the stored context.in_reply_to (or
 * context.quoted) object contains just the tweet_id/url and author handle with
 * empty content.  This endpoint re-attempts to fetch the missing tweet(s) via
 * the RapidAPI provider and persists the enriched data.
 */
const enrichGrievanceContext = async (req, res) => {
    try {
        const { id } = req.params;
        const grievance = await Grievance.findOne(withTenant(req, { id, ...scopedDistrictQuery(req) }));
        if (!grievance) {
            return res.status(404).json({ message: 'Grievance not found' });
        }

        if (grievance.platform !== 'x') {
            // Only X/Twitter grievances have refetchable tweet context
            return res.status(200).json(grievance.toObject());
        }

        const ctx = grievance.context || {};
        let updated = false;

        // Helper: determine if a context node has empty/missing text
        const needsFetch = (node) => {
            if (!node || !node.tweet_id) return false;
            const text = node.content?.text || node.content?.full_text || '';
            return text.trim().length === 0;
        };

        // Re-fetch missing in_reply_to content
        if (needsFetch(ctx.in_reply_to)) {
            try {
                const parentHandle = ctx.in_reply_to.posted_by?.handle || null;
                const snapshot = await grievanceService.fetchTweetById(ctx.in_reply_to.tweet_id, null, parentHandle);
                if (snapshot && (snapshot.content?.text || snapshot.content?.full_text)) {
                    grievance.context.in_reply_to = {
                        ...ctx.in_reply_to.toObject ? ctx.in_reply_to.toObject() : ctx.in_reply_to,
                        ...snapshot
                    };
                    updated = true;
                }
            } catch (e) {
                console.error(`[enrichGrievanceContext] Failed to fetch in_reply_to ${ctx.in_reply_to.tweet_id}:`, e.message);
            }
        }

        // Re-fetch missing quoted content
        if (needsFetch(ctx.quoted)) {
            try {
                const quotedHandle = ctx.quoted.posted_by?.handle || null;
                const snapshot = await grievanceService.fetchTweetById(ctx.quoted.tweet_id, null, quotedHandle);
                if (snapshot && (snapshot.content?.text || snapshot.content?.full_text)) {
                    grievance.context.quoted = {
                        ...ctx.quoted.toObject ? ctx.quoted.toObject() : ctx.quoted,
                        ...snapshot
                    };
                    updated = true;
                }
            } catch (e) {
                console.error(`[enrichGrievanceContext] Failed to fetch quoted ${ctx.quoted.tweet_id}:`, e.message);
            }
        }

        // Re-fetch missing reposted_from content
        if (needsFetch(ctx.reposted_from)) {
            try {
                const repostHandle = ctx.reposted_from.posted_by?.handle || null;
                const snapshot = await grievanceService.fetchTweetById(ctx.reposted_from.tweet_id, null, repostHandle);
                if (snapshot && (snapshot.content?.text || snapshot.content?.full_text)) {
                    grievance.context.reposted_from = {
                        ...ctx.reposted_from.toObject ? ctx.reposted_from.toObject() : ctx.reposted_from,
                        ...snapshot
                    };
                    updated = true;
                }
            } catch (e) {
                console.error(`[enrichGrievanceContext] Failed to fetch reposted_from ${ctx.reposted_from.tweet_id}:`, e.message);
            }
        }

        // Build/refresh full parent reply chain so UI can render complete thread history.
        const replySeed = grievance.context?.in_reply_to || ctx.in_reply_to;
        if (replySeed?.tweet_id) {
            try {
                const threadChain = await grievanceService.buildReplyThreadChain(replySeed, null, 8);
                if (threadChain.length > 0) {
                    grievance.context.thread_chain = threadChain;
                    grievance.context.thread_parent = threadChain[threadChain.length - 1];
                    updated = true;
                }
            } catch (e) {
                console.error(`[enrichGrievanceContext] Failed to build thread chain for ${replySeed.tweet_id}:`, e.message);
            }
        }

        // Re-enrich individual thread_chain nodes that still have empty content
        const chain = grievance.context?.thread_chain;
        if (Array.isArray(chain)) {
            for (let i = 0; i < chain.length; i++) {
                if (needsFetch(chain[i])) {
                    try {
                        const nodeHandle = chain[i].posted_by?.handle || null;
                        const snapshot = await grievanceService.fetchTweetById(chain[i].tweet_id, null, nodeHandle);
                        if (snapshot && (snapshot.content?.text || snapshot.content?.full_text)) {
                            chain[i] = {
                                ...(chain[i].toObject ? chain[i].toObject() : chain[i]),
                                ...snapshot
                            };
                            updated = true;
                        }
                    } catch (e) {
                        console.error(`[enrichGrievanceContext] Failed to re-enrich thread_chain node ${chain[i].tweet_id}:`, e.message);
                    }
                }
            }
            if (chain.length > 0) {
                grievance.context.thread_parent = chain[chain.length - 1];
            }
        }

        if (updated) {
            grievance.markModified('context');
            await grievance.save();
        }

        const payload = grievance.toObject();
        payload.workflow_status = inferWorkflowStatusFromLegacy(payload);
        payload.can_convert_to_fir = canConvertToFir(payload);
        res.status(200).json({ enriched: updated, grievance: payload });
    } catch (error) {
        console.error('[enrichGrievanceContext] Error:', error);
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getSources,
    addSource,
    discoverFacebookSources,
    confirmFacebookSources,
    updateSource,
    deleteSource,
    fetchSourceGrievances,
    fetchAllGrievances,
    getGrievances,
    getGrievance,
    acknowledgeGrievance,
    markAsComplaint,
    updateComplaintStatus,
    updateWorkflowStatus,
    convertToFir,
    escalateGrievance,
    ingestWhatsAppWebhook,
    generateReport,
    recordShare,
    getStats,
    getDashboardStats,
    getSettings,
    updateSettings,
    revertGrievance,
    enrichGrievanceContext
};
