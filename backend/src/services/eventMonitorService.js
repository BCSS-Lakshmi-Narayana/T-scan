const Event = require('../models/Event');
const Content = require('../models/Content');

const youtubeService = require('./youtube.service');
const rapidApiXService = require('./rapidApiXService');
const rapidApiFacebookService = require('./rapidApiFacebookService');
const rapidApiInstagramService = require('./rapidApiInstagramService');

const normalizeText = (text) => String(text || '').toLowerCase();
const squeezeWhitespace = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const formatQueryTerm = (term) => {
  const t = squeezeWhitespace(term);
  if (!t) return '';
  if (t.startsWith('#') || t.startsWith('@')) return t;
  return t.includes(' ') ? `"${t}"` : t;
};

const normalizeEventKeywords = (event) =>
  (event.keywords || [])
    .map((k) => (typeof k === 'string' ? k : k.keyword))
    .map((k) => squeezeWhitespace(k))
    .filter(Boolean);

const uniqueById = (items = []) => {
  const map = new Map();
  for (const item of items) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    if (!map.has(id)) map.set(id, item);
  }
  return Array.from(map.values());
};

const nowUtc = () => new Date();

const getActiveEvents = async (tenantId = null) => {
  // Only return events the user has explicitly set to 'active' (via Resume)
  const query = { status: 'active' };
  if (tenantId) query.tenant_id = tenantId; // scope to one tenant when provided
  const events = await Event.find(query).sort({ start_date: 1 });
  return events;
};

// Auto-archive disabled — all status transitions are manual
const autoArchiveEndedEvents = async () => {
  return { archived: 0 };
};

const buildEventQueries = (event) => {
  const queries = [];
  const keywords = normalizeEventKeywords(event);

  // Search each keyword individually.
  if (keywords.length > 0) {
    for (const keyword of keywords) {
      const term = formatQueryTerm(keyword);
      if (term) queries.push(term);
    }
  }

  // Fallback for events with no keyword config.
  if (queries.length === 0 && event.name) {
    const nameTerm = formatQueryTerm(event.name);
    if (nameTerm) queries.push(nameTerm);
  }

  // Secondary fallback.
  if (queries.length === 0 && event.location) {
    const locationTerm = formatQueryTerm(event.location);
    if (locationTerm) queries.push(locationTerm);
  }

  return Array.from(new Set(queries)).filter(Boolean);
};

const normalizeForKeywordMatch = (text) =>
  squeezeWhitespace(String(text || '').toLowerCase());

// Collapse whitespace and strip non-word punctuation so that "Telangana Fest",
// "telanganafest", and "#TelanganaFest" all collide on a single comparable form.
const collapseForFuzzyMatch = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[\s_\-.,!?'"():;/\\#@]+/g, '');

const keywordMatchesText = (keyword, text) => {
  const k = normalizeForKeywordMatch(keyword);
  if (!k) return false;
  if (!text) return false;

  // 1) Direct substring (works for hashtags, mentions, multi-word phrases)
  if (text.includes(k)) return true;

  // 2) Strip a leading # / @ and try again — a keyword like "#TelanganaFest"
  //    should still match plain "telangana fest" appearing in body text.
  if (k.startsWith('#') || k.startsWith('@')) {
    const bare = k.slice(1);
    if (bare && text.includes(bare)) return true;
  }

  // 3) Whitespace/punctuation-insensitive fallback — "Telangana Fest" matches
  //    "#TelanganaFest", "telanganafest", etc. (min length 3 to avoid noise).
  const kFuzzy = collapseForFuzzyMatch(k);
  if (kFuzzy && kFuzzy.length >= 3) {
    const tFuzzy = collapseForFuzzyMatch(text);
    if (tFuzzy.includes(kFuzzy)) return true;
  }

  return false;
};

const filterTweetsByEventRelevance = (tweets, event) => {
  const keywords = normalizeEventKeywords(event);
  if (keywords.length === 0) return tweets;

  return (tweets || []).filter((t) => {
    const text = normalizeForKeywordMatch(t?.text || '');
    if (!text) return false;
    return keywords.some((keyword) => keywordMatchesText(keyword, text));
  });
};

const filterPostsByEventRelevance = (posts, event, getText) => {
  const keywords = normalizeEventKeywords(event);
  if (keywords.length === 0) return posts || [];

  return (posts || []).filter((post) => {
    const text = normalizeForKeywordMatch(getText(post));
    if (!text) return false;
    return keywords.some((keyword) => keywordMatchesText(keyword, text));
  });
};

// How many keyword queries of one platform are in flight at once. Bounded rather
// than unlimited: an event can carry dozens of keywords, and firing them all at
// the gateway together earns a 429 for the whole batch instead of results.
const QUERY_CONCURRENCY = Math.max(1, Number(process.env.EVENT_QUERY_CONCURRENCY) || 4);

// Pause before hydrating one author's media, so back-to-back misses don't spray
// the gateway. Paid once per author, not once per tweet.
const MEDIA_HYDRATION_DELAY_MS = Math.max(0, Number(process.env.EVENT_MEDIA_HYDRATION_DELAY_MS) || 1500);

// How many scanned items are turned into content records at once. The work per
// item is a database upsert plus, for X, a possible media-hydration call — all
// independent, so a serial loop over a few hundred hits was the single biggest
// remaining cost in a scan.
const ITEM_CONCURRENCY = Math.max(1, Number(process.env.EVENT_ITEM_CONCURRENCY) || 6);

/** Run `worker` over `items` in bounded batches, preserving per-item isolation. */
const inBatches = async (items, worker, limit = ITEM_CONCURRENCY) => {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(worker));
  }
};

const fetchUniqueByQueries = async (queries, fetcher) => {
  const merged = [];
  // Queries are independent, so run them in bounded batches instead of one at a
  // time — a serial loop made a 14-keyword event take minutes per platform.
  for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
    const batchQueries = queries.slice(i, i + QUERY_CONCURRENCY);
    const results = await Promise.all(batchQueries.map(async (query) => {
      try {
        const batch = await fetcher(query);
        return Array.isArray(batch) ? batch : [];
      } catch (error) {
        // One bad query must not lose the others in its batch.
        console.warn(`[EventMonitor] Query failed "${query}": ${error.message}`);
        return [];
      }
    }));
    for (const batch of results) if (batch.length > 0) merged.push(...batch);
  }
  return uniqueById(merged);
};



const upsertEventContent = async ({ eventId, tenantId, platform, contentId, payload }) => {
  const existing = await Content.findOne({ tenant_id: tenantId, platform, content_id: contentId });

  if (!existing) {
    const created = await Content.create({
      ...payload,
      tenant_id: tenantId,
      platform,
      content_id: contentId,
      event_ids: [eventId]
    });
    return { content: created, isNew: true };
  }

  const updatedEventIds = Array.isArray(existing.event_ids) ? existing.event_ids : [];
  if (!updatedEventIds.includes(eventId)) updatedEventIds.push(eventId);

  existing.event_ids = updatedEventIds;

  // Best-effort engagement history
  if (payload.engagement) {
    existing.engagement = { ...existing.engagement, ...payload.engagement };
    existing.engagement_history = existing.engagement_history || [];
    existing.engagement_history.push({
      timestamp: new Date(),
      views: existing.engagement.views,
      likes: existing.engagement.likes,
      comments: existing.engagement.comments
    });
  }

  // Prefer latest text
  if (payload.text) existing.text = payload.text;
  if (payload.published_at) existing.published_at = payload.published_at;

  // Safeguard Author Updates: Don't overwrite valid author with "Unknown"
  const isUnknown = (val) => !val || String(val).trim().toLowerCase() === 'unknown' || String(val).trim().toLowerCase() === 'unknown user';

  if (payload.author && (!isUnknown(payload.author) || isUnknown(existing.author))) {
    existing.author = payload.author;
  }
  if (payload.author_handle && (!isUnknown(payload.author_handle) || isUnknown(existing.author_handle))) {
    existing.author_handle = payload.author_handle;
  }

  if (payload.content_url) existing.content_url = payload.content_url;
  if (payload.thumbnails) existing.thumbnails = payload.thumbnails;
  if (payload.duration) existing.duration = payload.duration;
  if (payload.tags) existing.tags = payload.tags;
  if (payload.media) existing.media = payload.media;
  if (payload.quoted_content) {
    // Only overwrite if new one is valid (not Unknown) or if existing is already Unknown/missing
    const isNewUnknown = !payload.quoted_content.author_name || payload.quoted_content.author_name === 'Unknown';
    const isExistingUnknown = !existing.quoted_content || !existing.quoted_content.author_name || existing.quoted_content.author_name === 'Unknown';

    if (!isNewUnknown || isExistingUnknown) {
      existing.quoted_content = payload.quoted_content;
    }
  }
  if (payload.url_cards) existing.url_cards = payload.url_cards;
  if (payload.scraped_content) existing.scraped_content = payload.scraped_content;
  if (payload.raw_data) existing.raw_data = payload.raw_data;

  await existing.save();
  return { content: existing, isNew: false };
};

const scanEventOnce = async ({ event, settings }) => {

  // Respect api_config.events.enabled (defensive — monitorService also checks)
  if (settings?.api_config?.events?.enabled === false) {
    return { scanned: 0, ingested: 0, alerts: 0 };
  }

  const queries = buildEventQueries(event);
  if (!queries.length) return { scanned: 0, ingested: 0, alerts: 0 };

  let ingested = 0;
  let alerts = 0;
  let scanned = 0;

  // Keyed by handle and holding the in-flight PROMISE, not the resolved map: many
  // tweets share an author, so caching only the result would let a dozen of them
  // race past the check and each fire its own hydration call for the same handle.
  const tweetMediaCache = new Map();
  const getHandleMediaMap = (handle) => {
    if (!handle) return Promise.resolve(null);
    const cleanHandle = String(handle).replace('@', '').trim();
    if (!cleanHandle) return Promise.resolve(null);

    if (tweetMediaCache.has(cleanHandle)) return tweetMediaCache.get(cleanHandle);

    const pending = (async () => {
      // Throttle only the call that actually reaches the provider. This used to sit
      // at the call site, so every tweet paid it — including the ones answered from
      // this cache, which is most of them.
      await new Promise((r) => setTimeout(r, MEDIA_HYDRATION_DELAY_MS));
      try {
        const result = await rapidApiXService.fetchUserTweets(cleanHandle);
        const tweets = Array.isArray(result) ? result : (result?.tweets || []);
        const map = new Map();
        for (const t of tweets) {
          if (t?.id) map.set(t.id, t);
        }
        return map;
      } catch (error) {
        console.warn(`[EventScan] Failed to hydrate media for @${cleanHandle}:`, error.message);
        return null;
      }
    })();

    tweetMediaCache.set(cleanHandle, pending);
    return pending;
  };

  const platforms = event.platforms && event.platforms.length > 0 ? event.platforms : ['youtube', 'x', 'facebook', 'instagram'];

  // The four platform blocks are independent — different gateways, different
  // results, no shared state beyond the counters below. Running them in sequence
  // meant a slow or rate-limited platform (YouTube quota, typically) held up every
  // platform after it, so they are started together and awaited as a group. Each
  // keeps its own try/catch, so one platform failing still cannot sink the others.
  const platformTasks = [];

  // X / Twitter
  if (platforms.includes('x')) platformTasks.push((async () => {
    try {
      const tweets = await fetchUniqueByQueries(queries, (q) => rapidApiXService.searchTweets(q));
      const relevantTweets = filterTweetsByEventRelevance(tweets, event);
      scanned += relevantTweets.length;

      await inBatches(relevantTweets, async (t) => {
        if ((!t.media || t.media.length === 0) && t.author_handle) {
          // The throttle now lives inside getHandleMediaMap, on the cache-miss path.
          const mediaMap = await getHandleMediaMap(t.author_handle);
          const enriched = mediaMap?.get(t.id);
          if (enriched?.media?.length) {
            t.media = enriched.media;
            if (!t.quoted_content && enriched.quoted_content) t.quoted_content = enriched.quoted_content;
            if ((!t.url_cards || t.url_cards.length === 0) && enriched.url_cards) t.url_cards = enriched.url_cards;
          }
        }

        const { content, isNew } = await upsertEventContent({
          eventId: event.id,
          tenantId: event.tenant_id,
          platform: 'x',
          contentId: t.id,
          payload: {
            source_id: null,
            content_url: t.url,
            text: t.text || '',
            author: t.author || t.author_handle || 'Unknown',
            author_handle: t.author_handle || 'unknown',
            published_at: t.created_at ? new Date(t.created_at) : new Date(),
            engagement: {
              views: Number(t.metrics?.views || 0),
              likes: Number(t.metrics?.likes || 0),
              retweets: Number(t.metrics?.retweets || 0),
              comments: Number(t.metrics?.reply || 0)
            },
            media: t.media || [],
            quoted_content: t.quoted_content,
            raw_data: t.raw_data,
            url_cards: t.url_cards || [],
            scraped_content: t.media && t.media.length > 0 ? `Media Count: ${t.media.length}` : ''
          }
        });

        if (isNew) ingested++;
      });
    } catch (error) {
      console.error(`[EventMonitor] Error monitoring X for event ${event.name}: ${error.message}`);
    }
  })());

  // YouTube
  if (platforms.includes('youtube')) platformTasks.push((async () => {
    try {
      const videos = await fetchUniqueByQueries(queries, (q) => youtubeService.searchVideos(q));
      const relevantVideos = filterPostsByEventRelevance(
        videos,
        event,
        (v) => `${v?.title || ''} ${v?.description || ''}`
      );
      scanned += relevantVideos.length;

      for (const v of relevantVideos) {
        const text = `${v.title || ''}\n${v.description || ''}`.trim();
        const { content, isNew } = await upsertEventContent({
          eventId: event.id,
          tenantId: event.tenant_id,
          platform: 'youtube',
          contentId: v.id,
          payload: {
            source_id: null,
            content_url: `https://www.youtube.com/watch?v=${v.id}`,
            text: text || v.title || 'Untitled',
            author: v.channelTitle || 'Unknown',
            author_handle: v.channelId || 'unknown',
            published_at: v.publishedAt ? new Date(v.publishedAt) : new Date(),
            duration: v.duration,
            thumbnails: v.thumbnails,
            tags: v.tags,
            category_id: v.categoryId,
            engagement: {
              views: Number(v.statistics?.viewCount || 0),
              likes: Number(v.statistics?.likeCount || 0),
              comments: Number(v.statistics?.commentCount || 0)
            },
            media: [{
              url: `https://www.youtube.com/watch?v=${v.id}`,
              type: 'video'
            }]
          }
        });

        if (isNew) ingested++;
      }
    } catch (error) {
      if (error.code === 403 || (error.message && error.message.includes('quota'))) {
        console.warn(`[EventMonitor] YouTube Quota Exceeded for event ${event.name}. Skipping YouTube scan.`);
      } else {
        console.error(`[EventMonitor] Error monitoring YouTube for event ${event.name}: ${error.message}`);
      }
    }
  })());

  // Facebook
  if (platforms.includes('facebook')) platformTasks.push((async () => {
    try {
      const posts = await fetchUniqueByQueries(queries, (q) => rapidApiFacebookService.searchPosts(q));
      const relevantPosts = filterPostsByEventRelevance(posts, event, (p) => p?.text || '');
      scanned += relevantPosts.length;

      for (const p of relevantPosts) {
        // Normalize media: searchPosts returns plain URL strings, Content model expects {type, url}
        const normalizedMedia = (Array.isArray(p.media) ? p.media : []).map(m => {
          if (typeof m === 'string') {
            const isVideo = /\.(mp4|m3u8|webm|mov)(\?|$)/i.test(m) || /video/i.test(m);
            return { type: isVideo ? 'video' : 'photo', url: m };
          }
          return m;
        }).filter(m => m && m.url);

        const { content, isNew } = await upsertEventContent({
          eventId: event.id,
          tenantId: event.tenant_id,
          platform: 'facebook',
          contentId: p.id,
          payload: {
            source_id: null,
            content_url: p.url || `https://facebook.com/${p.id}`,
            text: p.text || '',
            author: p.author || 'Unknown',
            author_handle: p.author_handle || 'unknown',
            author_avatar: p.author_avatar || '',
            published_at: p.created_at ? new Date(p.created_at) : new Date(),
            engagement: {
              views: Number(p.metrics?.views || 0),
              likes: Number(p.metrics?.likes || 0),
              comments: Number(p.metrics?.comments || 0),
              retweets: Number(p.metrics?.shares || 0)
            },
            media: normalizedMedia,
            raw_data: p
          }
        });

        if (isNew) ingested++;

      }
    } catch (error) {
      console.error(`[EventMonitor] Error monitoring Facebook for event ${event.name}: ${error.message}`);
    }
  })());

  // Instagram
  if (platforms.includes('instagram')) platformTasks.push((async () => {
    try {
      const posts = await fetchUniqueByQueries(queries, (q) => rapidApiInstagramService.searchPosts(q));
      const relevantPosts = filterPostsByEventRelevance(posts, event, (p) => p?.text || '');
      scanned += relevantPosts.length;

      for (const p of relevantPosts) {
        const { content, isNew } = await upsertEventContent({
          eventId: event.id,
          tenantId: event.tenant_id,
          platform: 'instagram',
          contentId: p.id,
          payload: {
            source_id: null,
            content_url: p.url,
            text: p.text || '',
            author: p.author || 'Unknown',
            author_handle: p.author_handle || 'unknown',
            published_at: p.created_at ? new Date(p.created_at) : new Date(),
            engagement: {
              views: Number(p.metrics?.views || 0),
              likes: Number(p.metrics?.likes || 0),
              comments: Number(p.metrics?.comments || 0)
            },
            media: p.media || []
          }
        });

        if (isNew) ingested++;

      }
    } catch (error) {
      console.error(`[EventMonitor] Error monitoring Instagram for event ${event.name}: ${error.message}`);
    }
  })());

  // Every platform must finish before the poll timestamp is written, or the next
  // tick would skip an event whose scan is still in flight.
  await Promise.all(platformTasks);

  event.last_polled_at = new Date();
  // Status is controlled manually — don't auto-set to active
  await event.save();

  return { scanned, ingested, alerts };
};

const shouldPollEvent = (event, pollingIntervalMinutes) => {
  if (!pollingIntervalMinutes) return true;
  if (!event.last_polled_at) return true;
  const last = new Date(event.last_polled_at).getTime();
  const now = Date.now();
  return now - last >= pollingIntervalMinutes * 60 * 1000;
};

module.exports = {
  getActiveEvents,
  autoArchiveEndedEvents,
  scanEventOnce,
  shouldPollEvent
};
