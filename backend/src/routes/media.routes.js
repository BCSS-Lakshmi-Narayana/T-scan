const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const mediaAnalyzerService = require('../services/mediaAnalyzerService');
const AuditLog = require('../models/AuditLog');
const { protect } = require('../middleware/authMiddleware');
const { requireAnyPageAccess } = require('../middleware/rbacMiddleware');

const mediaAccessMiddleware = [
  protect,
  requireAnyPageAccess([
    '/alerts',
    '/grievances',
    '/content',
    '/monitors',
    '/x-monitor',
    '/facebook-monitor',
    '/instagram-monitor',
    '/youtube-monitor'
  ])
];

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
    //console.error('Audit Log Error:', error);
  }
};

const getAbsoluteUrlHelper = (req) => (maybeRelativeUrl) => {
  if (!maybeRelativeUrl || typeof maybeRelativeUrl !== 'string') return maybeRelativeUrl;
  if (/^https?:\/\//i.test(maybeRelativeUrl)) return maybeRelativeUrl;
  if (!maybeRelativeUrl.startsWith('/')) return maybeRelativeUrl;
  const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}${maybeRelativeUrl}`;
};

const DIRECT_VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m3u8)(\?|$)/i;
const DIRECT_IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;
const FACEBOOK_HOST_RE = /(?:^|\.)facebook\.com$/i;
const INSTAGRAM_HOST_RE = /(?:^|\.)instagram\.com$/i;
const YOUTUBE_HOST_RE = /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$|(?:^|\.)youtube-nocookie\.com$/i;

const ALLOWED_TWITTER_MEDIA_HOSTS = new Set([
  'video.twimg.com',
  'pbs.twimg.com',
  'twitter.com',
  'x.com',
  'abs.twimg.com'
]);

const STREAM_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 32 });
const STREAM_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 32 });
const STREAM_TIMEOUT_MS = 30000;

const STREAM_FALLBACK_CACHE_TTL_MS = 15 * 60 * 1000;
const STREAM_FALLBACK_CACHE_MAX = 1500;
const streamFallbackCache = new Map();

const getCachedS3FallbackUrl = (sourceUrl) => {
  const key = String(sourceUrl || '').trim();
  if (!key) return null;
  const cached = streamFallbackCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    streamFallbackCache.delete(key);
    return null;
  }
  // Refresh insertion order for simple LRU behavior.
  streamFallbackCache.delete(key);
  streamFallbackCache.set(key, cached);
  return cached.url;
};

const setCachedS3FallbackUrl = (sourceUrl, fallbackUrl) => {
  const key = String(sourceUrl || '').trim();
  const value = String(fallbackUrl || '').trim();
  if (!key || !value) return;

  if (streamFallbackCache.size >= STREAM_FALLBACK_CACHE_MAX) {
    const oldestKey = streamFallbackCache.keys().next().value;
    if (oldestKey) streamFallbackCache.delete(oldestKey);
  }

  streamFallbackCache.set(key, {
    url: value,
    expiresAt: Date.now() + STREAM_FALLBACK_CACHE_TTL_MS
  });
};

const clearCachedS3FallbackUrl = (sourceUrl) => {
  const key = String(sourceUrl || '').trim();
  if (!key) return;
  streamFallbackCache.delete(key);
};

const classifyStreamHost = (hostname = '') => {
  const normalizedHost = String(hostname || '').toLowerCase();
  const isTwitterHost = ALLOWED_TWITTER_MEDIA_HOSTS.has(normalizedHost) || normalizedHost.endsWith('.twimg.com');
  const isInstagramHost =
    normalizedHost === 'instagram.com' ||
    normalizedHost === 'www.instagram.com' ||
    normalizedHost.endsWith('.cdninstagram.com');
  const isFacebookHost =
    normalizedHost === 'facebook.com' ||
    normalizedHost === 'www.facebook.com' ||
    normalizedHost.endsWith('.fbcdn.net') ||
    normalizedHost.endsWith('.fbsbx.com');
  const isYouTubeHost =
    normalizedHost === 'youtube.com' ||
    normalizedHost === 'www.youtube.com' ||
    normalizedHost.endsWith('.ggpht.com') ||
    normalizedHost.endsWith('.googleusercontent.com');
  const isS3Host = normalizedHost.endsWith('.amazonaws.com');

  return {
    normalizedHost,
    isTwitterHost,
    isInstagramHost,
    isFacebookHost,
    isYouTubeHost,
    isS3Host,
    isAllowed: isTwitterHost || isInstagramHost || isFacebookHost || isYouTubeHost || isS3Host
  };
};

const getStreamOriginHeaders = (hostFlags) => {
  if (hostFlags?.isInstagramHost) {
    return { referer: 'https://www.instagram.com/', origin: 'https://www.instagram.com' };
  }
  if (hostFlags?.isFacebookHost) {
    return { referer: 'https://www.facebook.com/', origin: 'https://www.facebook.com' };
  }
  if (hostFlags?.isYouTubeHost) {
    return { referer: 'https://www.youtube.com/', origin: 'https://www.youtube.com' };
  }
  if (hostFlags?.isS3Host) {
    return { referer: '', origin: '' };
  }
  return { referer: 'https://x.com/', origin: 'https://x.com' };
};

const buildStreamRequestConfig = ({ range, ifRange, referer, origin }) => ({
  responseType: 'stream',
  headers: {
    ...(range ? { Range: range } : {}),
    ...(ifRange ? { 'If-Range': ifRange } : {}),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    ...(referer ? { 'Referer': referer } : {}),
    ...(origin ? { 'Origin': origin } : {})
  },
  validateStatus: (status) => true,
  decompress: false,
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  maxRedirects: 5,
  timeout: STREAM_TIMEOUT_MS,
  httpAgent: STREAM_HTTP_AGENT,
  httpsAgent: STREAM_HTTPS_AGENT
});

const normalizeMediaType = (value) => String(value ?? '').trim().toLowerCase();
const isVideoType = (value) => {
  const normalized = normalizeMediaType(value);
  return ['video', 'animated_gif', 'gifv', '2'].includes(normalized);
};
const isImageType = (value) => {
  const normalized = normalizeMediaType(value);
  return ['photo', 'image', '1'].includes(normalized);
};

const decodeEmbeddedFacebookUrl = (value) => {
  let decoded = String(value || '')
    .replace(/\\\\u0025/g, '%')
    .replace(/\\\\u0026/g, '&')
    .replace(/\\\\u003D/g, '=')
    .replace(/\\\\u002F/g, '/')
    .replace(/\\u0025/g, '%')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003D/g, '=')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  for (let i = 0; i < 3; i += 1) {
    try {
      const once = decodeURIComponent(decoded);
      if (!once || once === decoded) break;
      decoded = once;
    } catch (_) {
      break;
    }
  }

  return decoded;
};

const extractFacebookHtmlMedia = (html = '') => {
  const pickFirst = (patterns = []) => {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEmbeddedFacebookUrl(match[1]);
    }
    return '';
  };

  const collect = (patterns = []) => {
    const results = [];
    const seen = new Set();
    patterns.forEach((pattern) => {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        const value = decodeEmbeddedFacebookUrl(match?.[1] || '');
        if (!value || seen.has(value)) continue;
        seen.add(value);
        results.push(value);
      }
    });
    return results;
  };

  const flexibleVideoPatterns = [
    /(?:"|\\")playable_url_quality_hd(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")browser_native_hd_url(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")playable_url(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")browser_native_sd_url(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")playable_url_quality_sd(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /https?:\/\/[^"'\\\s]*video[^"'\\\s]*/gi
  ];

  const flexibleImagePatterns = [
    /(?:"|\\")preferred_thumbnail(?:"|\\")\s*:\s*\{[^}]*?(?:"|\\")uri(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")thumbnailImage(?:"|\\")\s*:\s*\{[^}]*?(?:"|\\")uri(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g,
    /(?:"|\\")image(?:"|\\")\s*:\s*\{[^}]*?(?:"|\\")uri(?:"|\\")\s*:\s*(?:"|\\")([^"\\]*(?:\\.[^"\\]*)*)(?:"|\\")/g
  ];

  const videoCandidates = collect(flexibleVideoPatterns)
    .filter((url) => /^https?:\/\//i.test(url));
  const imageCandidates = collect(flexibleImagePatterns)
    .filter((url) => /^https?:\/\//i.test(url));

  return {
    videoUrl: videoCandidates[0] || pickFirst([
      /"playable_url_quality_hd":"([^"]+)"/,
      /"browser_native_hd_url":"([^"]+)"/,
      /"playable_url":"([^"]+)"/,
      /"browser_native_sd_url":"([^"]+)"/,
      /"playable_url_quality_sd":"([^"]+)"/
    ]),
    videoUrls: videoCandidates,
    imageUrl: imageCandidates[0] || pickFirst([
      /"preferred_thumbnail":{"image":{"uri":"([^"]+)"/,
      /"thumbnailImage":{"uri":"([^"]+)"/,
      /"image":{"uri":"([^"]+)"/
    ]),
    imageUrls: imageCandidates
  };
};

const buildResolverHeaders = (rawUrl) => {
  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch (_) {
    hostname = '';
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  if (FACEBOOK_HOST_RE.test(hostname)) {
    headers.Referer = 'https://www.facebook.com/';
    headers.Origin = 'https://www.facebook.com';
  } else if (INSTAGRAM_HOST_RE.test(hostname)) {
    headers.Referer = 'https://www.instagram.com/';
    headers.Origin = 'https://www.instagram.com';
  } else if (YOUTUBE_HOST_RE.test(hostname)) {
    headers.Referer = 'https://www.youtube.com/';
    headers.Origin = 'https://www.youtube.com';
  }

  return headers;
};

router.get('/resolve', ...mediaAccessMiddleware, mockUser, async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'url query param is required' });
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    const hostname = (parsed.hostname || '').toLowerCase();
    if (!FACEBOOK_HOST_RE.test(hostname) && !INSTAGRAM_HOST_RE.test(hostname) && !YOUTUBE_HOST_RE.test(hostname)) {
      return res.status(403).json({ error: 'Host not allowed' });
    }

    const upstream = await axios.get(rawUrl, {
      timeout: 20000,
      headers: buildResolverHeaders(rawUrl)
    });

    const $ = cheerio.load(upstream.data);
    const readMeta = (...selectors) => {
      for (const selector of selectors) {
        const value = $(selector).attr('content');
        if (value && String(value).trim()) return String(value).trim();
      }
      return '';
    };

    const extracted = FACEBOOK_HOST_RE.test(hostname)
      ? extractFacebookHtmlMedia(upstream.data)
      : { imageUrl: null, imageUrls: [], videoUrl: null, videoUrls: [] };

    const videoMeta = readMeta(
      'meta[property="og:video:secure_url"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video"]'
    );
    const imageMeta = readMeta(
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]'
    );

    return res.json({
      success: true,
      image_url: imageMeta || extracted.imageUrl || null,
      image_urls: [imageMeta, ...(extracted.imageUrls || [])].filter(Boolean),
      video_url: videoMeta || extracted.videoUrl || null,
      video_urls: [videoMeta, ...(extracted.videoUrls || [])].filter(Boolean),
      title: readMeta('meta[property="og:title"]', 'meta[name="twitter:title"]') || null
    });
  } catch (error) {
    return res.status(500).json({
      error: error.response?.data?.error || error.message || 'Failed to resolve media'
    });
  }
});

// Generic media download for any platform
router.post('/download', ...mediaAccessMiddleware, mockUser, async (req, res) => {
  try {
    const { media_url, media_urls, media_items, content_url, url, content_id } = req.body;
    const mediaUrl = media_url || content_url || url;

    const toAbsolute = getAbsoluteUrlHelper(req);

    let result;

    const normalizeTwitterImageUrl = (u) => {
      if (!u || typeof u !== 'string') return u;
      // Prefer highest quality for Twitter images
      if (u.includes('pbs.twimg.com') && !/[?&]name=/.test(u)) {
        return `${u}${u.includes('?') ? '&' : '?'}name=orig`;
      }
      return u;
    };

    const isLikelyVideoUrl = (u) => {
      if (!u || typeof u !== 'string') return false;
      return (
        u.includes('video.twimg.com') ||
        u.includes('.cdninstagram.com') ||
        u.includes('.fbcdn.net') ||
        DIRECT_VIDEO_EXT_RE.test(u)
      );
    };

    const isLikelyImageUrl = (u) => {
      if (!u || typeof u !== 'string') return false;
      return DIRECT_IMAGE_EXT_RE.test(u);
    };

    const hasVideoInItems = (items = []) => {
      if (!Array.isArray(items)) return false;
      return items.some((it) => {
        const t = normalizeMediaType(it?.type);
        const u = String(it?.url || '');
        const mediaType = normalizeMediaType(it?.media_type);
        const isStoryOrReelVideo = Boolean(it?.is_video) || ['story_video', 'reel_video'].includes(mediaType);
        return isVideoType(t) || isVideoType(mediaType) || isStoryOrReelVideo || isLikelyVideoUrl(u);
      });
    };

    // If frontend passes explicit media items/urls (Twitter posts often have 1+ images)
    if ((Array.isArray(media_items) && media_items.length > 0) || (Array.isArray(media_urls) && media_urls.length > 0)) {
      const rawItems = Array.isArray(media_items) && media_items.length > 0
        ? media_items
        : media_urls.map((u) => ({ type: 'photo', url: u }));

      const cleaned = rawItems
        .map((it) => ({
          type: it?.type,
          media_type: it?.media_type,
          is_video: it?.is_video,
          url: typeof it?.url === 'string' ? it.url.trim() : it
        }))
        .filter((it) => !!it.url);

      const hasVideo = hasVideoInItems(cleaned);

      // Requirement: if any video exists, trigger MEDIA_ANALYZER_URL downloader.
      if (hasVideo) {
        if (!mediaUrl) {
          // Fall back to first video URL if tweet URL wasn't provided
          const firstVideo = cleaned.find((it) => {
            const t = normalizeMediaType(it?.type);
            const mt = normalizeMediaType(it?.media_type);
            return isVideoType(t) || isVideoType(mt) || Boolean(it?.is_video) || isLikelyVideoUrl(String(it?.url || ''));
          });
          if (!firstVideo?.url) {
            return res.status(400).json({ error: 'media_url is required for video download' });
          }
          result = await mediaAnalyzerService.downloadVideo(String(firstVideo.url));
        } else {
          result = await mediaAnalyzerService.downloadVideo(mediaUrl);
        }
      } else {
        // Images: return direct URLs (browser downloads), no external service.
        const directItems = cleaned.map((it, idx) => {
          const directUrl = normalizeTwitterImageUrl(String(it.url));
          const normalizedType = normalizeMediaType(it.type);
          const outputType = isImageType(normalizedType) ? normalizedType : (isLikelyImageUrl(directUrl) ? 'photo' : (normalizedType || 'photo'));
          return {
            type: outputType,
            url: directUrl,
            download_url: directUrl,
            title: `Media ${idx + 1}`
          };
        });

        result = {
          video_id: content_id || 'media',
          filename: directItems.length === 1 ? 'image' : `images_${directItems.length}`,
          download_url: directItems.length === 1 ? directItems[0].download_url : directItems.map((i) => i.download_url),
          title: directItems.length === 1 ? 'Image' : `Images (${directItems.length})`,
          media_count: directItems.length,
          items: directItems
        };
      }
    } else {
      if (!mediaUrl) {
        return res.status(400).json({ error: 'media_url is required' });
      }

      //console.log(`Initiating media download for: ${mediaUrl}`);
      result = await mediaAnalyzerService.downloadVideo(mediaUrl);
    }

    await logAction(req.user, 'download_video', 'content', content_id || result.video_id, {
      media_url: mediaUrl,
      video_id: result.video_id,
      filename: result.filename
    });

    // Normalize/absolute-ify URLs so window.open works from the React app
    const downloadUrl = Array.isArray(result.download_url)
      ? result.download_url.map(toAbsolute)
      : toAbsolute(result.download_url);

    const items = Array.isArray(result.items)
      ? result.items.map((i) => ({
        ...i,
        download_url: toAbsolute(i.download_url)
      }))
      : undefined;

    // Backward compatible: keep download_url as a single string when possible
    const primaryDownloadUrl = Array.isArray(downloadUrl) ? downloadUrl[0] : downloadUrl;

    res.json({
      success: true,
      video_id: result.video_id,
      filename: result.filename,
      download_url: primaryDownloadUrl,
      download_urls: Array.isArray(downloadUrl) ? downloadUrl : undefined,
      title: result.title,
      duration_seconds: result.duration_seconds,
      media_count: result.media_count,
      items
    });
  } catch (error) {
    //console.error('Media download error:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to download media'
    });
  }
});

// Download images only (for separate image download option)
router.post('/download-images', ...mediaAccessMiddleware, mockUser, async (req, res) => {
  try {
    const { image_urls, content_id } = req.body;

    if (!image_urls || !Array.isArray(image_urls) || image_urls.length === 0) {
      return res.status(400).json({ error: 'image_urls array is required' });
    }

    //console.log(`Downloading ${image_urls.length} images...`);
    const result = await mediaAnalyzerService.downloadImages(image_urls, content_id);

    const toAbsolute = getAbsoluteUrlHelper(req);
    const absoluteResult = {
      ...result,
      items: result.items ? result.items.map(i => ({
        ...i,
        download_url: toAbsolute(i.download_url)
      })) : []
    };

    await logAction(req.user, 'download_images', 'content', content_id, {
      image_count: result.media_count
    });

    res.json(absoluteResult);
  } catch (error) {
    // console.error('Image download error:', error);
    res.status(500).json({ error: 'Failed to download images' });
  }
});

// Download videos only (for separate video download option, supports up to 30 min)
router.post('/download-video', ...mediaAccessMiddleware, mockUser, async (req, res) => {
  try {
    const { media_url, video_urls, content_id } = req.body;

    if (!media_url && (!video_urls || video_urls.length === 0)) {
      return res.status(400).json({ error: 'media_url or video_urls is required' });
    }

    //console.log(`Downloading video from: ${media_url || video_urls[0]}`);

    // Use media analyzer service for video download (supports longer videos)
    const result = await mediaAnalyzerService.downloadVideo(media_url || video_urls[0]);

    await logAction(req.user, 'download_video', 'content', content_id || result.video_id, {
      media_url: media_url,
      video_id: result.video_id,
      filename: result.filename
    });

    const toAbsolute = getAbsoluteUrlHelper(req);
    const downloadUrl = toAbsolute(result.download_url);

    res.json({
      success: true,
      video_id: result.video_id,
      filename: result.filename,
      download_url: downloadUrl,
      title: result.title,
      duration_seconds: result.duration_seconds,
      items: result.items ? result.items.map(i => ({
        ...i,
        download_url: toAbsolute(i.download_url)
      })) : [{ filename: result.filename, download_url: downloadUrl }]
    });
  } catch (error) {
    //console.error('Video download error:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to download video'
    });
  }
});

// Serve downloaded files
router.get('/downloads/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);
    const filepath = mediaAnalyzerService.getLocalDownloadPath(sanitizedFilename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Determine content type
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.mp4': 'video/mp4',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);

    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
  } catch (error) {
    //console.error('File serve error:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// Check service status
router.get('/status', async (req, res) => {
  const externalAvailable = await mediaAnalyzerService.isMediaAnalyzerAvailable();
  res.json({
    external_service: externalAvailable ? 'available' : 'unavailable',
    fallback: 'available',
    message: externalAvailable
      ? 'Using external media analyzer service'
      : 'Using built-in Twitter media downloader'
  });
});

// ---------------------------------------------------------------------------
// S3 Fallback helper: when an upstream CDN returns 403 (expired token),
// look up the original URL in the database and serve the S3-archived copy.
// ---------------------------------------------------------------------------
const InstagramStory = require('../models/InstagramStory');
const Content = require('../models/Content');

/**
 * Given an expired CDN URL, search the DB for a matching S3-archived version.
 * Returns the S3 URL string or null.
 */
const findS3FallbackUrl = async (cdnUrl) => {
  if (!cdnUrl) return null;

  const cachedUrl = getCachedS3FallbackUrl(cdnUrl);
  if (cachedUrl) return cachedUrl;

  try {
    // 1. Check InstagramStory collection
    const story = await InstagramStory.findOne({
      $or: [
        { original_url: cdnUrl },
        { thumbnail_url: cdnUrl }
      ]
    }).select('s3_url s3_thumbnail_url original_url thumbnail_url').lean();

    if (story) {
      if (story.original_url === cdnUrl && story.s3_url) {
        setCachedS3FallbackUrl(cdnUrl, story.s3_url);
        return story.s3_url;
      }
      if (story.thumbnail_url === cdnUrl && story.s3_thumbnail_url) {
        setCachedS3FallbackUrl(cdnUrl, story.s3_thumbnail_url);
        return story.s3_thumbnail_url;
      }
      // Fallback: return any available S3 URL from this story
      const storyFallbackUrl = story.s3_url || story.s3_thumbnail_url || null;
      if (storyFallbackUrl) {
        setCachedS3FallbackUrl(cdnUrl, storyFallbackUrl);
      }
      return storyFallbackUrl;
    }

    // 2. Check Content collection (media array)
    const content = await Content.findOne({
      $or: [
        { 'media.url': cdnUrl },
        { 'media.original_url': cdnUrl },
        { 'media.video_url': cdnUrl },
        { 'media.original_video_url': cdnUrl }
      ]
    }).select('media').lean();

    if (content && Array.isArray(content.media)) {
      for (const m of content.media) {
        const matchesUrl = (m.url === cdnUrl || m.original_url === cdnUrl ||
          m.video_url === cdnUrl || m.original_video_url === cdnUrl);
        if (matchesUrl && m.s3_url) {
          setCachedS3FallbackUrl(cdnUrl, m.s3_url);
          return m.s3_url;
        }
        if (matchesUrl && m.s3_preview) {
          setCachedS3FallbackUrl(cdnUrl, m.s3_preview);
          return m.s3_preview;
        }
      }
    }

    return null;
  } catch (err) {
    // Don't let DB errors break the proxy
    return null;
  }
};

// Stream proxy for remote media (primarily X/Twitter videos).
// Rationale: browsers often can't play video.twimg.com MP4s directly due to CORS/hotlinking;
// by streaming through our backend, videos become playable "from our platform".
// Security: strict allowlist to avoid becoming an open proxy.
router.get('/stream', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'url query param is required' });
    }

    // Handle local paths for profile images and other uploads
    if (rawUrl.startsWith('/') || !rawUrl.startsWith('http')) {
      const publicPath = path.join(process.cwd(), 'public');
      const filePath = path.join(publicPath, rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`);

      // Safety check to prevent path traversal
      if (!filePath.startsWith(publicPath)) {
        return res.status(403).json({ error: 'Path not allowed' });
      }

      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      return res.status(404).json({ error: 'File not found' });
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid url' });
    }

    const hostname = (parsed.hostname || '').toLowerCase();
    const initialHostFlags = classifyStreamHost(hostname);
    if (!initialHostFlags.isAllowed) {
      return res.status(403).json({ error: 'Host not allowed' });
    }

    const range = req.headers.range;
    const ifRange = req.headers['if-range'];

    const requestStream = async (targetUrl, hostFlags) => {
      const { referer, origin } = getStreamOriginHeaders(hostFlags);
      return axios.get(targetUrl, buildStreamRequestConfig({
        range,
        ifRange,
        referer,
        origin
      }));
    };

    let streamUrl = getCachedS3FallbackUrl(rawUrl) || rawUrl;
    let streamParsed = parsed;

    if (streamUrl !== rawUrl) {
      try {
        streamParsed = new URL(streamUrl);
      } catch (_) {
        clearCachedS3FallbackUrl(rawUrl);
        streamUrl = rawUrl;
        streamParsed = parsed;
      }
    }

    let streamHostFlags = classifyStreamHost((streamParsed.hostname || '').toLowerCase());
    if (!streamHostFlags.isAllowed) {
      clearCachedS3FallbackUrl(rawUrl);
      streamUrl = rawUrl;
      streamParsed = parsed;
      streamHostFlags = initialHostFlags;
    }

    let upstream = await requestStream(streamUrl, streamHostFlags);

    // Cached S3 target may expire; clear cache and retry original URL once.
    if (streamUrl !== rawUrl && (upstream.status === 403 || upstream.status === 404 || upstream.status === 410)) {
      if (upstream.data?.resume) upstream.data.resume();
      clearCachedS3FallbackUrl(rawUrl);
      streamUrl = rawUrl;
      streamParsed = parsed;
      streamHostFlags = initialHostFlags;
      upstream = await requestStream(streamUrl, streamHostFlags);
    }

    const bindAbortOnClientClose = (sourceStream) => {
      if (!sourceStream || typeof sourceStream.destroy !== 'function') return;
      req.once('close', () => {
        if (!res.writableEnded) {
          sourceStream.destroy();
        }
      });
    };

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'accept-ranges',
      'content-range',
      'etag',
      'last-modified',
      'cache-control'
    ];

    const applyStreamDefaults = (sourceUrl, fallbackContentType = '') => {
      const finalContentType = String(res.getHeader('content-type') || fallbackContentType || '').toLowerCase();
      const isVideoResponse = finalContentType.startsWith('video/') || DIRECT_VIDEO_EXT_RE.test(String(sourceUrl || ''));
      const isS3 = typeof sourceUrl === 'string' && /amazonaws\.com|bhaskar-media-storage/i.test(sourceUrl);

      if (isVideoResponse || finalContentType.startsWith('image/')) {
        if (!res.getHeader('accept-ranges') && isVideoResponse) {
          res.setHeader('accept-ranges', 'bytes');
        }
        if (!res.getHeader('cache-control')) {
          // S3 archived media is permanent — cache aggressively
          res.setHeader('cache-control', isS3 ? 'public, max-age=86400, immutable' : 'public, max-age=300');
        }
      }
    };

    // ---------------------------------------------------------------
    // S3 Fallback: if upstream CDN returns 403/410 (expired token),
    // look up the original URL in the DB and serve the S3 copy.
    // ---------------------------------------------------------------
    if ((upstream.status === 403 || upstream.status === 410) && !streamHostFlags.isS3Host) {
      // Drain the failed upstream stream to free the socket
      upstream.data.resume();

      const s3FallbackUrl = await findS3FallbackUrl(rawUrl);
      if (s3FallbackUrl) {
        try {
          const s3Parsed = new URL(s3FallbackUrl);
          const s3HostFlags = classifyStreamHost((s3Parsed.hostname || '').toLowerCase());
          if (!s3HostFlags.isAllowed) {
            throw new Error('S3 fallback host not allowed');
          }

          const s3Upstream = await requestStream(s3FallbackUrl, s3HostFlags);

          if (s3Upstream.status < 400) {
            setCachedS3FallbackUrl(rawUrl, s3FallbackUrl);

            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

            for (const headerName of passthroughHeaders) {
              const value = s3Upstream.headers?.[headerName];
              if (value) res.setHeader(headerName, value);
            }

            // Fix wrong content-type from S3 (e.g. video/mp4 for a .jpg)
            const s3ContentType = (s3Upstream.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
            const s3Path = new URL(s3FallbackUrl).pathname.toLowerCase();
            if (s3Path.match(/\.(jpg|jpeg)$/) && !s3ContentType.startsWith('image/')) {
              res.setHeader('content-type', 'image/jpeg');
            } else if (s3Path.match(/\.png$/) && !s3ContentType.startsWith('image/')) {
              res.setHeader('content-type', 'image/png');
            } else if (s3Path.match(/\.webp$/) && !s3ContentType.startsWith('image/')) {
              res.setHeader('content-type', 'image/webp');
            } else if (s3Path.match(/\.mp4$/) && !s3ContentType.startsWith('video/')) {
              res.setHeader('content-type', 'video/mp4');
            }

            applyStreamDefaults(s3FallbackUrl, s3Upstream.headers?.['content-type']);

            res.status(s3Upstream.status);
            bindAbortOnClientClose(s3Upstream.data);
            s3Upstream.data.pipe(res);
            s3Upstream.data.on('error', (err) => {
              if (!res.headersSent) {
                res.status(500).json({ error: 'S3 fallback stream error' });
              } else {
                res.end();
              }
            });
            return; // Successfully served from S3 fallback
          }

          // S3 also failed — drain and fall through to return original error
          s3Upstream.data.resume();
        } catch (s3Err) {
          // S3 fetch threw — fall through to return original error
        }
      }

      // No S3 fallback found or S3 also failed — return original 403
      return res.status(upstream.status).json({
        error: 'CDN returned ' + upstream.status + ' (media expired/unavailable)',
        hint: 'No S3 archive available for this media'
      });
    }

    for (const headerName of passthroughHeaders) {
      const value = upstream.headers?.[headerName];
      if (value) res.setHeader(headerName, value);
    }

    // Fix content-type for S3 objects served with wrong MIME type
    if (streamHostFlags.isS3Host) {
      const upstreamCT = (upstream.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      const s3Path = streamParsed.pathname.toLowerCase();
      if (s3Path.match(/\.(jpg|jpeg)$/) && !upstreamCT.startsWith('image/')) {
        res.setHeader('content-type', 'image/jpeg');
      } else if (s3Path.match(/\.png$/) && !upstreamCT.startsWith('image/')) {
        res.setHeader('content-type', 'image/png');
      } else if (s3Path.match(/\.webp$/) && !upstreamCT.startsWith('image/')) {
        res.setHeader('content-type', 'image/webp');
      } else if (s3Path.match(/\.mp4$/) && !upstreamCT.startsWith('video/')) {
        res.setHeader('content-type', 'video/mp4');
      }
    }

    // Fix content-type for Facebook video CDN (no file extensions in URL)
    if (streamHostFlags.isFacebookHost) {
      const upstreamCT = (upstream.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      const fbHost = (streamParsed.hostname || '').toLowerCase();
      const isVideoHost = /^video[^.]*\.fbcdn\.net$/.test(fbHost);
      // Facebook video hosts serve video but sometimes with generic content-type
      if (isVideoHost && (!upstreamCT || upstreamCT === 'application/octet-stream')) {
        res.setHeader('content-type', 'video/mp4');
      }
    }

    applyStreamDefaults(streamUrl, upstream.headers?.['content-type']);

    // If upstream returned partial content, preserve it.
    res.status(upstream.status);

    if (upstream.status >= 400) {
      //console.error(`Upstream error ${upstream.status} for ${rawUrl}`);
    }

    // ---------------------------------------------------------------
    // HLS m3u8 URL rewriting: buffer the manifest and rewrite every
    // segment URL (and URI= attributes in tags like EXT-X-KEY/EXT-X-MAP)
    // so that hls.js fetches all segments through this proxy instead of
    // hitting video.twimg.com directly (which is blocked by CORS).
    // ---------------------------------------------------------------
    const upstreamCT2 = (upstream.headers?.['content-type'] || '').toLowerCase();
    const isM3U8Response = upstreamCT2.includes('mpegurl') ||
      rawUrl.includes('.m3u8') || streamUrl.includes('.m3u8');

    if (isM3U8Response && upstream.status < 400) {
      const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
      const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'https';
      const proxyBase = `${protocol}://${req.get('host')}/api/media/stream?url=`;

      let m3u8Body = '';
      upstream.data.on('data', (chunk) => { m3u8Body += chunk.toString('utf8'); });
      upstream.data.on('end', () => {
        const rewritten = m3u8Body.split('\n').map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
              try {
                const abs = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).href;
                return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
              } catch (_) { return `URI="${uri}"`; }
            });
          }
          try {
            const abs = /^https?:\/\//i.test(trimmed) ? trimmed : new URL(trimmed, baseUrl).href;
            return proxyBase + encodeURIComponent(abs);
          } catch (_) { return line; }
        }).join('\n');

        res.setHeader('content-type', 'application/x-mpegURL');
        res.removeHeader('content-length');
        res.end(rewritten);
      });
      upstream.data.on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream m3u8' });
        else res.end();
      });
    } else {
      bindAbortOnClientClose(upstream.data);
      upstream.data.pipe(res);
      upstream.data.on('error', (err) => {
        //console.error('Upstream stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream media' });
        } else {
          res.end();
        }
      });
    }
  } catch (error) {
    //console.error('Media stream proxy error:', error.message);
    res.status(500).json({ error: 'Failed to stream media' });
  }
});

// Proxy endpoint to stream videos from media-analyzer service
// This allows the backend to serve files from the media-analyzer service
// which may not be directly accessible from the user's browser
router.get('/proxy/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    // Sanitize videoId to prevent path traversal (allow dots for file extensions)
    const sanitizedVideoId = videoId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!sanitizedVideoId) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    //console.log(`Proxying download for: ${sanitizedVideoId}`);

    const { stream, headers, status } = await mediaAnalyzerService.getVideoStream(sanitizedVideoId);

    // Skip problematic hop-by-hop headers
    const headersToSkip = [
      'host', 'connection', 'keep-alive', 'proxy-authenticate',
      'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'
    ];

    // Forward upstream status
    res.status(status || 200);

    // Forward headers
    for (const [key, value] of Object.entries(headers)) {
      if (!headersToSkip.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    // Reinforce content type if missing or generic to prevent .bin downloads
    const contentTypeToExt = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv',
      'video/x-msvideo': 'avi',
      'video/quicktime': 'mov',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'application/zip': 'zip'
    };

    let contentType = res.getHeader('Content-Type')?.toString().split(';')[0]?.trim();
    if (!contentType || contentType === 'application/octet-stream') {
      const ext = sanitizedVideoId.split('.').pop().toLowerCase();
      const mappedType = Object.entries(contentTypeToExt).find(([type, e]) => e === ext)?.[0];
      if (mappedType) {
        contentType = mappedType;
        res.setHeader('Content-Type', contentType);
      } else if (sanitizedVideoId.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        contentType = 'image/jpeg';
        res.setHeader('Content-Type', contentType);
      } else {
        // Fallback for media proxy if still unknown
        contentType = 'video/mp4';
        res.setHeader('Content-Type', contentType);
      }
    }

    // Reinforce Content-Disposition with a proper extension if needed
    let contentDisposition = res.getHeader('Content-Disposition')?.toString();
    if (!contentDisposition) {
      const ext = contentTypeToExt[contentType] || 'mp4';
      const filename = sanitizedVideoId.includes('.') ? sanitizedVideoId : `${sanitizedVideoId}.${ext}`;
      contentDisposition = `attachment; filename="${filename}"`;
      res.setHeader('Content-Disposition', contentDisposition);
    }

    // Pipe the stream to the response
    stream.pipe(res);

    stream.on('error', (err) => {
      // console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream video' });
      }
    });
  } catch (error) {
    // console.error('Proxy download error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.detail || 'Failed to download video. It may have been cleaned up.'
    });
  }
});

module.exports = router;
