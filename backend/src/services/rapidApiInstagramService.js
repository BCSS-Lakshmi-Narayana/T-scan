const axios = require('axios');
const blugate = require('./blugate');


// ─── Subscribed Key — Direct Usage (no cooldown/rotation) ──────────────────
let totalCalls = 0;

// ─── Global Rate-Limit Protection ──────────────────────────────────────────
let igGlobalRateLimitPauseUntil = 0;
const IG_GLOBAL_RATE_LIMIT_PAUSE_MS = Number(process.env.RAPIDAPI_IG_GLOBAL_PAUSE_MS) || 60000;
let igLastRequestTime = 0;
const IG_MIN_REQUEST_GAP_MS = Number(process.env.RAPIDAPI_IG_MIN_GAP_MS) || 500;

// Normalize an Instagram location object (may live on the post root, in
// `location`, `location_info`, or `place.location`) into our Content schema shape.
const extractInstagramLocation = (post) => {
    if (!post || typeof post !== 'object') return null;
    const candidates = [
        post.location,
        post.location_info,
        post.place?.location,
        post.place
    ].filter((c) => c && typeof c === 'object');

    for (const loc of candidates) {
        const name = loc.name || loc.short_name || loc.title || null;
        if (!name) continue;
        const lat = typeof loc.lat === 'number'
            ? loc.lat
            : (typeof loc.latitude === 'number' ? loc.latitude : null);
        const lng = typeof loc.lng === 'number'
            ? loc.lng
            : (typeof loc.longitude === 'number' ? loc.longitude : null);
        return {
            name,
            address: loc.address || loc.street_address || null,
            city: loc.city || loc.city_name || null,
            country: loc.country || loc.country_name || null,
            lat,
            lng,
            place_id: loc.pk ? String(loc.pk) : (loc.id ? String(loc.id) : null),
            source: 'instagram_post'
        };
    }
    return null;
};

// ─── Core POST Request (subscribed key — simple retry on errors) ────────────
/**
 * Instagram requests, routed through BluGate.
 *
 * NOTE — the upstream provider changed with this migration: BluGate fronts
 * ig-downloader-api, whereas this service previously called instagram120
 * directly. The endpoint NAMES line up (/userInfo, /posts, /stories,
 * /mediaByShortcode …) but the response BODIES differ, so anything downstream
 * that reaches into these payloads has to be checked against real responses.
 *
 * Both helpers keep the axios-style `{ data }` envelope their callers were
 * written against, so the call sites in this file did not change.
 */
const rapidPost = async (path, data, _retryCount = 0) => {
    const MAX_RETRIES = 2;
    try {
        // Per-request throttle — the gateway meters quota, but pacing still
        // keeps one busy source from crowding out the rest of the cycle.
        const gap = Date.now() - igLastRequestTime;
        if (gap < IG_MIN_REQUEST_GAP_MS) {
            await new Promise((r) => setTimeout(r, IG_MIN_REQUEST_GAP_MS - gap));
        }
        igLastRequestTime = Date.now();

        return { data: await blugate.callByPath('instagram', path, data), status: 200 };
    } catch (error) {
        const status = error.status || error?.response?.status;
        if (error.code === 'BLUGATE_NOT_CONFIGURED' || error.code === 'ENDPOINT_UNSUPPORTED') throw error;
        if (status === 429 && _retryCount < MAX_RETRIES) {
            const waitMs = 2000 * (_retryCount + 1);
            console.warn(`[BluGate:Instagram] 429 on ${path} — backing off ${waitMs / 1000}s`);
            await new Promise((r) => setTimeout(r, waitMs));
            return rapidPost(path, data, _retryCount + 1);
        }
        throw error;
    }
};

// ig-downloader takes its arguments in the body on every endpoint, so a GET is
// expressed as the same POST. Kept as a separate name because call sites below
// distinguish the two and that distinction may return with another provider.
const rapidGet = async (path, params = {}, _retryCount = 0) => rapidPost(path, params, _retryCount);

// ─── Public API Methods ────────────────────────────────────────────────────

/**
 * Fetch latest posts for a given username.
 * Includes fallback: if POST /api/instagram/posts fails, tries alternative endpoints.
 */
const fetchUserPosts = async (username, maxId = "") => {
    const endpoints = [
        { method: 'POST', path: '/posts', data: { username, maxId } }
    ];

    for (const ep of endpoints) {
        try {
            console.log(`[Instagram] Fetching posts for ${username} via ${ep.method} ${ep.path}`);
            const response = ep.method === 'POST'
                ? await rapidPost(ep.path, ep.data)
                : await rapidGet(ep.path, ep.data);

            if (response?.data) {
                console.log(`[Instagram] ✅ Posts fetched for ${username} via ${ep.path}`);
                return response.data;
            }
        } catch (error) {
            if (error.isRateLimit) {
                console.warn(`[Instagram] ⚠️ Rate-limited on ${ep.path} for ${username} — will try next endpoint (global pause will auto-wait)`);
                // Don't return null — let the loop continue; the next rapidPost call
                // will wait out the global pause automatically before making the request
            } else {
                console.warn(`[Instagram] ⚠️ ${ep.path} failed for ${username}: ${error.message}`);
            }
            // Continue to next endpoint
        }
    }

    console.error(`[Instagram] ❌ All endpoints failed for posts of ${username}`);
    return null;
};

/**
 * Fetch profile information for a given username.
 * Multiple endpoint fallbacks.
 */
const fetchUserProfile = async (username) => {
    // /userInfo is the richer response; /profile is kept as a fallback because
    // the gateway occasionally returns an empty result for the first.
    const endpoints = [
        { method: 'POST', path: '/userInfo', data: { username } },
        { method: 'POST', path: '/profile', data: { username } }
    ];

    for (const ep of endpoints) {
        try {
            //console.log(`[Instagram] Fetching profile for ${username} via ${ep.method} ${ep.path}`);
            const response = ep.method === 'POST'
                ? await rapidPost(ep.path, ep.data)
                : await rapidGet(ep.path, ep.data);

            if (response?.data) {
                console.log(`[Instagram] ✅ Profile fetched for ${username} via ${ep.path}`);
                return response.data;
            }
        } catch (error) {
            if (error.isRateLimit) {
                console.warn(`[Instagram] ⚠️ Rate-limited on ${ep.path} for profile ${username} — will try next endpoint`);
            } else {
                console.warn(`[Instagram] ⚠️ ${ep.path} failed for ${username}: ${error.message}`);
            }
        }
    }

    console.error(`[Instagram] ❌ All endpoints failed for profile of ${username}`);
    return null;
};

/**
 * Fetch profile information for a given Instagram user id.
 * Different RapidAPI providers expose different endpoint names, so we try a few.
 */
const fetchUserProfileById = async (userId) => {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;

    const endpoints = [
        { method: 'POST', path: '/userInfo', data: { userId: cleanUserId } },
        { method: 'POST', path: '/userInfo', data: { username: cleanUserId } },
        { method: 'POST', path: '/userInfo', data: { user_id: cleanUserId } },
        { method: 'POST', path: '/userInfo', data: { userId: cleanUserId } },
        { method: 'POST', path: '/userInfo', data: { id: cleanUserId } },
        { method: 'POST', path: '/profile', data: { user_id: cleanUserId } },
        { method: 'POST', path: '/profile', data: { userId: cleanUserId } },
        { method: 'POST', path: '/profile', data: { id: cleanUserId } },
        { method: 'GET', path: '/userInfo', data: { user_id: cleanUserId } },
        { method: 'GET', path: '/userInfo', data: { userId: cleanUserId } },
        { method: 'GET', path: '/userInfo', data: { id: cleanUserId } },
        { method: 'GET', path: '/profile', data: { user_id: cleanUserId } },
        { method: 'GET', path: '/profile', data: { userId: cleanUserId } },
        { method: 'GET', path: '/profile', data: { id: cleanUserId } },
        { method: 'POST', path: '/profile', data: { user_id: cleanUserId } },
        { method: 'GET', path: '/profile', data: { user_id: cleanUserId } }
    ];

    for (const ep of endpoints) {
        try {
            const response = ep.method === 'POST'
                ? await rapidPost(ep.path, ep.data)
                : await rapidGet(ep.path, ep.data);

            if (!response?.data) continue;

            // Quick structural check to avoid returning unrelated payloads.
            const payload = response.data;
            const resultArr = payload.result || payload.results;
            const user = Array.isArray(resultArr)
                ? (resultArr[0]?.user || resultArr[0])
                : (payload.data || payload.user || payload);

            const maybeId = String(user?.pk || user?.pk_id || user?.id || '').trim();
            const maybeHandle = String(user?.username || '').trim();

            if (maybeId || maybeHandle) {
                return payload;
            }
        } catch (error) {
            // Try next endpoint variant.
        }
    }

    return null;
};

/**
 * Fetch stories for a given username.
 * Stories are ephemeral (24h) so we need to poll regularly.
 */
const fetchUserStories = async (username) => {
    // Disabled because the current RapidAPI Instagram provider does not expose
    // working stories/highlights endpoints in this project integration.
    // Username refresh remains available via POI/source identity refresh flows.
    void username;
    return null;
};

/**
 * Fetch detailed information for a specific Instagram post/reel.
 * Multiple fallback strategies: shortcode-based, then URL-based.
 */
const fetchInstagramPostDetail = async (shortcode) => {
    const endpoints = [
        { method: 'POST', path: '/mediaByShortcode', data: { shortcode } },
        { method: 'GET', path: '/mediaByShortcode', data: { shortcode } },
        { method: 'POST', path: '/reels', data: { shortcode } },
        { method: 'GET', path: '/reels', data: { shortcode } }
    ];

    for (const ep of endpoints) {
        try {
            const response = ep.method === 'POST'
                ? await rapidPost(ep.path, ep.data)
                : await rapidGet(ep.path, ep.data);

            const data = response?.data?.data || response?.data;
            if (!data) continue;

            // Normalize a single API media item into { url, type }
            const normApiMedia = (item) => {
                if (!item) return null;
                const isVideo = item.media_type === 2 || Array.isArray(item.video_versions);
                const url = isVideo
                    ? (item.video_versions?.[0]?.url || item.image_versions2?.candidates?.[0]?.url)
                    : item.image_versions2?.candidates?.[0]?.url;
                return url ? { url, type: isVideo ? 'video' : 'photo' } : null;
            };

            let mediaArr = [];
            if (Array.isArray(data.carousel_media) && data.carousel_media.length) {
                mediaArr = data.carousel_media.map(normApiMedia).filter(Boolean);
            } else {
                const single = normApiMedia(data);
                if (single) mediaArr = [single];
            }

            return {
                id: data.id || shortcode,
                text: data.caption?.text || data.text || '',
                author: data.user?.full_name || data.owner?.full_name || 'Instagram User',
                author_handle: data.user?.username || data.owner?.username || 'instagram',
                author_avatar: data.user?.profile_pic_url || data.owner?.profile_pic_url || '',
                created_at: data.taken_at ? new Date(data.taken_at * 1000) : new Date(),
                media: mediaArr,
                location: extractInstagramLocation(data),
                metrics: {
                    likes: data.like_count || 0,
                    comments: data.comment_count || 0,
                    views: data.view_count || data.play_count || data.video_play_count || 0
                }
            };
        } catch (error) {
            //console.warn(`[Instagram] ⚠️ Post detail ${ep.path} failed for ${shortcode}: ${error.message}`);
        }
    }

    //console.error(`[Instagram] ❌ All endpoints failed for post detail ${shortcode}`);
    return null;
};

/**
 * Infer a profile's canonical username from the links endpoint.
 * This helps when profile endpoints are stale right after a rename.
 */
const inferUsernameFromProfileUrl = async (identifierOrUrl) => {
    const raw = String(identifierOrUrl || '').trim();
    if (!raw) return null;

    const profileUrl = /^https?:\/\//i.test(raw)
        ? raw
        : `https://www.instagram.com/${raw.replace(/^@/, '')}/`;

    const endpoints = [
        { method: 'POST', path: '/links', data: { url: profileUrl } },
        { method: 'POST', path: '/links', data: { url: profileUrl } }
    ];

    for (const ep of endpoints) {
        try {
            const response = ep.method === 'POST'
                ? await rapidPost(ep.path, ep.data)
                : await rapidGet(ep.path, ep.data);

            const rows = Array.isArray(response?.data?.result)
                ? response.data.result
                : (Array.isArray(response?.data) ? response.data : []);

            if (!rows.length) continue;

            // Prefer explicit username from sourceUrl query param when present.
            for (const row of rows) {
                const sourceUrl = String(row?.meta?.sourceUrl || '').trim();
                if (!sourceUrl) continue;
                try {
                    const u = new URL(sourceUrl);
                    const username = String(u.searchParams.get('username') || '').trim().replace(/^@/, '').toLowerCase();
                    if (username) return username;
                } catch {
                    // ignore malformed sourceUrl
                }
            }

            // Fallback: most frequent meta.username value.
            const counts = new Map();
            for (const row of rows) {
                const name = String(row?.meta?.username || '').trim().replace(/^@/, '').toLowerCase();
                if (!name) continue;
                counts.set(name, (counts.get(name) || 0) + 1);
            }

            let best = null;
            let bestCount = 0;
            for (const [name, count] of counts.entries()) {
                if (count > bestCount) {
                    best = name;
                    bestCount = count;
                }
            }

            if (best) return best;
        } catch {
            // Try next endpoint variant.
        }
    }

    return null;
};

/**
 * Search Instagram users by query.
 * Tries dedicated search endpoints, falls back to direct profile lookup.
 */
const searchUsers = async (query, limit = 1) => {
    const cleanQuery = String(query || '').trim().replace(/^@/, '');
    if (!cleanQuery) return [];

    // instagram120 API has no search endpoint — only direct profile lookup
    try {
        const profileData = await fetchUserProfile(cleanQuery);
        if (profileData) {
            // Response may nest user data under .data, .result[0].user, .user, or at top level
            const resultArr = profileData.result || profileData.results;
            const raw = Array.isArray(resultArr) ? (resultArr[0]?.user || resultArr[0]) : null;
            const user = raw || profileData.data || profileData.user || profileData;
            if (user.username || user.full_name) {
                console.log(`[Instagram] Found user profile: ${user.username}`);
                return [{
                    id: user.pk || user.pk_id || user.id || '',
                    name: user.full_name || user.username || cleanQuery,
                    screen_name: user.username || cleanQuery,
                    description: user.biography || user.bio_text || user.bio || '',
                    profile_image_url: user.profile_pic_url || user.profile_pic_url_hd || user.hd_profile_pic_url_info?.url || '',
                    followers_count: user.follower_count || user.edge_followed_by?.count || 0,
                    following_count: user.following_count || user.edge_follow?.count || 0,
                    posts_count: user.media_count || user.edge_owner_to_timeline_media?.count || 0,
                    verified: user.is_verified || false,
                    platform: 'instagram'
                }];
            }
        }
    } catch (err) {
        console.warn(`[Instagram] Profile lookup failed for '${cleanQuery}':`, err.message);
    }

    return [];
};

/**
 * Search Instagram posts by keyword.
 * Tries hashtag/tag search endpoints, which is the closest to keyword search on Instagram.
 */
const searchPosts = async (query, limit = 50) => {
    const rawQuery = String(query || '').trim();
    // Strip wrapping quotes that the event monitor adds around multi-word phrases.
    const unquoted = rawQuery.replace(/^"|"$/g, '').trim();
    const cleanQuery = unquoted.replace(/^#/, '');
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);
    if (!cleanQuery) return [];

    // instagram120 has no general keyword/hashtag search endpoint — it can only
    // look up a username. Phrases with spaces or invalid handle chars can't be
    // resolved that way, so bail out cleanly instead of wasting an API call.
    if (!/^[A-Za-z0-9._]{1,30}$/.test(cleanQuery)) {
        console.log(`[Instagram] Skipping unsupported keyword query "${rawQuery}" — no general search endpoint`);
        return [];
    }

    // Fetch posts from the user matching the query
    try {
        const rawPosts = await fetchUserPosts(cleanQuery);
        if (!rawPosts) return [];

        // Response nests posts under .result.edges or .items
        const edges = rawPosts.result?.edges || rawPosts.edges || rawPosts.items || (Array.isArray(rawPosts) ? rawPosts : []);
        if (!Array.isArray(edges) || edges.length === 0) return [];

        const normalized = edges.slice(0, safeLimit).map(p => {
            const node = p.node || p;
            return {
                id: node.id || node.pk || node.code || node.shortcode || '',
                text: node.caption?.text || node.edge_media_to_caption?.edges?.[0]?.node?.text || node.text || '',
                author: node.user?.full_name || node.owner?.full_name || cleanQuery,
                author_handle: node.user?.username || node.owner?.username || cleanQuery,
                author_avatar: node.user?.profile_pic_url || node.owner?.profile_pic_url || '',
                url: (node.shortcode || node.code)
                    ? `https://www.instagram.com/p/${node.shortcode || node.code}/`
                    : '',
                created_at: node.taken_at
                    ? new Date(node.taken_at * 1000).toISOString()
                    : (node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : new Date().toISOString()),
                media: node.image_versions2
                    ? [{ url: node.image_versions2.candidates?.[0]?.url, type: 'photo' }]
                    : (node.display_url ? [{ url: node.display_url, type: 'photo' }]
                        : (node.thumbnail_src ? [{ url: node.thumbnail_src, type: 'photo' }] : [])),
                metrics: {
                    likes: node.like_count || node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
                    comments: node.comment_count || node.edge_media_to_comment?.count || 0,
                    views: node.view_count || node.play_count || node.video_view_count || 0
                },
                platform: 'instagram'
            };
        }).filter(p => p.id);

        if (normalized.length > 0) {
            console.log(`[Instagram] Found ${normalized.length} posts for user '${cleanQuery}'`);
        }
        return normalized;
    } catch (err) {
        console.warn(`[Instagram] Posts lookup failed for '${cleanQuery}':`, err.message);
    }

    return [];
};

/**
 * Whether Instagram is usable for the tenant in scope.
 *
 * Kept because the monitor skips a scan rather than logging an error when a
 * platform is unconfigured. The authoritative check is the BluGate call itself,
 * which fails closed — this is only to avoid a pointless scan.
 */
const isInstagramConfigured = () => blugate.isConfigured('instagram');

module.exports = {
    fetchUserPosts,
    fetchUserStories,
    fetchUserProfile,
    fetchUserProfileById,
    inferUsernameFromProfileUrl,
    fetchInstagramPostDetail,
    searchUsers,
    searchPosts,
    isInstagramConfigured,
    extractInstagramLocation
};
