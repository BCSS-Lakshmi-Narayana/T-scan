const axios = require('axios');

const blugate = require('./blugate');

/**
 * Every X request this service makes.
 *
 * The transport is BluGate: it holds the upstream twitter241 credentials, meters
 * each tenant's usage, and returns the provider payload unchanged — so every
 * parser below still sees exactly the shapes it saw when this service called
 * RapidAPI directly.
 *
 * Callers pass `endpoint` (e.g. 'user-tweets'); the path is resolved against the
 * BluGate endpoint catalogue, so no provider URL is spelled out here or at any
 * call site.
 *
 * Retries and the global rate-limit pause are kept: BluGate meters quota, but a
 * 429 or a network blip still benefits from backing off rather than hammering
 * the gateway on behalf of every source in the cycle.
 */
const rapidRequestX = async (config, retryCount = 0) => {
    const maxRetries = Math.max(1, parseInt(process.env.RAPIDAPI_X_MAX_RETRIES || '3', 10));
    const baseDelay = Math.max(1000, parseInt(process.env.RAPIDAPI_X_RETRY_DELAY_MS || '4000', 10));
    const requestTimeout = Math.max(15000, parseInt(process.env.RAPIDAPI_X_TIMEOUT_MS || '45000', 10));

    try {
        // Global rate-limit pause: if a 429 triggered a global pause, wait it out
        if (Date.now() < globalRateLimitPauseUntil) {
            const waitMs = globalRateLimitPauseUntil - Date.now();
            console.warn(`[BluGate:X] ⏸️ Global rate-limit pause active — waiting ${Math.ceil(waitMs / 1000)}s`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        // Throttle: enforce a minimum gap between requests
        const elapsed = Date.now() - lastRequestTime;
        if (elapsed < MIN_REQUEST_GAP_MS) {
            await new Promise(r => setTimeout(r, MIN_REQUEST_GAP_MS - elapsed));
        }
        lastRequestTime = Date.now();

        const data = await blugate.callByPath('x', config.endpoint, config.params || {}, {
            timeout: requestTimeout,
        });
        // The call sites read `response.data`, the axios shape they were written
        // against; keeping it means none of them had to change.
        return { data, status: 200 };
    } catch (error) {
        const status = error.status || error.response?.status;
        const msg = error.message || '';
        const isTimeoutOrNetwork =
            !status ||
            ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code) ||
            msg.includes('timeout') ||
            msg.includes('network');
        const is5xx = status >= 500 && status <= 599;

        // A missing credential or a disabled platform will not fix itself on a
        // retry — surface it immediately instead of burning the backoff budget.
        if (error.code === 'BLUGATE_NOT_CONFIGURED' || error.code === 'ENDPOINT_UNSUPPORTED') {
            throw error;
        }

        if (status === 429 && retryCount < maxRetries) {
            const delay = baseDelay * (retryCount + 1);
            console.warn(`[BluGate:X] Rate limited (429). Retrying in ${delay / 1000}s... (attempt ${retryCount + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
            return rapidRequestX(config, retryCount + 1);
        }

        if (status === 429) {
            globalRateLimitPauseUntil = Date.now() + GLOBAL_RATE_LIMIT_PAUSE_MS;
            console.error(`[BluGate:X] 🛑 Rate limit exhausted after ${maxRetries} retries. Global pause for ${GLOBAL_RATE_LIMIT_PAUSE_MS / 1000}s`);
            const err = new Error('Rate limit exhausted (429)');
            err.isRateLimit = true;
            throw err;
        }

        if ((isTimeoutOrNetwork || is5xx) && retryCount < maxRetries) {
            const delay = baseDelay * (retryCount + 1);
            console.warn(`[BluGate:X] Transient error (${error.code || status || 'network'}). Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return rapidRequestX(config, retryCount + 1);
        }

        console.error(`[BluGate:X] Request failed (${status || 'network'}): ${msg}`);
        throw error;
    }
};

const rapidGet = async (endpoint, params = {}) => {
    const cleanEndpoint = String(endpoint || '').replace(/^\/+/, '').trim();
    if (!cleanEndpoint) {
        throw new Error('Endpoint is required');
    }

    const endpointKey = cleanEndpoint;
    if (unsupportedEndpointCache.has(endpointKey)) {
        const err = new Error(`Endpoint '${cleanEndpoint}' is not available through BluGate`);
        err.code = 'ENDPOINT_UNSUPPORTED';
        throw err;
    }

    const response = await rapidRequestX({
        method: 'get',
        endpoint: cleanEndpoint,
        params
    });

    return response.data;
};

const userIdCache = new Map();
const unsupportedEndpointCache = new Set();
const tweetFetchCache = new Map();
const handleFailureCooldown = new Map();

const TWEET_FETCH_CACHE_TTL_MS = Math.max(10000, parseInt(process.env.RAPIDAPI_X_TWEET_CACHE_MS || '45000', 10));
const HANDLE_FAILURE_COOLDOWN_MS = Math.max(15000, parseInt(process.env.RAPIDAPI_X_HANDLE_COOLDOWN_MS || '90000', 10));
const MAX_TWEET_FETCH_CACHE_ENTRIES = Math.max(20, parseInt(process.env.RAPIDAPI_X_TWEET_CACHE_MAX || '300', 10));

// Global rate-limit backoff: when 429 is hit after all retries, pause ALL requests
let globalRateLimitPauseUntil = 0;
const GLOBAL_RATE_LIMIT_PAUSE_MS = Math.max(30000, parseInt(process.env.RAPIDAPI_X_GLOBAL_PAUSE_MS || '60000', 10));

// Per-request throttle: minimum gap between API calls to avoid burst-hitting rate limits
let lastRequestTime = 0;
const MIN_REQUEST_GAP_MS = Math.max(200, parseInt(process.env.RAPIDAPI_X_MIN_GAP_MS || '500', 10));

const getTweetCacheKey = (handle, limit) => `${String(handle || '').toLowerCase()}::${limit}`;

const getCachedTweets = (cacheKey) => {
    const entry = tweetFetchCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        tweetFetchCache.delete(cacheKey);
        return null;
    }
    return entry.payload;
};

const setCachedTweets = (cacheKey, payload) => {
    if (tweetFetchCache.size >= MAX_TWEET_FETCH_CACHE_ENTRIES) {
        const oldestKey = tweetFetchCache.keys().next().value;
        if (oldestKey) tweetFetchCache.delete(oldestKey);
    }
    tweetFetchCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + TWEET_FETCH_CACHE_TTL_MS
    });
};

const pickBestVideoVariant = (variants = []) => {
    if (!Array.isArray(variants) || variants.length === 0) return null;

    // Prefer HLS, then highest bitrate MP4
    let bestVariant = variants.find(v => v.content_type === 'application/x-mpegURL');
    if (!bestVariant) {
        bestVariant = variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    }
    return bestVariant || null;
};

const getMediaUrlCandidates = (media) => {
    const primary = media?.media_url_https || media?.media_url || media?.url || media?.image_url || media?.image?.url;
    const preview = media?.media_url_https || media?.media_url || media?.preview_image_url || media?.thumbnail_url || media?.image_url || media?.image?.url || primary;
    return { primary, preview };
};

const extractUserResultFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;

    const direct = payload?.result?.data?.user?.result ||
        payload?.result?.data?.userResult?.result ||
        payload?.data?.user?.result ||
        payload?.user?.result ||
        payload?.result?.user?.result ||
        payload?.result?.userResult?.result ||
        payload?.data?.result?.user?.result ||
        payload?.result;

    const isUserLike = (node) => {
        if (!node || typeof node !== 'object') return false;
        const hasId = !!(node.rest_id || node.id || node.id_str);
        const hasHandle = !!(
            node?.legacy?.screen_name ||
            node?.core?.screen_name ||
            node?.screen_name ||
            node?.username ||
            node?.handle
        );
        const userType = String(node?.__typename || '').toLowerCase();
        return (hasId && hasHandle) || userType.includes('user');
    };

    if (isUserLike(direct)) return direct;

    // Deep-search fallback for variable RapidAPI payload wrappers.
    const stack = [payload];
    const seen = new Set();
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);

        if (isUserLike(node)) return node;

        if (Array.isArray(node)) {
            for (const item of node) stack.push(item);
            continue;
        }

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') stack.push(value);
        }
    }

    return direct || payload;
};

const normalizeMediaItem = (media) => {
    if (!media) return null;

    let type = media.type || media.media_type || 'photo';
    const { primary, preview } = getMediaUrlCandidates(media);
    let url = primary;

    if (!type && media.video_info) type = 'video';

    if (media.type === 'video' || media.type === 'animated_gif' || type === 'video' || type === 'animated_gif') {
        type = media.type || type;

        const variant = pickBestVideoVariant(media.video_info?.variants || []);
        if (variant?.url) {
            url = variant.url;
        } else if (media.video_url) {
            url = media.video_url;
        } else if (media.player_stream_url) {
            url = media.player_stream_url;
        } else if (media.url && media.url !== primary) {
            url = media.url;
        }
    }

    if (!url) return null;

    return { type, url, preview: preview || url };
};

const fetchUserProfile = async (handle) => {
    try {
        let cleanHandle = String(handle || '').trim();
        
        // Extract handle from URL
        if (/^https?:\/\//i.test(cleanHandle) || /x\.com\//i.test(cleanHandle) || /twitter\.com\//i.test(cleanHandle)) {
            try {
                const url = new URL(cleanHandle.startsWith('http') ? cleanHandle : `https://${cleanHandle}`);
                const segments = url.pathname.split('/').filter(Boolean);
                if (segments.length > 0) cleanHandle = segments[0];
            } catch { /* fall through */ }
        }
        
        cleanHandle = cleanHandle.replace(/^@/, '').trim().toLowerCase();
        console.log(`[RapidAPI] Fetching profile for ${cleanHandle}...`);

        const userResponse = await rapidRequestX({
            method: 'get',
            endpoint: 'user',
            params: { username: cleanHandle }
        });

        if (userResponse.data?.errors || userResponse.data?.error) {
            throw new Error(`RapidAPI Error: ${JSON.stringify(userResponse.data.errors || userResponse.data.error)}`);
        }

        const result = extractUserResultFromPayload(userResponse.data);

        if (!result) return null;

        const userId = result.rest_id;
        const freshVerified = result.is_blue_verified || result.legacy?.verified || false;
        const freshImage = result.avatar?.image_url ||
            result.legacy?.profile_image_url_https ||
            result.profile_image_url_https;

        // Update cache
        if (userId) userIdCache.set(cleanHandle, userId);
        userIdCache.set(cleanHandle + '_meta', { isVerified: freshVerified, profileImageUrl: freshImage });

        return {
            id: userId,
            isVerified: freshVerified,
            profileImageUrl: freshImage,
            name: result.legacy?.name,
            screenName: result.legacy?.screen_name
        };
    } catch (error) {
        console.warn(`[RapidAPI] Profile fetch failed for ${handle}:`, error.message);
        return null;
    }
};

const fetchUserProfileById = async (userId) => {
    try {
        const cleanUserId = String(userId || '').trim();
        if (!cleanUserId) return null;

        const endpointAttempts = [
            {
                path: 'get-users',
                paramsCandidates: [
                    { users: cleanUserId },
                    { users: `${cleanUserId},` }
                ]
            },
            {
                path: 'user',
                paramsCandidates: [
                    { user_id: cleanUserId },
                    { userId: cleanUserId },
                    { id: cleanUserId },
                    { rest_id: cleanUserId }
                ]
            },
            {
                path: 'user-by-id',
                paramsCandidates: [
                    { user_id: cleanUserId },
                    { userId: cleanUserId },
                    { id: cleanUserId }
                ]
            },
            {
                path: 'user-v2',
                paramsCandidates: [
                    { user_id: cleanUserId },
                    { userId: cleanUserId },
                    { id: cleanUserId }
                ]
            }
        ];

        let result = null;
        for (const attempt of endpointAttempts) {
            for (const params of attempt.paramsCandidates) {
                try {
                    const response = await rapidRequestX({
                        method: 'get',
                        endpoint: attempt.path,
                        params
                    });
                    result = extractUserResultFromPayload(response.data);
                    if (result) break;
                } catch {
                    // Try next endpoint/parameter variant
                }
            }
            if (result) break;
        }

        if (!result) return null;

        const resolvedId = result.rest_id || cleanUserId;
        const freshVerified = result.is_blue_verified || result.legacy?.verified || false;
        const freshImage = result.avatar?.image_url ||
            result.legacy?.profile_image_url_https ||
            result.profile_image_url_https;

        const screenNameRaw =
            result?.legacy?.screen_name ||
            result?.core?.screen_name ||
            result?.screen_name ||
            result?.username ||
            result?.handle ||
            null;
        const screenName = screenNameRaw ? String(screenNameRaw).replace(/^@/, '') : null;
        if (screenName) {
            userIdCache.set(String(screenName).toLowerCase(), resolvedId);
            userIdCache.set(String(screenName).toLowerCase() + '_meta', { isVerified: freshVerified, profileImageUrl: freshImage });
        }

        return {
            id: resolvedId,
            isVerified: freshVerified,
            profileImageUrl: freshImage,
            name: result.legacy?.name || result.core?.name || null,
            screenName
        };
    } catch (error) {
        console.warn(`[RapidAPI] Profile-by-id fetch failed for ${userId}:`, error.message);
        return null;
    }
};

const fetchUserTweets = async (handle, limit = 20) => {
    try {
        let cleanHandle = String(handle || '').trim();
        
        // Extract handle from URL if it's a full X/Twitter URL
        if (/^https?:\/\//i.test(cleanHandle) || /x\.com\//i.test(cleanHandle) || /twitter\.com\//i.test(cleanHandle)) {
            try {
                const url = new URL(cleanHandle.startsWith('http') ? cleanHandle : `https://${cleanHandle}`);
                const segments = url.pathname.split('/').filter(Boolean);
                if (segments.length > 0) {
                    cleanHandle = segments[0];
                }
            } catch { /* fall through */ }
        }
        
        cleanHandle = cleanHandle.replace(/^@/, '').trim().toLowerCase();
        
        // Skip obvious non-handles (contain spaces, too long, etc.)
        if (!cleanHandle || cleanHandle.includes(' ') || cleanHandle.length > 50) {
            console.warn(`[RapidAPI] ⚠️ Invalid X handle: "${handle}" → skipping`);
            return { tweets: [], userData: null };
        }
        
        const isNumericIdentifier = /^\d{6,}$/.test(cleanHandle);
        const cacheKey = getTweetCacheKey(cleanHandle, limit);
        const cachedPayload = getCachedTweets(cacheKey);
        if (cachedPayload) {
            console.log(`[RapidAPI] 💾 Cache hit for @${cleanHandle} — ${cachedPayload?.tweets?.length || 0} tweets (TTL ${TWEET_FETCH_CACHE_TTL_MS / 1000}s)`);
            return cachedPayload;
        }

        const cooldownUntil = handleFailureCooldown.get(cleanHandle);
        if (cooldownUntil && Date.now() < cooldownUntil) {
            const waitMs = cooldownUntil - Date.now();
            console.warn(`[RapidAPI] ⏳ @${cleanHandle} in cooldown — waiting ${Math.ceil(waitMs / 1000)}s before fetching`);
            await new Promise(r => setTimeout(r, waitMs));
            handleFailureCooldown.delete(cleanHandle);
        }

        console.log(`[RapidAPI] Fetching tweets for ${cleanHandle}...`);

        let userId = userIdCache.get(cleanHandle);

        if (!userId && isNumericIdentifier) {
            userId = cleanHandle;
            userIdCache.set(cleanHandle, userId);
        }

        if (!userId) {
            const userResponse = await rapidRequestX({
                method: 'get',
                endpoint: 'user',
                params: { username: cleanHandle }
            });

            if (userResponse.data?.errors || userResponse.data?.error) {
                const errMsg = JSON.stringify(userResponse.data.errors || userResponse.data.error);
                console.warn(`[RapidAPI] API returned errors for ${cleanHandle}: ${errMsg}`);
                // return null instead of throwing to allow other sources to proceed
                return null;
            }

            let result = null;

            if (userResponse.data?.result?.data?.user?.result) {
                result = userResponse.data.result.data.user.result;
            } else if (userResponse.data?.result?.data?.userResult?.result) {
                result = userResponse.data.result.data.userResult.result;
            } else if (userResponse.data?.data?.user?.result) {
                result = userResponse.data.data.user.result;
            } else if (userResponse.data?.result?.rest_id) {
                result = userResponse.data.result;
            } else if (userResponse.data?.user?.result) {
                result = userResponse.data.user.result;
            } else if (userResponse.data?.rest_id) {
                result = userResponse.data;
            } else {
                console.warn(`[RapidAPI] User structure mismatch for ${cleanHandle}. Response:`, JSON.stringify(userResponse.data).substring(0, 500));
            }

            if (!result || !result.rest_id) {
                console.warn(`[RapidAPI] User identification failed for: ${handle}`);
                return null;
            }

            userId = result.rest_id;
            userIdCache.set(cleanHandle, userId);

            const freshVerified = result.is_blue_verified || result.legacy?.verified || false;
            const freshImage = result.avatar?.image_url ||
                result.legacy?.profile_image_url_https ||
                result.profile_image_url_https;
            userIdCache.set(cleanHandle + '_meta', { isVerified: freshVerified, profileImageUrl: freshImage });
        }

        const perPage = Math.min(limit, 40); // per-page count sent to API
        const maxPages = Math.min(Math.ceil(limit / 20), 5); // max pagination rounds (cap at 5 to avoid runaway)
        const tweetEndpointAttempts = [
            { path: 'user-tweets', paramKey: 'user' },
            { path: 'user-tweets', paramKey: 'user_id' }
        ];

        // Initialize with cached metadata
        const cachedMeta = userIdCache.get(cleanHandle + '_meta');
        let isVerified = cachedMeta?.isVerified || false;
        let profileImageUrl = cachedMeta?.profileImageUrl || null;

        const tweets = [];
        let workingEndpoint = null;

        for (const attempt of tweetEndpointAttempts) {
            let cursor = null;

            for (let page = 0; page < maxPages; page++) {
                try {
                    const params = { [attempt.paramKey]: userId, count: perPage };
                    if (cursor) params.cursor = cursor;

                    const tweetsResponse = await rapidRequestX({
                        method: 'get',
                        endpoint: attempt.path,
                        params
                    });

                    const instructions =
                        tweetsResponse?.data?.result?.timeline?.instructions ||
                        tweetsResponse?.data?.timeline?.instructions ||
                        tweetsResponse?.data?.data?.user?.result?.timeline?.instructions ||
                        [];

                    // ── Robust extraction: handle ALL instruction types ──
                    // Twitter timeline returns multiple instruction types:
                    //   TimelineAddEntries — main timeline entries (tweets, conversations, cursors)
                    //   TimelinePinEntry   — pinned tweet
                    //   TimelineAddToModule — module-grouped tweets
                    //   TimelineClearCache  — ignore
                    const allRawTweets = [];
                    let bottomCursor = null;

                    // Helper: extract tweet from any nested structure
                    const extractTweetFromContent = (content) => {
                        if (!content) return null;
                        return content.itemContent?.tweet_results?.result ||
                               content.tweetResult?.result ||
                               content.tweet_results?.result ||
                               null;
                    };

                    for (const instruction of instructions) {
                        // 1. TimelineAddEntries (main timeline)
                        if (instruction.type === 'TimelineAddEntries' || instruction.entries) {
                            const entries = instruction.entries || [];
                            for (const entry of entries) {
                                const entryId = entry.entryId || entry.sortIndex || '';

                                // Cursor entries → extract cursor, skip tweet extraction
                                if (entryId.startsWith('cursor-bottom') || entry.content?.cursorType === 'Bottom') {
                                    bottomCursor = entry.content?.value || entry.content?.itemContent?.value || null;
                                    continue;
                                }
                                if (entryId.startsWith('cursor-top') || entry.content?.cursorType === 'Top') continue;

                                // Single tweet entry (tweet-{id})
                                const singleRaw = extractTweetFromContent(entry.content);
                                if (singleRaw) {
                                    allRawTweets.push({ raw: singleRaw, source: entryId });
                                    continue;
                                }

                                // Multi-item entries: conversations, threads, modules
                                const items = entry.content?.items || entry.items || [];
                                if (items.length > 0) {
                                    for (const item of items) {
                                        const nested = extractTweetFromContent(item?.item?.itemContent ? item.item : null) ||
                                                       extractTweetFromContent(item?.item) ||
                                                       extractTweetFromContent(item);
                                        if (nested) {
                                            allRawTweets.push({ raw: nested, source: `${entryId}:nested` });
                                        }
                                    }
                                    continue;
                                }

                                // Promoted tweet entries (skip silently)
                                if (entryId.startsWith('promoted-') || entryId.startsWith('who-to-follow') || entryId.startsWith('profile-grid')) continue;

                                // Unknown entry type — log for debugging
                                console.log(`[RapidAPI] 🔍 Unknown entry type for @${cleanHandle}: id=${entryId}, keys=${Object.keys(entry.content || {}).join(',')}`);
                            }
                        }

                        // 2. TimelinePinEntry (pinned tweet)
                        if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
                            const pinRaw = extractTweetFromContent(instruction.entry?.content);
                            if (pinRaw) {
                                allRawTweets.push({ raw: pinRaw, source: 'pinned' });
                            }
                        }

                        // 3. TimelineAddToModule (module-grouped items)
                        if (instruction.type === 'TimelineAddToModule' && instruction.moduleItems) {
                            for (const modItem of instruction.moduleItems) {
                                const modRaw = extractTweetFromContent(modItem?.item?.itemContent ? modItem.item : null) ||
                                               extractTweetFromContent(modItem?.item) ||
                                               extractTweetFromContent(modItem);
                                if (modRaw) {
                                    allRawTweets.push({ raw: modRaw, source: 'module' });
                                }
                            }
                        }
                    }

                    if (allRawTweets.length === 0 && page === 0) break; // this endpoint doesn't work, try next

                    // Normalize and deduplicate
                    let newTweets = 0;
                    const seenIds = new Set(tweets.map(t => t.id));
                    let normalizeFailures = 0;

                    for (const { raw, source } of allRawTweets) {
                        const normalized = normalizeTweet(raw, cleanHandle);
                        if (!normalized) {
                            normalizeFailures++;
                            continue;
                        }
                        if (seenIds.has(normalized.id)) continue; // skip duplicates across pages/entries
                        seenIds.add(normalized.id);
                        tweets.push(normalized);
                        newTweets++;
                        if (!profileImageUrl && normalized.author_avatar) profileImageUrl = normalized.author_avatar;
                        if (normalized.verified !== undefined) isVerified = normalized.verified;
                    }

                    if (normalizeFailures > 0) {
                        console.log(`[RapidAPI] ⚠️ ${normalizeFailures} tweets failed normalization for @${cleanHandle} (page ${page})`);
                    }
                    console.log(`[RapidAPI] Page ${page}: ${allRawTweets.length} raw entries → ${newTweets} new tweets for @${cleanHandle} (total: ${tweets.length})`);

                    workingEndpoint = attempt.path;

                    // Stop if we have enough tweets, or no cursor for next page
                    const noRealContent = newTweets === 0 && allRawTweets.length === 0;
                    if (tweets.length >= limit || noRealContent || !bottomCursor || bottomCursor === cursor) break;
                    cursor = bottomCursor;
                } catch (endpointError) {
                    if (endpointError?.response?.status !== 404) {
                        console.warn(`[RapidAPI] ${attempt.path} page ${page} failed for ${cleanHandle}: ${endpointError.message}`);
                    }
                    break;
                }
            }

            if (tweets.length > 0) break; // found a working endpoint with results
        }

        console.log(`[RapidAPI] Fetched ${tweets.length} tweets for @${cleanHandle} (endpoint: ${workingEndpoint || 'none'}, limit: ${limit})${tweets.length > 0 ? ` — newest: ${tweets[0]?.created_at?.toISOString?.() || 'N/A'}` : ''}`);

        const payload = {
            tweets,
            userData: { isVerified, profileImageUrl }
        };
        setCachedTweets(cacheKey, payload);
        handleFailureCooldown.delete(cleanHandle);
        return payload;


    } catch (error) {
        console.error(`[RapidAPI] Error fetching tweets for ${handle}:`, error.message);
        const cleanHandle = String(handle || '').replace('@', '').trim();
        // Only cooldown the handle for handle-specific errors (not global rate limits)
        if (cleanHandle && !error.isRateLimit) {
            handleFailureCooldown.set(cleanHandle, Date.now() + HANDLE_FAILURE_COOLDOWN_MS);
        } else if (error.isRateLimit) {
            console.warn(`[RapidAPI] ⚠️ Skipping handle cooldown for @${cleanHandle} — error is global rate limit, not handle-specific`);
        }
        // Return null so callers (monitorXSource) know this was an error, not "no tweets"
        return null;
    }
};

/**
 * Fetch ALL user tweets since a given date, paginating through as many pages as needed.
 * Unlike fetchUserTweets (which has a fixed limit), this keeps going until tweets are older than sinceDate.
 * Used by engager analysis to ensure full 30-day coverage.
 * @param {string} handle - Twitter handle
 * @param {Date} sinceDate - Stop fetching when tweets are older than this
 * @param {number} maxTweets - Safety cap (default 200)
 * @returns {{ tweets: Array, userData: Object }}
 */
const fetchAllUserTweetsSince = async (handle, sinceDate, maxTweets = 200) => {
    try {
        let cleanHandle = String(handle || '').trim();
        
        // Extract handle from URL
        if (/^https?:\/\//i.test(cleanHandle) || /x\.com\//i.test(cleanHandle) || /twitter\.com\//i.test(cleanHandle)) {
            try {
                const url = new URL(cleanHandle.startsWith('http') ? cleanHandle : `https://${cleanHandle}`);
                const segments = url.pathname.split('/').filter(Boolean);
                if (segments.length > 0) cleanHandle = segments[0];
            } catch { /* fall through */ }
        }
        
        cleanHandle = cleanHandle.replace(/^@/, '').trim().toLowerCase();
        const isNumericIdentifier = /^\d{6,}$/.test(cleanHandle);

        const cooldownUntil = handleFailureCooldown.get(cleanHandle);
        if (cooldownUntil && Date.now() < cooldownUntil) {
            const waitMs = cooldownUntil - Date.now();
            console.warn(`[RapidAPI] ⏳ @${cleanHandle} in cooldown — waiting ${Math.ceil(waitMs / 1000)}s before fetchAllSince`);
            await new Promise(r => setTimeout(r, waitMs));
            handleFailureCooldown.delete(cleanHandle);
        }

        console.log(`[RapidAPI] Fetching all tweets for @${cleanHandle} since ${sinceDate.toISOString()}...`);

        let userId = userIdCache.get(cleanHandle);
        if (!userId && isNumericIdentifier) {
            userId = cleanHandle;
            userIdCache.set(cleanHandle, userId);
        }

        if (!userId) {
            const userResponse = await rapidRequestX({
                method: 'get',
                endpoint: 'user',
                params: { username: cleanHandle }
            });

            if (userResponse.data?.errors || userResponse.data?.error) {
                console.warn(`[RapidAPI] API returned errors for ${cleanHandle}`);
                return { tweets: [], userData: {} };
            }

            let result =
                userResponse.data?.result?.data?.user?.result ||
                userResponse.data?.result?.data?.userResult?.result ||
                userResponse.data?.data?.user?.result ||
                userResponse.data?.result ||
                userResponse.data?.user?.result ||
                userResponse.data;

            if (!result?.rest_id) {
                console.warn(`[RapidAPI] User identification failed for: ${handle}`);
                return { tweets: [], userData: {} };
            }

            userId = result.rest_id;
            userIdCache.set(cleanHandle, userId);

            const freshVerified = result.is_blue_verified || result.legacy?.verified || false;
            const freshImage = result.avatar?.image_url || result.legacy?.profile_image_url_https || result.profile_image_url_https;
            userIdCache.set(cleanHandle + '_meta', { isVerified: freshVerified, profileImageUrl: freshImage });
        }

        const endpoints = [
            { path: 'user-tweets', paramKey: 'user' },
            { path: 'user-tweets', paramKey: 'user_id' }
        ];

        const cachedMeta = userIdCache.get(cleanHandle + '_meta');
        let isVerified = cachedMeta?.isVerified || false;
        let profileImageUrl = cachedMeta?.profileImageUrl || null;

        const tweets = [];
        const maxPages = 10; // safety cap

        for (const endpoint of endpoints) {
            let cursor = null;
            let reachedDateBoundary = false;

            for (let page = 0; page < maxPages; page++) {
                try {
                    const params = { [endpoint.paramKey]: userId, count: 40 };
                    if (cursor) params.cursor = cursor;

                    const resp = await rapidRequestX({
                        method: 'get',
                        endpoint: endpoint.path,
                        params
                    });

                    const instructions =
                        resp?.data?.result?.timeline?.instructions ||
                        resp?.data?.timeline?.instructions ||
                        resp?.data?.data?.user?.result?.timeline?.instructions ||
                        [];

                    // Robust extraction: handle all instruction types
                    const allRawTweets = [];
                    let pageCursor = null;

                    const extractTweetFromContentSince = (content) => {
                        if (!content) return null;
                        return content.itemContent?.tweet_results?.result ||
                               content.tweetResult?.result ||
                               content.tweet_results?.result ||
                               null;
                    };

                    for (const instruction of instructions) {
                        if (instruction.type === 'TimelineAddEntries' || instruction.entries) {
                            for (const entry of (instruction.entries || [])) {
                                const entryId = entry.entryId || '';
                                if (entryId.startsWith('cursor-bottom') || entry.content?.cursorType === 'Bottom') {
                                    pageCursor = entry.content?.value || entry.content?.itemContent?.value || null;
                                    continue;
                                }
                                if (entryId.startsWith('cursor-')) continue;

                                const singleRaw = extractTweetFromContentSince(entry.content);
                                if (singleRaw) { allRawTweets.push(singleRaw); continue; }

                                const items = entry.content?.items || entry.items || [];
                                for (const item of items) {
                                    const nested = extractTweetFromContentSince(item?.item?.itemContent ? item.item : null) ||
                                                   extractTweetFromContentSince(item?.item) ||
                                                   extractTweetFromContentSince(item);
                                    if (nested) allRawTweets.push(nested);
                                }
                            }
                        }
                        if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
                            const pinRaw = extractTweetFromContentSince(instruction.entry?.content);
                            if (pinRaw) allRawTweets.push(pinRaw);
                        }
                        if (instruction.type === 'TimelineAddToModule' && instruction.moduleItems) {
                            for (const modItem of instruction.moduleItems) {
                                const modRaw = extractTweetFromContentSince(modItem?.item?.itemContent ? modItem.item : null) ||
                                               extractTweetFromContentSince(modItem?.item) ||
                                               extractTweetFromContentSince(modItem);
                                if (modRaw) allRawTweets.push(modRaw);
                            }
                        }
                    }

                    if (allRawTweets.length === 0 && page === 0) break; // endpoint doesn't work

                    let newTweets = 0;
                    const seenIds = new Set(tweets.map(t => t.id));

                    for (const rawTweet of allRawTweets) {
                        const normalized = normalizeTweet(rawTweet, cleanHandle);
                        if (!normalized) continue;
                        if (seenIds.has(normalized.id)) continue;
                        seenIds.add(normalized.id);
                        // Check if tweet is older than sinceDate
                        if (normalized.created_at && new Date(normalized.created_at) < sinceDate) {
                            reachedDateBoundary = true;
                            continue;
                        }
                        tweets.push(normalized);
                        newTweets++;
                        if (!profileImageUrl && normalized.author_avatar) profileImageUrl = normalized.author_avatar;
                        if (normalized.verified !== undefined) isVerified = normalized.verified;
                    }

                    // Stop conditions: hit date boundary, safety cap, no raw entries, no cursor
                    if (reachedDateBoundary || tweets.length >= maxTweets || (newTweets === 0 && allRawTweets.length === 0) || !pageCursor || pageCursor === cursor) break;
                    cursor = pageCursor;
                } catch (err) {
                    if (err?.response?.status !== 404) {
                        console.warn(`[RapidAPI] ${endpoint.path} page ${page} failed for ${cleanHandle}: ${err.message}`);
                    }
                    break;
                }
            }

            if (tweets.length > 0) break;
        }

        console.log(`[RapidAPI] fetchAllUserTweetsSince: ${tweets.length} tweets for @${cleanHandle} since ${sinceDate.toISOString()}`);
        handleFailureCooldown.delete(cleanHandle);
        return { tweets, userData: { isVerified, profileImageUrl } };
    } catch (error) {
        console.error(`[RapidAPI] Error in fetchAllUserTweetsSince for ${handle}:`, error.message);
        const cleanHandle = String(handle || '').replace('@', '').trim();
        // Only cooldown the handle for handle-specific errors (not global rate limits)
        if (cleanHandle && !error.isRateLimit) {
            handleFailureCooldown.set(cleanHandle, Date.now() + HANDLE_FAILURE_COOLDOWN_MS);
        } else if (error.isRateLimit) {
            console.warn(`[RapidAPI] ⚠️ Skipping handle cooldown for @${cleanHandle} (fetchAllSince) — error is global rate limit`);
        }
        return null;
    }
};

const searchUsers = async (query, limit = 30) => {
    try {
        const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
        const apiCount = Math.min(safeLimit, 20);
        console.log(`[RapidAPI] Searching users for: ${query}`);
        const cleanQuery = query.replace('@', '').trim();

        const extractUsersFromEntries = (entries) => {
            const users = [];
            for (const entry of entries) {
                const userResult = entry?.content?.itemContent?.user_results?.result ||
                    entry?.content?.itemContent?.userDisplayType?.user_results?.result ||
                    entry?.content?.itemContent?.user_result?.result;

                if (!userResult) continue;
                const legacy = userResult.legacy || {};
                const core = userResult.core || {};
                // API now puts name/screen_name in core, not legacy
                const screenName = core.screen_name || legacy.screen_name || '';
                if (!screenName) continue;

                users.push({
                    id: userResult.rest_id,
                    name: core.name || legacy.name || cleanQuery,
                    screen_name: screenName,
                    description: userResult.profile_bio?.description || legacy.description || '',
                    profile_image_url: userResult.avatar?.image_url || legacy.profile_image_url_https || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
                    followers_count: legacy.followers_count || 0,
                    friends_count: legacy.friends_count || 0,
                    verified: userResult.is_blue_verified || userResult.verification?.verified || legacy.verified || false,
                    platform: 'x'
                });
            }
            return users;
        };

        // Use type: 'People' (the API requires this, not section: 'people')
        try {
            const searchResponse = await rapidRequestX({
                method: 'get',
                endpoint: 'search',
                params: {
                    query: cleanQuery,
                    type: 'People',
                    count: apiCount
                }
            });

            // Parse search results - handle multiple response structures
            const instructions = searchResponse.data?.result?.timeline?.instructions ||
                searchResponse.data?.timeline?.instructions ||
                searchResponse.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
                [];
            const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries ||
                instructions[0]?.entries || [];

            const users = extractUsersFromEntries(entries);

            if (users.length > 0) {
                console.log(`[RapidAPI] Found ${users.length} users matching "${query}"`);
                return users.slice(0, safeLimit);
            }
        } catch (searchError) {
            console.warn(`[RapidAPI] Search endpoint failed, falling back to exact lookup:`, searchError.message);
        }

        // Fallback: Try exact username lookup
        const response = await rapidRequestX({
            method: 'get',
            endpoint: 'user',
            params: { username: cleanQuery }
        });

        const result = response.data?.result?.data?.user?.result ||
            response.data?.data?.user?.result ||
            response.data?.result;

        if (result) {
            const legacy = result.legacy || {};
            const core = result.core || {};

            return [{
                id: result.rest_id,
                name: core.name || legacy.name || cleanQuery,
                screen_name: core.screen_name || legacy.screen_name || cleanQuery,
                description: result.profile_bio?.description || legacy.description || '',
                profile_image_url: result.avatar?.image_url || legacy.profile_image_url_https || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
                followers_count: legacy.followers_count || 0,
                friends_count: legacy.friends_count || 0,
                verified: result.is_blue_verified || result.verification?.verified || legacy.verified || false,
                platform: 'x'
            }];
        }

        return [];
    } catch (error) {
        console.warn(`[RapidAPI] User search failed for ${query}:`, error.message);
        return [];
    }
};

const resolveUser = (userResult) => {
    if (!userResult) return null;

    // Handle UserUnavailable / Tombstone
    if (userResult.__typename === 'UserUnavailable' || userResult.__typename === 'UserTombstone') {
        return null;
    }

    // Step 1: Deep Unwrapping Loop
    // This finds the "User" object (which contains legacy/core) if we pass it a wrapper or a Tweet
    let raw = userResult;
    for (let i = 0; i < 6; i++) {
        if (!raw || typeof raw !== 'object') break;

        // Common wrappers
        if (raw.result && typeof raw.result === 'object') raw = raw.result;
        else if (raw.user_results?.result) raw = raw.user_results.result;
        else if (raw.core?.user_results?.result) raw = raw.core.user_results.result;
        else if (raw.author_results?.result) raw = raw.author_results.result; // Seen in some v2 APIs
        else if (raw.user && typeof raw.user === 'object' && (raw.user.id || raw.user.rest_id)) raw = raw.user;
        else if (raw.data?.user) raw = raw.data.user;
        else if (raw.core && typeof raw.core === 'object' && (raw.core.screen_name || raw.core.name)) break;
        else break;
    }

    // Secondary unwrapping for TweetWithVisibilityResults style
    if (raw && (raw.__typename === 'UserWithVisibilityResults' || raw.__typename === 'User') && raw.user) {
        raw = raw.user;
    }

    if (!raw) return null;

    // Step 2: Extract core/legacy fields
    // Some APIs put 'core' and 'legacy' inside another 'core' or 'result'
    const legacy = raw.legacy || raw.core?.legacy || {};
    const core = raw.core || {};

    // Prioritize core (new API structure / Mathematical unicode names) then legacy then top-level
    const name = core.name || legacy.name || raw.name || core.screen_name || legacy.screen_name || raw.screen_name || 'Unknown User';
    const screen_name = core.screen_name || legacy.screen_name || raw.screen_name || 'unknown';

    // Avatar resolution with multiple fallbacks
    const avatar = core.avatar?.image_url ||
        legacy.profile_image_url_https ||
        raw.avatar?.image_url ||
        raw.profile_image_url_https ||
        'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png';

    const verified = core.is_blue_verified || legacy.verified || raw.is_blue_verified || raw.verified || false;

    if (!screen_name || screen_name === 'unknown') {
        // Log locally if we can't find a handle in a non-null object
        if (raw.id_str || raw.rest_id) {
            console.warn('[RapidAPI] Could not resolve screen_name for user ID:', raw.rest_id || raw.id_str);
        }
        return null;
    }

    // Profile location string ("Hyderabad, India") — free-text set by the user.
    // Twitter exposes this on `legacy.location` (sometimes also on `location.location`).
    const profileLocation = (
        legacy.location ||
        raw.location?.location ||
        (typeof raw.location === 'string' ? raw.location : null) ||
        core.location ||
        ''
    ).toString().trim() || null;

    return {
        name: name,
        screen_name: screen_name,
        profile_image_url_https: avatar,
        verified,
        id: raw.rest_id || raw.id_str || raw.id,
        profile_location: profileLocation
    };
};

const extractRetweeterUsers = (payload) => {
    const usersMap = new Map();

    const addUser = (candidate, retweetedAt = null) => {
        const resolved = resolveUser(candidate);
        if (!resolved?.screen_name) return;

        const key = resolved.screen_name.toLowerCase();
        const existing = usersMap.get(key);

        const normalized = {
            id: resolved.id || null,
            handle: resolved.screen_name,
            name: resolved.name || resolved.screen_name,
            avatar: resolved.profile_image_url_https || null,
            verified: !!resolved.verified,
            retweeted_at: retweetedAt ? new Date(retweetedAt) : null
        };

        if (!existing) {
            usersMap.set(key, normalized);
            return;
        }

        const oldTs = existing.retweeted_at ? new Date(existing.retweeted_at).getTime() : 0;
        const newTs = normalized.retweeted_at ? new Date(normalized.retweeted_at).getTime() : 0;
        if (newTs > oldTs) {
            existing.retweeted_at = normalized.retweeted_at;
        }
        if (!existing.avatar && normalized.avatar) existing.avatar = normalized.avatar;
        if (!existing.name && normalized.name) existing.name = normalized.name;
        existing.verified = existing.verified || normalized.verified;
        if (!existing.id && normalized.id) existing.id = normalized.id;
    };

    const addFromEntry = (entry) => {
        if (!entry || typeof entry !== 'object') return;

        const item = entry.content?.itemContent || entry.item?.itemContent || entry;
        const createdAt =
            item?.tweet_results?.result?.legacy?.created_at ||
            item?.tweet?.legacy?.created_at ||
            null;

        addUser(item?.user_results?.result, createdAt);
        addUser(item?.user_result?.result, createdAt);
        addUser(item?.user, createdAt);
        addUser(item?.tweet_results?.result, createdAt);
    };

    const walk = (node) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }

        if (node.user_results?.result) addUser(node.user_results.result);
        if (node.user_result?.result) addUser(node.user_result.result);
        if (node.user) addUser(node.user);
        if (node.tweet_results?.result) addUser(node.tweet_results.result, node.tweet_results.result?.legacy?.created_at);

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') walk(value);
        }
    };

    const instructions =
        payload?.result?.timeline?.instructions ||
        payload?.timeline?.instructions ||
        payload?.data?.timeline?.instructions ||
        payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
        [];

    instructions.forEach((instruction) => {
        const entries = instruction?.entries || [];
        entries.forEach((entry) => {
            addFromEntry(entry);
            const moduleItems = entry?.content?.items || entry?.items || [];
            moduleItems.forEach((mod) => addFromEntry(mod?.item || mod));
        });
    });

    const fallbackCollections = [
        payload?.result?.users,
        payload?.users,
        payload?.result?.data?.users,
        payload?.data?.users
    ];
    fallbackCollections.forEach((collection) => {
        if (Array.isArray(collection)) {
            collection.forEach((u) => addUser(u));
        }
    });

    walk(payload?.result?.data);
    walk(payload?.data?.data);

    return Array.from(usersMap.values());
};

/**
 * Unifies normalization of a raw tweet result from any RapidAPI endpoint into a standard format.
 * Handles: full text (note tweets), media, quoted content, reposts/retweets, and robust author resolution.
 */
const normalizeTweet = (tweetResult, fallbackHandle = 'unknown') => {
    if (!tweetResult) return null;

    let tweet = tweetResult;
    // Unwrap generic wrappers
    for (let i = 0; i < 6; i++) {
        if (!tweet || typeof tweet !== 'object') break;

        if (tweet.result) tweet = tweet.result;
        else if (tweet.tweet) tweet = tweet.tweet;
        else if (tweet.tweetResult) tweet = tweet.tweetResult;
        else if (tweet.tweet_results?.result) tweet = tweet.tweet_results.result;
        else if (tweet.data && typeof tweet.data === 'object') tweet = tweet.data;
        else if (tweet.__typename === 'TweetWithVisibilityResults' && tweet.tweet) tweet = tweet.tweet;
        else break;
    }

    if (tweet.__typename === 'TweetUnavailable' || tweet.__typename === 'TweetTombstone') {
        return null;
    }

    const legacy = tweet.legacy;
    if (!legacy) return null;

    // Helper to extract user raw from various possible locations in a tweet object
    const extractUserRaw = (obj) => {
        if (!obj) return null;
        return obj.core?.user_results?.result ||
            obj.user_results?.result ||
            obj.author ||
            obj.user ||
            obj.result?.user_results?.result ||
            obj.result?.user ||
            obj.author_results?.result ||
            obj.result?.author_results?.result ||
            (obj.legacy || obj.screen_name || obj.core ? obj : null);
    };

    // Recursively resolve author to handle nested retweets
    const resolveAuthorRecursive = (obj) => {
        if (!obj) return null;
        const resolved = resolveUser(extractUserRaw(obj));

        // Check for nested retweet structure
        let retweet = obj.retweeted_status_result?.result ||
            obj.result?.retweeted_status_result?.result ||
            obj.legacy?.retweeted_status_result?.result;

        if (retweet) {
            const nested = resolveAuthorRecursive(retweet);
            // Prioritize original author if successfully resolved
            if (nested && nested.screen_name !== 'unknown') return nested;
        }
        return resolved;
    };

    // 1. Resolve Main Author
    const mainUser = resolveAuthorRecursive(tweet) || {
        name: fallbackHandle,
        screen_name: fallbackHandle,
        profile_image_url_https: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
        verified: false
    };


    // 2. Handle Reposts / Retweets
    let retweetResult = legacy.retweeted_status_result?.result;
    if (retweetResult && retweetResult.result) retweetResult = retweetResult.result;
    if (retweetResult && retweetResult.tweet) retweetResult = retweetResult.tweet;

    const isRepost = !!retweetResult;
    let targetLegacy = legacy;
    let originalAuthor = null;
    let originalAuthorName = null;
    let originalAuthorAvatar = null;

    if (isRepost && retweetResult.legacy) {
        targetLegacy = retweetResult.legacy;

        let origUserRaw = retweetResult.core?.user_results?.result ||
            retweetResult.author ||
            retweetResult.user;

        const origUser = resolveUser(origUserRaw);
        if (origUser) {
            originalAuthor = origUser.screen_name;
            originalAuthorName = origUser.name;
            originalAuthorAvatar = origUser.profile_image_url_https;
        }
    }

    // 3. Extract Text (Handling Note Tweets / Long Posts)
    const targetNoteTweet = retweetResult?.note_tweet || tweet.note_tweet;
    const noteTweetText = targetNoteTweet?.note_tweet_results?.result?.text;
    let fullText = noteTweetText || targetLegacy.full_text || targetLegacy.text || '';

    // 4. Extract Quotes
    let quotedContent = null;
    let rawQuote = retweetResult?.quoted_status_result?.result ||
        retweetResult?.legacy?.quoted_status_result?.result ||
        tweet.quoted_status_result?.result ||
        tweet.quoted_status_result ||
        legacy.quoted_status_result?.result ||
        legacy.quoted_status_result;

    if (rawQuote) {
        // Handle wrappers for Quote
        let unwrappedQuote = rawQuote;
        for (let i = 0; i < 5; i++) {
            if (unwrappedQuote.result) unwrappedQuote = unwrappedQuote.result;
            else if (unwrappedQuote.tweet) unwrappedQuote = unwrappedQuote.tweet;
            else if (unwrappedQuote.tweet_results?.result) unwrappedQuote = unwrappedQuote.tweet_results.result;
            else if (unwrappedQuote.__typename === 'TweetWithVisibilityResults' && unwrappedQuote.tweet) unwrappedQuote = unwrappedQuote.tweet;
            else break;
        }

        // Check if the quote itself is a retweet, and if so, use the original tweet
        let targetQuote = unwrappedQuote;
        const qRetweetResult = unwrappedQuote.retweeted_status_result?.result ||
            unwrappedQuote.legacy?.retweeted_status_result?.result;

        if (qRetweetResult) {
            let unwrappedOrig = qRetweetResult;
            for (let i = 0; i < 3; i++) {
                if (unwrappedOrig.result) unwrappedOrig = unwrappedOrig.result;
                else if (unwrappedOrig.tweet) unwrappedOrig = unwrappedOrig.tweet;
                else break;
            }
            if (unwrappedOrig && unwrappedOrig.legacy) {
                targetQuote = unwrappedOrig;
            }
        }

        if (targetQuote.legacy) {
            const qLegacy = targetQuote.legacy;
            const qUser = resolveUser(extractUserRaw(targetQuote)) || {
                name: 'Unknown',
                screen_name: 'unknown',
                profile_image_url_https: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'
            };

            const qNoteTweet = targetQuote.note_tweet;
            let qText = qNoteTweet?.note_tweet_results?.result?.text || qLegacy.full_text || qLegacy.text || '';

            const qEntities = qLegacy.extended_entities || qLegacy.entities;
            const qMediaRaw = (qEntities?.media || []);
            const qMedia = qMediaRaw.map(normalizeMediaItem).filter(Boolean);

            quotedContent = {
                text: qText,
                author_name: qUser.name,
                author_handle: qUser.screen_name,
                profile_image_url: qUser.profile_image_url_https,
                media: qMedia,
                created_at: qLegacy.created_at ? new Date(qLegacy.created_at) : null
            };
        }
    }

    // NEW FALLBACK: Extract handle from permalink URL if quoted data is missing or incomplete
    if ((!quotedContent || quotedContent.author_handle === 'unknown') && (targetLegacy.is_quote_status || tweet.is_quote_status)) {
        const permalink = targetLegacy.quoted_status_permalink || tweet.quoted_status_permalink;
        if (permalink) {
            const urlStr = permalink.expanded || permalink.url || permalink.display || '';
            let authorHandle = null;

            if (urlStr) {
                const parts = urlStr.split('/').filter(Boolean);
                const xIndex = parts.findIndex(p => p.includes('twitter.com') || p.includes('x.com'));
                if (xIndex !== -1 && parts[xIndex + 1]) {
                    authorHandle = parts[xIndex + 1].split('?')[0];
                }
            }

            if (authorHandle && authorHandle !== 'status' && authorHandle !== 'i') {
                if (!quotedContent) {
                    quotedContent = {
                        text: '',
                        author_name: authorHandle,
                        author_handle: authorHandle,
                        profile_image_url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
                        media: [],
                        created_at: null
                    };
                } else if (quotedContent.author_handle === 'unknown') {
                    quotedContent.author_handle = authorHandle;
                    if (quotedContent.author_name === 'Unknown') quotedContent.author_name = authorHandle;
                }
            }
        }
    }

    // 5. Extract Media
    const rawMediaMap = new Map();
    const addMediaItems = (items) => {
        if (!Array.isArray(items)) return;
        items.forEach(m => {
            const key = m.media_key || m.id_str || m.media_url_https || m.media_url || m.url;
            if (key) rawMediaMap.set(key, m);
        });
    };

    if (targetLegacy.extended_entities?.media) addMediaItems(targetLegacy.extended_entities.media);
    else if (targetLegacy.entities?.media) addMediaItems(targetLegacy.entities.media);

    if (targetNoteTweet?.note_tweet_results?.result?.media?.inline_media) {
        addMediaItems(targetNoteTweet.note_tweet_results.result.media.inline_media);
    }

    // Fallback search in high level buckets
    if (tweet.extended_entities?.media) addMediaItems(tweet.extended_entities.media);

    const media = Array.from(rawMediaMap.values()).map(normalizeMediaItem).filter(Boolean);

    // 6. Extract URL Cards
    const urlCards = [];
    const urlEntities = targetLegacy.entities?.urls || [];
    for (const urlEntity of urlEntities) {
        if (urlEntity.expanded_url && !urlEntity.expanded_url.includes('twitter.com') && !urlEntity.expanded_url.includes('x.com')) {
            urlCards.push({
                url: urlEntity.url,
                expanded_url: urlEntity.unwound_url || urlEntity.expanded_url,
                display_url: urlEntity.display_url,
                title: urlEntity.title,
                description: urlEntity.description,
                image: urlEntity.images?.[0]?.url || urlEntity.image
            });
        }
    }

    // 7. Extract Location
    //
    // Twitter location can come from several places, in order of precision:
    //   (a) `place` — explicit geotag picked by the author. Modern Twitter
    //       almost never returns this (the feature was deprecated for new
    //       tweets in 2019), but legacy tweets still have it.
    //   (b) `geo.coordinates` / `coordinates.coordinates` — precise lat/lng.
    //   (c) Author profile location — free-text "Hyderabad, India" the user
    //       set on their profile. This is our most reliable fallback because
    //       most active accounts have it filled in.
    //
    // We attach a `source` field so the UI can say "Posted from" vs
    // "Author's profile location" — they are different things.
    let location = null;

    const placeRaw = targetLegacy.place || tweet.place || null;
    if (placeRaw && typeof placeRaw === 'object') {
        const bbox = placeRaw.bounding_box?.coordinates?.[0];
        let lat = null;
        let lng = null;
        if (Array.isArray(bbox) && bbox.length >= 4) {
            const lngs = bbox.map(p => Array.isArray(p) ? p[0] : null).filter(v => typeof v === 'number');
            const lats = bbox.map(p => Array.isArray(p) ? p[1] : null).filter(v => typeof v === 'number');
            if (lngs.length && lats.length) {
                lng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
                lat = lats.reduce((a, b) => a + b, 0) / lats.length;
            }
        }
        const name = placeRaw.full_name || placeRaw.name || null;
        if (name) {
            location = {
                name,
                address: placeRaw.full_name || null,
                city: placeRaw.name || null,
                country: placeRaw.country || null,
                lat,
                lng,
                place_id: placeRaw.id || null,
                source: 'tweet_place'
            };
        }
    }

    // Fallback (b): raw coordinates on the tweet itself
    if (!location) {
        const geoCoords = targetLegacy.geo?.coordinates || tweet.geo?.coordinates;
        const coordCoords = targetLegacy.coordinates?.coordinates || tweet.coordinates?.coordinates;
        const pair = Array.isArray(geoCoords) && geoCoords.length === 2
            ? geoCoords
            : (Array.isArray(coordCoords) && coordCoords.length === 2 ? coordCoords : null);
        if (pair) {
            // Twitter `geo` is [lat, lng]; `coordinates` is [lng, lat]
            const usingGeo = Array.isArray(geoCoords);
            const lat = usingGeo ? Number(pair[0]) : Number(pair[1]);
            const lng = usingGeo ? Number(pair[1]) : Number(pair[0]);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                location = {
                    name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
                    address: null,
                    city: null,
                    country: null,
                    lat,
                    lng,
                    place_id: null,
                    source: 'tweet_coordinates'
                };
            }
        }
    }

    // Fallback (c): author profile location string
    if (!location && mainUser.profile_location) {
        location = {
            name: mainUser.profile_location,
            address: null,
            city: null,
            country: null,
            lat: null,
            lng: null,
            place_id: null,
            source: 'author_profile'
        };
    }

    // 8. Clean Text
    let cleanText = fullText;
    const urlsToRemove = [];
    if (targetLegacy.extended_entities?.media) targetLegacy.extended_entities.media.forEach(m => urlsToRemove.push(m.url));
    if (targetLegacy.quoted_status_permalink?.url) urlsToRemove.push(targetLegacy.quoted_status_permalink.url);
    urlsToRemove.forEach(u => { if (u) cleanText = cleanText.replace(u, ''); });
    cleanText = cleanText.trim();

    return {
        id: targetLegacy.id_str,
        text: cleanText || fullText,
        url: `https://x.com/${mainUser.screen_name}/status/${targetLegacy.id_str}`,
        created_at: targetLegacy.created_at ? new Date(targetLegacy.created_at) : (tweet.created_at ? new Date(tweet.created_at) : new Date()),
        media,
        url_cards: urlCards,
        is_repost: isRepost,
        author: mainUser.name,
        author_handle: mainUser.screen_name,
        author_avatar: mainUser.profile_image_url_https,
        verified: mainUser.verified,
        original_author: originalAuthor,

        original_author_name: originalAuthorName,
        original_author_avatar: originalAuthorAvatar,
        quoted_content: quotedContent,
        location,
        raw_data: tweetResult,
        metrics: {
            like: (targetLegacy.favorite_count || 0).toString(),
            retweet: (targetLegacy.retweet_count || 0).toString(),
            reply: (targetLegacy.reply_count || 0).toString(),
            views: (tweet.views?.count || 0).toString(),
            quote: (targetLegacy.quote_count || 0).toString()
        }
    };
};


const searchTweets = async (query, limit = 50) => {
    try {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
        const apiCount = Math.min(safeLimit, 20);
        const maxPages = Math.min(Math.ceil(safeLimit / apiCount) + 1, 8);
        // Search last 7 days for broader results
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const sinceDate = weekAgo.toISOString().split('T')[0];

        console.log(`[RapidAPI] Searching tweets for: ${query} since:${sinceDate}`);

        const extractTweetsAndCursor = (responseData) => {
            const instructions = responseData?.result?.timeline?.instructions ||
                responseData?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
                responseData?.timeline?.instructions ||
                [];

            const tweets = [];
            const seenIds = new Set();
            let nextCursor = null;

            const extractTweetFromContent = (content) => {
                if (!content) return null;
                return content.itemContent?.tweet_results?.result ||
                    content.tweetResult?.result ||
                    content.tweet_results?.result ||
                    null;
            };

            for (const instruction of instructions) {
                if (instruction.type === 'TimelineAddEntries' || instruction.entries) {
                    const entries = instruction.entries || [];

                    for (const entry of entries) {
                        const entryId = entry.entryId || entry.sortIndex || '';

                        if (entryId.startsWith('cursor-bottom') || entry.content?.cursorType === 'Bottom') {
                            nextCursor =
                                entry.content?.value ||
                                entry.content?.itemContent?.value ||
                                entry.content?.operation?.cursor?.value ||
                                nextCursor;
                            continue;
                        }

                        const rawTweet = extractTweetFromContent(entry.content);
                        if (rawTweet) {
                            const normalized = normalizeTweet(rawTweet);
                            if (normalized?.id && !seenIds.has(normalized.id)) {
                                seenIds.add(normalized.id);
                                tweets.push(normalized);
                            }
                            continue;
                        }

                        if (entry.content?.items) {
                            for (const item of entry.content.items) {
                                const nestedTweet = extractTweetFromContent(item?.item?.itemContent ? item.item : null) ||
                                    extractTweetFromContent(item?.item) ||
                                    extractTweetFromContent(item);
                                if (nestedTweet) {
                                    const normalized = normalizeTweet(nestedTweet);
                                    if (normalized?.id && !seenIds.has(normalized.id)) {
                                        seenIds.add(normalized.id);
                                        tweets.push(normalized);
                                    }
                                }
                            }
                        }
                    }
                }

                if (instruction.type === 'TimelinePinEntry' && instruction.entry) {
                    const pinnedTweet = extractTweetFromContent(instruction.entry.content);
                    if (pinnedTweet) {
                        const normalized = normalizeTweet(pinnedTweet);
                        if (normalized?.id && !seenIds.has(normalized.id)) {
                            seenIds.add(normalized.id);
                            tweets.push(normalized);
                        }
                    }
                }

                if (instruction.type === 'TimelineAddToModule' && instruction.moduleItems) {
                    for (const moduleItem of instruction.moduleItems) {
                        const moduleTweet = extractTweetFromContent(moduleItem?.item?.itemContent ? moduleItem.item : null) ||
                            extractTweetFromContent(moduleItem?.item) ||
                            extractTweetFromContent(moduleItem);
                        if (moduleTweet) {
                            const normalized = normalizeTweet(moduleTweet);
                            if (normalized?.id && !seenIds.has(normalized.id)) {
                                seenIds.add(normalized.id);
                                tweets.push(normalized);
                            }
                        }
                    }
                }
            }

            return { tweets, nextCursor };
        };

        const fetchWithCursor = async (baseQuery, type = 'Latest') => {
            const aggregated = [];
            const seenIds = new Set();
            let cursor = null;

            for (let page = 0; page < maxPages; page++) {
            const params = { query: baseQuery, type, count: apiCount };
                if (cursor) params.cursor = cursor;

                const response = await rapidRequestX({
                    method: 'get',
                    endpoint: 'search',
                    params
                });

                const { tweets: pageTweets, nextCursor } = extractTweetsAndCursor(response.data);
                for (const tweet of pageTweets) {
                    if (!tweet?.id || seenIds.has(tweet.id)) continue;
                    seenIds.add(tweet.id);
                    aggregated.push(tweet);
                }

                if (aggregated.length >= safeLimit) break;
                if (!nextCursor || nextCursor === cursor) break;
                cursor = nextCursor;
            }

            return aggregated;
        };

        const mergeUnique = (base, incoming) => {
            const merged = [...base];
            const seen = new Set(base.map((t) => t?.id).filter(Boolean));
            for (const tweet of incoming || []) {
                if (!tweet?.id || seen.has(tweet.id)) continue;
                seen.add(tweet.id);
                merged.push(tweet);
                if (merged.length >= safeLimit) break;
            }
            return merged;
        };

        let tweets = await fetchWithCursor(`${query} since:${sinceDate}`, 'Latest');

        if (tweets.length < safeLimit) {
            const topWithDate = await fetchWithCursor(`${query} since:${sinceDate}`, 'Top');
            tweets = mergeUnique(tweets, topWithDate);
        }

        if (tweets.length < safeLimit) {
            const latestNoDate = await fetchWithCursor(query, 'Latest');
            tweets = mergeUnique(tweets, latestNoDate);
        }

        if (tweets.length < safeLimit) {
            const topNoDate = await fetchWithCursor(query, 'Top');
            tweets = mergeUnique(tweets, topNoDate);
        }

        console.log(`[RapidAPI] Found ${tweets.length} tweets for "${query}"`);
        return tweets.slice(0, safeLimit);
    } catch (error) {
        console.error('[RapidAPI] Search Tweets Error:', error.message);
        return [];
    }
};


const fs = require('fs');
const path = require('path');

const fetchTweetDetail = async (tweetId, options = {}) => {
    const log = (msg) => console.log(`[Investigation] ${msg}`);
    const key = String(tweetId || '').trim();
    if (!key) {
        log('Error: Empty tweet ID provided');
        return null;
    }

    try {
        log(`Fetching details for tweet ${key}...`);

        const endpointAttempts = [
            { path: '/tweet-v2', params: { pid: key } },
            { path: '/tweet', params: { pid: key } },
            { path: '/tweet', params: { id: key } },
            { path: '/tweet', params: { tweet_id: key } }
        ];

        let tweetData = null;

        for (const attempt of endpointAttempts) {
            try {
                const response = await rapidRequestX({
                    method: 'get',
                    endpoint: attempt.path,
                    params: attempt.params
                });

                // DEBUG: Log keys to see structure
                if (response.data) {
                    const topKeys = Object.keys(response.data);
                    log(`Response keys for ${attempt.path}: ${topKeys.join(', ')}`);
                    if (response.data.result) log(`Result keys: ${Object.keys(response.data.result).join(', ')}`);
                }

                // Robust extraction based on known twitter241 and related schemas
                let result = response.data?.result || response.data?.data || response.data;

                // Aggressive unwrapping for deeply nested RapidAPI structures
                for (let i = 0; i < 6; i++) {
                    if (!result || typeof result !== 'object') break;
                    if (result.tweetResult) result = result.tweetResult;
                    else if (result.tweet) result = result.tweet;
                    else if (result.result) result = result.result;
                    else if (result.tweet_results?.result) result = result.tweet_results.result;
                    else if (result.data && typeof result.data === 'object') result = result.data;
                    else break;
                }

                // Check if we found valid data
                if (result && (result.legacy || result.data?.legacy || result.rest_id)) {
                    tweetData = result;
                    log(`Successfully fetched tweet ${key} via ${attempt.path}`);
                    break;
                } else if (result) {
                    log(`Found data for ${attempt.path} but it lacked legacy/rest_id. Keys: ${Object.keys(result).join(', ')}`);
                }
            } catch (e) {
                // Only log if it's not a 404
                if (e.response?.status !== 404) {
                    log(`Attempt error for ${attempt.path}: ${e.response?.status || e.message}`);
                }
            }
        }

        // 2. Search Fallback (if no direct fetch worked)
        if (!tweetData) {
            try {
                const searchQuery = `url:\"/status/${key}\"`;
                log(`Direct fetch failed for ${key}, trying search fallback with query: ${searchQuery}...`);
                // Search for the ID directly which is very reliable for many APIs
                const searchRes = await rapidRequestX({
                    method: 'get',
                    endpoint: 'search',
                    params: { query: searchQuery, type: 'Latest', count: 10 }
                });

                const instructions = searchRes.data?.result?.timeline?.instructions ||
                    searchRes.data?.timeline?.instructions ||
                    searchRes.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

                const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries ||
                    instructions[0]?.entries || [];

                const processEntry = (entry) => {
                    let result = entry.content?.itemContent?.tweet_results?.result;
                    if (!result) return null;

                    // Unwrap TweetWithVisibilityResults
                    if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
                        result = result.tweet;
                    }

                    // 1. Check top-level ID
                    if (result.rest_id === key || result.legacy?.id_str === key || result.id_str === key) {
                        return result;
                    }

                    // 2. Check Quoted Status
                    let quote = result.quoted_status_result?.result || result.quoted_status_result;
                    if (quote) {
                        if (quote.result || quote.tweet) quote = quote.result || quote.tweet;
                        if (quote.__typename === 'TweetWithVisibilityResults' && quote.tweet) quote = quote.tweet;

                        if (quote.rest_id === key || quote.legacy?.id_str === key || quote.id_str === key) {
                            log(`Found tweet ${key} INSIDE quoted_status_result`);
                            return quote;
                        }
                    }

                    // 3. Check Retweeted Status
                    let retweet = result.legacy?.retweeted_status_result?.result || result.legacy?.retweeted_status_result;
                    if (retweet) {
                        if (retweet.result || retweet.tweet) retweet = retweet.result || retweet.tweet;
                        if (retweet.__typename === 'TweetWithVisibilityResults' && retweet.tweet) retweet = retweet.tweet;

                        if (retweet.rest_id === key || retweet.legacy?.id_str === key || retweet.id_str === key) {
                            log(`Found tweet ${key} INSIDE retweeted_status_result`);
                            return retweet;
                        }
                    }

                    return null;
                };

                for (const entry of entries) {
                    tweetData = processEntry(entry);
                    if (tweetData) break;
                }

                // If still not found, try a broader search for the ID as a string
                if (!tweetData) {
                    log(`Specific URL search failed for ${key}, trying keyword search fallback (count: 20)...`);
                    const broadRes = await rapidRequestX({
                        method: 'get',
                        endpoint: 'search',
                        params: { query: key, type: 'Latest', count: 20 }
                    });

                    const broadInstructions = broadRes.data?.result?.timeline?.instructions ||
                        broadRes.data?.timeline?.instructions ||
                        broadRes.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

                    const broadEntries = broadInstructions.find(i => i.type === 'TimelineAddEntries')?.entries ||
                        broadInstructions[0]?.entries || [];

                    for (const entry of broadEntries) {
                        tweetData = processEntry(entry);
                        if (tweetData) break;
                    }
                }
            } catch (e) {
                log(`Search fallback failed for ${key}: ${e.response?.status || e.message}`);
            }
        }

        if (!tweetData) return null;

        const normalized = normalizeTweet(tweetData);
        return normalized;

    } catch (error) {
        console.error(`[RapidAPI] Final Fetch Tweet Detail Error for ${tweetId}:`, error.message);
        return null;
    }
};

const fetchTweetRetweeters = async (tweetId, options = {}) => {
    const key = String(tweetId || '').trim();
    if (!key) return [];

    const count = Math.max(5, Math.min(parseInt(options.count, 10) || 200, 200));
    const endpointAttempts = [
        // Confirmed endpoint for your twitter241 subscription
        { endpoint: 'retweets', params: { pid: key, count } },
        { endpoint: 'retweets', params: { tweet_id: key, count } },
        { endpoint: 'retweets', params: { id: key, count } },
        { endpoint: 'retweets', params: { pid: key } },
        // Primary endpoint for twitter241 docs: "Get Post Retweets"
        { endpoint: 'post-retweets', params: { pid: key, count } },
        { endpoint: 'post-retweets', params: { tweet_id: key, count } },
        { endpoint: 'post-retweets', params: { id: key, count } },
        { endpoint: 'post-retweets', params: { pid: key } },
        // Alternate alias-style paths
        { endpoint: 'post/retweets', params: { pid: key, count } },
        { endpoint: 'post/retweets', params: { tweet_id: key, count } },
        { endpoint: 'post/retweets', params: { id: key, count } },
        // Legacy fallback endpoint
        { endpoint: 'tweet-retweets-v2', params: { tweet_id: key, count } }
    ];

    for (const attempt of endpointAttempts) {
        try {
            const data = await rapidGet(attempt.endpoint, attempt.params);
            const users = extractRetweeterUsers(data);
            if (users.length > 0) return users;

            if (data && !data.error && !data.errors) {
                return [];
            }
        } catch (error) {
            const status = error?.response?.status;
            const endpointKey = attempt.endpoint;
            if (status === 404 || status === 422) {
                unsupportedEndpointCache.add(endpointKey);
                continue;
            }
            if (error?.code === 'ENDPOINT_UNSUPPORTED') continue;
        }
    }

    return [];
};

/**
 * Fetch users who replied to a specific tweet using conversation_id search.
 * Returns array of { handle, name, avatar, verified, text, created_at }.
 */
const fetchTweetRepliers = async (tweetId, authorHandle, options = {}) => {
    const key = String(tweetId || '').trim();
    if (!key) return [];

    const count = Math.min(parseInt(options.count, 10) || 40, 100);
    const handle = String(authorHandle || '').replace(/^@/, '').trim();

    // Strategy: search for replies in the conversation thread
    const queries = [
        `conversation_id:${key} -from:${handle}`,
        `to:${handle} conversation_id:${key}`,
    ];

    const seen = new Set();
    const repliers = [];

    for (const query of queries) {
        try {
            const response = await rapidRequestX({
                method: 'get',
                endpoint: 'search',
                params: { query, type: 'Latest', count }
            });

            const instructions = response.data?.result?.timeline?.instructions ||
                response.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
                response.data?.timeline?.instructions || [];

            const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries ||
                instructions[0]?.entries || [];

            for (const entry of entries) {
                const rawTweet = entry.content?.itemContent?.tweet_results?.result;
                if (!rawTweet) continue;
                const normalized = normalizeTweet(rawTweet);
                if (!normalized) continue;
                const rHandle = (normalized.author_handle || '').toLowerCase();
                if (rHandle === handle.toLowerCase() || seen.has(rHandle)) continue;
                seen.add(rHandle);
                repliers.push({
                    handle: normalized.author_handle,
                    name: normalized.author,
                    avatar: normalized.author_avatar,
                    verified: normalized.verified || false,
                    text: (normalized.text || '').slice(0, 280),
                    created_at: normalized.created_at
                });
            }

            if (repliers.length > 0) break; // first query that returns data is enough
        } catch (err) {
            console.log(`[RapidAPI] Reply search failed for ${key}: ${err.message}`);
        }
    }

    return repliers;
};

/**
 * Fetch users who quote-tweeted a specific tweet using search.
 * Returns array of { handle, name, avatar, verified, text, created_at }.
 */
const fetchTweetQuoteTweeters = async (tweetId, authorHandle, options = {}) => {
    const key = String(tweetId || '').trim();
    if (!key) return [];

    const count = Math.min(parseInt(options.count, 10) || 40, 100);
    const handle = String(authorHandle || '').replace(/^@/, '').trim();

    const queries = [
        `quoted_tweet_id:${key}`,
        `url:"/status/${key}"`,
    ];

    const seen = new Set();
    const quoters = [];

    for (const query of queries) {
        try {
            const response = await rapidRequestX({
                method: 'get',
                endpoint: 'search',
                params: { query, type: 'Latest', count }
            });

            const instructions = response.data?.result?.timeline?.instructions ||
                response.data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ||
                response.data?.timeline?.instructions || [];

            const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries ||
                instructions[0]?.entries || [];

            for (const entry of entries) {
                const rawTweet = entry.content?.itemContent?.tweet_results?.result;
                if (!rawTweet) continue;
                const normalized = normalizeTweet(rawTweet);
                if (!normalized) continue;
                const qHandle = (normalized.author_handle || '').toLowerCase();
                if (qHandle === handle.toLowerCase() || seen.has(qHandle)) continue;
                seen.add(qHandle);
                quoters.push({
                    handle: normalized.author_handle,
                    name: normalized.author,
                    avatar: normalized.author_avatar,
                    verified: normalized.verified || false,
                    text: (normalized.text || '').slice(0, 280),
                    created_at: normalized.created_at
                });
            }

            if (quoters.length > 0) break;
        } catch (err) {
            console.log(`[RapidAPI] Quote search failed for ${key}: ${err.message}`);
        }
    }

    return quoters;
};

/**
 * Whether X can be reached for the tenant currently in scope.
 *
 * Callers used to decide this by testing an environment key. That is no longer
 * what governs access: credentials are per tenant and live in the tenant's own
 * database, so the only honest answer comes from BluGate. Mirrors
 * isInstagramConfigured in the Instagram service.
 */
const isXConfigured = () => blugate.isConfigured('x');

module.exports = {
    isXConfigured,
    fetchUserTweets,
    fetchAllUserTweetsSince,
    searchUsers,
    searchTweets,
    fetchUserProfile,
    fetchUserProfileById,
    fetchTweetDetail,
    fetchTweetRetweeters,
    fetchTweetRepliers,
    fetchTweetQuoteTweeters,
    rapidGet,
    normalizeTweet
};

