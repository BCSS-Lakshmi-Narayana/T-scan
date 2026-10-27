const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── On-prem, tenant-isolated local storage (replaces AWS S3) ──────────────
// Instagram stories expire in ~24h, so we DO keep archiving them — but to the
// server's disk under storage/<tenant_id>/instagram-stories/... The public URL
// is relative (no tenant id); the /files route serves each tenant its own folder.
const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');
const safeTenant = (t) => (String(t || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown');

const STORIES_FOLDER = 'instagram-stories';
const MEDIA_DOWNLOAD_URL = process.env.MEDIA_ANALYZER_URL || 'http://localhost:8005';

/**
 * Download media via Python Service (handles auth/signatures)
 */
const downloadViaPythonService = async (mediaUrl) => {
  try {
    // 1. Request download
    const dlRes = await axios.post(`${MEDIA_DOWNLOAD_URL}/download`, {
        media_url: mediaUrl
    }, {
        headers: { 'x-api-key': process.env.GATEWAY_API_KEY || '' }
    });

    if (!dlRes.data || !dlRes.data.download_url) throw new Error("No download URL returned");

    // 2. Fetch file content
    const fileUrl = `${MEDIA_DOWNLOAD_URL}${dlRes.data.download_url}`;
    const fileRes = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'arraybuffer',
        timeout: 60000
    });

    return {
        buffer: Buffer.from(fileRes.data),
        contentType: fileRes.headers['content-type']
    };
  } catch (err) {
      // Silent fail to allow fallback
      return null;
  }
}

/**
 * Write a story media buffer to on-prem local storage (tenant-scoped).
 * Name kept for backwards compatibility with callers.
 */
const uploadStoryToS3 = async (buffer, filename, _contentType = 'application/octet-stream', tenantId = null) => {
  const key = `${STORIES_FOLDER}/${filename}`;
  const absPath = path.join(STORAGE_DIR, safeTenant(tenantId), key);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);

  const url = `/files/${key.split('/').map(encodeURIComponent).join('/')}`;
  return { url, key };
};

/**
 * Download media from a URL and store it on disk (tenant-scoped).
 * Returns { url, key } on success, null on failure.
 */
const archiveStoryMedia = async (mediaUrl, storyPk, mediaType = 'image', suffix = '', tenantId = null) => {
  if (!mediaUrl) return null;

  try {
    let buffer, contentType;

    // 1. Try Python Download Service first (Required for robust Stories/Reels fetching)
    const pyDl = await downloadViaPythonService(mediaUrl);

    if (pyDl) {
        buffer = pyDl.buffer;
        contentType = pyDl.contentType;
    } else {
        // 2. Fallback to direct download (Node.js Service)
        const response = await axios({
        method: 'GET',
        url: mediaUrl,
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        });
        buffer = Buffer.from(response.data);
        contentType = response.headers['content-type'] || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
    }

    const ext = mediaType === 'video' ? 'mp4' : 'jpg';
    const filename = `${storyPk}${suffix}.${ext}`;

    const result = await uploadStoryToS3(buffer, filename, contentType, tenantId);
    console.log(`[StoryS3] ✅ Archived story ${storyPk}${suffix} → ${result.key}`);
    return result;
  } catch (error) {
    console.error(`[StoryS3] ❌ Failed to archive story ${storyPk}${suffix}:`, error.message);
    return null;
  }
};

/**
 * Delete a story's media from disk (tenant-scoped).
 */
const deleteStoryFromS3 = async (s3Key, tenantId = null) => {
  if (!s3Key) return false;

  try {
    await fs.promises.unlink(path.join(STORAGE_DIR, safeTenant(tenantId), s3Key));
    console.log(`[StoryS3] 🗑️ Deleted ${s3Key}`);
    return true;
  } catch (error) {
    console.error(`[StoryS3] ❌ Delete failed for ${s3Key}:`, error.message);
    return false;
  }
};

/**
 * Check if a story media file exists on disk (tenant-scoped).
 */
const storyExistsInS3 = async (s3Key, tenantId = null) => {
  if (!s3Key) return false;

  try {
    await fs.promises.access(path.join(STORAGE_DIR, safeTenant(tenantId), s3Key), fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
};

module.exports = {
  uploadStoryToS3,
  archiveStoryMedia,
  deleteStoryFromS3,
  storyExistsInS3,
};
