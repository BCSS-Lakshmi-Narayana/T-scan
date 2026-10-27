const { buildYouTubeClient } = require('./youtube.service');
const { TwitterApi } = require('twitter-api-v2');
const Source = require('../models/Source');
const Content = require('../models/Content');
const Settings = require('../models/Settings');
const Comment = require('../models/Comment');
const sentiment = require('./sentiment');
const { getActiveEvents, autoArchiveEndedEvents, scanEventOnce, shouldPollEvent } = require('./eventMonitorService');
const { queueUrlEnrichment } = require('./urlEnrichmentService');
const rapidApiInstagramService = require('./rapidApiInstagramService');
const { enqueueMediaLocationExtraction } = require('./mediaLocationService');
const { scheduleTenantPipeline } = require('./pipeline/tenantScheduler');
const tenantContextService = require('./pipeline/tenantContextService');
const { createPipelineLogger } = require('../utils/tenantLogger');

const normalizeInstagramHandle = (value) => {
  if (!value) return value;
  let id = String(value).trim();
  if (/^https?:\/\//i.test(id) || /instagram\.com\//i.test(id)) {
    try {
      const url = new URL(id.startsWith('http') ? id : `https://${id}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) id = parts[0];
    } catch (_) {
      // ignore
    }
  }
  id = id.replace(/^@/, '');
  return id.toLowerCase();
};

const extractAndFetchUrlContent = async (text) => {
  try {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);

    if (!urls || urls.length === 0) return '';

    let scrapedText = '';
    for (const url of urls.slice(0, 2)) {
      try {
        if (url.includes('youtube.com') || url.includes('twitter.com') || url.includes('x.com')) continue;

        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) continue;

        const html = await response.text();

        // Simple regex extraction
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
          html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
        const description = descMatch ? descMatch[1].trim() : '';

        if (title || description) {
          scrapedText += ` [Link Content: ${title} - ${description}]`;
        }
      } catch (err) {
        // Ignore fetch errors
        //console.log(`Failed to fetch URL ${url}: ${err.message}`);
      }
    }
    return scrapedText;
  } catch (error) {
    //console.error('Error in URL extraction:', error);
    return '';
  }
};

const monitorYoutubeSource = async (source) => {
  try {
    const youtube = buildYouTubeClient();

    // ─── Resolve identifier to channel ID if needed ───────────────────
    let channelId = source.identifier;
    const isChannelId = /^UC[A-Za-z0-9_-]{20,}$/.test(channelId);

    if (!isChannelId) {
      // Identifier is @ handle, URL, or username — resolve to channel ID
      console.log(`[YouTube Monitor] Resolving identifier "${channelId}" for ${source.display_name}...`);
      const platformIdentityService = require('./platformIdentityService');
      const resolved = await platformIdentityService.resolvePlatformIdentity('youtube', channelId);

      if (!resolved?.platformUserId) {
        console.warn(`[YouTube Monitor] ⚠️ Could not resolve "${channelId}" for ${source.display_name} (method: ${resolved?.method || 'unknown'})`);
        // Don't update last_checked — let it retry next cycle
        return [];
      }

      channelId = resolved.platformUserId;
      console.log(`[YouTube Monitor] ✅ Resolved "${source.identifier}" → ${channelId} (${resolved.resolvedDisplayName || 'no name'}) via ${resolved.method}`);

      // Persist the resolved channel ID so we don't re-resolve every cycle
      const updates = { identifier: channelId };
      if (resolved.resolvedDisplayName && source.display_name?.includes('Pending Resolution')) {
        updates.display_name = resolved.resolvedDisplayName;
      }
      if (resolved.profileImageUrl && !source.profile_image_url) {
        updates.profile_image_url = resolved.profileImageUrl;
      }
      await Source.findOneAndUpdate({ id: source.id }, updates);
    }

    // Get latest videos
    const response = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      order: 'date',
      maxResults: 10,
      type: 'video'
    });

    const newContent = [];
    const items = response.data.items || [];

    for (const item of items) {
      const videoId = item.id.videoId;

      // Check if exists (tenant-scoped: each tenant keeps its own copy even if
      // another tenant monitors the same channel/video)
      const existing = await Content.findOne({ tenant_id: source.tenant_id, content_id: videoId });
      if (existing) continue;

      // Get video details
      const videoResponse = await youtube.videos.list({
        part: 'snippet,statistics',
        id: videoId
      });

      if (!videoResponse.data.items || videoResponse.data.items.length === 0) continue;

      const videoData = videoResponse.data.items[0];
      const snippet = videoData.snippet;
      const stats = videoData.statistics;

      const baseText = `${snippet.title} ${snippet.description}`;
      const scrapedContent = await extractAndFetchUrlContent(baseText);

      const content = new Content({
        source_id: source.id,
        tenant_id: source.tenant_id,
        districts: source.districts || [],
        state: source.state || '',
        platform: 'youtube',
        content_id: videoId,
        content_url: `https://www.youtube.com/watch?v=${videoId}`,
        text: baseText + scrapedContent,
        scraped_content: scrapedContent,
        media: [{
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: 'video'
        }],
        author: snippet.channelTitle,
        author_handle: source.identifier,
        published_at: new Date(snippet.publishedAt),
        engagement: {
          views: parseInt(stats.viewCount || 0),
          likes: parseInt(stats.likeCount || 0),
          comments: parseInt(stats.commentCount || 0)
        }
      });

      await content.save();
      newContent.push(content);
      console.log(`[YouTube Monitor] 🆕 New video: ${videoId} from ${source.display_name}`);
    }

    // Update last checked
    await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });

    if (newContent.length === 0 && items.length === 0) {
      console.log(`[YouTube Monitor] ℹ️ No videos found for ${source.display_name} (${channelId})`);
    } else {
      console.log(`[YouTube Monitor] ✅ ${source.display_name}: ${items.length} videos checked, ${newContent.length} new`);
    }

    return newContent;
  } catch (error) {
    console.error(`[YouTube Monitor] ❌ Error monitoring ${source.display_name}: ${error.message}`);
    // Don't update last_checked on error — let it retry
    return [];
  }
};

const xApiService = require('./xApiService');
const rapidApiXService = require('./rapidApiXService');
const rapidApiFacebookService = require('./rapidApiFacebookService');
const { scrapeProfile, getHealthyAccount } = require('./scraperService');
const { syncRetweetRelationshipsForSource } = require('./retweetNetworkService');

const monitorXSource = async (source) => {
  try {
    let tweets = [];
    // Whether the gateway path is available is a per-tenant question now, so ask
    // BluGate rather than testing an environment key. The old `RAPIDAPI_KEY` test
    // was left over from before the migration: X stopped using that key, but the
    // check survived, so on a host where it happened to be unset (it is only
    // still needed by google-trends) this branch would be skipped and X sources
    // would quietly fall through to the scraper instead of being fetched.
    const useGatewayApi = await rapidApiXService.isXConfigured();
    const useOfficialApi = !!process.env.X_BEARER_TOKEN;

    let userData = null;

    if (useGatewayApi) {
      const result = await rapidApiXService.fetchUserTweets(source.identifier);

      // Handle null (API error), array, and object returns safely
      if (!result) {
        console.warn(`[Monitor:X] ⚠️ fetchUserTweets returned null for ${source.display_name} (@${source.identifier}) — API error or user not found`);
        // Track consecutive failures — auto-deactivate after 10 consecutive null returns
        const failCount = (source.api_fail_count || 0) + 1;
        const updateFields = { api_fail_count: failCount, last_api_error: new Date() };
        if (failCount >= 10) {
          updateFields.is_active = false;
          updateFields.deactivation_reason = 'api_not_found_10x';
          console.warn(`[Monitor:X] 🚫 Auto-deactivated @${source.identifier} after ${failCount} consecutive API failures`);
        }
        await Source.findOneAndUpdate({ id: source.id }, { $set: updateFields });
        // Do NOT update last_checked — let it retry next cycle
        return [];
      } else if (Array.isArray(result)) {
        tweets = result;
      } else {
        tweets = result.tweets || [];
        userData = result.userData;

        if (userData) {
          const updates = {};
          // Update verification status if different
          if (userData.isVerified !== undefined && source.is_verified !== userData.isVerified) {
            updates.is_verified = userData.isVerified;
          }
          // Update profile image if availalble and different
          if (userData.profileImageUrl && source.profile_image_url !== userData.profileImageUrl) {
            updates.profile_image_url = userData.profileImageUrl;
          }

          if (Object.keys(updates).length > 0) {
            await Source.updateOne({ id: source.id }, updates);
            //console.log(`[Monitor] Updated metadata for ${source.identifier}:`, Object.keys(updates).join(', '));
          }
        }
      }
    } else if (useOfficialApi) {
      //console.log(`[Monitor] Using Official X API for ${source.display_name}`);
      tweets = await xApiService.fetchUserTweets(source.identifier);
    }

    // Fallback or legacy path if API fails or not configured
    if (!tweets || tweets.length === 0) {
      // Corrected Logic: Check if NO API is configured
      if (!useGatewayApi && !useOfficialApi) {
        //console.log(`[Monitor] API not configured, falling back to scraper for ${source.display_name}`);
        const account = await getHealthyAccount();
        if (account) {
          tweets = await scrapeProfile(source.identifier, account);
        } else {
          //console.warn('No healthy Twitter accounts available for scraping.');
        }
      } else {
        // console.log(`[Monitor] API active but returned no data (Rate Limit or empty). Skipping scraper fallback per policy.`);
      }
    }

    // Update last checked only when API returned NO tweets (confirms poll happened but account is quiet)
    if (!tweets || tweets.length === 0) {
      console.warn(`[Monitor:X] 📭 No tweets returned for ${source.display_name} (@${source.identifier}) — cooldown/cache/empty/error. NOT updating last_checked.`);
      // Do NOT update last_checked when API returned empty — it may be rate limited or in cooldown.
      // last_checked should only be updated after tweets are actually processed below.
      return [];
    }

    console.log(`[Monitor:X] 📥 Got ${tweets.length} raw tweets for ${source.display_name} (@${source.identifier})`);

    // Reset API failure counter on successful tweet fetch
    if (source.api_fail_count > 0) {
      await Source.findOneAndUpdate({ id: source.id }, { $set: { api_fail_count: 0 }, $unset: { last_api_error: 1 } });
    }

    // Log the tweet IDs and dates for audit trail
    if (tweets.length > 0) {
      const sorted = [...tweets].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      console.log(`[Monitor:X] 📋 Tweet dates for ${source.display_name}: newest=${sorted[0]?.created_at?.toISOString?.() || 'N/A'}, oldest=${sorted[sorted.length - 1]?.created_at?.toISOString?.() || 'N/A'}, IDs: ${sorted.slice(0, 5).map(t => t.id).join(', ')}${sorted.length > 5 ? `... +${sorted.length - 5} more` : ''}`);
    }

    // Check if this source has any existing content (first scan detection) —
    // tenant-scoped so each tenant's first scan is detected independently
    const hasExistingContent = await Content.findOne(
      { tenant_id: source.tenant_id, platform: 'x', author_handle: source.identifier },
      { _id: 1 }
    );
    const isFirstScan = !hasExistingContent;

    const beforeFilter = tweets.length;

    if (isFirstScan) {
      // First scan: keep ALL tweets — don't apply 24h filter so infrequent tweeters get initial content
      console.log(`[Monitor:X] 🆕 First scan for ${source.display_name} (@${source.identifier}) — keeping all ${tweets.length} tweets (no 24h filter)`);
    } else {
      // Subsequent scans: filter to last 24 hours only
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      tweets = tweets.filter(t => {
        const tweetDate = new Date(t.created_at);
        // Safety: if created_at is null/invalid, KEEP the tweet (don't silently drop it)
        if (!t.created_at || isNaN(tweetDate.getTime())) return true;
        return tweetDate > twentyFourHoursAgo;
      });

      if (beforeFilter > 0 && tweets.length === 0) {
        console.log(`[Monitor:X] ⏰ All ${beforeFilter} tweets for ${source.display_name} were older than 24h — filtered out`);
      }
    }

    if (!tweets || tweets.length === 0) {
      // All tweets were older than 24h — this IS a valid check, update last_checked
      await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });
      return [];
    }

    console.log(`[Monitor:X] 🔍 Processing ${tweets.length} tweets (of ${beforeFilter} raw) for ${source.display_name} (@${source.identifier})`);

    const newContent = [];

    for (const tweet of tweets) {
      // Check if exists (tenant-scoped)
      const existing = await Content.findOne({ tenant_id: source.tenant_id, content_id: tweet.id });
      if (existing) {
        const incomingMedia = Array.isArray(tweet.media) ? tweet.media : [];
        const incomingCards = Array.isArray(tweet.url_cards) ? tweet.url_cards : [];
        const existingMedia = Array.isArray(existing.media) ? existing.media : [];
        const existingQuoted = existing.quoted_content || null;
        const incomingQuoted = tweet.quoted_content || null;

        const mediaForSave = incomingMedia.length > 0 ? incomingMedia : existingMedia;
        const quotedForSave = incomingQuoted || existingQuoted;

        const shouldUpdate =
          (incomingMedia.length > 0 && (!existing.media || existing.media.length === 0)) ||
          (!existing.quoted_content && quotedForSave) ||
          (incomingCards.length > 0 && (!existing.url_cards || existing.url_cards.length === 0)) ||
          (!existing.original_author && tweet.original_author) ||
          (!existing.original_author_name && tweet.original_author_name) ||
          (!existing.original_author_avatar && tweet.original_author_avatar) ||
          (tweet.is_repost !== undefined && existing.is_repost !== tweet.is_repost);

        if (shouldUpdate || true) { // Always update metrics if found
          const newEngagement = {
            likes: parseInt(tweet.metrics?.like || tweet.metrics?.likes) || 0,
            retweets: parseInt(tweet.metrics?.retweet || tweet.metrics?.retweets) || 0,
            replies: parseInt(tweet.metrics?.reply || tweet.metrics?.replies) || 0,
            views: parseInt(tweet.metrics?.view || tweet.metrics?.views) || 0
          };

          // An edited tweet is analysed again (in-flight claims are left alone).
          const textChanged = Boolean(tweet.text)
            && String(tweet.text).trim() !== String(existing.text || '').trim()
            && existing.analysis_status !== 'processing';

          const updatedDoc = await Content.findOneAndUpdate(
            { id: existing.id },
            {
              $set: {
                ...(textChanged ? { analysis_status: 'pending', analysis_attempts: 0, analysis_next_attempt_at: null } : {}),
                text: tweet.text || existing.text,
                quoted_content: quotedForSave || existing.quoted_content,
                media: incomingMedia.length > 0 ? incomingMedia : existing.media,
                // Safeguard against 'Unknown' overwriting valid quoted_content
                quoted_content: (tweet.quoted_content && (tweet.quoted_content.author_name !== 'Unknown' || !existing.quoted_content))
                  ? tweet.quoted_content : existing.quoted_content,

                url_cards: incomingCards.length > 0 ? incomingCards : existing.url_cards,
                is_repost: tweet.is_repost ?? existing.is_repost,

                // Safeguard against 'Unknown' overwriting valid original_author info
                original_author: (tweet.original_author && (tweet.original_author !== 'unknown' || !existing.original_author))
                  ? tweet.original_author : existing.original_author,
                original_author_name: (tweet.original_author_name && (tweet.original_author_name !== 'Unknown' || !existing.original_author_name))
                  ? tweet.original_author_name : existing.original_author_name,

                original_author_avatar: tweet.original_author_avatar || existing.original_author_avatar,
                media: mediaForSave,
                scraped_content: mediaForSave.length > 0 ? `Media Count: ${mediaForSave.length}` : existing.scraped_content,
                engagement: newEngagement,
                location: tweet.location || existing.location,
                raw_data: tweet.raw_data || existing.raw_data
              },
              $push: {
                engagement_history: {
                  $each: [{
                    timestamp: new Date(),
                    ...newEngagement
                  }],
                  $slice: -50
                }
              }
            },
            { new: true }
          );
          //console.log(`[Monitor] Updated metrics/meta for ${tweet.id} from ${source.display_name}`);

          // Add to newContent so it gets checked for velocity alerts
          // We attach a flag 'is_update' so analysis service can skip re-analysis if needed
          updatedDoc.is_update = true;
          newContent.push(updatedDoc);
        }
        continue;
      }

      const incomingMedia = Array.isArray(tweet.media) ? tweet.media : [];
      const incomingQuoted = tweet.quoted_content || null;

      const content = new Content({
        source_id: source.id,
        tenant_id: source.tenant_id,
        districts: source.districts || [],
        state: source.state || '',
        platform: 'x',
        content_id: tweet.id,
        content_url: tweet.url,
        text: tweet.text,
        scraped_content: incomingMedia.length > 0 ? `Media Count: ${incomingMedia.length}` : '',
        media: incomingMedia,
        is_repost: tweet.is_repost || false,
        original_author: tweet.original_author,
        original_author_name: tweet.original_author_name,
        original_author_avatar: tweet.original_author_avatar,
        quoted_content: incomingQuoted,
        url_cards: tweet.url_cards || [],
        author: source.display_name,
        author_handle: source.identifier,
        published_at: new Date(tweet.created_at),
        location: tweet.location || null,
        engagement: {
          likes: parseInt(tweet.metrics.like) || 0,
          retweets: parseInt(tweet.metrics.retweet) || 0,
          replies: parseInt(tweet.metrics.reply) || 0,
          views: parseInt(tweet.metrics.views) || 0
        }
      });

      await content.save();
      newContent.push(content);
      enqueueMediaLocationExtraction(content.id);
      //console.log(`New X post: ${tweet.id} from ${source.display_name}`);
    }

    // ── AUDIT SUMMARY ──
    const newCreated = newContent.filter(c => !c.is_update).length;
    const updated = newContent.filter(c => c.is_update).length;
    console.log(`[Monitor:X] ✅ ${source.display_name} (@${source.identifier}): API=${beforeFilter}→24hFilter=${tweets.length} | new=${newCreated}, updated=${updated}, total_processed=${newContent.length}`);

    // Queue background URL card enrichment for new content
    if (newContent.length > 0) {
      const contentIds = newContent.map(c => c.id);
      queueUrlEnrichment(contentIds);
    }

    // Update last_checked AFTER content is actually processed/saved
    await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });

    // Retweet sync disabled — engager analysis is now on-demand only (triggered from alert card)
    // try {
    //   const retweetCandidates = newContent.filter(
    //     (doc) => Number(doc?.engagement?.retweets || 0) > 0
    //   );
    //   if (retweetCandidates.length > 0) {
    //     await syncRetweetRelationshipsForSource(source, retweetCandidates, {
    //       maxTweets: retweetCandidates.length,
    //       staleHours: 1
    //     });
    //   }
    // } catch (retweetSyncError) {
    //   console.warn(`[Retweet Network] monitor sync warning for ${source.identifier}: ${retweetSyncError.message}`);
    // }

    return newContent;
  } catch (error) {
    console.error(`Error monitoring X source ${source.display_name}: ${error.message}`);
    return [];
  }
};

const monitorInstagramSource = async (source, accessToken) => {
  try {
    // Credentials live in this tenant's BluGate row, so "configured" is a
    // per-tenant question — skip the scan rather than log an error per source.
    if (!(await rapidApiInstagramService.isInstagramConfigured())) {
      console.warn('[Instagram Monitor] ⚠️ BluGate Instagram is not configured for this tenant. Skipping scan.');
      // Do NOT update last_checked — keys not configured is not a successful check
      return [];
    }

    // ─── Handle Normalization ──────────────────────────────────────────────
    const normalizeHandle = (value) => {
      let str = String(value || '').trim();
      if (str.includes('instagram.com/')) {
        try {
          if (!str.startsWith('http')) str = 'https://' + str;
          const urlObj = new URL(str);
          const segments = urlObj.pathname.split('/').filter(Boolean);
          if (segments.length > 0) return segments[0].toLowerCase();
        } catch (e) { /* fallback */ }
      }
      return str.replace(/^@/, '').toLowerCase();
    };

    const handle = normalizeHandle(source.identifier || source.display_name);
    if (!handle) {
      console.warn(`[Instagram Monitor] ⚠️ No valid handle for source ${source.display_name}`);
      return [];
    }

    console.log(`[Instagram Monitor] 🔍 Starting scan for @${handle} (${source.display_name})`);

    // ─── Utility Helpers ───────────────────────────────────────────────────
    const toJsDate = (value) => {
      if (!value) return new Date();
      if (value instanceof Date) return value;
      if (typeof value === 'number') {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return isNaN(d) ? new Date() : d;
      }
      const d = new Date(value);
      return isNaN(d) ? new Date() : d;
    };

    const pickFirst = (...values) => values.find(v => v !== undefined && v !== null && v !== '');
    const asArray = (value) => (Array.isArray(value) ? value : []);
    const INSTAGRAM_VIDEO_EXT_RE = /\.(mp4|webm|m3u8|mov)(\?|$)/i;

    const unwrapStoryNode = (item) => {
      if (!item || typeof item !== 'object') return item;
      let current = item;
      let depth = 0;

      while (depth < 6) {
        const next = current?.node || current?.media || current?.story || current?.item || current?.data || null;
        if (!next || next === current || typeof next !== 'object') break;
        current = next;
        depth += 1;
      }

      return current;
    };

    const pickBestVideoVariantUrl = (variants = []) => {
      const normalized = variants
        .map((variant) => {
          if (typeof variant === 'string') return { url: variant, contentType: '' };
          if (!variant || typeof variant !== 'object') return null;
          return {
            ...variant,
            url: variant.url || variant.src,
            contentType: variant.content_type || variant.mime_type || variant.type || ''
          };
        })
        .filter((variant) => typeof variant?.url === 'string' && variant.url.trim());

      if (!normalized.length) return null;

      const mp4Only = normalized.filter((variant) => {
        const contentType = String(variant.contentType || '').toLowerCase();
        return !contentType || contentType.includes('mp4');
      });

      const selectable = mp4Only.length > 0 ? mp4Only : normalized;
      selectable.sort((a, b) => Number(b.bitrate || b.bandwidth || 0) - Number(a.bitrate || a.bandwidth || 0));
      return selectable[0]?.url || null;
    };

    // ─── Profile Extraction (deep fallbacks for different API shapes) ─────
    const extractProfile = (raw) => {
      if (!raw) return null;
      const data = raw?.data?.data || raw?.data || raw?.result || raw;
      const user =
        data?.user ||
        data?.data?.user ||
        data?.user_info?.user ||
        data?.userInfo ||
        data?.profile ||
        data?.result?.user ||
        data?.result?.data?.user ||
        data?.graphql?.user ||
        null;

      if (!user) return null;

      const username = pickFirst(user.username, user.user?.username, user.handle);
      const fullName = pickFirst(user.full_name, user.name, user.fullName, user.user?.full_name);
      const profilePic = pickFirst(
        user.profile_pic_url_hd,
        user.profile_pic_url,
        user.profile_pic,
        user.avatar,
        user.user?.profile_pic_url
      );
      const followers = pickFirst(
        user.edge_followed_by?.count,
        user.follower_count,
        user.followers,
        user.followers_count
      );
      const posts = pickFirst(
        user.edge_owner_to_timeline_media?.count,
        user.media_count,
        user.posts_count,
        user.post_count
      );
      const verified = pickFirst(user.is_verified, user.isVerified);
      const bio = pickFirst(user.biography, user.bio, user.description, '');

      return { username, fullName, profilePic, followers, posts, verified, bio };
    };

    // ─── Post Extraction (handles 10+ different API response shapes) ──────
    const extractPosts = (raw) => {
      if (!raw) return [];
      // Check raw.response first — RapidAPI Instagram wraps posts in { response: [...], success: true }
      if (Array.isArray(raw?.response)) return raw.response.map(item => item?.node || item).filter(Boolean);
      const data = raw?.data?.data || raw?.data || raw?.result || raw;
      if (Array.isArray(data)) return data.map(item => item?.node || item).filter(Boolean);
      const candidates = [
        data?.edges,
        data?.user?.edge_owner_to_timeline_media?.edges,
        data?.data?.user?.edge_owner_to_timeline_media?.edges,
        data?.edge_owner_to_timeline_media?.edges,
        data?.graphql?.user?.edge_owner_to_timeline_media?.edges,
        data?.items,
        data?.data?.items,
        data?.posts,
        data?.data?.posts,
        data?.results,
        data?.data?.results,
        data?.feed?.items,
        data?.media?.items
      ];
      const list = candidates.find(Array.isArray) || [];
      return list.map(item => item?.node || item).filter(Boolean);
    };

    // ─── Story Extraction (handles various API response shapes) ───────────
    const extractStories = (raw) => {
      if (!raw) return [];
      const data = raw?.data?.data || raw?.data || raw?.result || raw;

      const extracted = [];
      const appendCandidates = (input) => {
        asArray(input).forEach((entry) => {
          const unwrapped = unwrapStoryNode(entry);
          if (Array.isArray(unwrapped?.items)) {
            unwrapped.items.forEach((nestedEntry) => extracted.push(unwrapStoryNode(nestedEntry)));
            return;
          }
          extracted.push(unwrapped);
        });
      };

      if (Array.isArray(data)) {
        appendCandidates(data);
      } else {
        const candidates = [
          data?.reel?.items,
          data?.reel_media?.items,
          data?.reels_media?.[0]?.items,
          data?.story?.items,
          data?.story_items,
          data?.stories,
          data?.items,
          data?.data?.stories,
          data?.data?.items,
          data?.data?.reel?.items,
          data?.user?.reel?.items,
          data?.highlights,
          data?.data?.highlights
        ];

        candidates.forEach(appendCandidates);
        asArray(data?.reels_media).forEach((reel) => appendCandidates(reel?.items));
      }

      return extracted.filter(Boolean);
    };

    // ─── Media Normalization ───────────────────────────────────────────────
    const normalizeMediaItem = (item) => {
      if (!item) return null;

      if (typeof item === 'string') {
        const rawUrl = item.trim();
        if (!rawUrl) return null;
        const isVideoUrl = INSTAGRAM_VIDEO_EXT_RE.test(rawUrl);
        return {
          type: isVideoUrl ? 'video' : 'photo',
          url: rawUrl,
          preview: rawUrl
        };
      }

      const normalizedItem = unwrapStoryNode(item);
      const videoVersions = [
        ...asArray(normalizedItem?.video_versions),
        ...asArray(normalizedItem?.videoVersions),
        ...asArray(normalizedItem?.video_resources),
        ...asArray(normalizedItem?.variants)
      ];

      const bestVariantUrl = pickBestVideoVariantUrl(videoVersions);
      const directVideoUrl = pickFirst(
        normalizedItem?.video_url,
        normalizedItem?.videoUrl,
        normalizedItem?.video?.url,
        normalizedItem?.play_url,
        bestVariantUrl
      );

      const imageCandidates = [
        normalizedItem?.preview,
        normalizedItem?.preview_image_url,
        normalizedItem?.thumbnail_url,
        normalizedItem?.thumbnail_src,
        normalizedItem?.display_url,
        normalizedItem?.image_url,
        normalizedItem?.cover_frame_url,
        ...asArray(normalizedItem?.image_versions2?.candidates).map((candidate) => candidate?.url),
        ...asArray(normalizedItem?.image_versions).map((candidate) => candidate?.url),
        ...asArray(normalizedItem?.display_resources).map((resource) => resource?.src)
      ];

      const imageUrl = pickFirst(
        ...imageCandidates,
        normalizedItem?.url
      );

      const mediaType = String(normalizedItem?.type || normalizedItem?.media_type || '').toLowerCase();
      const isVideo = !!(
        normalizedItem?.is_video ||
        mediaType === 'video' ||
        mediaType === 'animated_gif' ||
        mediaType === '2' ||
        directVideoUrl ||
        videoVersions.length > 0 ||
        (typeof normalizedItem?.url === 'string' && INSTAGRAM_VIDEO_EXT_RE.test(normalizedItem.url))
      );

      const url = isVideo ? pickFirst(directVideoUrl, imageUrl) : imageUrl;
      if (!url) return null;

      const preview = pickFirst(imageUrl, url, directVideoUrl);
      return { type: isVideo ? 'video' : 'photo', url, preview };
    };

    const normalizeMedia = (node) => {
      const normalizedNode = unwrapStoryNode(node);
      const children = (
        normalizedNode?.edge_sidecar_to_children?.edges ||
        normalizedNode?.carousel_media ||
        normalizedNode?.carousel ||
        []
      );

      if (Array.isArray(children) && children.length > 0) {
        return children
          .map(child => normalizeMediaItem(unwrapStoryNode(child)))
          .filter(Boolean);
      }

      const single = normalizeMediaItem(normalizedNode);
      return single ? [single] : [];
    };

    const hasUsableMedia = (mediaItems = []) => (
      Array.isArray(mediaItems) &&
      mediaItems.some((mediaItem) => typeof mediaItem?.url === 'string' && mediaItem.url.trim())
    );

    // ─── STEP 1: Fetch Profile (with fallback to cached data) ─────────────
    let profile = null;
    let profileFetchFailed = false;

    try {
      const profileRaw = await rapidApiInstagramService.fetchUserProfile(handle);
      profile = extractProfile(profileRaw);
      if (profile) {
        console.log(`[Instagram Monitor] ✅ Profile fetched: ${profile.fullName || profile.username || handle}`);
      }
    } catch (profileErr) {
      profileFetchFailed = true;
      console.warn(`[Instagram Monitor] ⚠️ Profile fetch failed for @${handle}: ${profileErr.message}. Using cached data.`);
    }

    // Update source metadata from fresh profile (or keep existing)
    if (profile) {
      const set = {};
      const push = {};

      if (profile.fullName && profile.fullName !== source.display_name) set.display_name = profile.fullName;
      if (profile.profilePic && profile.profilePic !== source.profile_image_url) set.profile_image_url = profile.profilePic;
      if (profile.verified !== undefined && profile.verified !== null) set.is_verified = profile.verified;

      if (profile.followers || profile.posts) {
        const existingStats = source.statistics || {};
        set.statistics = {
          ...existingStats,
          subscriber_count: Number(profile.followers) || existingStats.subscriber_count || 0,
          video_count: Number(profile.posts) || existingStats.video_count || 0,
          view_count: existingStats.view_count || 0
        };

        push.history = {
          date: new Date(),
          subscriber_count: Number(profile.followers) || 0,
          video_count: Number(profile.posts) || 0,
          view_count: existingStats.view_count || 0
        };
      }

      const update = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(push).length > 0) update.$push = push;
      if (Object.keys(update).length > 0) {
        await Source.findOneAndUpdate({ id: source.id }, update);
        //console.log(`[Instagram Monitor] 📝 Updated source metadata for @${handle}`);
      }
    }

    // ─── STEP 2: Fetch Posts (with fallback — continue even if profile failed) ──
    let posts = [];
    let postsFetchFailed = false;

    try {
      const postsRaw = await rapidApiInstagramService.fetchUserPosts(handle);
      if (postsRaw === null) {
        // API returned null = all endpoints failed (not "user has 0 posts")
        postsFetchFailed = true;
        console.warn(`[Instagram Monitor] ⚠️ fetchUserPosts returned null for @${handle} — API failure`);
      } else if (postsRaw?.success === false || postsRaw?.response_type === 'page not found') {
        // API explicitly said this account doesn't exist / is private
        postsFetchFailed = true;
        console.warn(`[Instagram Monitor] ⚠️ Account not found/private for @${handle}: ${postsRaw?.message || postsRaw?.response_type}`);
      } else {
        posts = extractPosts(postsRaw);
        console.log(`[Instagram Monitor] 📦 Extracted ${posts.length} posts for @${handle}`);
      }
    } catch (postsErr) {
      postsFetchFailed = true;
      console.error(`[Instagram Monitor] ❌ Posts fetch failed for @${handle}: ${postsErr.message}`);
    }

    // If both profile and posts failed, something is seriously wrong with this source
    if (profileFetchFailed && postsFetchFailed) {
      console.error(`[Instagram Monitor] 🚨 Complete API failure for @${handle}. All API keys may be exhausted. Will retry next cycle.`);
      // Do NOT update last_checked on API failure — so it retries next cycle
      return [];
    }

    if (!posts || posts.length === 0) {
      if (postsFetchFailed) {
        // Posts API failed but profile worked — don't mark as checked
        console.warn(`[Instagram Monitor] ⚠️ Posts API failed for @${handle} but profile succeeded — will retry`);
        return [];
      }
      console.log(`[Instagram Monitor] ℹ️ No posts found for @${handle} (may be private or empty)`);
      await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });
      return [];
    }

    // ─── STEP 3: Process Each Post (with per-post error isolation) ────────
    const newContent = [];
    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    for (const post of posts) {
      try {
        const shortcode = pickFirst(post.shortcode, post.code);
        const contentId = String(pickFirst(post.id, post.pk, post.media_id, shortcode));
        if (!contentId) continue;

        let content = await Content.findOne({ tenant_id: source.tenant_id, platform: 'instagram', content_id: contentId });

        const caption =
          pickFirst(
            post.edge_media_to_caption?.edges?.[0]?.node?.text,
            post.caption?.text,
            post.text,
            post.caption_text,
            ''
          ) || '';

        // Safe date parsing with fallback
        let createdAt;
        try {
          createdAt = toJsDate(pickFirst(post.taken_at_timestamp, post.taken_at, post.created_time, post.timestamp, post.created_at));
        } catch (dateErr) {
          createdAt = new Date();
          //console.warn(`[Instagram Monitor] ⚠️ Date parse failed for post ${contentId}, using now()`);
        }

        const media = normalizeMedia(post);
        const contentUrl = pickFirst(
          post.permalink,
          shortcode ? `https://www.instagram.com/p/${shortcode}/` : null,
          post.url
        );

        // Geotag — try the feed payload first; if absent, fall back to the
        // per-post detail endpoint (costs +1 RapidAPI call, but only when
        // missing). The lookup runs AT MOST ONCE per post: most posts carry no
        // geotag, and without location_checked a post that simply has none would
        // be re-fetched on every single scan for the life of the content.
        let location = rapidApiInstagramService.extractInstagramLocation(post);
        let locationChecked = content?.location_checked === true;
        if (!location && shortcode) {
          const existingLoc = content?.location?.name ? content.location : null;
          if (existingLoc) {
            location = existingLoc;
          } else if (!locationChecked) {
            try {
              const detail = await rapidApiInstagramService.fetchInstagramPostDetail(shortcode);
              if (detail?.location?.name) location = detail.location;
            } catch (locErr) {
              // Non-fatal — location is best-effort
            }
            // Mark it either way: a lookup that found nothing is still a lookup,
            // and repeating it would cost the same quota for the same answer.
            locationChecked = true;
          }
        }

        // Engagement extraction with deep fallbacks
        const likes = Number(pickFirst(post.edge_media_preview_like?.count, post.edge_liked_by?.count, post.likes?.count, post.like_count, 0)) || 0;
        const comments = Number(pickFirst(post.edge_media_to_comment?.count, post.comment_count, post.comments?.count, 0)) || 0;
        const views = Number(
          pickFirst(
            post.video_view_count,
            post.view_count,
            post.play_count,
            post.video_play_count,
            post.clips_view_count,
            post.media?.view_count,
            post.statistics?.view_count,
            post.reel_play_count,
            post.reel_view_count,
            0
          )
        ) || 0;

        if (content) {
          const existingMedia = Array.isArray(content.media) ? content.media : [];
          const mediaForSave = media.length > 0 ? media : existingMedia;

          // ── UPDATE existing content (metrics refresh, like X monitoring) ──
          const newEngagement = { likes, comments, views, retweets: 0 };

          const updatedDoc = await Content.findOneAndUpdate(
            { id: content.id },
            {
              $set: {
                text: caption || content.text,
                media: mediaForSave,
                engagement: newEngagement,
                location: location || content.location || null,
                location_checked: locationChecked || content.location_checked || false,
                author: profile?.fullName || content.author || source.display_name,
                author_handle: handle || content.author_handle || source.identifier
              },
              $push: {
                engagement_history: {
                  $each: [{
                    timestamp: new Date(),
                    likes,
                    comments,
                    views
                  }],
                  $slice: -50 // Keep last 50 history entries
                }
              }
            },
            { new: true }
          );

          if (updatedDoc) {
            // Safeguard Author Updates (Separate Update)
            const isUnknown = (val) => !val || String(val).trim().toLowerCase() === 'unknown' || String(val).trim().toLowerCase() === 'unknown user';
            const newAuthor = profile?.fullName || source.display_name;
            const newHandle = handle || source.identifier;

            if (!isUnknown(newAuthor) || isUnknown(updatedDoc.author)) {
              await Content.updateOne({ id: content.id }, { $set: { author: newAuthor || content.author } });
            }
            if (!isUnknown(newHandle) || isUnknown(updatedDoc.author_handle)) {
              await Content.updateOne({ id: content.id }, { $set: { author_handle: newHandle || content.author_handle } });
            }

            updatedDoc.is_update = true;
            newContent.push(updatedDoc);
            updatedCount++;
          }
        } else {
          // ── CREATE new content ────────────────────────────────────────────
          content = new Content({
            source_id: source.id,
            tenant_id: source.tenant_id,
            districts: source.districts || [],
            state: source.state || '',
            platform: 'instagram',
            content_id: contentId,
            content_url: contentUrl || `https://www.instagram.com/p/${shortcode || contentId}/`,
            text: caption || 'Instagram post',
            scraped_content: media.length > 0 ? `Media Count: ${media.length}` : '',
            media,
            author: profile?.fullName || source.display_name,
            author_handle: handle || source.identifier,
            published_at: createdAt,
            location: location || null,
            location_checked: locationChecked,
            engagement: {
              likes,
              comments,
              views,
              retweets: 0
            }
          });
          await content.save();
          newContent.push(content);
          processedCount++;
          console.log(`[Instagram Monitor] 🆕 New post: ${contentId} from @${handle}`);
          enqueueMediaLocationExtraction(content.id);
        }
      } catch (postErr) {
        errorCount++;
        console.error(`[Instagram Monitor] ⚠️ Error processing post: ${postErr.message}`);
        // Continue processing remaining posts
      }
    }

    // ─── STEP 4: Fetch Stories (ephemeral, 24h content) ────────────────
    let storiesCount = 0;
    try {
      const storiesRaw = await rapidApiInstagramService.fetchUserStories(handle);
      const stories = extractStories(storiesRaw);
      //console.log(`[Instagram Monitor] 📖 Extracted ${stories.length} stories for @${handle}`);

      for (const story of stories) {
        try {
          const storyId = String(pickFirst(story.id, story.pk, story.story_id, story.media_id));
          if (!storyId) continue;

          const caption = pickFirst(story.caption?.text, story.text, '') || '';
          let createdAt;
          try {
            createdAt = toJsDate(pickFirst(story.taken_at, story.taken_at_timestamp, story.timestamp, story.created_at));
          } catch (dateErr) {
            createdAt = new Date();
          }

          const media = normalizeMedia(story);
          const storyUrl = pickFirst(
            story.story_url,
            story.url,
            `https://www.instagram.com/stories/${handle}/${storyId}/`
          );

          const expiresAt = story.expiring_at
            ? toJsDate(story.expiring_at)
            : new Date(createdAt.getTime() + 24 * 60 * 60 * 1000); // 24h from creation

          // Check if story already exists and repair only when media was missing earlier.
          const existingStory = await Content.findOne({
            tenant_id: source.tenant_id,
            platform: 'instagram',
            content_id: storyId,
            content_type: 'story'
          });

          if (existingStory) {
            const existingHasMedia = hasUsableMedia(existingStory.media);
            const incomingHasMedia = hasUsableMedia(media);
            const existingMedia = Array.isArray(existingStory.media) ? existingStory.media : [];
            const mediaForSave = incomingHasMedia ? media : existingMedia;

            if ((!existingHasMedia && incomingHasMedia) || incomingHasMedia) {
              existingStory.media = mediaForSave;
              existingStory.content_url = storyUrl || existingStory.content_url;
              existingStory.scraped_content = `Story expires: ${expiresAt.toISOString()}`;
              if ((!existingStory.text || existingStory.text === 'Instagram Story') && caption) {
                existingStory.text = caption;
              }
              await existingStory.save();
              updatedCount++;
              //console.log(`[Instagram Monitor] 🔧 Repaired story media: ${storyId} from @${handle}`);
            }

            continue;
          }

          const storyContent = new Content({
            source_id: source.id,
            tenant_id: source.tenant_id,
            districts: source.districts || [],
            state: source.state || '',
            platform: 'instagram',
            content_type: 'story',
            content_id: storyId,
            content_url: storyUrl,
            text: caption || 'Instagram Story',
            scraped_content: `Story expires: ${expiresAt.toISOString()}`,
            media,
            author: profile?.fullName || source.display_name,
            author_handle: handle || source.identifier,
            published_at: createdAt,
            engagement: {
              likes: 0,
              comments: 0,
              views: Number(pickFirst(story.view_count, story.viewer_count, story.seen_count, 0)) || 0,
              retweets: 0
            }
          });
          await storyContent.save();
          newContent.push(storyContent);
          storiesCount++;
          //console.log(`[Instagram Monitor] 📖 New story: ${storyId} from @${handle}`);
        } catch (storyErr) {
          //console.warn(`[Instagram Monitor] ⚠️ Error processing story: ${storyErr.message}`);
        }
      }
    } catch (storiesErr) {
      //console.warn(`[Instagram Monitor] ⚠️ Stories fetch failed for @${handle}: ${storiesErr.message}`);
      // Stories are optional, continue without them
    }

    // ─── STEP 5: Update source last_checked ──────────────────────────────
    await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });

    console.log(`[Instagram Monitor] ✅ Scan complete for @${handle}: ${processedCount} new posts, ${storiesCount} stories, ${updatedCount} updated, ${errorCount} errors`);
    return newContent;

  } catch (error) {
    console.error(`[Instagram Monitor] ❌ Fatal error monitoring ${source.display_name}: ${error.message}`);
    // Do NOT update last_checked on fatal error — let it retry
    return [];
  }
};

const monitorFacebookSource = async (source, accessToken, options = {}) => {
  try {
    const FACEBOOK_VIDEO_URL_RE = /\.(mp4|webm|mkv|mov|avi|m3u8)(\?|$)/i;

    const isFacebookVideoUrl = (url) => typeof url === 'string' && (
      FACEBOOK_VIDEO_URL_RE.test(url) || /(^|[/?=_-])video([/?=_-]|$)/i.test(url)
    );

    const readFacebookMediaUrl = (value, depth = 0) => {
      if (depth > 3 || value === null || value === undefined) return '';
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || '';
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = readFacebookMediaUrl(entry, depth + 1);
          if (found) return found;
        }
        return '';
      }
      if (typeof value === 'object') {
        const directKeys = [
          's3_url',
          'video_url',
          'videoUrl',
          'url',
          'uri',
          'src',
          'source',
          'href',
          'hd_url',
          'sd_url',
          'playable_url',
          'playable_url_quality_hd',
          'playable_url_quality_sd',
          'playable_url_hd',
          'playable_url_sd',
          'browser_native_hd_url',
          'browser_native_sd_url',
          'browser_native_src',
          'download_url',
          'secure_url',
          'image_url',
          'thumbnail_url',
          'preview_url',
          'preview_image_url',
          'display_url',
          'thumbnail_src',
          'cover_frame_url',
          'poster',
          'poster_url',
          'original_url'
        ];

        for (const key of directKeys) {
          const found = readFacebookMediaUrl(value[key], depth + 1);
          if (found) return found;
        }

        if (value.thumbnails && typeof value.thumbnails === 'object') {
          const thumbPriority = ['maxres', 'high', 'medium', 'default', 'small'];
          for (const key of thumbPriority) {
            const found = readFacebookMediaUrl(value.thumbnails[key], depth + 1);
            if (found) return found;
          }
          const anyThumb = readFacebookMediaUrl(Object.values(value.thumbnails), depth + 1);
          if (anyThumb) return anyThumb;
        }

        const nestedKeys = ['image', 'video', 'thumbnail', 'preview', 'media', 'picture', 'attachment', 'node', 'cover', 'poster'];
        for (const key of nestedKeys) {
          const found = readFacebookMediaUrl(value[key], depth + 1);
          if (found) return found;
        }

        const listKeys = ['images', 'media', 'items', 'data', 'attachments', 'subattachments', 'children', 'nodes', 'edges', 'sources', 'video_versions', 'videoVersions'];
        for (const key of listKeys) {
          const found = readFacebookMediaUrl(value[key], depth + 1);
          if (found) return found;
        }
      }

      return '';
    };

    const collectFacebookMediaUrls = (...values) => {
      const seen = new Set();
      const urls = [];

      const visit = (value, depth = 0) => {
        if (depth > 4 || value === null || value === undefined) return;
        if (Array.isArray(value)) {
          value.forEach((entry) => visit(entry, depth + 1));
          return;
        }

        const resolved = readFacebookMediaUrl(value);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          urls.push(resolved);
        }
      };

      values.forEach((value) => visit(value));
      return urls;
    };

    const normalizeFacebookMediaItems = (mediaInput) => {
      const sourceMedia = Array.isArray(mediaInput) ? mediaInput : (mediaInput ? [mediaInput] : []);
      const normalized = [];
      const seen = new Set();

      const expandedMedia = sourceMedia.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return entry ? [entry] : [];

        const nested = [
          ...(Array.isArray(entry.media) ? entry.media : []),
          ...(Array.isArray(entry.images) ? entry.images : []),
          ...(Array.isArray(entry.items) ? entry.items : []),
          ...(Array.isArray(entry.data) ? entry.data : []),
          ...(Array.isArray(entry.attachments) ? entry.attachments : []),
          ...(Array.isArray(entry.attachments?.data) ? entry.attachments.data : []),
          ...(Array.isArray(entry.attachments?.media) ? entry.attachments.media : []),
          ...(Array.isArray(entry.subattachments) ? entry.subattachments : []),
          ...(Array.isArray(entry.subattachments?.data) ? entry.subattachments.data : []),
          ...(Array.isArray(entry.all_subattachments) ? entry.all_subattachments : []),
          ...(Array.isArray(entry.all_subattachments?.nodes) ? entry.all_subattachments.nodes : []),
          ...(Array.isArray(entry.children) ? entry.children : []),
          ...(Array.isArray(entry.nodes) ? entry.nodes : [])
        ];

        const hasDirectMediaValue = Boolean(readFacebookMediaUrl([
          entry?.s3_url,
          entry?.video_url,
          entry?.videoUrl,
          entry?.url,
          entry?.uri,
          entry?.src,
          entry?.hd_url,
          entry?.sd_url,
          entry?.playable_url,
          entry?.playable_url_quality_hd,
          entry?.playable_url_quality_sd,
          entry?.browser_native_hd_url,
          entry?.browser_native_sd_url,
          entry?.image_url,
          entry?.thumbnail_url,
          entry?.preview_url,
          entry?.preview_image_url,
          entry?.original_url,
          entry?.original_video_url
        ]));

        if (nested.length > 0) {
          return hasDirectMediaValue ? [entry, ...nested] : nested;
        }

        return [entry];
      });

      for (const mediaEntry of expandedMedia) {
        const typeHint = String(
          mediaEntry?.type
          || mediaEntry?.media_type
          || mediaEntry?.mime_type
          || mediaEntry?.kind
          || mediaEntry?.__typename
          || ''
        ).toLowerCase();

        const videoCandidates = collectFacebookMediaUrls(
          mediaEntry?.s3_url,
          mediaEntry?.video_url,
          mediaEntry?.videoUrl,
          mediaEntry?.original_video_url,
          mediaEntry?.hd_url,
          mediaEntry?.sd_url,
          mediaEntry?.playable_url,
          mediaEntry?.playable_url_quality_hd,
          mediaEntry?.playable_url_quality_sd,
          mediaEntry?.playable_url_hd,
          mediaEntry?.playable_url_sd,
          mediaEntry?.browser_native_hd_url,
          mediaEntry?.browser_native_sd_url,
          mediaEntry?.browser_native_src,
          mediaEntry?.source,
          mediaEntry?.sources,
          mediaEntry?.video_versions,
          mediaEntry?.videoVersions,
          mediaEntry?.video?.playable_url,
          mediaEntry?.video?.playable_url_quality_hd,
          mediaEntry?.video?.playable_url_quality_sd,
          mediaEntry?.video?.playable_url_hd,
          mediaEntry?.video?.playable_url_sd,
          mediaEntry?.video?.browser_native_hd_url,
          mediaEntry?.video?.browser_native_sd_url,
          mediaEntry?.video?.browser_native_src,
          mediaEntry?.video?.hd_url,
          mediaEntry?.video?.sd_url,
          mediaEntry?.video?.video_url,
          mediaEntry?.video?.url,
          mediaEntry?.video?.src,
          mediaEntry?.media_url_https,
          mediaEntry?.media_url
        );

        const imageCandidates = collectFacebookMediaUrls(
          mediaEntry?.s3_preview,
          mediaEntry?.preview,
          mediaEntry?.preview_url,
          mediaEntry?.original_preview,
          mediaEntry?.thumbnail_url,
          mediaEntry?.thumbnail_src,
          mediaEntry?.preview_image_url,
          mediaEntry?.image_url,
          mediaEntry?.display_url,
          mediaEntry?.cover_frame_url,
          mediaEntry?.poster,
          mediaEntry?.poster_url,
          mediaEntry?.image,
          mediaEntry?.picture,
          mediaEntry?.thumbnail,
          mediaEntry?.thumbnails,
          mediaEntry?.photo_image,
          mediaEntry?.media_image,
          mediaEntry?.image_lowres,
          mediaEntry?.image_highres,
          mediaEntry?.imageHigh,
          mediaEntry?.image_versions2?.candidates,
          mediaEntry?.image_versions,
          mediaEntry?.display_resources
        );

        const generalCandidates = collectFacebookMediaUrls(
          mediaEntry?.url,
          mediaEntry?.uri,
          mediaEntry?.src,
          mediaEntry?.href,
          mediaEntry?.original_url,
          mediaEntry?.secure_url,
          mediaEntry?.download_url,
          mediaEntry?.attachment,
          mediaEntry?.attachments,
          mediaEntry?.subattachments,
          mediaEntry?.all_subattachments,
          mediaEntry
        );

        const generalVideoCandidates = generalCandidates.filter((candidate) => isFacebookVideoUrl(candidate));
        const generalImageCandidates = generalCandidates.filter((candidate) => !isFacebookVideoUrl(candidate));
        const hasVideoSignal =
          typeHint.includes('video')
          || Boolean(
            mediaEntry?.is_video
            || mediaEntry?.video
            || mediaEntry?.video_url
            || mediaEntry?.videoUrl
            || mediaEntry?.hd_url
            || mediaEntry?.sd_url
            || mediaEntry?.playable_url
            || mediaEntry?.playable_url_quality_hd
            || mediaEntry?.playable_url_quality_sd
            || mediaEntry?.browser_native_hd_url
            || mediaEntry?.browser_native_sd_url
            || (Array.isArray(mediaEntry?.video_versions) && mediaEntry.video_versions.length > 0)
            || (Array.isArray(mediaEntry?.videoVersions) && mediaEntry.videoVersions.length > 0)
          );
        const isVideo = hasVideoSignal || [...videoCandidates, ...generalVideoCandidates].some((candidate) => isFacebookVideoUrl(candidate));

        const orderedCandidates = isVideo
          ? [...videoCandidates, ...generalVideoCandidates, ...imageCandidates, ...generalImageCandidates]
          : [...imageCandidates, ...generalImageCandidates, ...videoCandidates, ...generalVideoCandidates];
        const url = orderedCandidates.find(Boolean) || '';

        if (!url) continue;

        const previewCandidates = isVideo
          ? [...imageCandidates, ...generalImageCandidates, ...videoCandidates, ...generalVideoCandidates]
          : [...imageCandidates, ...generalImageCandidates, url];
        const preview = previewCandidates.find(Boolean) || url;

        const dedupeKey = `${isVideo ? 'video' : 'photo'}::${url}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const normalizedItem = {
          url,
          type: isVideo ? 'video' : 'photo',
          preview
        };

        if (isVideo) {
          normalizedItem.video_url = videoCandidates.find((candidate) => isFacebookVideoUrl(candidate)) || url;
          normalizedItem.preview_url = preview || '';
        }

        normalized.push(normalizedItem);
      }

      return normalized;
    };

    const mediaSignature = (media = []) => JSON.stringify(
      (Array.isArray(media) ? media : []).map((item) => ({
        type: item?.type || '',
        url: item?.url || '',
        video_url: item?.video_url || '',
        preview: item?.preview || '',
        preview_url: item?.preview_url || ''
      }))
    );

    const mediaNeedsRefresh = (existingMedia = [], incomingMedia = []) => {
      if (!Array.isArray(incomingMedia) || incomingMedia.length === 0) return false;
      if (!Array.isArray(existingMedia) || existingMedia.length === 0) return true;

      const hasBrokenVideo = existingMedia.some((item) => {
        const type = String(item?.type || item?.media_type || '').toLowerCase();
        const candidate = String(item?.video_url || item?.url || '');
        return type.includes('video') && !isFacebookVideoUrl(candidate);
      });

      return hasBrokenVideo || mediaSignature(existingMedia) !== mediaSignature(incomingMedia);
    };

    const pageUrl = source.identifier;
    let details = await rapidApiFacebookService.fetchPageDetails(pageUrl, { throwOnCooldown: !!options.throwOnCooldown });
    if (details) {
      const updates = {};
      if (details.name && details.name !== source.display_name) updates.display_name = details.name;
      if (details.image && details.image !== source.profile_image_url) updates.profile_image_url = details.image;

      // Update stats
      if (details.followers || details.likes) {
        updates.statistics = {
          ...source.statistics,
          subscriber_count: details.followers || source.statistics.subscriber_count,
          view_count: details.likes || source.statistics.view_count
        };

        // Track history
        if (!source.history) source.history = [];
        source.history.push({
          date: new Date(),
          subscriber_count: details.followers || 0,
          view_count: details.likes || 0
        });
      }

      if (Object.keys(updates).length > 0) {
        await Source.findOneAndUpdate({ id: source.id }, updates);
        //console.log(`[Monitor] Updated profile info for ${source.display_name}`);
      }
    }

    // 2. Fetch Posts - prefer numeric id from details when available, else use the stored page URL
    const pageKey = details?.id || pageUrl;
    let posts = await rapidApiFacebookService.fetchPagePosts(pageKey, 10, source.display_name, { throwOnCooldown: !!options.throwOnCooldown });
    if ((!posts || posts.length === 0) && pageKey !== pageUrl) {
      // fallback: try the URL form (covers cases where pageKey is numeric but API expects URL).
      // Only worth a second call when the key actually differs — when fetchPageDetails
      // gave us no id, pageKey IS pageUrl and this would repeat the identical request.
      posts = await rapidApiFacebookService.fetchPagePosts(pageUrl, 10, source.display_name, { throwOnCooldown: !!options.throwOnCooldown });
    }

    if (posts === null) {
      // fetchPagePosts returned null = API error (not "no posts") — do NOT update last_checked
      console.warn(`[Facebook Monitor] ⚠️ Posts API failed for ${source.display_name} — will retry next cycle`);
      return [];
    }

    if (!posts || posts.length === 0) {
      // Check if this is likely an API/resolution failure versus truly no posts
      if (!details) {
        console.warn(`[Facebook Monitor] ⚠️ Could not resolve page details for "${pageUrl}" — will retry next cycle`);
        // Do NOT update last_checked on resolution failure
        return [];
      }
      console.log(`[Facebook Monitor] ℹ️ No posts found for ${source.display_name} (pageKey=${pageKey})`);
      await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });
      return [];
    }

    console.log(`[Facebook Monitor] 📥 Got ${posts.length} posts for ${source.display_name}`);
    const newContent = [];

    for (const post of posts) {
      let content = await Content.findOne({ tenant_id: source.tenant_id, content_id: post.id });
      const incomingMedia = normalizeFacebookMediaItems(post.media);

      const toJsDate = (value) => {
        if (!value) return new Date();
        if (value instanceof Date) return value;
        if (typeof value === 'number') {
          const ms = value < 1e12 ? value * 1000 : value;
          const d = new Date(ms);
          return isNaN(d) ? new Date() : d;
        }
        const d = new Date(value);
        return isNaN(d) ? new Date() : d;
      };

      if (content) {
        // Update existing content engagement
        if (!Array.isArray(content.engagement_history)) content.engagement_history = [];
        content.engagement = {
          likes: post.engagement.likes,
          comments: post.engagement.comments,
          views: post.engagement.views,
          retweets: post.engagement.shares // mapping shares to retweets
        };
        content.engagement_history.push({
          timestamp: new Date(),
          likes: post.engagement.likes,
          comments: post.engagement.comments,
          views: post.engagement.views
        });

        if (mediaNeedsRefresh(content.media, incomingMedia)) {
          content.media = incomingMedia;
          content.scraped_content = `Media Count: ${incomingMedia.length}`;
        }

        if (post.location?.name && !content.location?.name) {
          content.location = post.location;
        }

        await content.save();
      } else {
        // Create new content
        const mediaItems = incomingMedia;

        content = new Content({
          source_id: source.id,
          tenant_id: source.tenant_id,
          districts: source.districts || [],
          state: source.state || '',
          platform: 'facebook',
          content_id: post.id,
          content_url: post.url,
          text: post.text || 'Facebook post',
          scraped_content: mediaItems.length > 0 ? `Media Count: ${mediaItems.length}` : '',
          media: mediaItems,
          author: post.author_name,
          author_handle: source.identifier,
          published_at: toJsDate(post.created_at),
          location: post.location || null,
          raw_data: post,
          engagement: {
            likes: post.engagement.likes,
            comments: post.engagement.comments,
            views: post.engagement.views,
            retweets: post.engagement.shares
          }
        });
        await content.save();
        newContent.push(content);
        enqueueMediaLocationExtraction(content.id);
      }

      // 3. Fetch Comments for this post
      if (post.engagement.comments > 0) {
        const comments = await rapidApiFacebookService.fetchPostComments(post.id, 20, { throwOnCooldown: !!options.throwOnCooldown });
        for (const c of comments) {
          const existingComment = await Comment.findOne({ tenant_id: content.tenant_id, comment_id: c.id });
          if (!existingComment) {
            const newComment = new Comment({
              tenant_id: content.tenant_id,
              content_id: content.id,
              video_id: post.id, // Using post_id as video_id
              comment_id: c.id,
              author_channel_id: c.author_id || 'unknown',
              author_display_name: c.author_name,
              author_profile_image: c.author_image,
              text: c.text || '',
              like_count: c.likes,
              published_at: new Date(c.created_at)
            });
            await newComment.save();
            // TODO: Analyze comment risk?
          }
        }
      }
    }

    // Update source last_checked
    await Source.findOneAndUpdate({ id: source.id }, { last_checked: new Date() });

    return newContent;

  } catch (error) {
    if (options.throwOnCooldown && (error?.code === 'FB_RAPIDAPI_COOLDOWN' || error?.response?.status === 429)) {
      throw error;
    }
    console.error(`[Facebook Monitor] ❌ Error monitoring ${source.display_name}: ${error.message}`);
    // Do NOT update last_checked on error — let it retry
    return [];
  }
};

const scanSourceOnce = async (source, options = {}) => {
  if (!source) throw new Error('Source is required');

  // Per-tenant context (preferred). The scheduler always supplies it; the manual
  // scan endpoints in sourceController do not, so fall back to reading this
  // source's OWN tenant settings. The fallback used to look for a single
  // `global_settings` document, which no longer exists in the multi-tenant model —
  // so every manual "Scan now" threw "Settings not found".
  const ctx = options.context || null;
  const settings = ctx?.settings
    || await Settings.findOne({ tenant_id: source.tenant_id, district: '' })
    || await Settings.findOne({ tenant_id: source.tenant_id });
  if (!settings) throw new Error(`Settings not found for tenant ${source.tenant_id}`);

  const xBearerToken = process.env.X_BEARER_TOKEN || settings.x_bearer_token;
  const fbAccessToken = settings.facebook_access_token || process.env.FACEBOOK_ACCESS_TOKEN;

  // The provider keys that used to be copied into process.env here are gone:
  // BluGate holds them per tenant, read from that tenant's own database. Copying
  // a tenant's key into a process-wide variable was never safe in a multi-tenant
  // process — the next tenant's scan would read whatever the last one wrote.
  if (xBearerToken) process.env.X_BEARER_TOKEN = xBearerToken;

  let newContent = [];
  if (source.platform === 'youtube') {
    // Credentials are resolved per tenant inside the BluGate client; a missing
    // one fails closed there with a message naming the platform.
    newContent = await monitorYoutubeSource(source);
  } else if (source.platform === 'x') {
    newContent = await monitorXSource(source);
  } else if (source.platform === 'instagram') {
    const normalized = normalizeInstagramHandle(source.identifier);
    if (normalized && normalized !== source.identifier) {
      source.identifier = normalized;
      await Source.findOneAndUpdate({ id: source.id }, { identifier: normalized });
    }
    newContent = await monitorInstagramSource(source, fbAccessToken);
  } else if (source.platform === 'facebook') {
    newContent = await monitorFacebookSource(source, fbAccessToken, { throwOnCooldown: !!options.throwOnCooldown });
  }

  // New content is saved as analysis_status='pending'; the sentiment pipeline
  // analyses it (and raises alerts) through the shared service dispatcher.
  if (newContent.length > 0) sentiment.kick();

  return { scanned: newContent.length, ingested: newContent.length };
};

/**
 * Re-analyse the last 24h of monitored-source content through the sentiment
 * service. Requeues it as pending and kicks the pipeline; results and alerts
 * arrive asynchronously.
 *
 * `districts` restricts the rescan to those districts (a district officer's own);
 * empty = whole tenant (admin).
 */
const rescanContent = async (tenantId, districts = []) => {
  if (!tenantId) throw new Error('tenantId is required for rescanContent');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const filter = {
    tenant_id: tenantId,
    source_id: { $exists: true, $nin: [null, ''] },
    created_at: { $gte: since },
    // Leave in-flight claims alone.
    analysis_status: { $ne: 'processing' },
  };
  if (Array.isArray(districts) && districts.length) filter.districts = { $in: districts };

  const res = await Content.updateMany(filter, {
    $set: { analysis_status: 'pending', analysis_attempts: 0, analysis_error: null },
    $unset: { analysis_next_attempt_at: 1 },
  });
  sentiment.kick();
  return { scanned: res.modifiedCount || 0, queued: res.modifiedCount || 0 };
};

// Per-tenant, per-platform, per-category last-scan timers (in-memory; reset on
// restart so every category is due immediately after a restart, matching the
// legacy loop's behavior). Keyed: tenantId -> platform -> category -> epochMs.
const tenantCategoryTimers = new Map();

const MONITOR_PLATFORMS = ['x', 'youtube', 'instagram', 'facebook'];
const MONITOR_CATEGORIES = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];

/**
 * Monitor ONE tenant: scan only that tenant's active sources using that tenant's
 * own settings + keywords + AI context (via tenantContextService), preserving the
 * per-platform/per-category frequency throttling. Content/alerts are tenant-tagged
 * by source.tenant_id inside scanSourceOnce. Runs under the tenant scheduler
 * (bounded tenant concurrency) and the Ollama semaphore (inside the analysis path),
 * so multiple tenants never overload the LLM. Each source error is isolated.
 */
const monitorTenant = async (tenant) => {
  const log = createPipelineLogger('monitor', tenant);
  const ctx = await tenantContextService.getContext(tenant.id);
  if (!ctx) { log.warn('no context (tenant missing?)'); return; }

  const settings = ctx.settings || {};
  const now = Date.now();
  let ingested = 0;
  let errors = 0;
  const scannedCats = [];

  // ── Source monitoring (respects per-tenant monitoring on/off + frequencies) ──
  if (settings.api_config?.monitoring?.enabled !== false) {
    if (!tenantCategoryTimers.has(tenant.id)) tenantCategoryTimers.set(tenant.id, {});
    const timers = tenantCategoryTimers.get(tenant.id);
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const CONCURRENCY = Math.max(1, Number(process.env.MONITOR_SOURCE_CONCURRENCY) || 5);
    const allSources = ctx.sources || [];

    for (const platform of MONITOR_PLATFORMS) {
      const frequencies = settings.api_config?.monitoring?.frequencies?.[platform] || {};
      if (!timers[platform]) timers[platform] = {};

      const dueCategories = MONITOR_CATEGORIES.filter((cat) => {
        const intervalMs = (frequencies[cat] || 60) * 60 * 1000;
        return now - (timers[platform][cat] || 0) >= intervalMs;
      });
      if (dueCategories.length === 0) continue;

      const platSources = allSources.filter((s) => s.platform === platform);

      for (const cat of dueCategories) {
        const catSources = platSources.filter((s) => {
          const c = (s.category || 'unknown').toLowerCase().trim();
          const eff = MONITOR_CATEGORIES.includes(c) ? c : 'others';
          return eff === cat;
        });
        timers[platform][cat] = Date.now(); // mark scanned even if 0 sources, so the timer advances
        if (catSources.length === 0) continue;

        catSources.sort((a, b) => (priorityOrder[b.priority] || 2) - (priorityOrder[a.priority] || 2));

        for (let i = 0; i < catSources.length; i += CONCURRENCY) {
          const batch = catSources.slice(i, i + CONCURRENCY);
          await Promise.allSettled(batch.map(async (source) => {
            // Honor "Pause" instantly: re-check is_active (tenant-scoped) against DB.
            const currentSource = await Source.findOne({ tenant_id: tenant.id, id: source.id }).lean();
            if (!currentSource || !currentSource.is_active) return;
            try {
              const res = await scanSourceOnce(source, { context: ctx });
              ingested += res?.ingested || 0;
            } catch (err) {
              errors += 1;
              log.error(`source ${source.identifier || source.display_name} scan failed`, err);
            }
          }));
        }
        scannedCats.push(`${platform}:${cat}`);
      }
    }
  }

  // Events used to be scanned here, at the tail of this function. They now run as
  // their own tenant pipeline (eventScanTenant) so they start immediately on their
  // own tick instead of queueing behind every source of every category.

  if (scannedCats.length > 0 || ingested > 0) {
    log.summary({ categories: scannedCats.length, ingested, errors });
  }
  return { ingested, errors, categories: scannedCats.length };
};

/**
 * Scan this tenant's active events — its own pipeline, peer to source monitoring
 * and grievance fetching rather than a step appended to either.
 *
 * Events were previously scanned at the end of monitorTenant, which meant an event
 * could not begin until every source in every category had finished. Sources are
 * scanned in parallel batches and events are not urgent individually, but coupling
 * the two made event latency a function of how many sources a tenant happens to
 * have. As a separate pipeline they tick independently and start fetching at once.
 *
 * Events within a tenant are scanned in parallel: each one is a distinct keyword
 * set, and scanEventOnce already isolates failures per platform inside itself.
 */
const eventScanTenant = async (tenant) => {
  const log = createPipelineLogger('event', tenant);
  const ctx = await tenantContextService.getContext(tenant.id);
  if (!ctx) { log.warn('no context (tenant missing?)'); return { scanned: 0, ingested: 0 }; }

  const settings = ctx.settings || {};
  if (settings.api_config?.events?.enabled === false) return { scanned: 0, ingested: 0 };

  const activeEvents = await getActiveEvents(tenant.id);
  const due = activeEvents.filter((event) => {
    let pollMinutes = event.polling_interval_minutes;
    if (!pollMinutes) {
      const evtPlatforms = event.platforms && event.platforms.length > 0
        ? event.platforms
        : ['x', 'instagram', 'facebook', 'youtube'];
      const intervals = evtPlatforms.map((p) => settings?.api_config?.events?.[p] || 60);
      pollMinutes = Math.min(...intervals);
    }
    return shouldPollEvent(event, pollMinutes);
  });
  if (due.length === 0) return { scanned: 0, ingested: 0 };

  let scanned = 0;
  let ingested = 0;
  let errors = 0;

  const outcomes = await Promise.allSettled(
    due.map((event) => scanEventOnce({ event, settings }))
  );
  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      scanned += outcome.value?.scanned || 0;
      ingested += outcome.value?.ingested || 0;
    } else {
      errors += 1;
      log.error(`event "${due[i].name}" scan failed`, outcome.reason);
    }
  });

  log.summary({ events: due.length, scanned, ingested, errors });
  return { scanned, ingested, errors };
};

/**
 * Auxiliary cross-tenant maintenance (ended-event archive + media backfill +
 * tenant-scoped pending-analysis retry). Runs on a light separate interval — not
 * the per-tenant content path.
 */
const startAuxMonitorTasks = () => {
  const AUX_INTERVAL_MS = 5 * 60 * 1000;
  const runAux = async () => {
    try {
      // These sweep events and analyses that belong to individual tenants, so
      // each pass runs once per tenant inside that tenant's own scope. Without
      // it the models have no database to resolve against under
      // TENANT_DB_MODE=per-tenant, and the whole tick fails into the catch
      // below — silently, since nothing here surfaces to a user.
      const { forEachTenant } = require('../config/tenantContext');
      const { getActiveTenants } = require('./pipeline/tenantScheduler');
      await forEachTenant(await getActiveTenants(), async () => {
        await autoArchiveEndedEvents();
      });
    } catch (err) {
      console.error('[Monitor Aux] tick failed:', err.message);
    }
  };
  setTimeout(runAux, 60 * 1000);
  setInterval(runAux, AUX_INTERVAL_MS);
};

const startMonitoring = async () => {
  // ─── Per-Platform Parallel Monitoring ────────────────────────────────────
  // Each platform runs its OWN independent loop. Within each platform,
  // sources are grouped by category and each category has its own frequency
  // from settings.api_config.monitoring.frequencies.[platform].[category].
  // Only categories whose timer has elapsed get scanned in each tick.

  const PLATFORMS = ['x', 'youtube', 'instagram', 'facebook'];
  const CATEGORIES = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];

  // Concurrency limits per platform (how many sources scanned in parallel within that platform)
  const PLATFORM_CONCURRENCY = {
    x: 2,
    youtube: 3,
    instagram: 2,
    facebook: 2
  };

  // Per-platform isolated state
  const platformState = {};
  for (const p of PLATFORMS) {
    platformState[p] = {
      running: false,
      completedSourceIds: new Set(),
      cycleInProgress: false,
      // Track last scan time per category (in-memory, resets on server restart)
      lastCategoryScannedAt: {}
    };
    for (const c of CATEGORIES) {
      platformState[p].lastCategoryScannedAt[c] = 0; // epoch 0 = never scanned → will scan immediately
    }
  }

  // ─── Platform Loop (one per platform, runs independently) ─────────────
  const runPlatformLoop = async (platform) => {
    const state = platformState[platform];

    if (state.running) {
      console.log(`[Monitor:${platform}] Previous cycle still running, skipping this trigger.`);
      setTimeout(() => runPlatformLoop(platform), 30000);
      return;
    }

    state.running = true;
    const loopStartedAt = Date.now();
    let nextCheckSeconds = 60; // default: re-check in 1 minute

    try {
      const settings = await Settings.findOne({ id: 'global_settings' });
      if (!settings) {
        nextCheckSeconds = 60;
        return;
      }

      // Only the official-API bearer token is still environment-backed; every
      // provider key now comes from this tenant's BluGate row.
      const xBearerToken = process.env.X_BEARER_TOKEN || settings.x_bearer_token;
      if (xBearerToken) process.env.X_BEARER_TOKEN = xBearerToken;

      // Platform-specific startup logging
      if (platform === 'x') {
      }
      if (platform === 'instagram') {
        const igReady = await rapidApiInstagramService.isInstagramConfigured();
        console.log(`[Monitor:instagram] BluGate configured this cycle: ${igReady}`);
      }

      // Check if monitoring is enabled
      const monitoringEnabled = settings.api_config?.monitoring?.enabled !== false;
      if (!monitoringEnabled) {
        nextCheckSeconds = 300; // check again in 5 min in case user re-enables
        return;
      }

      // ─── Determine which categories are due for scanning ──────────
      const now = Date.now();
      const frequencies = settings.api_config?.monitoring?.frequencies?.[platform] || {};
      const dueCategories = [];

      for (const cat of CATEGORIES) {
        const intervalMin = frequencies[cat] || 60;
        const intervalMs = intervalMin * 60 * 1000;
        const lastScanned = state.lastCategoryScannedAt[cat] || 0;
        if (now - lastScanned >= intervalMs) {
          dueCategories.push(cat);
        }
      }

      if (dueCategories.length === 0) {
        // Nothing due yet — compute when the next category will be due
        let soonest = Infinity;
        for (const cat of CATEGORIES) {
          const intervalMs = (frequencies[cat] || 60) * 60 * 1000;
          const lastScanned = state.lastCategoryScannedAt[cat] || 0;
          const nextDue = lastScanned + intervalMs - now;
          if (nextDue < soonest) soonest = nextDue;
        }
        nextCheckSeconds = Math.max(30, Math.floor(soonest / 1000));
        console.log(`[Monitor:${platform}] No categories due. Next check in ${(nextCheckSeconds / 60).toFixed(1)} min`);
        return;
      }

      console.log(`[Monitor:${platform}] Categories due: ${dueCategories.join(', ')}`);

      // ─── Fetch sources ──────────────────────────────────────────────
      // Normalize: sources with unknown/empty category map to 'others'
      const sources = await Source.find({ is_active: true, platform });

      // Map sources to their effective category
      const sourcesWithCategory = sources.map(s => {
        const cat = (s.category || 'unknown').toLowerCase().trim();
        const effectiveCat = CATEGORIES.includes(cat) ? cat : 'others';
        return { source: s, category: effectiveCat };
      });

      // Sort by priority: high > medium > low
      const priorityOrder = { 'high': 3, 'medium': 2, 'low': 1 };

      const CONCURRENCY = PLATFORM_CONCURRENCY[platform] || 5;

      // ─── Process ONE category at a time, mark done immediately ─────
      for (const cat of dueCategories) {
        const catSources = sourcesWithCategory
          .filter(({ category }) => category === cat);

        if (catSources.length === 0) {
          state.lastCategoryScannedAt[cat] = Date.now();
          console.log(`[Monitor:${platform}:${cat}] No sources, marked done`);
          continue;
        }

        catSources.sort((a, b) => (priorityOrder[b.source.priority] || 2) - (priorityOrder[a.source.priority] || 2));
        console.log(`[Monitor:${platform}:${cat}] Scanning ${catSources.length} sources...`);

        let completed = 0;
        let failed = 0;

        for (let i = 0; i < catSources.length; i += CONCURRENCY) {
          const batch = catSources.slice(i, i + CONCURRENCY);

          await Promise.allSettled(batch.map(async ({ source }) => {
            try {
              const currentSource = await Source.findOne({ id: source.id });
              if (!currentSource || !currentSource.is_active) {
                completed++;
                return;
              }
              // Load this source's tenant context so analysis uses the tenant's own
              // keywords/settings/AI context (content is already tagged by source.tenant_id).
              const tenantCtx = source.tenant_id
                ? await require('./pipeline/tenantContextService').getContext(source.tenant_id)
                : null;
              await scanSourceOnce(source, { context: tenantCtx });
              completed++;
            } catch (err) {
              failed++;
              completed++;
              console.warn(`[Monitor:${platform}:${cat}] Error scanning ${source.display_name || source.identifier}: ${err.message}`);
            }
          }));

          if (completed % 25 === 0 || i + CONCURRENCY >= catSources.length) {
            console.log(`[Monitor:${platform}:${cat}] Progress: ${completed}/${catSources.length} (${failed} failed)`);
          }

          if ((platform === 'x' || platform === 'instagram' || platform === 'facebook') && i + CONCURRENCY < catSources.length) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // Mark THIS category done immediately after finishing it
        state.lastCategoryScannedAt[cat] = Date.now();
        console.log(`[Monitor:${platform}:${cat}] DONE: ${catSources.length} sources (${failed} failed)`);
      }

      const elapsed = ((Date.now() - loopStartedAt) / 1000).toFixed(1);
      console.log(`[Monitor:${platform}] Cycle COMPLETE: ${dueCategories.join(', ')} (${elapsed}s)`);

      // Compute next check: find the soonest category that will be due
      let soonest = Infinity;
      for (const cat of CATEGORIES) {
        const intervalMs = (frequencies[cat] || 60) * 60 * 1000;
        const lastScanned = state.lastCategoryScannedAt[cat] || 0;
        const nextDue = lastScanned + intervalMs - Date.now();
        if (nextDue < soonest) soonest = nextDue;
      }
      nextCheckSeconds = Math.max(30, Math.floor(soonest / 1000));

    } catch (error) {
      console.error(`[Monitor:${platform}] Cycle error: ${error.message}`);
      nextCheckSeconds = 60;
    } finally {
      state.running = false;
      console.log(`[Monitor:${platform}] Next check in ${(nextCheckSeconds / 60).toFixed(2)} min`);
      setTimeout(() => runPlatformLoop(platform), nextCheckSeconds * 1000);
    }
  };

  // ─── Housekeeping Loop (events + media backfill, independent of platforms) ─
  const runHousekeepingLoop = async () => {
    try {
      await autoArchiveEndedEvents();
      const settings = await Settings.findOne({ id: 'global_settings' });
      const activeEvents = await getActiveEvents();

      const eventsEnabled = settings?.api_config?.events?.enabled !== false;
      for (const event of activeEvents) {
        if (!eventsEnabled) break;
        // Use per-event override, or compute from the event's selected platforms
        let pollMinutes = event.polling_interval_minutes;
        if (!pollMinutes) {
          const evtPlatforms = event.platforms && event.platforms.length > 0
            ? event.platforms
            : ['x', 'instagram', 'facebook', 'youtube'];
          const intervals = evtPlatforms.map(p => settings?.api_config?.events?.[p] || 60);
          pollMinutes = Math.min(...intervals);
        }
        if (!shouldPollEvent(event, pollMinutes)) continue;
        await scanEventOnce({ event, settings });
      }

      // A media-backfill trigger stood here, gated on RAPIDAPI_KEY. The backfill it
      // drove was removed with the S3 archival pipeline, leaving a branch whose only
      // effect was to move its own timestamp — and whose condition read a key X no
      // longer uses. This loop is itself never launched (see startMonitoring).

    } catch (err) {
      console.error(`[Monitor:housekeeping] Error: ${err.message}`);
    } finally {
      setTimeout(runHousekeepingLoop, 5 * 60 * 1000); // Every 5 minutes
    }
  };

  // ─── Per-tenant monitoring via the tenant scheduler ─────────────────────
  // The legacy global per-platform `runPlatformLoop`/`runHousekeepingLoop`
  // helpers defined above depended on a single `global_settings` doc (which no
  // longer exists in the multi-tenant model) and are intentionally NOT launched.
  // Monitoring now runs once per active tenant per tick — each tenant scanning
  // its OWN sources with its OWN settings/keywords — bounded by the tenant worker
  // pool (TENANT_CONCURRENCY) and the Ollama semaphore inside the analysis path.
  // The per-tenant job (monitorTenant) preserves per-platform/per-category
  // frequency throttling.
  const intervalMs = Math.max(30000, (Number(process.env.MONITOR_INTERVAL_MIN) || 1) * 60 * 1000);
  const jobTimeoutMs = Number(process.env.TENANT_JOB_TIMEOUT_MS) || 30 * 60 * 1000;
  scheduleTenantPipeline({
    name: 'monitor',
    intervalMs,
    startDelayMs: 15000,
    jobFn: monitorTenant,
    timeoutMs: jobTimeoutMs,
  });

  // Events run as a peer pipeline, not a step inside monitorTenant — the two tick
  // independently, so event fetching starts right away instead of waiting for the
  // source sweep. Its own start delay keeps the two from opening every gateway
  // connection in the same instant on boot.
  const eventIntervalMs = Math.max(30000, (Number(process.env.EVENT_INTERVAL_MIN) || 5) * 60 * 1000);
  scheduleTenantPipeline({
    name: 'event',
    intervalMs: eventIntervalMs,
    startDelayMs: 20000,
    jobFn: eventScanTenant,
    timeoutMs: jobTimeoutMs,
  });

  // Sentiment analysis: every tick starts each active tenant's run, which claims
  // pending monitored-source content and comments and sends them to the service
  // through the shared dispatcher; kick() starts a tenant early after ingest.
  // Not in the tenant worker pool — see sentiment.scheduler.
  sentiment.startScheduler({
    intervalMs: Math.max(10000, Number(process.env.SENTIMENT_POLL_MS) || 30000),
    startDelayMs: 10000,
  });

  startAuxMonitorTasks();
  console.log(`[Monitor] Tenant-aware monitoring started (tick=${(intervalMs / 60000).toFixed(1)}m, tenant-concurrency=${process.env.TENANT_CONCURRENCY || 3})`);
};

module.exports = {
  startMonitoring,
  monitorTenant,
  eventScanTenant,
  rescanContent,
  scanSourceOnce,
  __private: {
    monitorXSource,
    monitorInstagramSource,
  }
};
