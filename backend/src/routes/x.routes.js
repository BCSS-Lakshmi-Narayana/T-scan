const express = require('express');
const router = express.Router();
const mediaAnalyzerService = require('../services/mediaAnalyzerService');
const rapidApiXService = require('../services/rapidApiXService');
const {
    resolveSourceForRetweetNetwork,
    refreshRetweetRelationshipsForSource,
    getRetweetNetworkSummary,
    getTweetEngagers
} = require('../services/retweetNetworkService');
const {
    runEngagerAnalysis,
    prepareAnalysisRecord,
    executeAnalysisWork,
    getLatestAnalysis,
    getAnalysisHistory,
    getAnalysisById,
    getAnalyzedHandles,
    getPendingCount,
    getAllAnalyses
} = require('../services/engagerAnalysisService');
const AuditLog = require('../models/AuditLog');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect, requireAnyPageAccess(['/x-monitor']));

// Keep legacy call sites but preserve authenticated user identity.
const mockUser = (req, res, next) => {
    if (!req.user) {
        req.user = {
            id: 'unknown',
            email: 'unknown@local',
            full_name: 'Unknown User'
        };
    }
    req.user.name = req.user.name || req.user.full_name || req.user.email || req.user.id;
    next();
};

const logAction = async (user, action, resourceType, resourceId, details) => {
    try {
        await AuditLog.create({
            tenant_id: user.tenant_id || user.tenantId,
            user_id: user.id,
            user_email: user.email,
            user_name: user.name,
            action: action,
            resource_type: resourceType,
            resource_id: resourceId,
            details: details
        });
    } catch (error) {
        console.error('Audit Log Error:', error);
    }
};

const RAPID_ENDPOINT_ALIASES = {
    // User Endpoint
    'user/by-username': 'user',
    'users/by-ids': 'users',
    'users/by-ids-v2': 'users-v2',
    'user/replies': 'user-replies',
    'user/replies-v2': 'user-replies-v2',
    'user/media': 'user-media',
    'user/tweets': 'user-tweets',
    'user/followings': 'user-followings',
    'user/following-ids': 'user-following-ids',
    'user/followers': 'user-followers',
    'user/verified-followers': 'user-verified-followers',
    'user/followers-ids': 'user-followers-ids',
    'user/highlights': 'user-highlights',
    'user/about': 'user-about',

    // Posts Endpoint
    'post/comments': 'tweet-comments',
    'post/comments-v2': 'tweet-comments-v2',
    'post/quotes': 'tweet-quotes',
    'post/retweets': 'retweets',
    'tweets/details-by-ids': 'tweets',
    'tweets/details-by-ids-v2': 'tweets-v2',

    // Explore Endpoint
    'explore/search': 'search',
    'explore/search-v2': 'search-v2',
    'explore/search-v3': 'search-v3',
    'explore/autocomplete': 'auto-complete',

    // Lists Endpoint
    'lists/search': 'search-lists',
    'lists/details': 'list-details',
    'lists/timeline': 'list-timeline',
    'lists/followers': 'list-followers',
    'lists/members': 'list-members',

    // Community Endpoint
    'community/search': 'search-community',
    'community/topics': 'community-topics',
    'community/timeline': 'community-timeline',
    'community/popular': 'community-popular',
    'community/members': 'community-members',
    'community/members-v2': 'community-members-v2',
    'community/moderators': 'community-moderators',
    'community/tweets': 'community-tweets',
    'community/about': 'community-about',
    'community/details': 'community-details',

    // Trends Endpoint
    'trends/locations': 'trends-available',
    'trends/by-location': 'trends'
};

const proxyRapidEndpoint = async (endpoint, req, res) => {
    try {
        const data = await rapidApiXService.rapidGet(endpoint, req.query);
        res.json(data);
    } catch (error) {
        res.status(500).json({
            error: 'RapidAPI request failed',
            message: error.message
        });
    }
};

// --- X / TWITTER VIDEO DOWNLOAD ---
router.post('/download-video', mockUser, async (req, res) => {
    try {
        const { content_url, media_url, tweet_url, content_id } = req.body;
        const mediaUrl = media_url || content_url || tweet_url;

        if (!mediaUrl) {
            return res.status(400).json({ error: 'media_url is required' });
        }

        console.log(`Initiating X video download for: ${mediaUrl}`);

        const result = await mediaAnalyzerService.downloadVideo(mediaUrl);

        await logAction(req.user, 'download_video', 'content', content_id || result.video_id, {
            media_url: mediaUrl,
            video_id: result.video_id,
            filename: result.filename
        });

        res.json({
            success: true,
            video_id: result.video_id,
            filename: result.filename,
            download_url: result.download_url,
            title: result.title,
            duration_seconds: result.duration_seconds
        });
    } catch (error) {
        console.error('X video download error:', error);
        res.status(error.statusCode || 500).json({
            error: error.message || 'Failed to download video'
        });
    }
});

// Get video download URL (if already downloaded)
router.get('/video-url/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const downloadUrl = mediaAnalyzerService.getVideoDownloadUrl(videoId);
        res.json({ download_url: downloadUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get video URL' });
    }
});

// Generic RapidAPI proxy for any GET endpoint (provide ?endpoint=path)
router.get('/rapid', async (req, res) => {
    const { endpoint } = req.query;
    if (!endpoint) {
        return res.status(400).json({ error: 'endpoint query parameter is required' });
    }
    return proxyRapidEndpoint(endpoint, req, res);
});

// Aliased RapidAPI endpoints for convenience
Object.entries(RAPID_ENDPOINT_ALIASES).forEach(([alias, endpoint]) => {
    router.get(`/rapid/${alias}`, async (req, res) => proxyRapidEndpoint(endpoint, req, res));
});

router.get('/retweet-network', async (req, res) => {
    try {
        const {
            source_id: sourceId,
            handle,
            days = 7,
            from: fromDate,
            to: toDate,
            limit = 25,
            content_id: contentId,
            ensure_tweet: ensureTweet,
            refresh
        } = req.query;
        const safeDays = Math.max(1, Math.min(Number(days) || 7, 365));
        const safeLimit = Math.max(5, Math.min(Number(limit) || 25, 5000));
        const safeMaxTweets = Math.max(1, Math.min(Number(req.query.max_tweets) || 8, 15));
        const safeMaxRetweeters = Math.max(10, Math.min(Number(req.query.max_retweeters) || 80, 120));

        if (!sourceId && !handle) {
            return res.status(400).json({ error: 'source_id or handle is required' });
        }

        const source = await resolveSourceForRetweetNetwork({ sourceId, handle, tenantId: req.tenantId });
        if (!source) {
            return res.status(404).json({ error: 'Monitored X source not found' });
        }

        if (String(refresh).toLowerCase() === 'true') {
            await refreshRetweetRelationshipsForSource(source, {
                maxTweets: safeMaxTweets,
                maxRetweetersPerTweet: safeMaxRetweeters
            });
        }

        const summary = await getRetweetNetworkSummary({
            source,
            days: safeDays,
            from: fromDate || null,
            to: toDate || null,
            limit: safeLimit,
            contentId: contentId || null,
            ensureTweetId: ensureTweet || null
        });

        return res.json(summary);
    } catch (error) {
        return res.status(500).json({
            error: 'Failed to build retweet network',
            message: error.message
        });
    }
});

// Get all engagers for a specific tweet: retweeters (with cross-tweet frequency), repliers, quote-tweeters
router.get('/tweet-engagers', async (req, res) => {
    try {
        const { source_id: sourceId, handle, tweet_id: tweetId } = req.query;

        if (!tweetId) {
            return res.status(400).json({ error: 'tweet_id is required' });
        }
        if (!sourceId && !handle) {
            return res.status(400).json({ error: 'source_id or handle is required' });
        }

        const source = await resolveSourceForRetweetNetwork({ sourceId, handle, tenantId: req.tenantId });
        if (!source) {
            return res.status(404).json({ error: 'Monitored X source not found' });
        }

        const engagers = await getTweetEngagers({ source, tweetId: String(tweetId) });
        return res.json(engagers);
    } catch (error) {
        console.error('[TweetEngagers] Error:', error.message);
        return res.status(500).json({ error: 'Failed to fetch tweet engagers', message: error.message });
    }
});

// ─── On-Demand Engager Analysis ──────────────────────────────────────────────

// Trigger a new engager analysis for a handle
// Synchronously checks conflicts and creates DB record, then backgrounds heavy work
router.post('/engager-analysis', async (req, res) => {
    try {
        const { handle, period_days: periodDays = 30, source_id: sourceId } = req.body;
        if (!handle) {
            return res.status(400).json({ error: 'handle is required' });
        }
        const safePeriod = Math.max(1, Math.min(Number(periodDays) || 30, 90));

        // Synchronously prepare the record (checks conflicts, creates/updates DB record)
        const prepResult = await prepareAnalysisRecord(handle, { periodDays: safePeriod, sourceId, tenantId: req.tenantId });

        if (prepResult.status === 'already_processing') {
            return res.json({ status: 'already_processing', handle: prepResult.handle });
        }
        if (prepResult.status === 'blocked') {
            return res.json({ status: 'blocked', handle: prepResult.handle, blocked_by: prepResult.blocked_by });
        }

        // Record is now saved as 'processing' — run heavy work in background
        const cleanHandle = String(handle).replace(/^@/, '').trim().toLowerCase();
        executeAnalysisWork(prepResult.analysisId, cleanHandle, safePeriod, prepResult.analysis).catch(err => {
            console.error(`[EngagerAnalysis] Background analysis failed for ${cleanHandle}:`, err.message);
        });

        return res.json({ status: 'started', handle: cleanHandle });
    } catch (error) {
        console.error('[EngagerAnalysis] Error:', error.message);
        return res.status(500).json({ error: 'Failed to start engager analysis', message: error.message });
    }
});

// Get the latest completed analysis for a handle
router.get('/engager-analysis/latest', async (req, res) => {
    try {
        const { handle } = req.query;
        if (!handle) {
            return res.status(400).json({ error: 'handle query param is required' });
        }
        const analysis = await getLatestAnalysis(handle, req.tenantId);
        if (!analysis) {
            return res.status(404).json({ error: 'No analysis found for this handle' });
        }
        return res.json(analysis);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch analysis', message: error.message });
    }
});

// Get analysis history for a handle
router.get('/engager-analysis/history', async (req, res) => {
    try {
        const { handle } = req.query;
        if (!handle) {
            return res.status(400).json({ error: 'handle query param is required' });
        }
        const history = await getAnalysisHistory(handle, req.tenantId, 20);
        return res.json({ handle, analyses: history });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch analysis history', message: error.message });
    }
});

// Get a specific analysis by ID
router.get('/engager-analysis/:id', async (req, res) => {
    try {
        const analysis = await getAnalysisById(req.params.id, req.tenantId);
        if (!analysis) {
            return res.status(404).json({ error: 'Analysis not found' });
        }
        return res.json(analysis);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch analysis', message: error.message });
    }
});

// Get all handles that have been analyzed (for history panel in alerts)
router.get('/engager-analysis-handles', async (req, res) => {
    try {
        const handles = await getAnalyzedHandles(req.tenantId);
        return res.json({ handles });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch analyzed handles', message: error.message });
    }
});

// Get count of currently processing analyses
router.get('/engager-analysis-pending', async (req, res) => {
    try {
        const count = await getPendingCount(req.tenantId);
        return res.json({ count });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch pending count', message: error.message });
    }
});

// Get ALL analysis records (one per handle) for the Frequent Engagers panel
router.get('/engager-analysis-all', async (req, res) => {
    try {
        const analyses = await getAllAnalyses(req.tenantId);
        return res.json({ analyses });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch analyses', message: error.message });
    }
});

module.exports = router;
