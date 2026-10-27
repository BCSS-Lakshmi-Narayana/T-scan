const POI = require('../models/POI');
const Source = require('../models/Source');
const mongoose = require('mongoose');
const { resolvePlatformIdentity } = require('../services/platformIdentityService');
const { withTenant } = require('../utils/tenantFilter');
const { validateScopedDistricts, scopedDistrictQuery, districtErrorMessage } = require('../utils/scopedDistricts');

const PROFILE_PLATFORMS = ['x', 'facebook', 'instagram', 'youtube', ];
const SOURCE_SYNC_PLATFORMS = new Set(['x', 'facebook', 'instagram', 'youtube']);

const normalizePlatform = (platform = '') => {
    const p = String(platform || '').toLowerCase().trim();
    return p === 'twitter' ? 'x' : p;
};

const normalizeIdentifier = (platform, identifier) => {
    const p = normalizePlatform(platform);
    let id = String(identifier || '').trim();
    if (!id) return '';

    if (p === 'x') return id.replace(/^@/, '').toLowerCase();
    if (p === 'instagram') return id.replace(/^@/, '').toLowerCase();
    if (p === 'youtube') {
        if (/^UC[A-Za-z0-9_-]{20,}$/.test(id)) return id;
        return id.toLowerCase();
    }
    if (p === 'facebook') return id;

    return id;
};

const findSourceByAnyId = async (sourceId, req) => {
    const raw = String(sourceId || '').trim();
    if (!raw) return null;

    const orQuery = [{ id: raw }];
    if (mongoose.Types.ObjectId.isValid(raw)) {
        orQuery.push({ _id: raw });
    }

    return Source.findOne(withTenant(req, { $or: orQuery }));
};

// GET /api/poi — List all POIs
const getAllPOIs = async (req, res) => {
    try {
        const { status, search, platform, minLinkedPlatforms, district, page = 1, limit = 50 } = req.query;

        const filter = { ...withTenant(req), ...scopedDistrictQuery(req) };
        if (district && district !== 'all') {
            if (req.user?.role !== 'admin' && !(req.user?.districts || []).includes(district)) {
                return res.status(403).json({ message: 'District not assigned to you' });
            }
            filter.districts = district;
        }
        if (status) {
            filter.status = status;
        }
        if (platform) {
            filter['socialMedia.platform'] = { $regex: new RegExp(`^${platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
        }
        if (minLinkedPlatforms) {
            const min = parseInt(minLinkedPlatforms, 10);
            if (min > 0) {
                filter.$expr = { $gte: [{ $size: { $ifNull: ['$socialMedia', []] } }, min] };
            }
        }
        if (search) {
            const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const normalizedSearch = escapedSearch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
            const searchRegex = { $regex: escapedSearch, $options: 'i' };
            const normalizedRegex = { $regex: normalizedSearch, $options: 'i' };
            filter.$or = [
                { name: searchRegex },
                { realName: searchRegex },
                { aliasNames: searchRegex },
                { mobileNumbers: searchRegex },
                { emailIds: searchRegex },
                { whatsappNumbers: searchRegex },
                { lastUsedIp: searchRegex },
                { softwareHardwareIdentifiers: searchRegex },
                { currentAddress: searchRegex },
                { psLimits: searchRegex },
                { districtCommisionerate: searchRegex },
                { firNo: searchRegex },
                { linkedIncidents: searchRegex },
                { briefSummary: searchRegex },
                { 'firDetails.firNo': searchRegex },
                { 'firDetails.psLimits': searchRegex },
                { 'firDetails.districtCommisionerate': searchRegex },
                { 'socialMedia.handle': searchRegex },
                { 'socialMedia.displayName': searchRegex },
                { 'socialMedia.displayNameNormalized': normalizedRegex },
                { 'socialMedia.followerCount': searchRegex },
                { 'socialMedia.createdDate': searchRegex },
                { 'previouslyDeletedProfiles.x': searchRegex },
                { 'previouslyDeletedProfiles.facebook': searchRegex },
                { 'previouslyDeletedProfiles.instagram': searchRegex },
                { 'previouslyDeletedProfiles.youtube': searchRegex },
                { 'previouslyDeletedProfiles.whatsapp': searchRegex },
                { 'customFields.value': searchRegex }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [pois, total] = await Promise.all([
            POI.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            POI.countDocuments(filter)
        ]);

        res.json({
            pois,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (error) {
        console.error('[POI] Error fetching POIs:', error.message);
        res.status(500).json({ message: 'Failed to fetch persons of interest', error: error.message });
    }
};

// GET /api/poi/:id — Get single POI
const getPOIById = async (req, res) => {
    try {
        const poi = await POI.findOne(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) })).lean();
        if (!poi) {
            return res.status(404).json({ message: 'Person of interest not found' });
        }
        res.json(poi);
    } catch (error) {
        console.error('[POI] Error fetching POI:', error.message);
        res.status(500).json({ message: 'Failed to fetch person of interest', error: error.message });
    }
};

// POST /api/poi — Create new POI
const createPOI = async (req, res) => {
    try {
        const {
            name, realName, aliasNames, mobileNumbers, emailIds, whatsappNumbers,
            lastUsedIp, currentAddress, psLimits, districtCommisionerate,
            softwareHardwareIdentifiers, firNo, firDetails, linkedIncidents,
            previouslyDeletedProfiles, socialMedia,
            briefSummary, profileImage, customFields, status
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }

        if (socialMedia && Array.isArray(socialMedia)) {
            const invalidSocial = socialMedia.find((sm) => {
                const p = normalizePlatform(sm?.platform);
                const h = String(sm?.handle || '').trim();
                const dn = String(sm?.displayName || sm?.display_name || '').trim();
                if (!p) return true;
                if (SOURCE_SYNC_PLATFORMS.has(p) && !h) return true;
                if (!dn) return true;
                return false;
            });

            if (invalidSocial) {
                return res.status(400).json({ message: 'Each social profile must include platform, handle, and display name' });
            }
        }

        const poi = await POI.create({
            tenant_id: req.tenantId,
            name: name.trim(),
            realName: realName || '',
            aliasNames: aliasNames || [],
            mobileNumbers: mobileNumbers || [],
            emailIds: emailIds || [],
            whatsappNumbers: whatsappNumbers || [],
            lastUsedIp: lastUsedIp || '',
            currentAddress: currentAddress || '',
            psLimits: psLimits || '',
            districtCommisionerate: districtCommisionerate || '',
            softwareHardwareIdentifiers: softwareHardwareIdentifiers || '',
            firNo: firNo || '',
            firDetails: firDetails || [],
            linkedIncidents: linkedIncidents || '',
            previouslyDeletedProfiles: previouslyDeletedProfiles || {},
            socialMedia: socialMedia || [],
            briefSummary: briefSummary || '',
            profileImage: profileImage || '',
            customFields: customFields || [],
            status: status || 'active',
            createdBy: req.body.createdBy || 'system'
        });

        // Keep Source collection synchronized when POI is created with social media rows.
        if (Array.isArray(poi.socialMedia) && poi.socialMedia.length > 0) {
            let changed = false;
            const syncedRows = [];

            for (const smRaw of poi.socialMedia) {
                const sm = smRaw.toObject ? smRaw.toObject() : { ...smRaw };
                const platform = normalizePlatform(sm.platform);
                const handle = String(sm.handle || '').trim();
                const displayName = String(sm.displayName || sm.display_name || '').trim();

                if (!SOURCE_SYNC_PLATFORMS.has(platform) || !handle || !displayName) {
                    syncedRows.push(sm);
                    continue;
                }

                const normalizedHandle = normalizeIdentifier(platform, handle);
                const identity = await resolvePlatformIdentity(platform, normalizedHandle);
                const resolvedHandle = normalizeIdentifier(platform, identity?.normalizedIdentifier || normalizedHandle);
                const resolvedUserId = String(identity?.platformUserId || sm.platformUserId || '').trim();
                const resolvedDisplayName = String(identity?.resolvedDisplayName || displayName || resolvedHandle).trim();

                let source = null;
                if (sm.sourceId) {
                    source = await findSourceByAnyId(sm.sourceId, req);
                }
                if (!source && resolvedUserId) {
                    source = await Source.findOne(withTenant(req, { platform, platform_user_id: resolvedUserId }));
                }
                if (!source) {
                    source = await Source.findOne(withTenant(req, { platform, identifier: resolvedHandle }));
                }

                if (source) {
                    source.identifier = resolvedHandle;
                    source.display_name = resolvedDisplayName;
                    source.platform_user_id = resolvedUserId;
                    source.category = String(sm.category || source.category || 'others').toLowerCase();
                    source.priority = sm.priority || source.priority || 'medium';
                    source.is_active = sm.is_active !== false;
                    source.follower_count = sm.followerCount !== undefined ? String(sm.followerCount || '') : (source.follower_count || '');
                    source.joined_date = sm.createdDate !== undefined ? String(sm.createdDate || '') : (source.joined_date || '');
                    if (identity?.profileImageUrl) source.profile_image_url = identity.profileImageUrl;
                    await source.save();
                } else {
                    source = await Source.create({
                        tenant_id: req.tenantId,
                        platform,
                        identifier: resolvedHandle,
                        platform_user_id: resolvedUserId,
                        display_name: resolvedDisplayName,
                        category: String(sm.category || 'others').toLowerCase(),
                        priority: sm.priority || 'medium',
                        is_active: sm.is_active !== false,
                        follower_count: sm.followerCount !== undefined ? String(sm.followerCount || '') : '',
                        joined_date: sm.createdDate !== undefined ? String(sm.createdDate || '') : '',
                        profile_image_url: identity?.profileImageUrl || sm.profileImage || undefined,
                        is_verified: identity?.isVerified === true,
                        created_by: req.user?.id || 'system'
                    });
                }

                syncedRows.push({
                    ...sm,
                    platform,
                    sourceId: source.id,
                    platformUserId: source.platform_user_id || resolvedUserId,
                    handle: source.identifier,
                    displayName: source.display_name,
                    category: source.category,
                    priority: source.priority,
                    is_active: sm.is_active !== false,
                    followerCount: sm.followerCount !== undefined ? sm.followerCount : (source.follower_count || ''),
                    createdDate: sm.createdDate !== undefined ? sm.createdDate : (source.joined_date || ''),
                    profileImage: identity?.profileImageUrl || sm.profileImage || ''
                });
                changed = true;
            }

            if (changed) {
                poi.socialMedia = syncedRows;
                await poi.save();
            }
        }

        res.status(201).json(poi);
    } catch (error) {
        console.error('[POI] Error creating POI:', error.message);
        res.status(500).json({ message: 'Failed to create person of interest', error: error.message });
    }
};

// PUT /api/poi/:id — Update POI
const updatePOI = async (req, res) => {
    try {
        // Fetch old POI to detect is_active changes and skip unchanged handles
        const oldPoi = await POI.findOne(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) })).lean();

        // Build lookup of old social media by platform+handle to skip API calls for unchanged rows
        const oldSmMap = {};
        if (oldPoi?.socialMedia) {
            for (const sm of oldPoi.socialMedia) {
                if (sm.platform && sm.handle) {
                    const key = `${String(sm.platform).toLowerCase()}::${String(sm.handle).toLowerCase()}`;
                    oldSmMap[key] = sm;
                }
            }
        }

        const nextBody = { ...req.body };

        if (nextBody.districts !== undefined) {
            const districtCheck = validateScopedDistricts(req, nextBody.districts);
            if (!districtCheck.ok) {
                return res.status(400).json({ message: districtErrorMessage(districtCheck) });
            }
            nextBody.districts = districtCheck.districts;
        }

        // Ensure POI social media edits are source-synced (create/update/link in Source collection).
        if (nextBody.socialMedia && Array.isArray(nextBody.socialMedia)) {
            const normalizedSocialMedia = [];
            for (const smInput of nextBody.socialMedia) {
                const sm = { ...(smInput || {}) };
                sm.platform = normalizePlatform(sm.platform);

                const smHandleRaw = String(sm.handle || '').trim();
                const smDisplayName = String(sm.displayName || sm.display_name || '').trim();

                if (!sm.platform) {
                    return res.status(400).json({ message: 'Each social media row must include platform' });
                }

                if (SOURCE_SYNC_PLATFORMS.has(sm.platform) && !smHandleRaw) {
                    return res.status(400).json({ message: `Handle is required for ${sm.platform} profiles` });
                }

                if (!smDisplayName) {
                    return res.status(400).json({ message: `Display name is required for ${sm.platform} profiles` });
                }

                if (!SOURCE_SYNC_PLATFORMS.has(sm.platform)) {
                    normalizedSocialMedia.push({
                        ...sm,
                        handle: smHandleRaw,
                        displayName: smDisplayName,
                        displayNameNormalized: smDisplayName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
                    });
                    continue;
                }

                const normalizedHandle = normalizeIdentifier(sm.platform, smHandleRaw);

                // Check if this handle is unchanged from the old POI — skip expensive API call
                const smKey = `${sm.platform}::${normalizedHandle.toLowerCase()}`;
                const oldSm = oldSmMap[smKey];
                const handleUnchanged = oldSm && oldSm.sourceId;

                let identity = null;
                if (handleUnchanged) {
                    // Handle unchanged — reuse existing identity, skip external API call
                    identity = {
                        platformUserId: oldSm.platformUserId || null,
                        normalizedIdentifier: oldSm.handle || normalizedHandle,
                        resolvedDisplayName: null,
                        profileImageUrl: oldSm.profileImage || null,
                        isVerified: false,
                        method: 'cached-unchanged'
                    };
                } else {
                    // Handle is new or changed — resolve via external API
                    identity = await resolvePlatformIdentity(sm.platform, normalizedHandle);
                }

                const resolvedHandle = normalizeIdentifier(sm.platform, identity?.normalizedIdentifier || normalizedHandle);
                const resolvedUserId = String(identity?.platformUserId || sm.platformUserId || '').trim();
                const resolvedDisplayName = String(identity?.resolvedDisplayName || smDisplayName || resolvedHandle).trim();
                const resolvedProfileImage = String(identity?.profileImageUrl || sm.profileImage || '').trim();

                // Fast path: if we already have a sourceId, look it up directly
                let source = null;
                if (sm.sourceId || (handleUnchanged && oldSm.sourceId)) {
                    const sid = sm.sourceId || oldSm.sourceId;
                    source = await findSourceByAnyId(sid, req);
                }

                if (!source && resolvedUserId) {
                    source = await Source.findOne(withTenant(req, {
                        platform: sm.platform,
                        platform_user_id: resolvedUserId
                    }));
                }

                if (!source) {
                    source = await Source.findOne(withTenant(req, { platform: sm.platform, identifier: resolvedHandle }));
                }

                const sourceUpdateData = {
                    platform: sm.platform,
                    identifier: resolvedHandle,
                    display_name: resolvedDisplayName,
                    category: String(sm.category || 'others').toLowerCase(),
                    priority: sm.priority || 'medium',
                    follower_count: sm.followerCount !== undefined ? String(sm.followerCount || '') : '',
                    joined_date: sm.createdDate !== undefined ? String(sm.createdDate || '') : '',
                    is_active: sm.is_active !== false,
                    platform_user_id: resolvedUserId,
                    is_verified: identity?.isVerified === true
                };

                if (resolvedProfileImage) {
                    sourceUpdateData.profile_image_url = resolvedProfileImage;
                }

                if (source) {
                    const oldIdentifier = String(source.identifier || '').trim();
                    if (!Array.isArray(source.old_identifiers)) source.old_identifiers = [];
                    if (oldIdentifier && oldIdentifier !== sourceUpdateData.identifier && !source.old_identifiers.includes(oldIdentifier)) {
                        source.old_identifiers.push(oldIdentifier);
                    }
                    Object.assign(source, sourceUpdateData);
                    source.last_identity_refresh_at = new Date();
                    await source.save();
                } else {
                    source = await Source.create({
                        ...sourceUpdateData,
                        tenant_id: req.tenantId,
                        created_by: req.user?.id || 'system'
                    });
                }

                normalizedSocialMedia.push({
                    ...sm,
                    sourceId: source.id,
                    platformUserId: source.platform_user_id || resolvedUserId,
                    handle: source.identifier,
                    displayName: source.display_name,
                    profileImage: resolvedProfileImage || sm.profileImage || '',
                    displayNameNormalized: source.display_name
                        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
                    category: source.category,
                    priority: source.priority,
                    followerCount: sm.followerCount !== undefined ? sm.followerCount : (source.follower_count || ''),
                    createdDate: sm.createdDate !== undefined ? sm.createdDate : (source.joined_date || ''),
                    is_active: sm.is_active !== false
                });

            }

            nextBody.socialMedia = normalizedSocialMedia;
        }

        const poi = await POI.findOneAndUpdate(
            withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }),
            { $set: nextBody },
            { new: true, runValidators: true }
        );

        if (!poi) {
            return res.status(404).json({ message: 'Person of interest not found' });
        }

        // Respond immediately — don't block on post-update Source sync
        res.json(poi);

        // Fire-and-forget: sync monitoring details to Source collection if linked
        if (nextBody.socialMedia && Array.isArray(nextBody.socialMedia)) {
            // Build a map of old is_active values by sourceId for change detection
            const oldActiveMap = {};
            if (oldPoi?.socialMedia) {
                for (const sm of oldPoi.socialMedia) {
                    if (sm.sourceId) oldActiveMap[sm.sourceId] = sm.is_active;
                }
            }

            const syncPromises = [];
            for (const sm of nextBody.socialMedia) {
                if (sm.sourceId) {
                    const updateData = {};
                    if (sm.category) updateData.category = sm.category;
                    if (sm.priority) updateData.priority = sm.priority;
                    if (sm.displayName) {
                        updateData.display_name = sm.displayName;
                        updateData.display_name_normalized = sm.displayName
                            .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                    }
                    if (sm.followerCount !== undefined) updateData.follower_count = sm.followerCount;
                    if (sm.createdDate !== undefined) updateData.joined_date = sm.createdDate;
                    if (sm.handle) updateData.identifier = sm.handle;
                    if (sm.platformUserId !== undefined) updateData.platform_user_id = String(sm.platformUserId || '');
                    // Only sync is_active if it actually changed from the old value
                    if (sm.is_active !== undefined && sm.is_active !== oldActiveMap[sm.sourceId]) {
                        updateData.is_active = sm.is_active;
                    }

                    if (Object.keys(updateData).length > 0) {
                        // Update by UUID (id) OR ObjectId (_id)
                        const mongoose = require('mongoose');
                        const query = withTenant(req, { $or: [{ id: sm.sourceId }] });
                        if (mongoose.Types.ObjectId.isValid(sm.sourceId)) {
                            query.$or.push({ _id: sm.sourceId });
                        }

                        syncPromises.push(
                            Source.findOneAndUpdate(query, { $set: updateData })
                                .catch(err => console.error(`[POI] Failed to sync Source ${sm.sourceId}:`, err.message))
                        );
                    }
                }
            }
            // Run all syncs in parallel, non-blocking (response already sent)
            if (syncPromises.length > 0) {
                Promise.all(syncPromises).catch(() => {});
            }
        }
    } catch (error) {
        console.error('[POI] Error updating POI:', error.message);
        res.status(500).json({ message: 'Failed to update person of interest', error: error.message });
    }
};

// GET /api/poi/:id/report/latest — Redirect to latest S3 report
const getLatestReport = async (req, res) => {
    try {
        const poi = await POI.findOne(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));
        if (!poi || !poi.s3ReportUrl) {
            console.log(`[POI] No report found for ID: ${req.params.id}`);
            return res.status(404).send('<h1>No report found</h1><p>The report for this profile has not been uploaded yet.</p>');
        }
        console.log(`[POI] Redirecting to report: ${poi.s3ReportUrl}`);
        res.redirect(poi.s3ReportUrl);
    } catch (error) {
        console.error('[POI] Error redirecting to report:', error.message);
        res.status(500).json({ message: 'Failed to find report', error: error.message });
    }
};

// DELETE /api/poi/:id — Delete POI
const deletePOI = async (req, res) => {
    try {
        const poi = await POI.findOneAndDelete(withTenant(req, { _id: req.params.id, ...scopedDistrictQuery(req) }));

        if (!poi) {
            return res.status(404).json({ message: 'Person of interest not found' });
        }

        res.json({ message: 'Person of interest deleted successfully' });
    } catch (error) {
        console.error('[POI] Error deleting POI:', error.message);
        res.status(500).json({ message: 'Failed to delete person of interest', error: error.message });
    }
};

// GET /api/poi/by-source/:sourceId — Find POI linked to a source
const getPoiBySourceId = async (req, res) => {
    try {
        const { sourceId } = req.params;
        // Try matching by sourceId first
        let poi = await POI.findOne(withTenant(req, { 'socialMedia.sourceId': sourceId, ...scopedDistrictQuery(req) })).lean();
        if (!poi) {
            // Fallback: try matching by handle + platform from query params
            const { handle, platform } = req.query;
            if (handle && platform) {
                const normalizedPlatform = platform === 'twitter' ? 'x' : platform;
                poi = await POI.findOne(withTenant(req, {
                    'socialMedia.handle': { $regex: `^${handle.replace(/^@/, '')}$`, $options: 'i' },
                    'socialMedia.platform': normalizedPlatform,
                    ...scopedDistrictQuery(req)
                })).lean();
            }
        }
        if (!poi) {
            return res.status(404).json({ message: 'No POI found for this source' });
        }
        res.json(poi);
    } catch (error) {
        console.error('[POI] Error finding POI by source:', error.message);
        res.status(500).json({ message: 'Failed to find POI', error: error.message });
    }
};

// GET /api/poi/stats — Platform-wise profile stats (active/inactive)
const getPoiStats = async (req, res) => {
    try {
        const rows = await POI.aggregate([
            { $match: withTenant(req, scopedDistrictQuery(req)) },
            {
                $project: {
                    createdAt: '$createdAt',
                    state: {
                        $cond: [{ $eq: ['$status', 'active'] }, 'active', 'inactive']
                    },
                    platforms: {
                        $map: {
                            input: { $ifNull: ['$socialMedia', []] },
                            as: 'social',
                            in: {
                                $let: {
                                    vars: {
                                        platform: {
                                            $toLower: {
                                                $trim: {
                                                    input: {
                                                        $convert: {
                                                            input: '$$social.platform',
                                                            to: 'string',
                                                            onError: '',
                                                            onNull: ''
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    in: {
                                        $switch: {
                                            branches: [
                                                { case: { $eq: ['$$platform', 'twitter'] }, then: 'x' },
                                                { case: { $eq: ['$$platform', 'x'] }, then: 'x' },
                                                { case: { $eq: ['$$platform', 'facebook'] }, then: 'facebook' },
                                                { case: { $eq: ['$$platform', 'instagram'] }, then: 'instagram' },
                                                { case: { $eq: ['$$platform', 'youtube'] }, then: 'youtube' },
                                                { case: { $eq: ['$$platform', 'whatsapp'] }, then: 'whatsapp' }
                                            ],
                                            default: null
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ]);

        const init = () => ({ total: 0, active: 0, inactive: 0, today_added: 0, week_added: 0 });
        const byPlatform = {
            all: init(),
            x: init(),
            facebook: init(),
            instagram: init(),
            youtube: init(),
            whatsapp: init()
        };

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayStartMs = todayStart.getTime();

        const weekStart = new Date();
        weekStart.setHours(0, 0, 0, 0);
        const dayOfWeek = weekStart.getDay();
        const daysSinceMonday = (dayOfWeek + 6) % 7;
        weekStart.setDate(weekStart.getDate() - daysSinceMonday);
        const weekStartMs = weekStart.getTime();

        rows.forEach((row) => {
            const state = row?.state === 'inactive' ? 'inactive' : 'active';
            const createdAtMs = row?.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
            const isTodayAdded = !Number.isNaN(createdAtMs) && createdAtMs >= todayStartMs;
            const isWeekAdded = !Number.isNaN(createdAtMs) && createdAtMs >= weekStartMs;

            byPlatform.all[state] += 1;
            byPlatform.all.total += 1;
            if (isTodayAdded) {
                byPlatform.all.today_added += 1;
            }
            if (isWeekAdded) {
                byPlatform.all.week_added += 1;
            }

            const uniquePlatforms = [...new Set(
                (row?.platforms || []).filter((platform) => PROFILE_PLATFORMS.includes(platform))
            )];

            uniquePlatforms.forEach((platform) => {
                byPlatform[platform][state] += 1;
                byPlatform[platform].total += 1;
                if (isTodayAdded) {
                    byPlatform[platform].today_added += 1;
                }
                if (isWeekAdded) {
                    byPlatform[platform].week_added += 1;
                }
            });
        });

        res.json({ byPlatform });
    } catch (error) {
        console.error('[POI] Error fetching POI stats:', error.message);
        res.status(500).json({ message: 'Failed to fetch POI stats', error: error.message });
    }
};

module.exports = {
    getAllPOIs,
    getPOIById,
    createPOI,
    updatePOI,
    deletePOI,
    getLatestReport,
    getPoiBySourceId,
    getPoiStats
};
