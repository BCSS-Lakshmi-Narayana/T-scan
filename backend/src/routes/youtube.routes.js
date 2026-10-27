const express = require('express');
const router = express.Router();
const youtubeService = require('../services/youtube.service');
const sentiment = require('../services/sentiment');
const Source = require('../models/Source');
const Content = require('../models/Content');
const Comment = require('../models/Comment');
const AuditLog = require('../models/AuditLog');
const { v4: uuidv4 } = require('uuid');
const YouTubeTranscript = require('../models/YouTubeTranscript');
const mediaAnalyzerService = require('../services/mediaAnalyzerService');
const { analyzeTranscriptWithGemini, splitTranscriptIntoLines } = require('../services/geminiService');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

router.use(protect, requireAnyPageAccess(['/youtube-monitor']));

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

// --- CHANNELS ---

// Get monitored channels
router.get('/channels', async (req, res) => {
    try {
        const channels = await Source.find({ tenant_id: req.tenantId, platform: 'youtube' }).sort({ created_at: -1 });
        res.json(channels);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Add a new YouTube Channel to monitor
router.post('/channels', mockUser, async (req, res) => {
    try {
        const { identifier, category, priority } = req.body;
        let channelId = identifier;
        let details = null;
        let isPending = false;

        try {
            if (identifier.startsWith('@') || identifier.startsWith('http')) {
                // Regex for Channel ID
                const channelIdMatch = identifier.match(/youtube\.com\/channel\/(UC[\w-]{21}[AQgw])/);
                if (channelIdMatch) {
                    channelId = channelIdMatch[1];
                } else {
                    const searchResults = await youtubeService.searchChannels(identifier);
                    if (searchResults.length > 0) {
                        channelId = searchResults[0].id;
                    } else {
                        // If it's just a 404 from search, we return 404 immediately
                        // unless we suspect it's a quota issue masked as empty results (unlikely for search)
                        return res.status(404).json({ message: 'Channel not found on YouTube' });
                    }
                }
            }
            details = await youtubeService.getChannelDetails(channelId);
        } catch (apiError) {
            const errorMessage = apiError.message || '';
            // Check for Quota limits OR explicit Forbidden/Blocked access (403 or "blocked")
            const isQuotaError = errorMessage.toLowerCase().includes('quota') ||
                errorMessage.toLowerCase().includes('blocked') ||
                errorMessage.includes('403') ||
                apiError.code === 403 ||
                apiError.status === 403;

            // Check if it's a "Channel not found" error from getChannelDetails
            if (errorMessage === 'Channel not found') {
                return res.status(404).json({ message: 'Channel not found on YouTube' });
            }

            if (isQuotaError) {
                console.warn(`YouTube API Quota Exceeded for ${identifier}. Creating pending source.`);
                isPending = true;
                // create dummy details
                details = {
                    id: identifier, // Use input as identifier (e.g. @handle)
                    title: identifier,
                    thumbnails: { default: { url: '' } }, // Empty string instead of null
                    uploadsPlaylistId: null,
                    brandingSettings: null,
                    country: null,
                    statistics: {
                        subscriberCount: 0,
                        videoCount: 0,
                        viewCount: 0,
                        hiddenSubscriberCount: false
                    }
                };
            } else {
                console.error('YouTube API Error:', apiError);
                throw apiError; // Re-throw other errors
            }
        }

        // Check if exists (tenant-scoped: each tenant manages its own channels)
        const existing = await Source.findOne({ tenant_id: req.tenantId, identifier: details.id, platform: 'youtube' });
        if (existing) {
            return res.status(400).json({ message: 'Channel already monitored' });
        }

        const newSource = new Source({
            tenant_id: req.tenantId,
            platform: 'youtube',
            identifier: details.id,
            display_name: details.title + (isPending ? ' (Pending Resolution)' : ''),
            profile_image_url: details.thumbnails?.default?.url || '',
            category: category || 'unknown',
            priority: priority || 'medium',
            created_by: req.user?.email || 'system', // Fallback if req.user is missing
            youtube_metadata: {
                error: isPending ? 'quota_exceeded_pending_resolution' : null,
                upload_playlist_id: details.uploadsPlaylistId,
                channel_branding_settings: details.brandingSettings,
                country: details.country
            },
            statistics: {
                subscriber_count: details.statistics.subscriberCount,
                video_count: details.statistics.videoCount,
                view_count: details.statistics.viewCount,
                hidden_subscriber_count: details.statistics.hiddenSubscriberCount
            }
        });

        await newSource.save();

        await logAction(req.user, 'ADD_CHANNEL', 'Source', newSource.id, {
            channel_name: newSource.display_name,
            identifier: newSource.identifier,
            status: isPending ? 'PENDING_QUOTA' : 'ACTIVE'
        });

        res.status(201).json(newSource);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error adding channel', error: error.message });
    }
});

// Update Channel Status (Pause/Resume)
router.patch('/channels/:id/status', mockUser, async (req, res) => {
    try {
        const { is_active } = req.body;
        const source = await Source.findOne({ tenant_id: req.tenantId, id: req.params.id });

        if (!source) return res.status(404).json({ message: 'Channel not found' });

        source.is_active = is_active;
        await source.save();

        await logAction(req.user, is_active ? 'RESUME_MONITORING' : 'PAUSE_MONITORING', 'Source', source.id, {
            channel_name: source.display_name
        });

        res.json(source);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Delete Channel
router.delete('/channels/:id', mockUser, async (req, res) => {
    try {
        const source = await Source.findOne({ tenant_id: req.tenantId, id: req.params.id });
        if (!source) return res.status(404).json({ message: 'Channel not found' });

        await Source.deleteOne({ tenant_id: req.tenantId, id: req.params.id });
        // Optionally delete content, but usually keeping it is better for intelligence history.
        // For compliance we might need to delete. Let's keep for now.

        await logAction(req.user, 'DELETE_CHANNEL', 'Source', source.id, {
            channel_name: source.display_name
        });

        res.json({ message: 'Channel deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Sync Videos for a Channel
router.post('/channels/:id/sync', mockUser, async (req, res) => {
    try {
        const source = await Source.findOne({ tenant_id: req.tenantId, id: req.params.id });
        if (!source) return res.status(404).json({ message: 'Source not found' });

        // Always fetch latest channel stats during sync
        const details = await youtubeService.getChannelDetails(source.identifier);

        source.youtube_metadata = {
            ...source.youtube_metadata,
            upload_playlist_id: details.uploadsPlaylistId,
            channel_branding_settings: details.brandingSettings,
            country: details.country
        };

        source.statistics = {
            subscriber_count: details.statistics.subscriberCount,
            video_count: details.statistics.videoCount,
            view_count: details.statistics.viewCount,
            hidden_subscriber_count: details.statistics.hiddenSubscriberCount
        };

        if (details.thumbnails?.default?.url) {
            source.profile_image_url = details.thumbnails.default.url;
        }

        await source.save();

        const videos = await youtubeService.getVideosFromPlaylist(source.youtube_metadata.upload_playlist_id, 10);

        let newCount = 0;
        let processedCount = 0;

        for (const video of videos) {
            processedCount++;
            const existing = await Content.findOne({ tenant_id: source.tenant_id, content_id: video.id });
            if (!existing) {
                // Saved pending; the sentiment pipeline analyses it and raises any alert.
                const newContent = new Content({
                    tenant_id: source.tenant_id,
                    source_id: source.id,
                    districts: source.districts || [],
                    platform: 'youtube',
                    content_id: video.id,
                    content_url: `https://www.youtube.com/watch?v=${video.id}`,
                    text: `${video.title}\n${video.description}`,
                    author: video.channelTitle,
                    author_handle: video.channelId,
                    published_at: video.publishedAt,
                    duration: video.duration,
                    thumbnails: video.thumbnails,
                    tags: video.tags,
                    category_id: video.categoryId,
                    engagement: {
                        views: video.statistics.viewCount,
                        likes: video.statistics.likeCount,
                        comments: video.statistics.commentCount
                    }
                });
                await newContent.save();
                newCount++;

                if (source.priority === 'high') {
                    await syncCommentsForVideo(newContent);
                }
            } else {
                existing.engagement = {
                    views: video.statistics.viewCount,
                    likes: video.statistics.likeCount,
                    comments: video.statistics.commentCount
                };
                await existing.save();
            }
        }

        if (newCount > 0) sentiment.kick();

        source.last_checked = new Date();
        // Update stats
        if (videos.length > 0) source.youtube_metadata = { ...source.youtube_metadata, sync_status: 'success' };
        await source.save();

        await logAction(req.user, 'SYNC_CHANNEL', 'Source', source.id, {
            channel_name: source.display_name,
            videos_processed: processedCount,
            new_videos: newCount
        });

        res.json({ message: 'Sync completed', new_videos: newCount });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error syncing channel', error: error.message });
    }
});

// --- VIDEOS ---

router.get('/videos', async (req, res) => {
    try {
        const { risk_level, channel_id, start_date, end_date, limit = 500 } = req.query;
        let matchStage = { tenant_id: req.tenantId, platform: 'youtube' };

        if (risk_level) matchStage.risk_level = risk_level;
        if (channel_id) matchStage.source_id = channel_id;
        if (start_date || end_date) {
            matchStage.published_at = {};
            if (start_date) matchStage.published_at.$gte = new Date(start_date);
            if (end_date) matchStage.published_at.$lte = new Date(end_date);
        }

        const videos = await Content.aggregate([
            { $match: matchStage },
            { $sort: { published_at: -1 } },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'analyses',
                    localField: 'content_id',
                    foreignField: 'content_id', // Analysis schema uses video content_id, not internal uuid
                    as: 'analysis_data'
                }
            },
            {
                $unwind: {
                    path: '$analysis_data',
                    preserveNullAndEmptyArrays: true
                }
            }
        ]);



        res.json(videos);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.get('/videos/:id', async (req, res) => {
    try {
        // ID could be internal UUID or youtube video ID. Let's try internal first.
        let video = await Content.findOne({ tenant_id: req.tenantId, id: req.params.id });
        if (!video) {
            video = await Content.findOne({ tenant_id: req.tenantId, content_id: req.params.id });
        }
        if (!video) return res.status(404).json({ message: 'Video not found' });

        res.json(video);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// --- COMMENTS ---

router.get('/videos/:id/comments', async (req, res) => {
    try {
        const comments = await Comment.find({ tenant_id: req.tenantId, video_id: req.params.id }).sort({ published_at: -1 });
        res.json(comments);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// --- MANUAL TRANSCRIPT + GEMINI ANALYSIS ---

// Fetch latest stored transcript+insights for a video
router.get('/videos/:id/transcript', async (req, res) => {
    try {
        const videoId = req.params.id;
        const doc = await YouTubeTranscript.findOne({ tenant_id: req.tenantId, platform: 'youtube', video_id: videoId }).sort({ created_at: -1 });
        if (!doc) return res.status(404).json({ message: 'Transcript not found' });
        res.json(doc);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Manually transcribe and analyze selected videos (controlled)
router.post('/videos/transcribe-analyze', mockUser, async (req, res) => {
    try {
        const { video_ids, youtube_urls } = req.body || {};

        const inputs = [];
        if (Array.isArray(video_ids)) {
            for (const id of video_ids) {
                if (typeof id === 'string' && id.trim()) {
                    inputs.push({ video_id: id.trim(), youtube_url: `https://www.youtube.com/watch?v=${id.trim()}` });
                }
            }
        }
        if (Array.isArray(youtube_urls)) {
            for (const url of youtube_urls) {
                if (typeof url === 'string' && url.trim()) {
                    inputs.push({ video_id: null, youtube_url: url.trim() });
                }
            }
        }

        if (inputs.length === 0) {
            return res.status(400).json({ message: 'Provide video_ids or youtube_urls' });
        }

        console.log('Backend /transcribe-analyze received inputs:', JSON.stringify(inputs, null, 2));

        const results = [];
        const errors = [];

        for (const input of inputs) {
            const { video_id, youtube_url } = input;
            const videoId = video_id || 'unknown_vid'; // fallback

            try {
                // 1. Transcribe
                console.log(`Calling media-analyzer for ${youtube_url}...`);
                const transcriptResponse = await mediaAnalyzerService.transcribeYoutubeUrl(youtube_url);
                console.log('media-analyzer response short summary:', {
                    id: transcriptResponse.id,
                    transcriptLength: transcriptResponse.transcript?.length,
                    duration: transcriptResponse.duration_seconds
                });

                if (!transcriptResponse.transcript) {
                    console.warn(`WARNING: Transcript is empty for ${youtube_url}`);
                    // Provide fallback to avoid Mongoose validation error
                    transcriptResponse.transcript = "[No speech detected or transcript empty]";
                }

                const transcriptLines = splitTranscriptIntoLines(transcriptResponse.transcript);

                // 2. Store Transcript
                const doc = new YouTubeTranscript({
                    tenant_id: req.tenantId,
                    transcript_id: transcriptResponse.id || uuidv4(),
                    platform: 'youtube',
                    video_id: videoId,
                    youtube_url: transcriptResponse.youtube_url,
                    title: transcriptResponse.title,
                    duration_seconds: transcriptResponse.duration_seconds,
                    language: transcriptResponse.language,
                    transcript: transcriptResponse.transcript,
                    transcript_lines: transcriptLines,
                    requested_by: {
                        user_id: req.user?.id,
                        user_email: req.user?.email,
                        user_name: req.user?.name
                    },
                    status: 'stored'
                });

                // Then send to Gemini for contextual + safety insights
                try {
                    const gemini = await analyzeTranscriptWithGemini({
                        title: transcriptResponse.title,
                        youtubeUrl: transcriptResponse.youtube_url,
                        videoId,
                        transcript: transcriptResponse.transcript,
                        language: transcriptResponse.language,
                        durationSeconds: transcriptResponse.duration_seconds
                    });

                    doc.gemini = {
                        model: gemini.model,
                        topic: gemini.topic,
                        context: gemini.context,
                        summary: gemini.summary,
                        flags: gemini.flags,
                        flagged_lines: gemini.flagged_lines,
                        analyzed_at: new Date(),
                        raw_response: gemini.raw_response
                    };
                    doc.status = 'gemini_completed';
                    // Ensure transcript_lines matches what Gemini saw
                    doc.transcript_lines = gemini.transcript_lines || doc.transcript_lines;
                    await doc.save();

                    // --- SYNC TRANSCRIPT TO CONTENT; the sentiment service analyses it ---
                    try {
                        let content = await Content.findOne({ tenant_id: req.tenantId, platform: 'youtube', content_id: videoId });

                        if (!content) {
                            content = new Content({
                                tenant_id: req.tenantId,
                                platform: 'youtube',
                                content_id: videoId,
                                content_url: `https://www.youtube.com/watch?v=${videoId}`,
                                text: transcriptResponse.title || `Video ${videoId}`,
                                author: 'Unknown',
                                author_handle: 'unknown',
                                published_at: new Date()
                            });
                            try {
                                const details = await youtubeService.getVideoDetails([videoId]);
                                if (details && details.length > 0) {
                                    const v = details[0];
                                    content.text = `${v.title}\n${v.description}`;
                                    content.author = v.channelTitle;
                                    content.author_handle = v.channelId;
                                    content.published_at = v.publishedAt;
                                    content.thumbnails = v.thumbnails;
                                    content.duration = v.duration;
                                    content.engagement = {
                                        views: v.statistics.viewCount,
                                        likes: v.statistics.likeCount,
                                        comments: v.statistics.commentCount
                                    };
                                }
                            } catch (e) {
                                console.warn('Failed to fetch video details for content creation', e);
                            }
                        }

                        // The transcript is analysed together with title + description.
                        content.scraped_content = `[MEDIA TRANSCRIPT]:\n${transcriptResponse.transcript}`;
                        if (content.analysis_status !== 'processing') {
                            content.analysis_status = 'pending';
                            content.analysis_attempts = 0;
                            content.analysis_next_attempt_at = null;
                        }
                        await content.save();
                        sentiment.kick();
                    } catch (syncErr) {
                        console.error('Failed to sync transcript to Content:', syncErr);
                    }

                } catch (geminiErr) {
                    doc.gemini = {
                        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
                        analyzed_at: new Date(),
                        error: geminiErr?.message || 'Gemini analysis failed',
                        raw_response: geminiErr?.raw ? String(geminiErr.raw) : undefined
                    };
                    doc.status = 'gemini_failed';
                    await doc.save();
                }

                results.push({
                    transcript_id: transcriptResponse.transcript_id,
                    youtube_url: transcriptResponse.youtube_url,
                    title: transcriptResponse.title,
                    video_id: videoId,
                    duration_seconds: transcriptResponse.duration_seconds,
                    language: transcriptResponse.language,
                    transcript: transcriptResponse.transcript,
                    gemini: doc.gemini,
                    stored_id: doc.id
                });

            } catch (videoErr) {
                console.error(`Error processing video ${videoId}:`, videoErr);
                errors.push({ video_id: videoId, error: videoErr.message });
            }
        }

        res.json({ results, errors });
    } catch (error) {
        const code = error.statusCode || 500;
        res.status(code).json({ message: error.message || 'Failed to transcribe/analyze' });
    }
});

// Helper to sync comments
async function syncCommentsForVideo(content) {
    try {
        const comments = await youtubeService.getVideoComments(content.content_id);
        for (const c of comments) {
            const existing = await Comment.findOne({ tenant_id: content.tenant_id, comment_id: c.id });
            if (!existing) {
                await Comment.create({
                    tenant_id: content.tenant_id,
                    content_id: content.id,
                    video_id: content.content_id,
                    comment_id: c.id,
                    author_channel_id: c.authorChannelId,
                    author_display_name: c.authorDisplayName,
                    author_profile_image: c.authorProfileImageUrl,
                    text: c.textDisplay,
                    like_count: c.likeCount,
                    published_at: c.publishedAt
                    // sentiment/threat fields are filled by the sentiment pipeline
                });
            }
        }
    } catch (e) {
        console.error("Comment Sync Error", e);
    }
}

// --- VIDEO DOWNLOAD ---

// Download video for alert/content
router.post('/download-video', mockUser, async (req, res) => {
    try {
        const { youtube_url, content_url, media_url, content_id } = req.body;
        const mediaUrl = media_url || content_url || youtube_url;
        
        if (!mediaUrl) {
            return res.status(400).json({ error: 'media_url is required' });
        }
        
        console.log(`Initiating video download for: ${mediaUrl}`);
        
        const result = await mediaAnalyzerService.downloadVideo(mediaUrl);
        
        // Log the action
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
        console.error('Video download error:', error);
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

module.exports = router;
