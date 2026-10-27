const blugate = require('./blugate');


// Page-id resolution is cached so the same URL is not resolved on every cycle.
// Key rotation used to live here too; BluGate issues one key per tenant and
// meters it centrally, so there is nothing left to rotate.
const fbState = {
    lastCooldownLogAt: 0,
    // Cache page_id resolution so we don't repeatedly call /search/pages for the same URL/slug
    pageIdCache: new Map()
};

const isNumericId = (value) => /^\d+$/.test(String(value || '').trim());

const isProbablyFacebookUrl = (value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    return /^https?:\/\//i.test(v) || /facebook\.com\//i.test(v) || /fb\.me\//i.test(v) || /m\.facebook\.com\//i.test(v);
};

const extractFacebookEntityToken = (value) => {
    const input = String(value || '').trim();
    if (!input) return null;

    // Clean malformed characters (trailing #, ?, etc.)
    const cleaned = input.replace(/[#?&]+$/, '').trim();
    if (!cleaned) return null;

    // If it's numeric already, treat it as a token/id.
    if (isNumericId(cleaned)) return cleaned;

    // Try parse as URL.
    if (isProbablyFacebookUrl(cleaned)) {
        try {
            const url = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
            const pathname = url.pathname || '';

            // profile.php?id=123
            if (/profile\.php/i.test(pathname)) {
                const id = url.searchParams.get('id');
                if (id) return id;
            }

            // /pages/<name>/<id>
            const pagesMatch = pathname.match(/^\/pages\/(?:[^\/]+)\/([^\/]+)/i);
            if (pagesMatch?.[1]) return pagesMatch[1];

            // /<slug>
            const first = pathname.split('/').filter(Boolean)[0];
            if (first) return first.replace(/[#?&]+$/, '');
        } catch {
            // Fall through
        }
    }

    // Otherwise treat as slug — clean trailing junk
    return cleaned.replace(/[#?&]+$/, '');
};

const normalizeFacebookUrlForMatch = (value) => {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        const host = url.hostname.replace(/^m\./i, '').replace(/^www\./i, 'www.');
        const path = (url.pathname || '').replace(/\/+$/, '');
        // Keep scheme+host+path only (ignore query/hash) so we can match canonical URLs.
        return `https://${host}${path}`.toLowerCase();
    } catch {
        return input.replace(/\/+$/, '').toLowerCase();
    }
};

const getCachedResolvedPageId = (cacheKey) => {
    const v = fbState.pageIdCache.get(cacheKey);
    if (!v) return null;
    if (Date.now() > v.expiresAt) {
        fbState.pageIdCache.delete(cacheKey);
        return null;
    }
    return v.id;
};

const setCachedResolvedPageId = (cacheKey, id) => {
    if (!cacheKey || !id) return;
    // 6 hours TTL
    fbState.pageIdCache.set(cacheKey, { id, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
};

const getCooldownSeconds = () => {
    const v = Number(process.env.RAPIDAPI_FACEBOOK_COOLDOWN_SECONDS);
    return Number.isFinite(v) && v > 0 ? v : 90;
};

const rapidGet = async (path, params, options = {}, _attempt = 0) => {
    try {
        // BluGate holds the upstream facebook-scraper3 credentials and meters
        // this tenant's usage, so the payload below is the same one this service
        // parsed when it called RapidAPI directly.
        const data = await blugate.callByPath('facebook', path, params, {
            timeout: Math.max(5000, Number(options.timeoutMs) || 20000),
        });
        // Callers read `response.data` — keep the axios shape they expect.
        return { data, status: 200 };
    } catch (error) {
        const status = error.status || error?.response?.status;

        // Nothing retryable about a missing credential or an unsupported route.
        if (error.code === 'BLUGATE_NOT_CONFIGURED' || error.code === 'ENDPOINT_UNSUPPORTED') {
            throw error;
        }

        // Per-key rotation is gone — BluGate issues one key per tenant and does
        // its own metering. A short backoff still helps: it stops one saturated
        // source from spending the rest of the cycle's budget on retries.
        if (status === 429 && _attempt < 3) {
            const waitMs = getCooldownSeconds() * 1000 * (_attempt + 1);
            console.warn(`[BluGate:Facebook] 429 on ${path} — backing off ${waitMs / 1000}s (attempt ${_attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, waitMs));
            return rapidGet(path, params, options, _attempt + 1);
        }

        throw error;
    }
};

// NOTE: headers are now handled in rapidGet(), so we can rotate keys and cooldown on 429.

const resolveUsablePageId = async (pageIdOrUrl) => {
    const input = String(pageIdOrUrl || '').trim();
    if (!input) return null;
    if (isNumericId(input)) return input;

    const cacheKey = `resolve:${input}`;
    const cached = getCachedResolvedPageId(cacheKey);
    if (cached) return cached;

    const token = extractFacebookEntityToken(input);
    if (!token) {
        console.warn(`[Facebook] resolveUsablePageId: Could not extract token from "${input}"`);
        return null;
    }

    // If token itself is numeric, return it.
    if (isNumericId(token)) {
        setCachedResolvedPageId(cacheKey, token);
        return token;
    }

    // Search by slug/token and pick the first match that has an id.
    const results = await searchPages(token);
    let best = null;
    if (isProbablyFacebookUrl(input)) {
        const wanted = normalizeFacebookUrlForMatch(input);
        best = (results || []).find((r) => r?.url && normalizeFacebookUrlForMatch(r.url) === wanted);
    }
    best = best || (results || []).find((r) => r?.id) || (results || [])[0];
    const id = best?.id;
    if (id) {
        setCachedResolvedPageId(cacheKey, id);
    } else {
        console.warn(`[Facebook] resolveUsablePageId: Search for "${token}" returned no usable page ID (${(results || []).length} results)`);
        // Cache the failure for a shorter time (30min) so we don't keep searching
        fbState.pageIdCache.set(cacheKey, { id: null, expiresAt: Date.now() + 30 * 60 * 1000 });
    }
    return id || null;
};

const fetchPageDetails = async (pageIdOrUrl, options = {}) => {
    try {
        // The current RapidAPI provider we use exposes /search/pages and /page/posts.
        // It does NOT expose /page/info, so we resolve basic page details via search.
        const input = String(pageIdOrUrl || '').trim();
        if (!input) return null;

        const token = extractFacebookEntityToken(input);
        if (!token) return null;

        const results = await searchPages(token, options);
        let best = null;
        if (isProbablyFacebookUrl(input)) {
            const wanted = normalizeFacebookUrlForMatch(input);
            best = (results || []).find((r) => r?.url && normalizeFacebookUrlForMatch(r.url) === wanted);
        }
        best = best || (results || []).find((r) => r?.id) || (results || [])[0];
        if (!best) {
            // Preserve the original numeric id if provider cannot resolve metadata.
            if (isNumericId(input)) {
                return { id: input, name: null, image: null, url: null, is_verified: null };
            }
            return null;
        }

        return {
            name: best.name || null,
            id: best.id || null,
            image: best.profile_image_url || null,
            url: best.url || null,
            is_verified: best.verified ?? null,
            about: best.description || null,
            followers: best.followers_count || 0,
            likes: best.likes_count || 0
        };
    } catch (error) {
        if (options?.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
            throw error;
        }
        if (error?.code === 'FB_RAPIDAPI_COOLDOWN') return null;
        console.error(`[Facebook] Error fetching page details for ${pageIdOrUrl}:`, error.message);
        return null;
    }
};

const fetchPagePosts = async (pageIdOrUrl, limit = 10, pageName = null, options = {}) => {
    try {
        const input = String(pageIdOrUrl || '').trim();

        const fetchRaw = async (params) => {
            // Provider requires `page_id` (numeric Facebook ID). `page_url` is not supported.
            const response = await rapidGet('/page/posts', { ...params, depth: 1, limit });
            return response.data?.results || response.data?.posts || [];
        };

        // Always attempt with a numeric page_id.
        // - If input is numeric: use directly.
        // - Else: resolve via /search/pages -> facebook_id.
        const resolvedId = isNumericId(input) ? input : await resolveUsablePageId(input);
        if (!resolvedId) {
            console.warn(`[Facebook] fetchPagePosts: Could not resolve page ID for "${input}" — returning empty`);
            return [];
        }

        const rawPosts = await fetchRaw({ page_id: resolvedId });

        const safeRawPosts = Array.isArray(rawPosts) ? rawPosts : [];

        // Map to standard format
        return safeRawPosts.slice(0, limit).map(post => ({
            id: post.post_id || post.id,
            text: post.text || post.message || post.caption || '',
            url: post.url || post.post_url,
            created_at: (() => {
                const dateValue = post.time || post.timestamp || post.created_time;
                if (!dateValue) return null;
                if (typeof dateValue === 'number') {
                    // Provider returns unix seconds
                    const ms = dateValue < 1e12 ? dateValue * 1000 : dateValue;
                    const d = new Date(ms);
                    return isNaN(d) ? null : d;
                }
                const d = new Date(dateValue);
                return isNaN(d) ? null : d;
            })(),
            author_id: post.author?.id || post.owner_id || post.user_id || post.from?.id || resolvedId,
            // Provider returns an `author` object
            author_name: post.author?.name || post.owner_name || post.author_name || post.page_name || post.name || post.from?.name || post.user?.name || pageName || pageIdOrUrl,
            type: post.type || 'post',
            media: (() => {
                const m = [];
                if (post.album_preview && Array.isArray(post.album_preview)) {
                    m.push(...post.album_preview.map(a => a?.url || a).filter(Boolean));
                }
                if (Array.isArray(post.images) && post.images.length > 0) {
                    m.push(...post.images);
                }
                if (post.full_picture) m.push(post.full_picture);
                if (post.picture) m.push(post.picture);
                if (post.image) m.push(post.image);
                if (post.video) m.push(post.video);
                if (post.video_thumbnail) m.push(post.video_thumbnail);
                if (post.source) m.push(post.source);
                // Deduplicate
                return [...new Set(m.filter(Boolean))];
            })(),
            engagement: {
                likes: post.likes || post.reactions?.likes || post.reactions_count || post.reaction_count || 0,
                comments: post.comments || post.comments_count || post.comment_count || 0,
                shares: post.shares || post.shares_count || post.share_count || post.reshare_count || 0,
                views: post.views || post.view_count || 0
            },
            location: (() => {
                const p = post.place || post.location || post.checkin;
                if (!p || typeof p !== 'object') return null;
                const name = p.name || p.title || p.location_name || null;
                if (!name) return null;
                const lat = typeof p.latitude === 'number' ? p.latitude : (typeof p.lat === 'number' ? p.lat : null);
                const lng = typeof p.longitude === 'number' ? p.longitude : (typeof p.lng === 'number' ? p.lng : null);
                return {
                    name,
                    address: p.address || p.street || null,
                    city: p.city || null,
                    country: p.country || null,
                    lat,
                    lng,
                    place_id: p.id ? String(p.id) : null,
                    source: 'facebook_place'
                };
            })()
        }));

    } catch (error) {
        if (options?.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
            throw error;
        }
        if (error?.code === 'FB_RAPIDAPI_COOLDOWN') return null;
        console.error(`[Facebook] Error fetching posts for ${pageIdOrUrl}:`, error.message);
        return null;
    }
};

const fetchPostComments = async (postId, limit = 20, options = {}) => {
    try {
        const response = await rapidGet('/post/comments', { post_id: postId });

        const rawComments = response.data?.results || response.data?.comments || [];
        
        return rawComments.slice(0, limit).map(comment => ({
            id: comment.comment_id || comment.id,
            text: comment.text || comment.message || '',
            author_id: comment.owner_id || comment.author_id,
            author_name: comment.owner_name || comment.author_name || 'Unknown',
            author_image: comment.owner_pic || comment.author_pic,
            created_at: (() => {
                const dateValue = comment.time || comment.timestamp || comment.created_time;
                if (!dateValue) return null;
                if (typeof dateValue === 'number') {
                    const ms = dateValue < 1e12 ? dateValue * 1000 : dateValue;
                    const d = new Date(ms);
                    return isNaN(d) ? null : d;
                }
                const d = new Date(dateValue);
                return isNaN(d) ? null : d;
            })(),
            likes: comment.likes || 0,
            replies_count: comment.replies || 0
        }));

    } catch (error) {
        if (options?.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
            throw error;
        }
        if (error.response?.status === 404) return [];
        if (error?.code === 'FB_RAPIDAPI_COOLDOWN') return [];
        console.error(`[Facebook] Error fetching comments for ${postId}:`, error.message);
        return [];
    }
};

// Search for Facebook pages
const searchPages = async (query, options = {}) => {
    try {
        const safeLimit = Math.min(Math.max(Number(options?.limit) || 20, 1), 50);
        const response = await rapidGet('/search/pages', { query, limit: safeLimit });

        const rawResults = response.data?.results || response.data?.pages || response.data || [];
        
        const pages = rawResults.map(page => ({
            // Provider returns `facebook_id` + `profile_url` + `image` object
            id: page.facebook_id || page.page_id || page.id,
            name: page.name || page.title || 'Unknown Page',
            screen_name: page.username || page.screen_name || page.facebook_id || page.page_id || page.id,
            description: page.about || page.description || '',
            profile_image_url: page.image?.uri || page.image || page.profile_pic || page.picture || '',
            followers_count: page.followers_count || page.followers || 0,
            likes_count: page.likes_count || page.likes || 0,
            verified: page.is_verified || false,
            url: page.profile_url || page.url || `https://facebook.com/${page.facebook_id || page.page_id || page.id}`,
            platform: 'facebook'
        }));

        const limitedPages = pages.slice(0, safeLimit);

        // Enrich with follower counts from /page/details (search endpoint doesn't return them)
        // Sequential to avoid 429 rate limits
        for (const page of limitedPages.slice(0, Math.min(10, safeLimit))) {
            try {
                const detailRes = await rapidGet('/page/details', { url: page.url });
                const d = detailRes.data?.results || detailRes.data || {};
                if (d.followers) page.followers_count = d.followers;
                if (d.likes) page.likes_count = d.likes;
                if (d.intro && !page.description) page.description = d.intro;
            } catch (_) { /* keep existing 0 */ }
        }

        return limitedPages;

    } catch (error) {
        if (options?.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
            throw error;
        }
        if (error?.code === 'FB_RAPIDAPI_COOLDOWN') return [];
        console.error(`[Facebook] Error searching pages:`, error.message);
        return [];
    }
};

// Normalize a raw Facebook post into standard format
const normalizeRawPost = (post) => {
    // Safe date parsing — API returns `timestamp` as Unix seconds
    let createdAt = null;
    try {
        const dateValue = post.timestamp || post.time || post.created_time;
        if (dateValue) {
            const parsedDate = typeof dateValue === 'number'
                ? new Date(dateValue < 1e12 ? dateValue * 1000 : dateValue)
                : new Date(dateValue);
            if (!isNaN(parsedDate)) {
                createdAt = parsedDate;
            }
        }
    } catch (e) {
        // Invalid date, skip
    }

    // Extract media URLs
    const media = [];
    if (post.album_preview && Array.isArray(post.album_preview)) {
        media.push(...post.album_preview.map(a => a?.url || a).filter(Boolean));
    }
    if (Array.isArray(post.images) && post.images.length > 0) {
        media.push(...post.images);
    }
    if (post.full_picture) media.push(post.full_picture);
    if (post.picture) media.push(post.picture);
    if (post.image) media.push(post.image);
    if (post.video) media.push(post.video);
    if (post.video_thumbnail) media.push(post.video_thumbnail);
    if (post.source) media.push(post.source);
    // Deduplicate
    const seen = new Set();
    const dedupedMedia = media.filter(u => { if (!u || seen.has(u)) return false; seen.add(u); return true; });

    // Author is an object: { id, name, url, profile_picture_url }
    const authorObj = (typeof post.author === 'object' && post.author) ? post.author : null;
    const authorName =
        authorObj?.name ||
        post.author_title ||
        post.owner_name ||
        post.author_name ||
        post.page_name ||
        (typeof post.author === 'string' ? post.author : null) ||
        'Facebook User';

    const authorHandle = authorObj?.id || post.owner_id || post.page_id || post.user_id || authorName;
    const authorAvatar = authorObj?.profile_picture_url || post.owner_pic || post.author_pic || '';
    const authorUrl = authorObj?.url || '';

    // Extract location/place if the post has one (FB "checked in at X")
    let location = null;
    const placeRaw = post.place || post.location || post.checkin || null;
    if (placeRaw && typeof placeRaw === 'object') {
        const name = placeRaw.name || placeRaw.title || placeRaw.location_name || null;
        if (name) {
            const lat = typeof placeRaw.latitude === 'number'
                ? placeRaw.latitude
                : (typeof placeRaw.lat === 'number' ? placeRaw.lat : null);
            const lng = typeof placeRaw.longitude === 'number'
                ? placeRaw.longitude
                : (typeof placeRaw.lng === 'number' ? placeRaw.lng : null);
            location = {
                name,
                address: placeRaw.address || placeRaw.street || null,
                city: placeRaw.city || null,
                country: placeRaw.country || null,
                lat,
                lng,
                place_id: placeRaw.id ? String(placeRaw.id) : null,
                source: 'facebook_place'
            };
        }
    }

    return {
        id: post.post_id || post.id,
        text: post.message || post.text || post.caption || '',
        created_at: createdAt,
        media: dedupedMedia,
        author: authorName,
        author_handle: authorHandle,
        author_avatar: authorAvatar,
        author_url: authorUrl,
        url: post.url || post.post_url || `https://facebook.com/${post.post_id || post.id}`,
        location,
        metrics: {
            likes: post.reactions_count || post.reaction_count || post.likes || 0,
            comments: post.comments_count || post.comment_count || post.comments || 0,
            shares: post.reshare_count || post.shares_count || post.shares || 0,
            views: post.views || post.view_count || 0
        },
        platform: 'facebook'
    };
};

const extractSearchPostsPayload = (responseData) => {
    return responseData?.results || responseData?.posts || responseData?.data || [];
};

const extractSearchCursor = (responseData) => {
    return responseData?.paging?.next_cursor ||
        responseData?.paging?.cursor ||
        responseData?.next_cursor ||
        responseData?.cursor ||
        null;
};

const fetchSearchPostsForParams = async ({ query, safeLimit, baseParams, shouldStop, rapidOptions }) => {
    const perRequestLimit = Math.min(safeLimit, 50);
    const maxPages = Math.min(Math.ceil(safeLimit / 15) + 2, 8);

    const aggregated = [];
    const seen = new Set();
    let cursor = null;
    let stagnantPages = 0;

    const appendUnique = (rawPosts) => {
        let added = 0;
        for (const post of rawPosts || []) {
            const pid = post?.post_id || post?.id;
            if (!pid || seen.has(pid)) continue;

            // Keep non-text posts when they still carry usable content (media/url).
            const text = String(post?.message || post?.text || post?.caption || '').trim();
            const hasMedia = Boolean(
                post?.full_picture ||
                post?.picture ||
                post?.image ||
                post?.video ||
                post?.video_thumbnail ||
                post?.source ||
                (Array.isArray(post?.album_preview) && post.album_preview.length) ||
                (Array.isArray(post?.images) && post.images.length)
            );
            const hasUrl = Boolean(post?.url || post?.post_url);
            if (!text && !hasMedia && !hasUrl) continue;

            seen.add(pid);
            aggregated.push(post);
            added += 1;
            if (aggregated.length >= safeLimit) break;
        }
        return added;
    };

    for (let page = 1; page <= maxPages && aggregated.length < safeLimit; page++) {
        if (typeof shouldStop === 'function' && shouldStop()) break;
        const variants = [];

        if (page === 1) {
            variants.push({ ...baseParams, query, limit: perRequestLimit });
        } else {
            if (cursor) {
                variants.push({ ...baseParams, query, limit: perRequestLimit, cursor });
                variants.push({ ...baseParams, query, limit: perRequestLimit, next_cursor: cursor });
                variants.push({ ...baseParams, query, limit: perRequestLimit, after: cursor });
            }
            variants.push({ ...baseParams, query, limit: perRequestLimit, page });
            variants.push({ ...baseParams, query, limit: perRequestLimit, page_number: page });
            variants.push({ ...baseParams, query, limit: perRequestLimit, offset: (page - 1) * perRequestLimit });
        }

        let pageAdded = 0;
        let pageCursor = cursor;

        for (const params of variants) {
            if (typeof shouldStop === 'function' && shouldStop()) break;
            try {
                const remainingMs = typeof rapidOptions?.getRemainingMs === 'function'
                    ? rapidOptions.getRemainingMs()
                    : null;
                if (remainingMs !== null && remainingMs <= 1500) break;

                const requestTimeoutMs = remainingMs !== null
                    ? Math.max(3000, Math.min(Number(rapidOptions?.timeoutMs) || 12000, remainingMs - 500))
                    : (Number(rapidOptions?.timeoutMs) || 12000);

                const response = await rapidGet('/search/posts', params, {
                    ...rapidOptions,
                    timeoutMs: requestTimeoutMs
                });
                const rawPosts = extractSearchPostsPayload(response.data);
                const added = appendUnique(rawPosts);

                pageCursor = extractSearchCursor(response.data) || pageCursor;
                pageAdded += added;

                if ((rawPosts || []).length > 0) break;
            } catch (_) {
                // Try the next pagination variant.
            }
        }

        if (!pageCursor || pageCursor === cursor) {
            // If no cursor progress and this page added nothing, we're likely at provider boundary.
            if (pageAdded === 0) stagnantPages += 1;
        } else {
            cursor = pageCursor;
            stagnantPages = pageAdded === 0 ? stagnantPages + 1 : 0;
        }

        if (pageAdded > 0) {
            stagnantPages = 0;
        }

        if (stagnantPages >= 2) break;
    }

    return aggregated;
};

// Search for Facebook posts — multi-pass request modes + pagination, merge & deduplicate
const searchPosts = async (query, limit = 50, options = {}) => {
    try {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
        const country = process.env.RAPIDAPI_FACEBOOK_COUNTRY || 'IN';
        const deadlineMs = Math.max(8000, Number(options?.maxSearchMs) || 30000);
        const startedAt = Date.now();
        const shouldStop = () => Date.now() - startedAt >= deadlineMs;
        const rapidOptions = {
            // Avoid waiting 60-90s for key cooldown in interactive global search.
            waitForCooldown: false,
            timeoutMs: Math.min(10000, Math.max(5000, deadlineMs - 2000)),
            getRemainingMs: () => deadlineMs - (Date.now() - startedAt)
        };

        const modeParams = [
            { recent_posts: 1, country },
            { country },
            { recent_posts: 1 },
            {}
        ];

        const merged = [];
        const mergedSeen = new Set();

        const appendMerged = (items) => {
            for (const post of items || []) {
                const pid = post?.post_id || post?.id;
                if (!pid || mergedSeen.has(pid)) continue;
                mergedSeen.add(pid);
                merged.push(post);
                if (merged.length >= safeLimit) break;
            }
        };

        for (const baseParams of modeParams) {
            if (shouldStop() || merged.length >= safeLimit) break;
            try {
                const modeResults = await fetchSearchPostsForParams({
                    query,
                    safeLimit,
                    baseParams,
                    shouldStop,
                    rapidOptions
                });
                appendMerged(modeResults);
            } catch (modeError) {
                if (modeError?.code === 'FB_RAPIDAPI_COOLDOWN') {
                    // Skip this mode quickly; keep whatever partial data we already have.
                    continue;
                }
                throw modeError;
            }
        }

        const allRaw = merged;

        if (shouldStop()) {
            console.warn(`[Facebook] searchPosts deadline reached (${deadlineMs}ms) for query "${query}" — returning ${allRaw.length} partial results`);
        }

        return allRaw.map(normalizeRawPost).sort((a, b) => {
            const timeA = a.created_at ? a.created_at.getTime() : 0;
            const timeB = b.created_at ? b.created_at.getTime() : 0;
            return timeB - timeA; // newest first
        }).slice(0, safeLimit);

    } catch (error) {
        if (options?.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
            throw error;
        }
        if (error?.code === 'FB_RAPIDAPI_COOLDOWN') return [];
        console.error(`[Facebook] Error searching posts:`, error.message);
        return [];
    }
};

module.exports = {
    fetchPageDetails,
    fetchPagePosts,
    fetchPostComments,
    searchPages,
    searchPosts
};
