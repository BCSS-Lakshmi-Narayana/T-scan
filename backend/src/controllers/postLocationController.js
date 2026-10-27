const { fetchInstagramPostDetail } = require('../services/rapidApiInstagramService');
const { fetchTweetDetail } = require('../services/rapidApiXService');

// ── URL parsers ─────────────────────────────────────────────────────────────
const extractInstagramShortcode = (url) => {
  // Accept formats:
  //   https://www.instagram.com/p/<shortcode>/
  //   https://www.instagram.com/reel/<shortcode>/
  //   https://www.instagram.com/tv/<shortcode>/
  //   https://instagram.com/<user>/p/<shortcode>/
  const match = String(url).match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
};

const extractTweetId = (url) => {
  // Accept https://x.com/<handle>/status/<id> and twitter.com variants
  const match = String(url).match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i);
  return match ? match[1] : null;
};

const detectPlatform = (url) => {
  const u = String(url || '').toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
  if (u.includes('facebook.com') || u.includes('fb.com')) return 'facebook';
  return null;
};

// ── Endpoint ────────────────────────────────────────────────────────────────
// POST /api/post-location/lookup  { url: string }
// Response shape:
//   { platform, post_id, location: {...}|null, post: {...}, message? }
const lookupPostLocation = async (req, res) => {
  const url = String(req.body?.url || req.query?.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'Post URL is required' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error: 'Unsupported URL — provide an Instagram, X/Twitter, or Facebook post link'
    });
  }

  try {
    if (platform === 'instagram') {
      const shortcode = extractInstagramShortcode(url);
      if (!shortcode) {
        return res.status(400).json({ error: 'Could not parse Instagram shortcode from URL' });
      }
      const detail = await fetchInstagramPostDetail(shortcode);
      if (!detail) {
        return res.status(404).json({ error: 'Instagram post not found or RapidAPI failed' });
      }
      return res.json({
        platform: 'instagram',
        post_id: detail.id || shortcode,
        location: detail.location || null,
        post: {
          author: detail.author,
          author_handle: detail.author_handle,
          author_avatar: detail.author_avatar,
          text: detail.text,
          created_at: detail.created_at,
          content_url: `https://www.instagram.com/p/${shortcode}/`,
          media: Array.isArray(detail.media) ? detail.media : [],
          metrics: detail.metrics || {}
        },
        message: detail.location ? null : 'No location tag was set by the author on this post.'
      });
    }

    if (platform === 'x') {
      const tweetId = extractTweetId(url);
      if (!tweetId) {
        return res.status(400).json({ error: 'Could not parse tweet ID from URL' });
      }
      const detail = await fetchTweetDetail(tweetId);
      if (!detail) {
        return res.status(404).json({ error: 'Tweet not found or RapidAPI failed' });
      }
      const locSource = detail.location?.source || null;
      let message = null;
      if (!detail.location) {
        message = 'This tweet has no place tag and the author has no profile location set.';
      } else if (locSource === 'author_profile') {
        message = 'Twitter does not expose precise post geotags for most tweets — showing the author\'s profile location instead.';
      } else if (locSource === 'tweet_coordinates') {
        message = 'Precise GPS coordinates attached to the tweet (no place name).';
      }

      return res.json({
        platform: 'x',
        post_id: detail.id || tweetId,
        location: detail.location || null,
        post: {
          author: detail.author,
          author_handle: detail.author_handle,
          author_avatar: detail.author_avatar,
          text: detail.text,
          created_at: detail.created_at,
          content_url: detail.url || `https://x.com/i/web/status/${tweetId}`,
          media: Array.isArray(detail.media) ? detail.media : [],
          metrics: detail.metrics || {}
        },
        message
      });
    }

    // Facebook intentionally not supported in single-link lookup — the public
    // RapidAPI providers we use do not expose a reliable post-by-URL endpoint.
    return res.status(400).json({
      error: 'Facebook single-link lookup is not supported. Add the Facebook page as a source to capture posts with location.'
    });
  } catch (err) {
    console.error('[Post Location Lookup] Error:', err);
    return res.status(500).json({ error: 'Lookup failed', details: err.message });
  }
};

module.exports = { lookupPostLocation };
