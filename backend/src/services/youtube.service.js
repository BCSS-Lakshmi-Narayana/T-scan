const moment = require('moment');
const blugate = require('./blugate');

/**
 * A stand-in for the googleapis YouTube client, backed by BluGate.
 *
 * BluGate fronts the YouTube Data API v3 and holds the API key for each tenant,
 * so the key no longer comes from the environment. Presenting the same
 * `.<resource>.list({...})` shape the googleapis client had means none of the
 * methods below changed: they still pass `part: [...]`, read `response.data.items`,
 * and parse exactly the payloads they always did.
 *
 * The REST API takes repeated parameters as comma-separated strings where the
 * client library accepted arrays, so arrays are joined here rather than at each
 * of the call sites.
 */
const buildYouTubeClient = () => {
    const toParams = (options = {}) => {
        const params = {};
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined || value === null) continue;
            params[key] = Array.isArray(value) ? value.join(',') : value;
        }
        return params;
    };
    // The googleapis client resolves to { data }, and every caller reads
    // response.data.items — so preserve that envelope.
    const resource = (endpointKey) => ({
        list: async (options) => ({ data: await blugate.youtube(endpointKey, toParams(options)) }),
    });
    return {
        channels: resource('CHANNELS'),
        search: resource('SEARCH'),
        videos: resource('VIDEOS'),
        playlistItems: resource('PLAYLIST_ITEMS'),
        commentThreads: resource('COMMENT_THREADS'),
    };
};

class YouTubeService {
    constructor() {
        this.youtube = buildYouTubeClient();
        this.quotaUsed = 0;
        this.quotaLimit = 10000; // Default daily limit
    }

    // --- Channel Methods ---

    async getChannelDetails(channelId) {
        try {
            const response = await this.youtube.channels.list({
                part: ['snippet', 'statistics', 'brandingSettings', 'contentDetails'],
                id: [channelId]
            });

            if (!response.data.items || response.data.items.length === 0) {
                throw new Error('Channel not found');
            }

            const channel = response.data.items[0];
            
            const stats = channel.statistics || {};
            
            return {
                id: channel.id,
                title: channel.snippet.title,
                description: channel.snippet.description,
                customUrl: channel.snippet.customUrl,
                publishedAt: channel.snippet.publishedAt,
                thumbnails: channel.snippet.thumbnails,
                statistics: {
                    viewCount: parseInt(stats.viewCount || '0', 10),
                    subscriberCount: parseInt(stats.subscriberCount || '0', 10),
                    hiddenSubscriberCount: stats.hiddenSubscriberCount || false,
                    videoCount: parseInt(stats.videoCount || '0', 10)
                },
                brandingSettings: channel.brandingSettings,
                uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads,
                country: channel.snippet.country
            };
        } catch (error) {
            console.error('Error fetching channel details:', error);
            throw error;
        }
    }

    async searchChannels(query, limit = 10) {
        try {
            const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
            const response = await this.youtube.search.list({
                part: ['snippet'],
                q: query,
                type: 'channel',
                maxResults: safeLimit
            });

            const channelIds = response.data.items.map(item => item.snippet.channelId).filter(Boolean);
            if (channelIds.length === 0) return [];

            // Fetch full channel details with statistics (subscriber counts)
            const detailsResponse = await this.youtube.channels.list({
                part: ['snippet', 'statistics'],
                id: channelIds
            });

            return (detailsResponse.data.items || []).map(channel => {
                const stats = channel.statistics || {};
                return {
                    id: channel.id,
                    title: channel.snippet.title,
                    description: channel.snippet.description,
                    thumbnails: channel.snippet.thumbnails,
                    publishedAt: channel.snippet.publishedAt,
                    statistics: {
                        subscriberCount: parseInt(stats.subscriberCount || '0', 10),
                        viewCount: parseInt(stats.viewCount || '0', 10),
                        videoCount: parseInt(stats.videoCount || '0', 10),
                        hiddenSubscriberCount: stats.hiddenSubscriberCount || false
                    }
                };
            });
        } catch (error) {
            if (error?.status === 403 || error?.code === 403 || error?.errors?.[0]?.reason === 'quotaExceeded') {
                console.warn('[YouTube] API quota exceeded, returning empty results');
                return [];
            }
            console.error('Error searching channels:', error);
            throw error;
        }
    }

    async searchVideos(query, limit = 50) {
        try {
            const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
            const videoIds = [];
            let nextPageToken = undefined;

            while (videoIds.length < safeLimit) {
                const remaining = safeLimit - videoIds.length;
                const pageSize = Math.min(remaining, 50);

                const response = await this.youtube.search.list({
                    part: ['snippet'],
                    q: query,
                    type: 'video',
                    maxResults: pageSize,
                    order: 'date',
                    pageToken: nextPageToken
                });

                const items = response?.data?.items || [];
                for (const item of items) {
                    const id = item?.id?.videoId;
                    if (id) videoIds.push(id);
                    if (videoIds.length >= safeLimit) break;
                }

                nextPageToken = response?.data?.nextPageToken;
                if (!nextPageToken || items.length === 0) break;
            }

            return await this.getVideoDetails(videoIds);
        } catch (error) {
            if (error?.status === 403 || error?.code === 403 || error?.errors?.[0]?.reason === 'quotaExceeded') {
                console.warn('[YouTube] API quota exceeded, returning empty results');
                return [];
            }
            console.error('Error searching videos:', error);
            throw error;
        }
    }

    // --- Video Methods ---

    async getVideosFromPlaylist(playlistId, maxResults = 50) {
        try {
            const response = await this.youtube.playlistItems.list({
                part: ['snippet', 'contentDetails'],
                playlistId: playlistId,
                maxResults: maxResults
            });

            const videoIds = response.data.items.map(item => item.contentDetails.videoId);
            return await this.getVideoDetails(videoIds);
        } catch (error) {
            console.error('Error fetching playlist videos:', error);
            throw error;
        }
    }


    async getVideoDetails(videoIds) {
        // Process in chunks of 50
        const chunks = [];
        for (let i = 0; i < videoIds.length; i += 50) {
            chunks.push(videoIds.slice(i, i + 50));
        }

        let allVideos = [];
        for (const chunk of chunks) {
            try {
                const response = await this.youtube.videos.list({
                    part: ['snippet', 'contentDetails', 'statistics'],
                    id: chunk
                });
                allVideos = allVideos.concat(response.data.items);
            } catch (error) {
                console.error('Error fetching video details chunk:', error);
            }
        }

        return allVideos.map(video => ({
            id: video.id,
            title: video.snippet.title,
            description: video.snippet.description,
            publishedAt: video.snippet.publishedAt,
            thumbnails: video.snippet.thumbnails,
            channelId: video.snippet.channelId,
            channelTitle: video.snippet.channelTitle,
            tags: video.snippet.tags || [],
            categoryId: video.snippet.categoryId,
            duration: video.contentDetails.duration,
            statistics: {
                viewCount: parseInt(video.statistics.viewCount || 0),
                likeCount: parseInt(video.statistics.likeCount || 0),
                commentCount: parseInt(video.statistics.commentCount || 0)
            }
        }));
    }

    // --- Comment Methods ---

    async getVideoComments(videoId, maxResults = 100) {
        try {
            const response = await this.youtube.commentThreads.list({
                part: ['snippet', 'replies'],
                videoId: videoId,
                maxResults: maxResults, // Note: max is 100 for this endpoint
                textFormat: 'plainText'
            });

            return response.data.items.map(item => {
                const topLevel = item.snippet.topLevelComment.snippet;
                const replies = item.replies ? item.replies.comments.map(reply => this._formatComment(reply.snippet, reply.id)) : [];

                return {
                    ...this._formatComment(topLevel, item.id),
                    replyCount: item.snippet.totalReplyCount,
                    replies: replies
                };
            });

        } catch (error) {
            // If comments are disabled, 403 error might occur, handle gracefully
            if (error.code === 403) {
                console.warn(`Comments disabled or restricted for video ${videoId}`);
                return [];
            }
            console.error(`Error fetching comments for video ${videoId}:`, error);
            throw error;
        }
    }

    _formatComment(snippet, id) {
        return {
            id: id,
            videoId: snippet.videoId,
            textDisplay: snippet.textDisplay,
            authorDisplayName: snippet.authorDisplayName,
            authorProfileImageUrl: snippet.authorProfileImageUrl,
            authorChannelId: snippet.authorChannelId?.value,
            likeCount: snippet.likeCount,
            publishedAt: snippet.publishedAt,
            updatedAt: snippet.updatedAt,
            parentId: snippet.parentId || null
        };
    }
}

module.exports = new YouTubeService();

// Exposed so any module that used to construct its own googleapis client can
// use the same BluGate-backed one instead of reaching for a provider key.
module.exports.buildYouTubeClient = buildYouTubeClient;
