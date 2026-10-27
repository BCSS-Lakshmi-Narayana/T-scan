const { v4: uuidv4 } = require('uuid');
const EngagerAnalysis = require('../models/EngagerAnalysis');
const rapidApiXService = require('./rapidApiXService');

const normalizeHandle = (value) => String(value || '').replace(/^@/, '').trim().toLowerCase();

/**
 * Prepare an analysis record synchronously (check conflicts, create/update DB record).
 * Returns { status, handle, analysisId, analysis, blocked_by? }
 *   status: 'already_processing' | 'blocked' | 'started'
 */
const prepareAnalysisRecord = async (handle, { periodDays = 30, sourceId = null, tenantId = null } = {}) => {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle) throw new Error('handle is required');
  if (!tenantId) throw new Error('tenantId is required');

  // Reset this tenant's stuck "processing" records older than 10 minutes
  await EngagerAnalysis.updateMany(
    { tenant_id: tenantId, status: 'processing', analyzed_at: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
    { $set: { status: 'failed', error: 'Analysis timed out' } }
  );

  // Check if THIS handle already has a processing record (this tenant)
  const sameHandleProcessing = await EngagerAnalysis.findOne({ tenant_id: tenantId, handle_lower: cleanHandle, status: 'processing' });
  if (sameHandleProcessing) {
    console.log(`[EngagerAnalysis] Already processing @${cleanHandle}, skipping`);
    return { status: 'already_processing', handle: cleanHandle };
  }

  // Check if ANY other analysis is currently processing for THIS tenant
  const anyProcessing = await EngagerAnalysis.findOne({ tenant_id: tenantId, status: 'processing' });
  if (anyProcessing) {
    console.log(`[EngagerAnalysis] Blocked — @${anyProcessing.handle} is already processing`);
    return { status: 'blocked', handle: cleanHandle, blocked_by: anyProcessing.handle };
  }

  // Find the best existing record to reuse (prefer completed, then any)
  // Also clean up duplicates — keep only one record per handle (this tenant)
  const allRecords = await EngagerAnalysis.find({ tenant_id: tenantId, handle_lower: cleanHandle }).sort({ analyzed_at: -1 });
  let analysis;
  if (allRecords.length > 0) {
    const completed = allRecords.find(r => r.status === 'completed');
    analysis = completed || allRecords[0];
    const toDelete = allRecords.filter(r => r._id.toString() !== analysis._id.toString());
    if (toDelete.length > 0) {
      await EngagerAnalysis.deleteMany({ _id: { $in: toDelete.map(r => r._id) } });
      console.log(`[EngagerAnalysis] Cleaned up ${toDelete.length} duplicate records for @${cleanHandle}`);
    }
    analysis.status = 'processing';
    analysis.analyzed_at = new Date();
    analysis.period_days = periodDays;
    if (sourceId) analysis.source_id = sourceId;
    analysis.error = null;
    await analysis.save();
  } else {
    analysis = await EngagerAnalysis.create({
      id: uuidv4(),
      tenant_id: tenantId,
      handle: cleanHandle,
      handle_lower: cleanHandle,
      source_id: sourceId,
      period_days: periodDays,
      status: 'processing',
      analyzed_at: new Date()
    });
  }

  return { status: 'started', handle: cleanHandle, analysisId: analysis._id, analysis };
};

/**
 * Run a full on-demand engager analysis for a Twitter handle.
 * 1. Prepare DB record (check conflicts, create/update)
 * 2. Fetch the user's recent tweets (up to ~40)
 * 3. For each tweet with retweets, fetch retweeters from Twitter API
 * 4. Build frequency hierarchy across all tweets
 * 5. Store the analysis persistently
 */
const runEngagerAnalysis = async (handle, { periodDays = 30, sourceId = null, tenantId = null } = {}) => {
  const prepResult = await prepareAnalysisRecord(handle, { periodDays, sourceId, tenantId });
  if (prepResult.status !== 'started') return prepResult;
  return executeAnalysisWork(prepResult.analysisId, normalizeHandle(handle), periodDays, prepResult.analysis);
};

/**
 * Execute the heavy analysis work (tweet fetching, retweeter analysis).
 * Called with an already-created processing record.
 */
const executeAnalysisWork = async (analysisId, cleanHandle, periodDays, analysis) => {

  try {
    // 1. Fetch ALL user tweets within the period
    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
    console.log(`[EngagerAnalysis] Fetching all tweets for @${cleanHandle} since ${cutoff.toISOString()}...`);
    
    let result;
    try {
      result = await rapidApiXService.fetchAllUserTweetsSince(cleanHandle, cutoff, 200);
    } catch (fetchErr) {
      console.error(`[EngagerAnalysis] Tweet fetch threw for @${cleanHandle}:`, fetchErr.message);
      await EngagerAnalysis.updateOne({ _id: analysisId }, { $set: { status: 'failed', error: `Tweet fetch failed: ${fetchErr.message}` } });
      return (await EngagerAnalysis.findById(analysisId).lean());
    }

    const apiTweets = Array.isArray(result) ? result : (result?.tweets || []);

    if (!apiTweets || apiTweets.length === 0) {
      await EngagerAnalysis.updateOne({ _id: analysisId }, { $set: { status: 'failed', error: 'Could not fetch tweets from Twitter. The account may be private or suspended.' } });
      console.warn(`[EngagerAnalysis] No tweets found for @${cleanHandle}`);
      return (await EngagerAnalysis.findById(analysisId).lean());
    }

    // Update display info from API response
    const userData = result?.userData || {};
    if (userData.profileImageUrl) analysis.avatar = userData.profileImageUrl;
    const firstTweet = apiTweets[0];
    if (firstTweet?.author) analysis.display_name = firstTweet.author;

    // All tweets are already within the period (filtered during fetch)
    const periodTweets = apiTweets;

    console.log(`[EngagerAnalysis] ${periodTweets.length} tweets within ${periodDays}-day window`);

    // 3. For each tweet, fetch retweeters
    // Merge with existing engager data from previous analyses
    // handle → { name, avatar, verified, user_id, tweet_ids: Set }
    const engagerMap = new Map();

    // Seed from previous engagers (merge with old data)
    if (analysis.engagers && analysis.engagers.length > 0) {
      for (const prev of analysis.engagers) {
        const h = normalizeHandle(prev.handle);
        if (!h) continue;
        engagerMap.set(h, {
          handle: h,
          name: prev.name || h,
          avatar: prev.avatar || null,
          verified: !!prev.verified,
          user_id: prev.user_id || null,
          tweet_ids: new Set(prev.tweet_ids || [])
        });
      }
    }

    // Seed existing tweet snapshots (avoid duplicates)
    const existingTweetIds = new Set();
    if (analysis.tweets && analysis.tweets.length > 0) {
      for (const t of analysis.tweets) {
        existingTweetIds.add(String(t.tweet_id));
      }
    }

    const tweetSnapshots = [];
    let totalRetweetEvents = 0;

    // Sort tweets by retweet count (highest first) and cap at 40 tweets for retweeter fetching
    // This prevents 200+ API calls for very active accounts
    const MAX_TWEETS_FOR_RETWEETERS = 40;
    const sortedTweets = [...periodTweets].sort((a, b) => {
      const rtA = Number(a?.metrics?.retweets || a?.metrics?.retweet || a?.engagement?.retweets || 0);
      const rtB = Number(b?.metrics?.retweets || b?.metrics?.retweet || b?.engagement?.retweets || 0);
      return rtB - rtA;
    });

    let retweeterFetchCount = 0;

    for (const tweet of periodTweets) {
      const tweetId = String(tweet?.id || '').trim();
      if (!tweetId) continue;

      const retweetCount = Number(tweet?.metrics?.retweets || tweet?.metrics?.retweet || tweet?.engagement?.retweets || 0);
      const tweetText = String(tweet?.text || tweet?.full_text || '').substring(0, 280);
      const tweetUrl = tweet?.url || `https://x.com/${cleanHandle}/status/${tweetId}`;

      const snapshot = {
        tweet_id: tweetId,
        text: tweetText,
        created_at: tweet?.created_at ? new Date(tweet.created_at) : null,
        content_url: tweetUrl,
        retweet_count: retweetCount,
        retweeters_found: 0
      };

      if (retweetCount > 0 && retweeterFetchCount < MAX_TWEETS_FOR_RETWEETERS) {
        // Check if this tweet is in the top N by retweet count (worth fetching)
        const isTopTweet = sortedTweets.indexOf(tweet) < MAX_TWEETS_FOR_RETWEETERS;
        if (isTopTweet) {
          retweeterFetchCount++;
          console.log(`[EngagerAnalysis] Fetching retweeters for tweet ${retweeterFetchCount}/${MAX_TWEETS_FOR_RETWEETERS}: ${tweetId} (${retweetCount} RTs)`);
          try {
            const retweeters = await rapidApiXService.fetchTweetRetweeters(tweetId, { count: 200 });
            snapshot.retweeters_found = retweeters.length;
            totalRetweetEvents += retweeters.length;

            for (const rt of retweeters) {
              const rtHandle = normalizeHandle(rt?.handle);
              if (!rtHandle) continue;

              if (!engagerMap.has(rtHandle)) {
                engagerMap.set(rtHandle, {
                  handle: rtHandle,
                  name: rt.name || rtHandle,
                  avatar: rt.avatar || null,
                  verified: !!rt.verified,
                  user_id: rt.id || null,
                  tweet_ids: new Set()
                });
              }
              const entry = engagerMap.get(rtHandle);
              entry.tweet_ids.add(tweetId);
              if (rt.name) entry.name = rt.name;
              if (rt.avatar) entry.avatar = rt.avatar;
              if (rt.verified) entry.verified = true;
              if (rt.id) entry.user_id = rt.id;
            }
          } catch (err) {
            console.warn(`[EngagerAnalysis] Failed to fetch retweeters for tweet ${tweetId}: ${err.message}`);
          }
        }
      }

      tweetSnapshots.push(snapshot);
    }

    // 4. Build frequency hierarchy
    const allTweetSnapshots = [
      // Keep old tweet snapshots that aren't in the new batch
      ...(analysis.tweets || []).filter(t => !tweetSnapshots.some(ns => ns.tweet_id === String(t.tweet_id))).map(t => ({
        tweet_id: String(t.tweet_id),
        text: t.text,
        created_at: t.created_at,
        content_url: t.content_url,
        retweet_count: t.retweet_count,
        retweeters_found: t.retweeters_found
      })),
      ...tweetSnapshots
    ];
    const totalTweetsAnalyzed = allTweetSnapshots.length;
    const engagers = [];
    const summaryCount = { 'super-active': 0, regular: 0, occasional: 0, 'one-time': 0 };

    for (const [, entry] of engagerMap) {
      const tweetsRetweeted = entry.tweet_ids.size;
      const ratio = totalTweetsAnalyzed > 0 ? tweetsRetweeted / totalTweetsAnalyzed : 0;

      let frequency;
      if (ratio >= 0.5 || tweetsRetweeted >= 10) {
        frequency = 'super-active';
      } else if (ratio >= 0.25 || tweetsRetweeted >= 5) {
        frequency = 'regular';
      } else if (tweetsRetweeted >= 2) {
        frequency = 'occasional';
      } else {
        frequency = 'one-time';
      }

      summaryCount[frequency] = (summaryCount[frequency] || 0) + 1;

      engagers.push({
        handle: entry.handle,
        name: entry.name,
        avatar: entry.avatar,
        verified: entry.verified,
        user_id: entry.user_id,
        tweets_retweeted: tweetsRetweeted,
        tweet_ids: Array.from(entry.tweet_ids),
        frequency
      });
    }

    // Sort: super-active first, then by tweets_retweeted desc
    const freqOrder = { 'super-active': 0, regular: 1, occasional: 2, 'one-time': 3 };
    engagers.sort((a, b) => {
      const fo = (freqOrder[a.frequency] ?? 9) - (freqOrder[b.frequency] ?? 9);
      if (fo !== 0) return fo;
      return b.tweets_retweeted - a.tweets_retweeted;
    });

    // 5. Update and save
    analysis.status = 'completed';
    analysis.tweets_analyzed = totalTweetsAnalyzed;
    analysis.total_retweet_events = totalRetweetEvents;
    analysis.unique_retweeters = engagerMap.size;
    analysis.summary = {
      super_active: summaryCount['super-active'],
      regular: summaryCount['regular'],
      occasional: summaryCount['occasional'],
      one_time: summaryCount['one-time']
    };
    analysis.engagers = engagers;
    analysis.tweets = allTweetSnapshots;
    analysis.error = null;
    await analysis.save();

    console.log(`[EngagerAnalysis] Completed for @${cleanHandle}: ${totalTweetsAnalyzed} tweets, ${engagerMap.size} unique retweeters, ${totalRetweetEvents} total retweet events`);
    return analysis.toObject();
  } catch (err) {
    console.error(`[EngagerAnalysis] Failed for @${cleanHandle}:`, err.message, err.stack);
    // Always mark as failed using updateOne (bulletproof even if analysis doc is stale)
    try {
      await EngagerAnalysis.updateOne({ _id: analysisId }, { $set: { status: 'failed', error: err.message } });
    } catch (saveErr) {
      console.error(`[EngagerAnalysis] CRITICAL - could not save failure status for @${cleanHandle}:`, saveErr.message);
    }
    return (await EngagerAnalysis.findById(analysisId).lean()) || { handle: cleanHandle, status: 'failed', error: err.message };
  }
};

/**
 * Get the latest completed analysis for a handle
 */
const getLatestAnalysis = async (handle, tenantId) => {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle || !tenantId) return null;
  return EngagerAnalysis.findOne({ tenant_id: tenantId, handle_lower: cleanHandle, status: 'completed' })
    .sort({ analyzed_at: -1 })
    .lean();
};

/**
 * Get analysis history for a handle (all past runs)
 */
const getAnalysisHistory = async (handle, tenantId, limit = 20) => {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle || !tenantId) return [];
  return EngagerAnalysis.find({ tenant_id: tenantId, handle_lower: cleanHandle })
    .sort({ analyzed_at: -1 })
    .limit(limit)
    .select('id handle display_name avatar analyzed_at status period_days tweets_analyzed unique_retweeters total_retweet_events summary error')
    .lean();
};

/**
 * Get a specific analysis by ID (tenant-scoped)
 */
const getAnalysisById = async (analysisId, tenantId) => {
  return EngagerAnalysis.findOne({ id: analysisId, ...(tenantId ? { tenant_id: tenantId } : {}) }).lean();
};

/**
 * Get all handles that have been analyzed (for the history panel)
 */
const getAnalyzedHandles = async (tenantId) => {
  const results = await EngagerAnalysis.aggregate([
    { $match: { tenant_id: tenantId, status: 'completed' } },
    { $sort: { analyzed_at: -1 } },
    {
      $group: {
        _id: '$handle_lower',
        handle: { $first: '$handle' },
        display_name: { $first: '$display_name' },
        avatar: { $first: '$avatar' },
        latest_analyzed_at: { $first: '$analyzed_at' },
        analysis_count: { $sum: 1 },
        latest_unique_retweeters: { $first: '$unique_retweeters' },
        latest_tweets_analyzed: { $first: '$tweets_analyzed' },
        latest_summary: { $first: '$summary' },
        latest_id: { $first: '$id' }
      }
    },
    { $sort: { latest_analyzed_at: -1 } }
  ]);
  return results;
};

/**
 * Get count of currently processing analyses.
 * Also resets any stuck processing records older than 10 minutes.
 */
const getPendingCount = async (tenantId) => {
  // Auto-cleanup this tenant's stuck processing records
  await EngagerAnalysis.updateMany(
    { tenant_id: tenantId, status: 'processing', analyzed_at: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
    { $set: { status: 'failed', error: 'Analysis timed out' } }
  );
  return EngagerAnalysis.countDocuments({ tenant_id: tenantId, status: 'processing' });
};

/**
 * Get all analysis records (one per handle) for the Frequent Engagers panel.
 * Returns only the latest record per handle via aggregation.
 */
const getAllAnalyses = async (tenantId) => {
  return EngagerAnalysis.aggregate([
    { $match: { tenant_id: tenantId } },
    { $sort: { analyzed_at: -1 } },
    {
      $group: {
        _id: '$handle_lower',
        id: { $first: '$id' },
        handle: { $first: '$handle' },
        handle_lower: { $first: '$handle_lower' },
        display_name: { $first: '$display_name' },
        avatar: { $first: '$avatar' },
        analyzed_at: { $first: '$analyzed_at' },
        status: { $first: '$status' },
        period_days: { $first: '$period_days' },
        tweets_analyzed: { $first: '$tweets_analyzed' },
        unique_retweeters: { $first: '$unique_retweeters' },
        total_retweet_events: { $first: '$total_retweet_events' },
        summary: { $first: '$summary' },
        error: { $first: '$error' }
      }
    },
    { $sort: { analyzed_at: -1 } }
  ]);
};

module.exports = {
  runEngagerAnalysis,
  prepareAnalysisRecord,
  executeAnalysisWork,
  getLatestAnalysis,
  getAnalysisHistory,
  getAnalysisById,
  getAnalyzedHandles,
  getPendingCount,
  getAllAnalyses
};
