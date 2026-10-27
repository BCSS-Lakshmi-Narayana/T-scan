const { v4: uuidv4 } = require('uuid');
const Content = require('../models/Content');
const Source = require('../models/Source');
const RetweetRelationship = require('../models/RetweetRelationship');
const rapidApiXService = require('./rapidApiXService');

const normalizeHandle = (value) => String(value || '').replace(/^@/, '').trim().toLowerCase();

const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parsePositiveInt = (value, fallback, min, max) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const shouldSyncTweetRetweets = (content, staleHours = 6) => {
  if (!content) return false;
  const retweetCount = Number(content?.engagement?.retweets || 0);
  if (retweetCount <= 0) return false;

  const lastSyncAt = toDate(content?.retweet_network?.last_synced_at);
  const previousCount = Number(content?.retweet_network?.last_observed_retweet_count || 0);

  if (!lastSyncAt) return true;
  if (retweetCount > previousCount) return true;

  const staleMs = staleHours * 60 * 60 * 1000;
  return Date.now() - lastSyncAt.getTime() > staleMs;
};

const syncRetweetRelationshipsForSource = async (
  source,
  contents = [],
  options = {}
) => {
  if (!source || source.platform !== 'x') return { syncedTweets: 0, syncedRetweeters: 0 };

  const maxTweets = parsePositiveInt(options.maxTweets, 15, 1, 100);
  const staleHours = parsePositiveInt(options.staleHours, 1, 1, 24);
  const force = options.force === true;

  const candidates = (Array.isArray(contents) ? contents : [])
    .filter((doc) => doc?.platform === 'x' && doc?.content_id)
    .filter((doc) => force || shouldSyncTweetRetweets(doc, staleHours))
    .sort((a, b) => {
      const aScore = Number(a?.engagement?.retweets || 0);
      const bScore = Number(b?.engagement?.retweets || 0);
      if (bScore !== aScore) return bScore - aScore;
      const aTime = toDate(a?.published_at)?.getTime() || 0;
      const bTime = toDate(b?.published_at)?.getTime() || 0;
      return bTime - aTime;
    })
    .slice(0, maxTweets);

  if (candidates.length === 0) return { syncedTweets: 0, syncedRetweeters: 0 };

  let syncedRetweeters = 0;

  for (const content of candidates) {
    try {
      const retweeters = await rapidApiXService.fetchTweetRetweeters(content.content_id, {
        count: 200
      });

      const now = new Date();
      const bulkOps = [];
      for (const retweeter of retweeters) {
        const retweeterHandle = normalizeHandle(retweeter?.handle);
        if (!retweeterHandle) continue;

        const update = {
          $setOnInsert: {
            id: uuidv4(),
            tenant_id: source.tenant_id,
            source_id: source.id,
            source_identifier: source.identifier,
            source_display_name: source.display_name,
            source_category: source.category || 'unknown',
            original_tweet_id: content.content_id,
            original_author_handle: normalizeHandle(content.author_handle || source.identifier),
            original_author_name: content.author || source.display_name || null,
            retweeter_handle: retweeterHandle,
            first_seen_at: now
          },
          $set: {
            content_ref_id: content.id || null,
            retweeter_id: retweeter?.id || null,
            retweeter_name: retweeter?.name || retweeterHandle,
            retweeter_avatar: retweeter?.avatar || null,
            retweeter_verified: !!retweeter?.verified,
            last_seen_at: now,
            last_retweeted_at: toDate(retweeter?.retweeted_at) || now
          },
          $inc: {
            observation_count: 1
          }
        };

        bulkOps.push({
          updateOne: {
            filter: {
              source_id: source.id,
              original_tweet_id: content.content_id,
              retweeter_handle: retweeterHandle
            },
            update,
            upsert: true
          }
        });
      }

      if (bulkOps.length > 0) {
        await RetweetRelationship.bulkWrite(bulkOps, { ordered: false });
      }

      const contentFilter = content?.id
        ? { id: content.id }
        : {
          tenant_id: source.tenant_id,
          platform: 'x',
          source_id: source.id,
          content_id: content.content_id
        };
      await Content.updateOne(contentFilter, {
        $set: {
          retweet_network: {
            last_synced_at: now,
            last_observed_retweet_count: Number(content?.engagement?.retweets || 0),
            unique_retweeter_count: retweeters.length
          }
        }
      });

      syncedRetweeters += retweeters.length;
    } catch (error) {
      console.warn(`[Retweet Network] Sync failed for source ${source.identifier}, tweet ${content.content_id}: ${error.message}`);
    }
  }

  return {
    syncedTweets: candidates.length,
    syncedRetweeters
  };
};

const refreshRetweetRelationshipsForSource = async (source, options = {}) => {
  if (!source || source.platform !== 'x') return { syncedTweets: 0, syncedRetweeters: 0 };

  const result = await rapidApiXService.fetchUserTweets(source.identifier, 40);
  const apiTweets = Array.isArray(result) ? result : (result?.tweets || []);
  const tweetIds = apiTweets
    .map((tweet) => String(tweet?.id || '').trim())
    .filter(Boolean);

  if (tweetIds.length === 0) return { syncedTweets: 0, syncedRetweeters: 0 };

  const contentDocs = await Content.find({
    platform: 'x',
    source_id: source.id,
    content_id: { $in: tweetIds }
  }).sort({ published_at: -1 }).lean();
  const contentByTweetId = new Map(contentDocs.map((doc) => [String(doc.content_id), doc]));

  // Build fallback candidates from live API tweets so hierarchy works even
  // when Content documents for those tweets are missing.
  const candidates = apiTweets.map((tweet) => {
    const tweetId = String(tweet?.id || '').trim();
    if (!tweetId) return null;

    const existing = contentByTweetId.get(tweetId);
    if (existing) return existing;

    return {
      id: null,
      platform: 'x',
      content_id: tweetId,
      author: tweet?.author || source.display_name || source.identifier,
      author_handle: tweet?.author_handle || source.identifier,
      published_at: tweet?.created_at || new Date(),
      engagement: {
        retweets: Number(tweet?.metrics?.retweets || tweet?.metrics?.retweet || 0)
      }
    };
  }).filter(Boolean);

  return syncRetweetRelationshipsForSource(source, candidates, { ...options, force: true });
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getRetweetNetworkSummary = async ({
  source,
  days = 7,
  from = null,
  to = null,
  limit = 25,
  contentId = null,
  ensureTweetId = null
}) => {
  const safeLimit = parsePositiveInt(limit, 25, 5, 5000);
  const maxTweetsInResponse = 50;
  const maxRetweeterPreview = 15;

  // Resolve date window: explicit from/to takes precedence over days preset
  let since, until;
  const parsedFrom = toDate(from);
  const parsedTo = toDate(to);
  if (parsedFrom && parsedTo) {
    since = parsedFrom;
    until = parsedTo;
  } else if (parsedFrom) {
    since = parsedFrom;
    until = new Date();
  } else {
    const safeDays = parsePositiveInt(days, 7, 1, 365);
    since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    until = new Date();
  }

  const match = {
    source_id: source.id,
    platform: 'x',
    last_seen_at: { $gte: since, $lte: until }
  };
  if (contentId) {
    match.original_tweet_id = String(contentId);
  }

  // --- Run stats, top retweeters, and by-tweet breakdown in parallel ---
  const [rawStatsArr, topRetweeters, byTweetRaw] = await Promise.all([
    // Stats for the selected window
    RetweetRelationship.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalRelationships: { $sum: 1 },
          uniqueRetweetersSet: { $addToSet: '$retweeter_handle' },
          uniqueTweetsSet: { $addToSet: '$original_tweet_id' }
        }
      },
      {
        $project: {
          _id: 0,
          totalRelationships: 1,
          uniqueRetweeters: { $size: '$uniqueRetweetersSet' },
          uniqueTweets: { $size: '$uniqueTweetsSet' }
        }
      }
    ]),
    // Top retweeters in the selected window
    RetweetRelationship.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$retweeter_handle',
          retweeter_name: { $last: '$retweeter_name' },
          retweeter_avatar: { $last: '$retweeter_avatar' },
          retweeter_verified: { $max: '$retweeter_verified' },
          tweets: { $addToSet: '$original_tweet_id' },
          first_seen_at: { $min: '$first_seen_at' },
          last_seen_at: { $max: '$last_seen_at' },
          observations: { $sum: '$observation_count' }
        }
      },
      {
        $project: {
          _id: 0,
          handle: '$_id',
          name: '$retweeter_name',
          avatar: '$retweeter_avatar',
          verified: '$retweeter_verified',
          tweet_count: { $size: '$tweets' },
          observations: 1,
          first_seen_at: 1,
          last_seen_at: 1,
          tweet_ids: '$tweets'
        }
      },
      { $sort: { tweet_count: -1, observations: -1, last_seen_at: -1 } },
      { $limit: safeLimit }
    ]).option({ maxTimeMS: 10000 }),
    // By-tweet breakdown
    RetweetRelationship.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$original_tweet_id',
          uniqueRetweeters: { $addToSet: '$retweeter_handle' },
          last_seen_at: { $max: '$last_seen_at' },
          observations: { $sum: '$observation_count' }
        }
      },
      {
        $project: {
          _id: 0,
          tweet_id: '$_id',
          retweeter_count: { $size: '$uniqueRetweeters' },
          retweeter_handles: '$uniqueRetweeters',
          last_seen_at: 1,
          observations: 1
        }
      },
      { $sort: { retweeter_count: -1, observations: -1, last_seen_at: -1 } },
      { $limit: maxTweetsInResponse }
    ]).option({ maxTimeMS: 10000 })
  ]);
  const rawStats = rawStatsArr[0];

  // Collect all handles from the window to do a targeted lifetime lookup
  const windowHandles = topRetweeters.map((r) => r.handle);

  // --- Lifetime stats: only for handles seen in this window (avoids full-collection scan) ---
  const lifetimeRetweeterStats = windowHandles.length > 0
    ? await RetweetRelationship.aggregate([
      { $match: { source_id: source.id, platform: 'x', retweeter_handle: { $in: windowHandles } } },
      {
        $group: {
          _id: '$retweeter_handle',
          tweets: { $addToSet: '$original_tweet_id' },
          name: { $last: '$retweeter_name' },
          avatar: { $last: '$retweeter_avatar' },
          verified: { $max: '$retweeter_verified' },
          first_seen_at: { $min: '$first_seen_at' },
          last_seen_at: { $max: '$last_seen_at' },
          total_observations: { $sum: '$observation_count' }
        }
      },
      {
        $project: {
          _id: 0,
          handle: '$_id',
          name: 1,
          avatar: 1,
          verified: 1,
          tweet_count: { $size: '$tweets' },
          first_seen_at: 1,
          last_seen_at: 1,
          total_observations: 1
        }
      }
    ]).option({ maxTimeMS: 10000 })
    : [];

  const lifetimeTweetCountByHandle = new Map(
    lifetimeRetweeterStats.map((r) => [r.handle, r.tweet_count || 0])
  );
  const lifetimeDataByHandle = new Map(
    lifetimeRetweeterStats.map((r) => [r.handle, r])
  );

  // Enrich top retweeters with lifetime data and frequency classification
  for (const rt of topRetweeters) {
    const lifetime = lifetimeDataByHandle.get(rt.handle);
    rt.lifetime_tweet_count = lifetime?.tweet_count || rt.tweet_count;
    rt.lifetime_first_seen = lifetime?.first_seen_at || rt.first_seen_at;
    // Classify: regular (>=5 tweets lifetime), frequent (>=3), occasional (>=2), one-time
    if (rt.lifetime_tweet_count >= 5) rt.frequency = 'regular';
    else if (rt.lifetime_tweet_count >= 3) rt.frequency = 'frequent';
    else if (rt.lifetime_tweet_count >= 2) rt.frequency = 'repeat';
    else rt.frequency = 'one-time';
  }

  // --- Common retweeters (retweeted >=2 different tweets in this window) ---
  const commonRetweeters = topRetweeters
    .filter((r) => (r.tweet_count || 0) >= 2)
    .sort((a, b) => (b.tweet_count || 0) - (a.tweet_count || 0))
    .slice(0, safeLimit)
    .map((r) => ({
      handle: r.handle,
      name: r.name,
      avatar: r.avatar,
      verified: r.verified,
      tweet_count: r.tweet_count,
      lifetime_tweet_count: r.lifetime_tweet_count,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      frequency: r.frequency
    }));

  // If ensureTweetId is provided and not already in byTweetRaw, do a targeted lookup
  const ensureId = ensureTweetId ? String(ensureTweetId) : null;
  if (ensureId && !byTweetRaw.some((r) => String(r.tweet_id) === ensureId)) {
    const [ensuredRow] = await RetweetRelationship.aggregate([
      { $match: { source_id: source.id, platform: 'x', original_tweet_id: ensureId } },
      {
        $group: {
          _id: '$original_tweet_id',
          uniqueRetweeters: { $addToSet: '$retweeter_handle' },
          last_seen_at: { $max: '$last_seen_at' },
          observations: { $sum: '$observation_count' }
        }
      },
      {
        $project: {
          _id: 0,
          tweet_id: '$_id',
          retweeter_count: { $size: '$uniqueRetweeters' },
          retweeter_handles: '$uniqueRetweeters',
          last_seen_at: 1,
          observations: 1
        }
      }
    ]).option({ maxTimeMS: 5000 });
    if (ensuredRow) {
      byTweetRaw.push(ensuredRow);
    }
  }

  const tweetIds = byTweetRaw.map((r) => r.tweet_id);
  const contentDocs = tweetIds.length
    ? await Content.find({ platform: 'x', source_id: source.id, content_id: { $in: tweetIds } })
      .select('content_id text published_at content_url')
      .lean()
    : [];
  const contentById = new Map(contentDocs.map((d) => [d.content_id, d]));

  const byTweet = byTweetRaw.map((row) => {
    const content = contentById.get(row.tweet_id);
    return {
      tweet_id: row.tweet_id,
      text: content?.text || '',
      published_at: content?.published_at || null,
      content_url: content?.content_url || `https://x.com/${source.identifier.replace(/^@/, '')}/status/${row.tweet_id}`,
      retweeter_count: row.retweeter_count,
      observations: row.observations,
      last_seen_at: row.last_seen_at,
      common_retweeter_count: 0,
      retweeters: [],
      retweeter_handles: row.retweeter_handles || []
    };
  });

  // Fetch retweeter previews per tweet
  if (byTweet.length > 0) {
    const previewDocs = await RetweetRelationship.find({
      source_id: source.id,
      platform: 'x',
      original_tweet_id: { $in: byTweet.map((i) => i.tweet_id) },
      last_seen_at: { $gte: since, $lte: until }
    })
      .sort({ last_seen_at: -1 })
      .select('original_tweet_id retweeter_handle retweeter_name retweeter_avatar retweeter_verified last_seen_at')
      .lean();

    const byTweetPreviewMap = new Map();
    for (const doc of previewDocs) {
      const key = doc.original_tweet_id;
      const list = byTweetPreviewMap.get(key) || [];
      // For the ensured tweet (opened in dialog), send all retweeters; for others, cap at preview limit
      if (key !== ensureId && list.length >= maxRetweeterPreview) continue;
      const ltCount = lifetimeTweetCountByHandle.get(doc.retweeter_handle) || 1;
      list.push({
        handle: doc.retweeter_handle,
        name: doc.retweeter_name,
        avatar: doc.retweeter_avatar,
        verified: doc.retweeter_verified,
        last_seen_at: doc.last_seen_at,
        lifetime_tweet_count: ltCount,
        is_common: ltCount >= 2,
        frequency: ltCount >= 5 ? 'regular' : ltCount >= 3 ? 'frequent' : ltCount >= 2 ? 'repeat' : 'one-time'
      });
      byTweetPreviewMap.set(key, list);
    }

    for (const row of byTweet) {
      const retweeters = byTweetPreviewMap.get(row.tweet_id) || [];
      row.retweeters = retweeters;
      row.common_retweeter_count = retweeters.filter((u) => u.is_common).length;
    }
  }

  // --- Overlap matrix: which retweeters appear across multiple tweets ---
  // Build a handle → set-of-tweet-ids map from the by_tweet data
  const handleToTweets = new Map();
  for (const row of byTweet) {
    for (const h of (row.retweeter_handles || [])) {
      const set = handleToTweets.get(h) || new Set();
      set.add(row.tweet_id);
      handleToTweets.set(h, set);
    }
  }
  // Find handles that appear in >=2 tweets in this window
  const overlapRetweeters = [];
  for (const [handle, tweetSet] of handleToTweets) {
    if (tweetSet.size >= 2) {
      const lt = lifetimeDataByHandle.get(handle);
      overlapRetweeters.push({
        handle,
        name: lt?.name || handle,
        avatar: lt?.avatar || null,
        verified: lt?.verified || false,
        tweets_in_window: tweetSet.size,
        lifetime_tweet_count: lt?.tweet_count || tweetSet.size,
        tweet_ids: Array.from(tweetSet)
      });
    }
  }
  overlapRetweeters.sort((a, b) => b.tweets_in_window - a.tweets_in_window || b.lifetime_tweet_count - a.lifetime_tweet_count);

  // Strip retweeter_handles from response to reduce payload
  for (const row of byTweet) {
    delete row.retweeter_handles;
  }

  const powerRetweeters = topRetweeters.filter((i) => i.tweet_count >= 3).length;

  // --- Frequency distribution ---
  const frequencyDist = { regular: 0, frequent: 0, repeat: 0, 'one-time': 0 };
  for (const rt of topRetweeters) {
    frequencyDist[rt.frequency] = (frequencyDist[rt.frequency] || 0) + 1;
  }

  return {
    window: {
      since,
      until,
      label: from && to ? 'custom' : `${parsePositiveInt(days, 7, 1, 365)}d`
    },
    source: {
      id: source.id,
      identifier: source.identifier,
      display_name: source.display_name,
      profile_image_url: source.profile_image_url || null
    },
    stats: {
      total_relationships: rawStats?.totalRelationships || 0,
      unique_retweeters: rawStats?.uniqueRetweeters || 0,
      unique_tweets: rawStats?.uniqueTweets || 0,
      power_retweeters: powerRetweeters,
      common_retweeters: commonRetweeters.length,
      frequency_distribution: frequencyDist
    },
    top_retweeters: topRetweeters,
    common_retweeters: commonRetweeters,
    overlap_retweeters: overlapRetweeters.slice(0, safeLimit),
    by_tweet: byTweet,
    graph: {
      nodes: [
        {
          id: `source:${source.id}`,
          type: 'source',
          label: source.display_name || source.identifier,
          handle: source.identifier,
          avatar: source.profile_image_url || null
        },
        ...topRetweeters.map((item) => ({
          id: `retweeter:${item.handle}`,
          type: 'retweeter',
          label: item.name || item.handle,
          handle: item.handle,
          avatar: item.avatar || null,
          tweet_count: item.tweet_count,
          frequency: item.frequency
        }))
      ],
      edges: topRetweeters.map((item) => ({
        source: `source:${source.id}`,
        target: `retweeter:${item.handle}`,
        weight: item.tweet_count
      }))
    }
  };
};

const resolveSourceForRetweetNetwork = async ({ sourceId, handle, tenantId }) => {
  const tenantScope = tenantId ? { tenant_id: tenantId } : {};
  if (sourceId) {
    return Source.findOne({ ...tenantScope, id: sourceId, platform: 'x' })
      .select('id identifier display_name profile_image_url category platform tenant_id')
      .lean();
  }

  const normalized = normalizeHandle(handle);
  if (!normalized) return null;
  const escaped = escapeRegex(normalized);
  return Source.findOne({
    ...tenantScope,
    platform: 'x',
    identifier: { $regex: new RegExp(`^@?${escaped}$`, 'i') }
  })
    .select('id identifier display_name profile_image_url category platform tenant_id')
    .lean();
};

// ─── Scheduled Retweet Sync (1-hour interval) ─────────────────────────────────
// Loops through all active X sources, fetches their latest 15 tweets via API,
// and syncs ALL retweeters (up to 200 per API call) with deduplication.

const RETWEET_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let retweetSyncRunning = false;

const runRetweetSyncCycle = async () => {
  if (retweetSyncRunning) {
    console.log('[Retweet Scheduler] Previous sync still running, skipping...');
    return;
  }

  retweetSyncRunning = true;
  const startTime = Date.now();

  try {
    const xSources = await Source.find({ platform: 'x', is_active: true }).lean();
    if (xSources.length === 0) {
      console.log('[Retweet Scheduler] No active X sources, skipping cycle.');
      return;
    }

    console.log(`[Retweet Scheduler] Starting sync for ${xSources.length} X sources...`);

    let totalSyncedTweets = 0;
    let totalSyncedRetweeters = 0;

    for (const source of xSources) {
      try {
        // Fetch latest tweets directly from the Twitter API for this source
        const result = await rapidApiXService.fetchUserTweets(source.identifier, 15);
        const apiTweets = Array.isArray(result) ? result : (result?.tweets || []);

        if (apiTweets.length === 0) continue;

        // Match API tweets to existing Content docs in DB, or build fallback objects
        const tweetIds = apiTweets.map((t) => String(t?.id || '').trim()).filter(Boolean);
        const contentDocs = await Content.find({
          platform: 'x',
          source_id: source.id,
          content_id: { $in: tweetIds }
        }).lean();
        const contentByTweetId = new Map(contentDocs.map((doc) => [String(doc.content_id), doc]));

        const candidates = apiTweets.map((tweet) => {
          const tweetId = String(tweet?.id || '').trim();
          if (!tweetId) return null;

          const existing = contentByTweetId.get(tweetId);
          if (existing) return existing;

          // Fallback for tweets not yet in DB
          return {
            id: null,
            platform: 'x',
            content_id: tweetId,
            author: tweet?.author || source.display_name || source.identifier,
            author_handle: tweet?.author_handle || source.identifier,
            published_at: tweet?.created_at || new Date(),
            engagement: {
              retweets: Number(tweet?.metrics?.retweets || tweet?.metrics?.retweet || 0)
            }
          };
        }).filter(Boolean);

        // Sync retweeters — upsert ensures uniqueness, no duplicates
        const syncResult = await syncRetweetRelationshipsForSource(source, candidates, {
          maxTweets: 15,
          staleHours: 1,
          force: true
        });

        totalSyncedTweets += syncResult.syncedTweets;
        totalSyncedRetweeters += syncResult.syncedRetweeters;
      } catch (sourceErr) {
        console.warn(`[Retweet Scheduler] Error syncing source ${source.identifier}: ${sourceErr.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Retweet Scheduler] Cycle complete in ${elapsed}s — ${totalSyncedTweets} tweets, ${totalSyncedRetweeters} retweeters synced.`);
  } catch (err) {
    console.error('[Retweet Scheduler] Cycle error:', err.message);
  } finally {
    retweetSyncRunning = false;
  }
};

const startRetweetSyncScheduler = () => {
  console.log('[Retweet Scheduler] Starting retweet sync scheduler (every 1 hour)...');

  // Run first cycle after a 2-minute delay to let monitoring settle
  setTimeout(() => {
    runRetweetSyncCycle();
    setInterval(runRetweetSyncCycle, RETWEET_SYNC_INTERVAL_MS);
  }, 2 * 60 * 1000);
};

/**
 * Get all engagers for a specific tweet: retweeters (from DB with cross-tweet frequency),
 * repliers, and quote-tweeters (from live API search).
 */
const getTweetEngagers = async ({ source, tweetId }) => {
  const safeTweetId = String(tweetId || '').trim();
  if (!safeTweetId) throw new Error('tweetId is required');

  // 1. Retweeters from DB
  const retweetDocs = await RetweetRelationship.find({
    source_id: source.id,
    original_tweet_id: safeTweetId,
    platform: 'x'
  }).lean();

  const handles = retweetDocs.map(r => r.retweeter_handle);

  // 2. Cross-tweet frequency: how many DIFFERENT tweets each retweeter has retweeted from this source
  const crossTweetAgg = handles.length > 0
    ? await RetweetRelationship.aggregate([
      { $match: { source_id: source.id, platform: 'x', retweeter_handle: { $in: handles } } },
      { $group: { _id: '$retweeter_handle', tweets: { $addToSet: '$original_tweet_id' } } },
      { $project: { _id: 0, handle: '$_id', total_tweet_count: { $size: '$tweets' } } }
    ]).option({ maxTimeMS: 10000 })
    : [];

  const crossTweetMap = new Map(crossTweetAgg.map(r => [r.handle, r.total_tweet_count]));

  const retweeters = retweetDocs.map(r => {
    const crossCount = crossTweetMap.get(r.retweeter_handle) || 1;
    return {
      handle: r.retweeter_handle,
      name: r.retweeter_name,
      avatar: r.retweeter_avatar,
      verified: r.retweeter_verified || false,
      cross_tweet_count: crossCount,
      observation_count: r.observation_count || 1,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      frequency: crossCount >= 5 ? 'regular' : crossCount >= 3 ? 'frequent' : crossCount >= 2 ? 'repeat' : 'one-time'
    };
  });

  // Sort: cross-tweet frequency desc, then observation count desc
  retweeters.sort((a, b) => b.cross_tweet_count - a.cross_tweet_count || b.observation_count - a.observation_count);

  // Deduplicate by handle (keep highest frequency entry)
  const seenHandles = new Set();
  const uniqueRetweeters = [];
  for (const rt of retweeters) {
    const key = (rt.handle || '').toLowerCase();
    if (seenHandles.has(key)) continue;
    seenHandles.add(key);
    uniqueRetweeters.push(rt);
  }

  // 3. Repliers and quote-tweeters from live API (best-effort)
  const sourceHandle = normalizeHandle(source.identifier);
  let repliers = [];
  let quoteTweeters = [];

  try {
    [repliers, quoteTweeters] = await Promise.all([
      rapidApiXService.fetchTweetRepliers(safeTweetId, sourceHandle).catch(() => []),
      rapidApiXService.fetchTweetQuoteTweeters(safeTweetId, sourceHandle).catch(() => [])
    ]);
  } catch (err) {
    console.error('[RetweetNetwork] Failed to fetch repliers/quoters:', err.message);
  }

  return {
    retweeters: uniqueRetweeters,
    repliers,
    quote_tweeters: quoteTweeters
  };
};

module.exports = {
  resolveSourceForRetweetNetwork,
  syncRetweetRelationshipsForSource,
  refreshRetweetRelationshipsForSource,
  getRetweetNetworkSummary,
  getTweetEngagers,
  startRetweetSyncScheduler
};
