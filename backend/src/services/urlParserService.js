/**
 * URL Parser Service
 * Detects platform and extracts post/video/tweet IDs from URLs
 */

/**
 * Detect platform and extract post ID from a URL
 * @param {string} url - The URL to parse
 * @returns {{ platform: string, postId: string, authorHandle: string | null } | null}
 */
const parsePostUrl = (url) => {
    if (!url || typeof url !== 'string') return null;

    const trimmedUrl = url.trim();
    if (!trimmedUrl) return null;

    // Try each platform parser
    const youtubeResult = parseYouTubeUrl(trimmedUrl);
    if (youtubeResult) return youtubeResult;

    const xResult = parseXTwitterUrl(trimmedUrl);
    if (xResult) return xResult;

    const facebookResult = parseFacebookUrl(trimmedUrl);
    if (facebookResult) return facebookResult;

    const instagramResult = parseInstagramUrl(trimmedUrl);
    if (instagramResult) return instagramResult;

    return null;
};

/**
 * Parse YouTube URLs
 * Supports: youtube.com/watch?v=xxx, youtu.be/xxx, youtube.com/shorts/xxx, youtube.com/live/xxx
 */
const parseYouTubeUrl = (url) => {
    try {
        // Handle youtu.be short links
        const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        if (shortMatch) {
            return {
                platform: 'youtube',
                postId: shortMatch[1],
                authorHandle: null
            };
        }

        // Handle youtube.com URLs
        if (!url.includes('youtube.com')) return null;

        const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);

        // Standard watch URL: youtube.com/watch?v=xxx
        if (urlObj.pathname === '/watch' || urlObj.pathname.startsWith('/watch')) {
            const videoId = urlObj.searchParams.get('v');
            if (videoId && videoId.length === 11) {
                return {
                    platform: 'youtube',
                    postId: videoId,
                    authorHandle: null
                };
            }
        }

        // Shorts: youtube.com/shorts/xxx
        const shortsMatch = urlObj.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) {
            return {
                platform: 'youtube',
                postId: shortsMatch[1],
                authorHandle: null
            };
        }

        // Live: youtube.com/live/xxx
        const liveMatch = urlObj.pathname.match(/\/live\/([a-zA-Z0-9_-]{11})/);
        if (liveMatch) {
            return {
                platform: 'youtube',
                postId: liveMatch[1],
                authorHandle: null
            };
        }

        // Embed: youtube.com/embed/xxx
        const embedMatch = urlObj.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) {
            return {
                platform: 'youtube',
                postId: embedMatch[1],
                authorHandle: null
            };
        }

        return null;
    } catch (e) {
        return null;
    }
};

/**
 * Parse X/Twitter URLs
 * Supports: twitter.com/user/status/xxx, x.com/user/status/xxx
 */
const parseXTwitterUrl = (url) => {
    try {
        // Match both twitter.com and x.com, including /i/web/status/<id>.
        const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
        const urlObj = new URL(normalizedUrl);
        const pathname = urlObj.pathname;

        const tweetMatch = pathname.match(/\/([^\/]+)\/status(?:es)?\/(\d+)/i);
        if (tweetMatch) {
            return {
                platform: 'x',
                postId: tweetMatch[2],
                authorHandle: tweetMatch[1]
            };
        }

        const webStatusMatch = pathname.match(/\/i\/web\/status\/(\d+)/i);
        if (webStatusMatch) {
            return {
                platform: 'x',
                postId: webStatusMatch[1],
                authorHandle: null
            };
        }

        return null;
    } catch (e) {
        return null;
    }
};

/**
 * Parse Facebook URLs
 * Supports: facebook.com/xxx/posts/yyy, facebook.com/xxx/videos/yyy, fb.watch/xxx
 */
const parseFacebookUrl = (url) => {
    try {
        // fb.watch short links
        const fbWatchMatch = url.match(/fb\.watch\/([a-zA-Z0-9_-]+)/i);
        if (fbWatchMatch) {
            return {
                platform: 'facebook',
                postId: fbWatchMatch[1],
                authorHandle: null,
                isShortLink: true
            };
        }

        if (!url.includes('facebook.com') && !url.includes('fb.com')) return null;

        const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
        const pathname = urlObj.pathname;
        const pathParts = pathname.split('/').filter(Boolean);
        const storyFbId = urlObj.searchParams.get('story_fbid') || urlObj.searchParams.get('fbid');
        const pageId = urlObj.searchParams.get('id');
        const watchVideoId = urlObj.searchParams.get('v');

        // Posts: /xxx/posts/yyy or /permalink.php?story_fbid=xxx&id=yyy
        const postsMatch = pathname.match(/\/([^\/]+)\/posts\/([^\/\?]+)/i);
        if (postsMatch) {
            return {
                platform: 'facebook',
                postId: postsMatch[2],
                authorHandle: postsMatch[1]
            };
        }

        // Videos: /xxx/videos/yyy
        const videosMatch = pathname.match(/\/([^\/]+)\/videos\/([^\/\?]+)/i);
        if (videosMatch) {
            return {
                platform: 'facebook',
                postId: videosMatch[2],
                authorHandle: videosMatch[1]
            };
        }

        // Groups: /groups/<group>/posts/<id>
        const groupPostMatch = pathname.match(/\/groups\/([^\/]+)\/posts\/(\d+)/i);
        if (groupPostMatch) {
            return {
                platform: 'facebook',
                postId: groupPostMatch[2],
                authorHandle: groupPostMatch[1]
            };
        }

        // Photos: /xxx/photos/yyy
        const photosMatch = pathname.match(/\/([^\/]+)\/photos\/[^\/]+\/(\d+)/i);
        if (photosMatch) {
            return {
                platform: 'facebook',
                postId: photosMatch[2],
                authorHandle: photosMatch[1]
            };
        }

        // Reel: /reel/xxx
        const reelMatch = pathname.match(/\/reel\/(\d+)/i);
        if (reelMatch) {
            return {
                platform: 'facebook',
                postId: reelMatch[1],
                authorHandle: null
            };
        }

        // /<page>/reels/<id>
        const pageReelMatch = pathname.match(/\/([^\/]+)\/reels\/(\d+)/i);
        if (pageReelMatch) {
            return {
                platform: 'facebook',
                postId: pageReelMatch[2],
                authorHandle: pageReelMatch[1]
            };
        }

        // Share links: /share/v/<token>/, /share/r/<token>/, /share/p/<token>/
        const shareMatch = pathname.match(/\/share\/(?:v|r|p)\/([^\/\?]+)/i);
        if (shareMatch) {
            return {
                platform: 'facebook',
                postId: shareMatch[1],
                authorHandle: null,
                isShareLink: true
            };
        }

        // Watch: /watch/?v=xxx or /watch/live/?v=xxx
        if (pathname.includes('/watch') && watchVideoId) {
            return {
                platform: 'facebook',
                postId: watchVideoId,
                authorHandle: null
            };
        }

        // story_fbid format: /permalink.php?story_fbid=xxx&id=yyy or /story.php
        if (storyFbId) {
            return {
                platform: 'facebook',
                postId: storyFbId,
                authorHandle: pageId || null
            };
        }

        // photo.php?fbid=<id>
        if (pathname.toLowerCase().includes('/photo.php') && storyFbId) {
            return {
                platform: 'facebook',
                postId: storyFbId,
                authorHandle: pageId || null
            };
        }

        const numericSegment = [...pathParts].reverse().find((part) => /^\d{8,}$/.test(part));
        if (numericSegment) {
            return {
                platform: 'facebook',
                postId: numericSegment,
                authorHandle: pathParts[0] || null
            };
        }

        return null;
    } catch (e) {
        return null;
    }
};

/**
 * Parse Instagram URLs
 * Supports: instagram.com/p/<shortcode>, /reel/<shortcode>, /reels/<shortcode>, /tv/<shortcode>, /stories/<user>/<id>
 */
const parseInstagramUrl = (url) => {
    try {
        if (!url.includes('instagram.com')) return null;

        const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
        const pathname = urlObj.pathname;

        const mediaMatch = pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
        if (mediaMatch) {
            return {
                platform: 'instagram',
                postId: mediaMatch[1],
                authorHandle: null
            };
        }

        const storyMatch = pathname.match(/\/stories\/([^\/]+)\/(\d+)/i);
        if (storyMatch) {
            return {
                platform: 'instagram',
                postId: storyMatch[2],
                authorHandle: storyMatch[1] || null
            };
        }

        return null;
    } catch (e) {
        return null;
    }
};

/**
 * Get display name for a platform
 */
const getPlatformDisplayName = (platform) => {
    const names = {
        'youtube': 'YouTube',
        'x': 'X (Twitter)',
        'facebook': 'Facebook',
        'instagram': 'Instagram'
    };
    return names[platform] || platform;
};

module.exports = {
    parsePostUrl,
    parseYouTubeUrl,
    parseXTwitterUrl,
    parseFacebookUrl,
    parseInstagramUrl,
    getPlatformDisplayName
};
