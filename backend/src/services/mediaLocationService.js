/**
 * mediaLocationService
 * ────────────────────────────────────────────────────────────────────────────
 * Pipeline for extracting GPS / location data from media attached to social-
 * media posts (Instagram, X, Facebook). Same idea as the OSINT Image Intel
 * tool — only here we run it automatically against every Content document
 * after it is saved.
 *
 * Reality check: Instagram/X/Facebook strip image EXIF on upload by design, so
 * this pipeline will return "no GPS" for nearly every post. The 1% of media
 * that *does* carry GPS (reposted originals, certain video containers) is
 * still worth catching, and the negative result is itself a useful signal:
 * once `media_location.status` is 'checked_no_gps' we know we tried.
 *
 * Output is written to Content.media_location and, when a GPS hit is found,
 * also lifted into Content.location with source='media_exif' so the existing
 * location chip in the UI picks it up automatically.
 */

const axios = require('axios');
const exifr = require('exifr');

const Content = require('../models/Content');

const DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_LOC_DOWNLOAD_TIMEOUT_MS) || 15000;
const MAX_DOWNLOAD_BYTES = Number(process.env.MEDIA_LOC_MAX_BYTES) || 25 * 1024 * 1024; // 25MB safety cap
const REVERSE_GEOCODE_TIMEOUT_MS = 8000;

// ── Small in-process queue ──────────────────────────────────────────────────
// Serial worker so we don't hammer Instagram/Twitter CDNs from a single Node
// process. If you scale to multiple instances, move this to a real queue.
const queue = [];
let workerRunning = false;

const enqueueMediaLocationExtraction = (contentId) => {
  if (!contentId) return;
  if (queue.includes(contentId)) return;
  queue.push(contentId);
  if (!workerRunning) drainQueue();
};

const drainQueue = async () => {
  workerRunning = true;
  while (queue.length > 0) {
    const id = queue.shift();
    try {
      await extractMediaLocationForContent(id);
    } catch (err) {
      console.error(`[MediaLocation] worker error for ${id}: ${err.message}`);
    }
  }
  workerRunning = false;
};

// ── Core: download a single media URL into a buffer ─────────────────────────
const downloadToBuffer = async (url) => {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    },
    validateStatus: (s) => s >= 200 && s < 400
  });
  return Buffer.from(res.data);
};

// ── Core: parse GPS from a buffer (works for images and many videos) ────────
const extractGpsFromBuffer = async (buffer) => {
  if (!buffer || buffer.length === 0) return null;
  try {
    // exifr.gps() reads only the GPS block — cheap and fast.
    const gps = await exifr.gps(buffer);
    if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      return { lat: gps.latitude, lng: gps.longitude };
    }
  } catch (err) {
    // Many CDN images are progressive JPEGs without GPS — exifr throws on
    // unparsable headers. Treat as "no GPS" rather than a fatal error.
  }
  return null;
};

// ── Reverse-geocode lat/lng → human-readable name ──────────────────────────
// Uses OpenStreetMap Nominatim (free, no key). Override with a self-hosted
// instance or paid provider via env var if rate limits become a problem.
const reverseGeocode = async (lat, lng) => {
  const base = process.env.MEDIA_LOC_REVERSE_GEOCODE_URL ||
    'https://nominatim.openstreetmap.org/reverse';
  try {
    const res = await axios.get(base, {
      params: { lat, lon: lng, format: 'json', zoom: 14, 'accept-language': 'en' },
      timeout: REVERSE_GEOCODE_TIMEOUT_MS,
      headers: {
        // Nominatim usage policy: identify yourself.
        'User-Agent': process.env.MEDIA_LOC_REVERSE_GEOCODE_UA ||
          'BluraSaga/1.0 (media-location-pipeline)'
      },
      validateStatus: (s) => s >= 200 && s < 500
    });
    const data = res.data || {};
    const addr = data.address || {};
    const name =
      data.display_name ||
      [addr.suburb, addr.city || addr.town || addr.village, addr.country].filter(Boolean).join(', ') ||
      null;
    return {
      name,
      address: data.display_name || null,
      city: addr.city || addr.town || addr.village || null,
      country: addr.country || null
    };
  } catch (err) {
    return { name: null, address: null, city: null, country: null };
  }
};

// ── Pick a list of media URLs to try (prefer S3 archives) ──────────────────
const pickMediaUrls = (media = []) => {
  const urls = [];
  for (const m of Array.isArray(media) ? media : []) {
    // Prefer archived S3 copies (won't have EXIF, but won't 403 either).
    const url = m?.s3_url || m?.original_url || m?.url || m?.video_url || m?.original_video_url;
    if (url && typeof url === 'string') urls.push(url);
  }
  return urls;
};

// ── Main entry point: extract location for one Content document ─────────────
const extractMediaLocationForContent = async (contentId) => {
  const content = await Content.findOne({ id: contentId }).lean();
  if (!content) return null;

  // Skip if already a precise location source was set (tweet_place,
  // instagram_post, facebook_place, tweet_coordinates). We don't want to
  // overwrite a real geotag with a noisy media_exif result.
  if (content.location?.name &&
      ['tweet_place', 'tweet_coordinates', 'instagram_post', 'facebook_place'].includes(content.location.source)) {
    await Content.updateOne(
      { id: contentId },
      { $set: { 'media_location.status': 'extracted', 'media_location.checked_at': new Date() } }
    );
    return content.location;
  }

  const urls = pickMediaUrls(content.media);
  if (urls.length === 0) {
    await Content.updateOne(
      { id: contentId },
      { $set: { 'media_location.status': 'no_media', 'media_location.checked_at': new Date() } }
    );
    return null;
  }

  let gpsHit = null;
  let sourceUrl = null;
  let lastError = null;

  for (const url of urls) {
    try {
      const buf = await downloadToBuffer(url);
      const gps = await extractGpsFromBuffer(buf);
      if (gps) {
        gpsHit = gps;
        sourceUrl = url;
        break;
      }
    } catch (err) {
      lastError = err.message;
      // Try next media item.
    }
  }

  const now = new Date();

  if (!gpsHit) {
    await Content.updateOne(
      { id: contentId },
      {
        $set: {
          'media_location.status': lastError && urls.every(() => false) ? 'failed' : 'checked_no_gps',
          'media_location.checked_at': now,
          'media_location.error': lastError || null
        }
      }
    );
    return null;
  }

  // Reverse-geocode for a human-readable name.
  const place = await reverseGeocode(gpsHit.lat, gpsHit.lng);

  const update = {
    'media_location.status': 'extracted',
    'media_location.lat': gpsHit.lat,
    'media_location.lng': gpsHit.lng,
    'media_location.name': place.name,
    'media_location.source_media_url': sourceUrl,
    'media_location.checked_at': now,
    'media_location.error': null
  };

  // Only lift into the primary `location` field if no better source already
  // populated it (e.g. author_profile is OK to override — extracted EXIF is
  // strictly more precise).
  const shouldLift = !content.location?.name || content.location?.source === 'author_profile';
  if (shouldLift) {
    update.location = {
      name: place.name || `${gpsHit.lat.toFixed(5)}, ${gpsHit.lng.toFixed(5)}`,
      address: place.address,
      city: place.city,
      country: place.country,
      lat: gpsHit.lat,
      lng: gpsHit.lng,
      place_id: null,
      source: 'media_exif'
    };
  }

  await Content.updateOne({ id: contentId }, { $set: update });

  console.log(`[MediaLocation] ✅ ${contentId} → ${place.name || `${gpsHit.lat},${gpsHit.lng}`}`);
  return update.location || null;
};

module.exports = {
  enqueueMediaLocationExtraction,
  extractMediaLocationForContent
};
