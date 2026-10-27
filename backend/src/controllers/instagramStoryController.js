const InstagramStory = require('../models/InstagramStory');
const { archiveStoryMedia, deleteStoryFromS3 } = require('../services/storyS3Service');
const axios = require('axios');
const { withTenant } = require('../utils/tenantFilter');

/**
 * GET /api/instagram-stories
 * Fetch stories from DB with filters, auto-remove expired/unavailable ones from response.
 */
const getStories = async (req, res) => {
  try {
    const {
      source_id,
      author_handle,
      include_expired = 'false',
      include_unavailable = 'false',
      archived_only = 'false',
      s3_only = 'false',
      limit = 50,
      page = 1
    } = req.query;

    const filter = withTenant(req);
    if (source_id) filter.source_id = source_id;
    if (author_handle) filter.author_handle = author_handle.replace('@', '').toLowerCase();

    // By default, exclude expired stories
    if (include_expired !== 'true') {
      filter.expires_at = { $gt: new Date() };
    }

    // By default, exclude unavailable stories
    if (include_unavailable !== 'true') {
      filter.is_available = true;
    }

    if (archived_only === 'true') {
      filter.is_archived = true;
    }

    if (s3_only === 'true') {
      // Prefer indexed boolean flags for speed; keeps older data compatible via is_archived.
      filter.$or = [
        { has_s3_media: true },
        { is_archived: true }
      ];
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);

    const skip = (parsedPage - 1) * parsedLimit;

    // Avoid countDocuments on large datasets; use limit+1 pagination for responsive UI.
    const docs = await InstagramStory.find(filter)
      .sort({ published_at: -1 })
      .skip(skip)
      .limit(parsedLimit + 1)
      .select('-raw_data')
      .lean();

    const hasMore = docs.length > parsedLimit;
    const stories = hasMore ? docs.slice(0, parsedLimit) : docs;

    res.json({
      stories,
      pagination: {
        total: null,
        page: parsedPage,
        limit: parsedLimit,
        hasMore
      }
    });
  } catch (error) {
    console.error('[StoryController] getStories error:', error);
    res.status(500).json({ message: 'Failed to fetch stories', error: error.message });
  }
};

/**
 * POST /api/instagram-stories/store
 * Store fetched stories from the Instagram API into the database.
 * Automatically archives media to S3.
 */
const storeStories = async (req, res) => {
  try {
    const { stories, source_id, author_handle, author, author_avatar } = req.body;

    if (!Array.isArray(stories) || stories.length === 0) {
      return res.status(400).json({ message: 'No stories provided' });
    }

    const results = { stored: 0, skipped: 0, archived: 0, errors: [] };

    for (const story of stories) {
      try {
        const storyPk = String(
          story.pk || story.id || story.story_pk || story.content_id ||
          `${author_handle || 'unknown'}_${new Date(story.taken_at * 1000 || story.published_at || Date.now()).getTime()}`
        );

        // Check if already stored
        const existing = await InstagramStory.findOne(withTenant(req, { story_pk: storyPk }));
        if (existing) {
          results.skipped++;
          continue;
        }

        // Determine media type
        const isVideo = story.media_type === 2 ||
          story.media_type === 'video' ||
          story.is_video === true ||
          (story.video_versions && story.video_versions.length > 0) ||
          (story.video_url);

        // Extract best media URL
        let originalUrl = '';
        let thumbnailUrl = '';

        if (isVideo) {
          // Pick best video URL
          const videoVersions = story.video_versions || story.videoVersions || [];
          if (videoVersions.length > 0) {
            originalUrl = videoVersions[0]?.url || videoVersions[0]?.src || '';
          }
          if (!originalUrl) originalUrl = story.video_url || story.videoUrl || '';

          // Pick thumbnail
          const imgCandidates = story.image_versions2?.candidates || story.image_versions || [];
          thumbnailUrl = imgCandidates[0]?.url || story.thumbnail_url || story.display_url || '';
        } else {
          // Pick best image URL
          const imgCandidates = story.image_versions2?.candidates || story.image_versions || [];
          if (imgCandidates.length > 0) {
            originalUrl = imgCandidates[0]?.url || imgCandidates[0]?.src || '';
          }
          if (!originalUrl) originalUrl = story.display_url || story.image_url || story.url || '';
          thumbnailUrl = originalUrl;
        }

        if (!originalUrl) {
          // Attempt to use any media array
          const mediaItems = Array.isArray(story.media) ? story.media : [];
          const firstMedia = mediaItems[0];
          if (firstMedia) {
            originalUrl = firstMedia.url || firstMedia.src || '';
          }
        }

        // Calculate expiry
        const publishedAt = story.taken_at
          ? new Date(story.taken_at * 1000)
          : new Date(story.published_at || Date.now());
        const expiresAt = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000);

        // Build video versions array for storage
        const videoVersionsData = isVideo
          ? (story.video_versions || story.videoVersions || []).map(v => ({
            url: v.url || v.src || '',
            width: v.width,
            height: v.height,
            type: v.type || v.content_type || ''
          }))
          : [];

        // Create DB record
        const storyDoc = new InstagramStory({
          tenant_id: req.tenantId,
          source_id: source_id || story.source_id,
          story_pk: storyPk,
          author: author || story.user?.full_name || story.author || author_handle,
          author_handle: (author_handle || story.user?.username || story.author_handle || '').replace('@', '').toLowerCase(),
          author_avatar: author_avatar || story.user?.profile_pic_url || story.author_avatar,
          media_type: isVideo ? 'video' : 'image',
          original_url: originalUrl,
          thumbnail_url: thumbnailUrl,
          video_duration: story.video_duration || null,
          video_versions: videoVersionsData,
          published_at: publishedAt,
          expires_at: expiresAt,
          is_available: true,
          width: story.original_width || story.width,
          height: story.original_height || story.height,
          caption: story.caption?.text || story.caption || '',
          raw_data: story
        });

        await storyDoc.save();
        results.stored++;

        // Archive to S3 in background (don't await to keep response fast)
        if (originalUrl) {
          archiveStoryMedia(originalUrl, storyPk, isVideo ? 'video' : 'image', '', req.tenantId)
            .then(async (s3Result) => {
              if (s3Result) {
                await InstagramStory.updateOne(
                  withTenant(req, { story_pk: storyPk }),
                  {
                    s3_url: s3Result.url,
                    s3_key: s3Result.key,
                    is_archived: true,
                    has_s3_media: true
                  }
                );
                results.archived++;
              }
            })
            .catch(err => console.error(`[StoryController] S3 archive bg error for ${storyPk}:`, err.message));

          // Also archive thumbnail if different from main
          if (thumbnailUrl && thumbnailUrl !== originalUrl) {
            archiveStoryMedia(thumbnailUrl, storyPk, 'image', '_thumb', req.tenantId)
              .then(async (s3Result) => {
                if (s3Result) {
                  await InstagramStory.updateOne(
                    withTenant(req, { story_pk: storyPk }),
                    {
                      s3_thumbnail_url: s3Result.url,
                      s3_thumbnail_key: s3Result.key,
                      has_s3_media: true
                    }
                  );
                }
              })
              .catch(err => console.error(`[StoryController] S3 thumb archive error for ${storyPk}:`, err.message));
          }
        }
      } catch (storyError) {
        if (storyError.code === 11000) {
          results.skipped++;
        } else {
          results.errors.push(storyError.message);
        }
      }
    }

    res.json({
      message: `Stored ${results.stored} stories, skipped ${results.skipped} duplicates`,
      ...results
    });
  } catch (error) {
    console.error('[StoryController] storeStories error:', error);
    res.status(500).json({ message: 'Failed to store stories', error: error.message });
  }
};

/**
 * PUT /api/instagram-stories/:id/viewed
 * Mark a story as viewed.
 */
const markViewed = async (req, res) => {
  try {
    const story = await InstagramStory.findOneAndUpdate(
      withTenant(req, { id: req.params.id }),
      { viewed: true, viewed_at: new Date() },
      { new: true }
    );
    if (!story) return res.status(404).json({ message: 'Story not found' });
    res.json(story);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update story', error: error.message });
  }
};

/**
 * DELETE /api/instagram-stories/:id
 * Admin delete - removes from DB and S3.
 */
const deleteStory = async (req, res) => {
  try {
    const story = await InstagramStory.findOne(withTenant(req, { id: req.params.id }));
    if (!story) return res.status(404).json({ message: 'Story not found' });

    // Delete from S3 if archived
    const deletions = [];
    if (story.s3_key) deletions.push(deleteStoryFromS3(story.s3_key, req.tenantId));
    if (story.s3_thumbnail_key) deletions.push(deleteStoryFromS3(story.s3_thumbnail_key, req.tenantId));
    await Promise.allSettled(deletions);

    await InstagramStory.deleteOne(withTenant(req, { id: req.params.id }));

    res.json({ message: 'Story deleted successfully', id: req.params.id });
  } catch (error) {
    console.error('[StoryController] deleteStory error:', error);
    res.status(500).json({ message: 'Failed to delete story', error: error.message });
  }
};

/**
 * DELETE /api/instagram-stories/bulk
 * Bulk delete stories (admin).
 */
const bulkDeleteStories = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No story IDs provided' });
    }

    const stories = await InstagramStory.find(withTenant(req, { id: { $in: ids } }));

    // Delete S3 files
    const s3Deletions = [];
    stories.forEach(story => {
      if (story.s3_key) s3Deletions.push(deleteStoryFromS3(story.s3_key, req.tenantId));
      if (story.s3_thumbnail_key) s3Deletions.push(deleteStoryFromS3(story.s3_thumbnail_key, req.tenantId));
    });
    await Promise.allSettled(s3Deletions);

    const result = await InstagramStory.deleteMany(withTenant(req, { id: { $in: ids } }));

    res.json({
      message: `Deleted ${result.deletedCount} stories`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('[StoryController] bulkDeleteStories error:', error);
    res.status(500).json({ message: 'Failed to delete stories', error: error.message });
  }
};

/**
 * POST /api/instagram-stories/cleanup
 * Remove expired & unavailable stories older than X days.
 */
const cleanupStories = async (req, res) => {
  try {
    const { days_old = 7 } = req.body;
    const cutoff = new Date(Date.now() - days_old * 24 * 60 * 60 * 1000);

    const expiredStories = await InstagramStory.find(withTenant(req, {
      expires_at: { $lt: new Date() },
      created_at: { $lt: cutoff }
    }));

    // Delete S3 files for expired stories
    const s3Deletions = [];
    expiredStories.forEach(story => {
      if (story.s3_key) s3Deletions.push(deleteStoryFromS3(story.s3_key, req.tenantId));
      if (story.s3_thumbnail_key) s3Deletions.push(deleteStoryFromS3(story.s3_thumbnail_key, req.tenantId));
    });
    await Promise.allSettled(s3Deletions);

    const result = await InstagramStory.deleteMany(withTenant(req, {
      expires_at: { $lt: new Date() },
      created_at: { $lt: cutoff }
    }));

    // Also mark stories as unavailable if they've expired but are within retention period
    await InstagramStory.updateMany(
      withTenant(req, { expires_at: { $lt: new Date() }, is_available: true }),
      { is_available: false }
    );

    res.json({
      message: `Cleaned up ${result.deletedCount} expired stories`,
      deletedCount: result.deletedCount,
      markedUnavailable: expiredStories.length
    });
  } catch (error) {
    console.error('[StoryController] cleanupStories error:', error);
    res.status(500).json({ message: 'Cleanup failed', error: error.message });
  }
};

/**
 * GET /api/instagram-stories/stats
 * Get story statistics.
 */
const getStoryStats = async (req, res) => {
  try {
    const now = new Date();
    const [total, active, archived, expired] = await Promise.all([
      InstagramStory.countDocuments(withTenant(req)),
      InstagramStory.countDocuments(withTenant(req, { expires_at: { $gt: now }, is_available: true })),
      InstagramStory.countDocuments(withTenant(req, { is_archived: true })),
      InstagramStory.countDocuments(withTenant(req, { expires_at: { $lt: now } }))
    ]);

    res.json({ total, active, archived, expired });
  } catch (error) {
    res.status(500).json({ message: 'Failed to get stats', error: error.message });
  }
};

module.exports = {
  getStories,
  storeStories,
  markViewed,
  deleteStory,
  bulkDeleteStories,
  cleanupStories,
  getStoryStats
};
