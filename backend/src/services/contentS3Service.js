/**
 * contentS3Service.js
 * -------------------
 * Downloads Instagram post/reel/story media from CDN URLs and archives
 * them permanently to S3.  After upload the Content document is updated
 * so the front-end can fall back to the S3 copy when the original CDN
 * link expires or the author deletes the post.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const cheerio = require('cheerio');

// ─── On-prem, tenant-isolated local storage (replaces AWS S3) ──────────────
// Files live under storage/<tenant_id>/<folder>/... and are served by the
// /files route, which resolves the tenant from the request subdomain. The
// public URL is RELATIVE (no tenant id) so it works on any tenant subdomain
// over HTTPS and never leaks another tenant's path.
const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');

const CONTENT_FOLDER = 'instagram-content'; // separate folder from stories
const TWITTER_FOLDER = 'twitter-content';
const FACEBOOK_FOLDER = 'facebook-content';
const MEDIA_DOWNLOAD_URL = process.env.MEDIA_ANALYZER_URL || 'http://localhost:8005';

// Social-media auto-archival is OFF by default: social posts (instagram / twitter /
// facebook) render directly from the platform CDN via the /api/media/stream proxy —
// no copy is stored. User-uploaded evidence (criticism / query / suggestion /
// grievance folders) is NOT social, so it still archives to disk. Set
// ENABLE_SOCIAL_MEDIA_ARCHIVE=1 to also store social media on disk.
const SOCIAL_FOLDERS = new Set([CONTENT_FOLDER, TWITTER_FOLDER, FACEBOOK_FOLDER]);
const SOCIAL_ARCHIVE_ENABLED = process.env.ENABLE_SOCIAL_MEDIA_ARCHIVE === '1' || process.env.ENABLE_SOCIAL_MEDIA_ARCHIVE === 'true';
const isSocialAutoArchive = (folder) => !SOCIAL_ARCHIVE_ENABLED && SOCIAL_FOLDERS.has(folder || CONTENT_FOLDER);

// ─── Helpers ───────────────────────────────────────────────────────────────

const FACEBOOK_CDN_HOST_RE = /(?:^|\.)fbcdn\.net$|(?:^|\.)fbsbx\.com$|^lookaside\.facebook\.com$/i;
const FACEBOOK_PAGE_HOST_RE = /(?:^|\.)facebook\.com$/i;
const INSTAGRAM_CDN_HOST_RE = /(?:^|\.)cdninstagram\.com$/i;
const TWITTER_CDN_HOST_RE = /(?:^|\.)twimg\.com$/i;

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

const getHostname = (rawUrl) => {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
};

const isFacebookPageUrl = (mediaUrl) => {
  const hostname = getHostname(mediaUrl);
  if (!hostname || !FACEBOOK_PAGE_HOST_RE.test(hostname)) return false;
  return !/\.(mp4|webm|mkv|mov|avi|m3u8|jpe?g|png|gif|webp)(\?|$)/i.test(mediaUrl);
};

const buildMediaRequestHeaders = (mediaUrl) => {
  const hostname = getHostname(mediaUrl);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  if (FACEBOOK_CDN_HOST_RE.test(hostname) || FACEBOOK_PAGE_HOST_RE.test(hostname)) {
    headers.Referer = 'https://www.facebook.com/';
    headers.Origin = 'https://www.facebook.com';
  } else if (INSTAGRAM_CDN_HOST_RE.test(hostname) || hostname === 'instagram.com' || hostname === 'www.instagram.com') {
    headers.Referer = 'https://www.instagram.com/';
    headers.Origin = 'https://www.instagram.com';
  } else if (TWITTER_CDN_HOST_RE.test(hostname) || hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.twitter.com') {
    headers.Referer = 'https://x.com/';
    headers.Origin = 'https://x.com';
  } else if (hostname === 'youtube.com' || hostname === 'www.youtube.com') {
    headers.Referer = 'https://www.youtube.com/';
    headers.Origin = 'https://www.youtube.com';
  }

  return headers;
};

const resolveFacebookPageMedia = async (pageUrl) => {
  if (!isFacebookPageUrl(pageUrl)) return { videoUrl: null, imageUrl: null };

  try {
    const response = await axios.get(pageUrl, {
      timeout: 20000,
      headers: {
        ...buildMediaRequestHeaders(pageUrl),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const $ = cheerio.load(response.data);
    const htmlMedia = extractFacebookHtmlMedia(response.data);
    const readMeta = (...selectors) => {
      for (const selector of selectors) {
        const value = $(selector).attr('content');
        if (value && String(value).trim()) return String(value).trim();
      }
      return '';
    };

    return {
      videoUrl: readMeta(
        'meta[property="og:video:secure_url"]',
        'meta[property="og:video:url"]',
        'meta[property="og:video"]'
      ) || htmlMedia.videoUrl || null,
      imageUrl: readMeta(
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image:url"]',
        'meta[property="og:image"]',
        'meta[name="twitter:image"]'
      ) || htmlMedia.imageUrl || null
    };
  } catch (err) {
    console.error(`[ContentS3] ❌ Facebook page media resolve failed for ${pageUrl}: ${err.message}`);
    return { videoUrl: null, imageUrl: null };
  }
};

/**
 * Fetch the actual video MP4 URL for a tweet via Twitter's syndication API.
 * This works without API keys and returns video_info with direct MP4 URLs.
 * @param {string} tweetId – the tweet ID
 * @returns {string|null} – highest quality MP4 URL, or null
 */
const fetchTwitterVideoUrl = async (tweetId) => {
  if (!tweetId) return null;
  try {
    const res = await axios.get('https://cdn.syndication.twimg.com/tweet-result', {
      params: { id: tweetId, token: 'x' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
      timeout: 10000
    });
    const mediaDetails = res.data?.mediaDetails || [];
    for (const m of mediaDetails) {
      if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info?.variants) {
        const mp4Variants = m.video_info.variants
          .filter(v => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4Variants.length > 0) return mp4Variants[0].url;
      }
    }
    return null;
  } catch (err) {
    console.error(`[ContentS3] ⚠️ Syndication fetch failed for ${tweetId}: ${err.message}`);
    return null;
  }
};

/**
 * Write a buffer to on-prem local storage under the tenant's namespace and
 * return a server-relative URL. Name kept as uploadToS3 for backwards
 * compatibility with internal callers.
 * @returns {{ url: string, key: string }}
 */
const uploadToS3 = async (buffer, key, _contentType = 'application/octet-stream', tenantId = null) => {
  const absPath = path.join(STORAGE_DIR, safeTenant(tenantId), key);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);

  // Relative URL (no tenant id in it) — the /files route serves each tenant its
  // OWN folder based on the request subdomain, so this resolves correctly and a
  // URL is meaningless outside its own tenant subdomain.
  const url = `/files/${key.split('/').map(encodeURIComponent).join('/')}`;
  return { url, key };
};

/**
 * Download a remote URL into a Buffer.
 * Returns null on failure so callers can skip gracefully.
 */
const downloadMedia = async (mediaUrl) => {
  try {
    const response = await axios({
      method: 'GET',
      url: mediaUrl,
      responseType: 'arraybuffer',
      timeout: 60000, // 60 s – videos can be large
      headers: buildMediaRequestHeaders(mediaUrl)
    });
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    if (/text\/html|application\/json|text\/plain/i.test(contentType)) {
      console.warn(`[ContentS3] ⚠️ Refusing non-media response ${contentType} for ${mediaUrl}`);
      return null;
    }
    return { buffer: Buffer.from(response.data), contentType };
  } catch (err) {
    console.error(`[ContentS3] ❌ Download failed for ${mediaUrl}: ${err.message}`);
    return null;
  }
};

/**
 * Download media using the Python Media Download Service.
 * This is preferred for Reels/Stories as it handles signatures/cookies better via yt-dlp.
 */
const downloadViaPythonService = async (mediaUrl) => {
  try {
    // 1. Request the download – send both `url` and `media_url` for compatibility
    console.log(`[ContentS3] 🐍 Sending to Python service: ${mediaUrl.substring(0, 80)}`);
    const dlRes = await axios.post(`${MEDIA_DOWNLOAD_URL}/download`, {
        url: mediaUrl,
        media_url: mediaUrl
    }, {
        timeout: 120000,
        headers: { 'x-api-key': process.env.GATEWAY_API_KEY || '' }
    }); // 2 min – yt-dlp may need time for HLS conversion
    
    if (!dlRes.data || !dlRes.data.download_url) {
        throw new Error('No download URL returned from service');
    }

    // 2. Retrieve the file content
    const fileUrl = `${MEDIA_DOWNLOAD_URL}${dlRes.data.download_url}`;
    console.log(`[ContentS3] 📥 Fetching file from: ${fileUrl}`);
    const fileRes = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'arraybuffer',
        timeout: 300000 // 5 minutes for large videos
    });

    const buffer = Buffer.from(fileRes.data);
    console.log(`[ContentS3] 📦 Python service returned ${(buffer.length / 1024).toFixed(1)} KB`);
    return {
        buffer,
        contentType: fileRes.headers['content-type'] || 'video/mp4'
    };
  } catch (err) {
    const detail = err.response?.data?.detail || err.message;
    console.error(`[ContentS3] ❌ Python Service download failed: ${detail}`);
    return null;
  }
};


/**
 * Determine file extension from content-type or URL.
 */
const getExtension = (contentType, url, mediaType) => {
  if (mediaType === 'video') return 'mp4';
  if (contentType) {
    if (contentType.includes('mp4') || contentType.includes('video')) return 'mp4';
    if (contentType.includes('webm')) return 'webm';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
  }
  // Fallback to URL extension
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.split('?')[0];
    if (ext && ext.length <= 5) return ext;
  } catch (_) { /* ignore */ }
  return 'jpg';
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Check if a URL points to a thumbnail/image rather than an actual video file.
 */
const isThumbnailUrl = (url) => {
  if (!url) return true;
  const u = url.toLowerCase();
  // Twitter video thumbnails
  if (u.includes('pbs.twimg.com') && (u.includes('video_thumb') || u.includes('amplify_video_thumb'))) return true;
  // Generic image extensions when we expect video
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) return true;
  return false;
};

/**
 * Check if a URL is an HLS playlist (.m3u8) instead of a direct MP4.
 */
const isHlsUrl = (url) => {
  if (!url) return false;
  return url.toLowerCase().includes('.m3u8') || url.includes('/pl/');
};

/**
 * Minimum size (in bytes) for a valid video file.
 * HLS playlist files are typically 0.7-1.5 KB.
 * Real videos are at least 10 KB.
 */
const MIN_VIDEO_SIZE_BYTES = 10 * 1024; // 10 KB

/**
 * Archive a single media item to S3.
 * @param {string} mediaUrl  – original CDN URL (or tweet/post page URL for video fallback)
 * @param {string} contentId – the Content document's content_id
 * @param {string} mediaType – 'photo' | 'video'
 * @param {number} index     – position in the media array (for carousels)
 * @param {object} options   – { folder, useUniqueFileName, fileBaseName, postUrl }
 * @returns {{ url, key } | null}
 */
const archiveMediaItem = async (mediaUrl, contentId, mediaType = 'photo', index = 0, options = {}) => {
  if (!mediaUrl) return null;

  try {
    let dl = null;
    const isVideo = mediaType === 'video' || mediaType === 'reel' || mediaType === 'animated_gif';
    let effectiveMediaUrl = mediaUrl;
    let resolvedFacebookPreviewUrl = options.previewUrl || '';

    if (isFacebookPageUrl(mediaUrl)) {
      const resolvedPageMedia = await resolveFacebookPageMedia(mediaUrl);
      if (isVideo && resolvedPageMedia.videoUrl) {
        effectiveMediaUrl = resolvedPageMedia.videoUrl;
      } else if (!isVideo && resolvedPageMedia.imageUrl) {
        effectiveMediaUrl = resolvedPageMedia.imageUrl;
      }

      if (!resolvedFacebookPreviewUrl && resolvedPageMedia.imageUrl) {
        resolvedFacebookPreviewUrl = resolvedPageMedia.imageUrl;
      }
    }

    if (isVideo) {
      // ── Strategy 1: Direct download ONLY for confirmed direct MP4 URLs ──
      // (e.g. video.twimg.com/ext_tw_video/...mp4 – NOT .m3u8 playlists)
      if (!isThumbnailUrl(effectiveMediaUrl) && !isHlsUrl(effectiveMediaUrl) && /\.(mp4|webm)(\?|$)/i.test(effectiveMediaUrl)) {
        dl = await downloadMedia(effectiveMediaUrl);
        // Validate: reject tiny files (HLS playlists, error pages)
        if (dl && dl.buffer.length < MIN_VIDEO_SIZE_BYTES) {
          console.warn(`[ContentS3] ⚠️ Direct download too small (${dl.buffer.length} bytes), likely not a real video`);
          dl = null;
        }
      }

      // ── Strategy 2: Use Python media-download service (handles HLS, cookies, yt-dlp) ──
      // Build the best URL for the service: prefer tweet/post page URL
      if (!dl && !mediaUrl.includes('facebook.com')) {
        const tweetId = String(contentId).split('_')[0];
        const postUrl = options.postUrl || (mediaUrl.includes('facebook.com') ? mediaUrl : `https://x.com/i/status/${tweetId}`);
        console.log(`[ContentS3] 🎬 Using Python service for video: ${postUrl.substring(0, 80)}`);
        dl = await downloadViaPythonService(postUrl);
        // Validate: reject tiny files
        if (dl && dl.buffer.length < MIN_VIDEO_SIZE_BYTES) {
          console.warn(`[ContentS3] ⚠️ Python service returned too small (${dl.buffer.length} bytes), discarding`);
          dl = null;
        }
      }

      // ── Strategy 3: Syndication API to get direct MP4 URL ──
      if (!dl && mediaUrl.includes('twimg.com')) {
        const tweetId = String(contentId).split('_')[0];
        console.log(`[ContentS3] 🔍 Trying syndication API for tweet ${tweetId}`);
        const realVideoUrl = await fetchTwitterVideoUrl(tweetId);
        if (realVideoUrl && !isHlsUrl(realVideoUrl)) {
          console.log(`[ContentS3] 🎥 Got real video URL: ${realVideoUrl.substring(0, 80)}`);
          dl = await downloadMedia(realVideoUrl);
          if (dl && dl.buffer.length < MIN_VIDEO_SIZE_BYTES) {
            console.warn(`[ContentS3] ⚠️ Syndication video too small (${dl.buffer.length} bytes), discarding`);
            dl = null;
          }
        }
      }
    }

    // For images, or if all video attempts failed, download directly
    if (!dl) {
      dl = await downloadMedia(effectiveMediaUrl);
    }

    if (!dl) return null;

    // Safety check: reject invalid content for video items
    if (isVideo && dl.contentType) {
      if (dl.contentType.startsWith('image/')) {
        console.warn(`[ContentS3] ⚠️ Expected video but got ${dl.contentType} for ${contentId}[${index}] – skipping`);
        return null;
      }
      // Reject HLS playlists that slipped through
      if (dl.contentType.includes('mpegURL') || dl.contentType.includes('m3u8')) {
        console.warn(`[ContentS3] ⚠️ Got HLS playlist (${dl.contentType}) instead of video for ${contentId}[${index}] – skipping`);
        return null;
      }
    }
    // Final size guard for videos
    if (isVideo && dl.buffer.length < MIN_VIDEO_SIZE_BYTES) {
      console.warn(`[ContentS3] ⚠️ Video file too small (${dl.buffer.length} bytes) for ${contentId}[${index}] – skipping`);
      return null;
    }

    const ext = getExtension(dl.contentType, effectiveMediaUrl, mediaType);
    const folder = options.folder || CONTENT_FOLDER;
    const useUniqueFileName = options.useUniqueFileName === true;
    const baseName = String(options.fileBaseName ?? index);
    const uniqueSuffix = useUniqueFileName ? `-${Date.now()}-${randomUUID().slice(0, 8)}` : '';
    const filename = `${baseName}${uniqueSuffix}.${ext}`;
    const key = `${folder}/${contentId}/${filename}`;

    const result = await uploadToS3(dl.buffer, key, dl.contentType, options.tenantId);
    console.log(`[ContentS3] ✅ Archived ${contentId}/${index}.${ext} (${(dl.buffer.length / 1024).toFixed(1)} KB)`);
    if (resolvedFacebookPreviewUrl) {
      result.previewUrl = resolvedFacebookPreviewUrl;
    }
    return result;
  } catch (err) {
    console.error(`[ContentS3] ❌ Archive failed for ${contentId}[${index}]: ${err.message}`);
    return null;
  }
};

/**
 * Archive a preview/thumbnail image to S3.
 * @returns {{ url, key } | null}
 */
const archivePreview = async (previewUrl, contentId, index = 0, options = {}) => {
  if (!previewUrl) return null;

  try {
    const dl = await downloadMedia(previewUrl);
    if (!dl) return null;

    const ext = getExtension(dl.contentType, previewUrl, 'photo');
    const folder = options.folder || CONTENT_FOLDER;
    const useUniqueFileName = options.useUniqueFileName === true;
    const uniqueSuffix = useUniqueFileName ? `-${Date.now()}-${randomUUID().slice(0, 8)}` : '';
    const key = `${folder}/${contentId}/preview_${index}${uniqueSuffix}.${ext}`;

    const result = await uploadToS3(dl.buffer, key, dl.contentType, options.tenantId);
    return result;
  } catch (err) {
    console.error(`[ContentS3] ❌ Preview archive failed for ${contentId}[${index}]: ${err.message}`);
    return null;
  }
};

/**
 * Archive ALL media items for a Content document.
 *
 * For each item in the `media` array the original URL is downloaded, stored
 * in S3 under `instagram-content/<content_id>/<index>.<ext>`, and the
 * returned s3_media array mirrors the original media array with added
 * `s3_url` and `s3_key` fields.
 *
 * @param {Array} mediaArray – the Content.media array [{ type, url, preview }]
 * @param {string} contentId
 * @param {object} options   – { folder, replaceOriginalUrls, useUniqueFileName, postUrl }
 * @returns {Array} – enriched media array with s3_url / s3_key per item
 */
const archiveContentMedia = async (mediaArray, contentId, options = {}) => {
  if (!Array.isArray(mediaArray) || mediaArray.length === 0) {
    return mediaArray;
  }

  const folder = options.folder || CONTENT_FOLDER;

  // Social-media auto-archival disabled — return the media untouched so the UI
  // streams from the original platform CDN URL (via /api/media/stream). Only
  // non-social folders (user-uploaded evidence) fall through to disk archival.
  if (isSocialAutoArchive(folder)) {
    return mediaArray;
  }

  const replaceOriginalUrls = options.replaceOriginalUrls === true;
  const useUniqueFileName = options.useUniqueFileName === true;
  const mediaArchiver = options.archiveMediaItemFn || archiveMediaItem;
  const previewArchiver = options.archivePreviewFn || archivePreview;
  const enriched = [];

  for (let i = 0; i < mediaArray.length; i++) {
    const item = { ...mediaArray[i] };
    const mainUrl = item.video_url || item.url;
    const previewUrl = item.preview || item.preview_url;
    const normalizedType = String(item.type || '').toLowerCase();
    const itemType = normalizedType || (item.video_url ? 'video' : 'photo');
    let archiveResult = null;

    // Preserve original CDN URLs before overwriting (for availability checks)
    if (mainUrl && !item.original_url) {
      item.original_url = item.url;
    }
    if (item.video_url && !item.original_video_url) {
      item.original_video_url = item.video_url;
    }
    if (previewUrl && !item.original_preview_url) {
      item.original_preview_url = previewUrl;
    }
    if (item.preview && !item.original_preview) {
      item.original_preview = item.preview;
    }

    // Archive main media URL
    if (mainUrl) {
      archiveResult = await mediaArchiver(mainUrl, contentId, itemType, i, {
        folder,
        useUniqueFileName,
        postUrl: item.post_url || options.postUrl,
        previewUrl,
        tenantId: options.tenantId
      });
      if (archiveResult) {
        item.s3_url = archiveResult.url;
        item.s3_key = archiveResult.key;
        if (replaceOriginalUrls) {
          item.url = archiveResult.url;
          if (item.video_url || itemType === 'video' || itemType === 'animated_gif') {
            item.video_url = archiveResult.url;
          }
        }
      }
    }

    // Archive preview/thumbnail (only if different from main URL)
    const effectivePreviewUrl = previewUrl || (archiveResult?.previewUrl && archiveResult.previewUrl !== mainUrl ? archiveResult.previewUrl : '');

    if (effectivePreviewUrl && effectivePreviewUrl !== mainUrl) {
      const previewResult = await previewArchiver(effectivePreviewUrl, contentId, i, {
        folder,
        useUniqueFileName,
        tenantId: options.tenantId
      });
      if (previewResult) {
        item.s3_preview = previewResult.url;
        item.s3_preview_key = previewResult.key;
        if (replaceOriginalUrls) {
          if (Object.prototype.hasOwnProperty.call(item, 'preview')) {
            item.preview = previewResult.url;
          }
          if (Object.prototype.hasOwnProperty.call(item, 'preview_url')) {
            item.preview_url = previewResult.url;
          }
        }
      }
    }

    enriched.push(item);
  }

  return enriched;
};

/**
 * Delete all on-disk objects for a content's media (tenant-scoped).
 * @param {Array} mediaArray – the enriched media array with s3_key fields
 * @param {string} tenantId  – owner tenant (files live under storage/<tenant>/)
 */
const deleteContentMediaFromS3 = async (mediaArray, tenantId = null) => {
  if (!Array.isArray(mediaArray)) return;

  const keys = mediaArray
    .flatMap(item => [item.s3_key, item.s3_preview_key])
    .filter(Boolean);

  await Promise.allSettled(
    keys.map(key =>
      fs.promises.unlink(path.join(STORAGE_DIR, safeTenant(tenantId), key))
        .then(() => console.log(`[ContentS3] 🗑️ Deleted ${key}`))
        .catch(err => console.error(`[ContentS3] ❌ Delete failed for ${key}: ${err.message}`))
    )
  );
};

module.exports = {
  archiveMediaItem,
  archivePreview,
  archiveContentMedia,
  deleteContentMediaFromS3,
};
