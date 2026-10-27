const axios = require('axios');
const TempContent = require('../models/TempContent');
const Source = require('../models/Source');
const Content = require('../models/Content');
const Settings = require('../models/Settings');
const Keyword = require('../models/Keyword');
const Tenant = require('../models/Tenant');
const { performFullAnalysis } = require('./monitorService');
const { isPerTenant } = require('../config/tenantConnections');
const { forEachTenant } = require('../config/tenantContext');

const BATCH_SIZE = Number(process.env.ENGINE_TEMP_BATCH_SIZE || 40);
const POLL_MS = Number(process.env.ENGINE_TEMP_POLL_MS || 30000);
const PROCESS_CONCURRENCY = Math.max(1, Number(process.env.ENGINE_TEMP_CONCURRENCY || 4));
const FAST_DRAIN = String(process.env.ENGINE_TEMP_FAST_DRAIN || 'true').toLowerCase() === 'true';
const PROCESSING_TIMEOUT_MS = Math.max(60000, Number(process.env.ENGINE_TEMP_PROCESSING_TIMEOUT_MS || 15 * 60 * 1000));
const INDEPENDENT_MODULES = ['profile', 'event', 'grievance'];
const MODULE_BATCH_SIZE = Math.max(1, Number(process.env.ENGINE_TEMP_BATCH_SIZE_PER_MODULE || BATCH_SIZE));
const ONPREM_HEALTH_TIMEOUT = 5000;
const isStrictAnalysisMode = () => String(process.env.ANALYSIS_STRICT_LLM_MODE || 'true').toLowerCase() === 'true';

let running = false;
let timer = null;
let lastCycleBacklogLikely = false;
let onPremReachable = null; // null = unknown, true/false = cached result
let onPremCheckedAt = 0;
const ONPREM_CHECK_INTERVAL = 60000; // re-check every 60s

/**
 * Lightweight health check: can we reach the on-prem LLM?
 * Cached for 60s to avoid hammering the endpoint.
 */
async function isOnPremReachable() {
  if (Date.now() - onPremCheckedAt < ONPREM_CHECK_INTERVAL && onPremReachable !== null) {
    return onPremReachable;
  }
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  try {
    await axios.get(baseUrl, { timeout: ONPREM_HEALTH_TIMEOUT });
    onPremReachable = true;
  } catch {
    onPremReachable = false;
  }
  onPremCheckedAt = Date.now();
  return onPremReachable;
}

const toDate = (v) => {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

const asString = (v, fallback = '') => {
  const s = String(v == null ? '' : v).trim();
  return s || fallback;
};

const normalizeHandle = (v) => asString(v).replace(/^@/, '').toLowerCase();

async function resolveSource(item) {
  if (item.source_id) {
    const byId = await Source.findOne({ id: item.source_id }).lean();
    if (byId) return byId;
  }

  const identifier = normalizeHandle(item.source_identifier);
  if (!identifier) return null;

  return await Source.findOne({
    platform: item.platform,
    identifier: { $in: [identifier, `@${identifier}`] }
  }).lean();
}

function normalizeIncoming(item, source) {
  const raw = item.raw_data || {};
  const platform = item.platform;

  const normalizeInstagramRaw = (value) => {
    if (!value || typeof value !== 'object') return {};
    if (value.node && typeof value.node === 'object') return value.node;
    if (Array.isArray(value.items) && value.items.length > 0 && value.items[0] && typeof value.items[0] === 'object') {
      return value.items[0];
    }
    if (value.data && typeof value.data === 'object') return normalizeInstagramRaw(value.data);
    return value;
  };

  if (platform === 'x') {
    return {
      content_id: asString(raw.id || raw.tweet_id),
      content_url: asString(raw.url || (raw.id ? `https://x.com/i/status/${raw.id}` : '')),
      text: asString(raw.text || raw.full_text),
      media: Array.isArray(raw.media) ? raw.media : [],
      quoted_content: raw.quoted_content || null,
      url_cards: Array.isArray(raw.url_cards) ? raw.url_cards : [],
      author: asString(raw.author_name || source?.display_name || item.source_display_name, source?.display_name || 'Unknown'),
      author_handle: asString(raw.author_handle || source?.identifier || item.source_identifier, source?.identifier || 'unknown'),
      published_at: toDate(raw.created_at),
      engagement: {
        likes: Number(raw?.metrics?.like || raw?.metrics?.likes || 0),
        comments: Number(raw?.metrics?.reply || raw?.metrics?.replies || 0),
        retweets: Number(raw?.metrics?.retweet || raw?.metrics?.retweets || 0),
        views: Number(raw?.metrics?.view || raw?.metrics?.views || 0)
      }
    };
  }

  if (platform === 'instagram') {
    const ig = normalizeInstagramRaw(raw);
    const igCaption = typeof ig.caption === 'string' ? ig.caption : ig.caption?.text;
    const igTakenAt = ig.taken_at || ig.created_at || ig.timestamp;
    return {
      content_id: asString(ig.id || ig.pk || ig.code || ig.shortcode || raw.id || raw.pk || raw.code || raw.shortcode),
      content_url: asString(ig.url || ig.post_url || ig.permalink || raw.url || raw.post_url || raw.permalink || (ig.code ? `https://www.instagram.com/p/${ig.code}/` : '')),
      text: asString(igCaption || ig.text || raw.caption || raw.text),
      media: Array.isArray(ig.media) ? ig.media : (Array.isArray(raw.media) ? raw.media : []),
      author: asString(ig.author_name || ig.username || raw.author_name || raw.username || source?.display_name || item.source_display_name, source?.display_name || 'Unknown'),
      author_handle: asString(ig.author_handle || ig.username || raw.author_handle || raw.username || source?.identifier || item.source_identifier, source?.identifier || 'unknown'),
      published_at: toDate(typeof igTakenAt === 'number' ? igTakenAt * 1000 : igTakenAt),
      engagement: {
        likes: Number(ig.likes || ig.like_count || raw.likes || raw.like_count || 0),
        comments: Number(ig.comments || ig.comment_count || raw.comments || raw.comment_count || 0),
        views: Number(ig.views || ig.play_count || raw.views || raw.play_count || 0)
      }
    };
  }

  if (platform === 'facebook') {
    return {
      content_id: asString(raw.id || raw.post_id),
      content_url: asString(raw.url || raw.post_url || raw.permalink || ''),
      text: asString(raw.text || raw.message),
      media: Array.isArray(raw.media) ? raw.media : [],
      author: asString(raw.author_name || raw.page_name || source?.display_name || item.source_display_name, source?.display_name || 'Unknown'),
      author_handle: asString(raw.author_handle || source?.identifier || item.source_identifier, source?.identifier || 'unknown'),
      published_at: toDate(raw.created_at || raw.timestamp || raw.time),
      engagement: {
        likes: Number(raw.likes || 0),
        comments: Number(raw.comments || 0),
        views: Number(raw.views || 0)
      }
    };
  }

  // youtube
  return {
    content_id: asString(raw.id || raw.videoId),
    content_url: asString(raw.url || (raw.id ? `https://www.youtube.com/watch?v=${raw.id}` : '')),
    text: asString(`${raw.title || ''} ${raw.description || ''}`),
    media: [{ type: 'video', url: asString(raw.url || (raw.id ? `https://www.youtube.com/watch?v=${raw.id}` : '')) }],
    author: asString(raw.channelTitle || source?.display_name || item.source_display_name, source?.display_name || 'Unknown'),
    author_handle: asString(raw.channelId || source?.identifier || item.source_identifier, source?.identifier || 'unknown'),
    published_at: toDate(raw.publishedAt || raw.created_at),
    engagement: {
      likes: Number(raw?.statistics?.likeCount || 0),
      comments: Number(raw?.statistics?.commentCount || 0),
      views: Number(raw?.statistics?.viewCount || 0)
    }
  };
}

async function upsertContent(item, source) {
  const normalized = normalizeIncoming(item, source);
  if (!normalized.content_id) {
    throw new Error('Missing content_id in raw temp item');
  }

  const baseFields = {
    source_id: source?.id || item.source_id || null,
    tenant_id: source?.tenant_id || item.tenant_id || null,
    // Inherit district(s) from the source so district officers only see content
    // fetched from their own monitoring profiles. Source-less content stays [].
    districts: source?.districts || [],
    state: source?.state || '',
    platform: item.platform,
    content_id: normalized.content_id,
    content_url: normalized.content_url || `https://${item.platform}.com`,
    text: normalized.text || '',
    media: normalized.media || [],
    quoted_content: normalized.quoted_content || null,
    url_cards: normalized.url_cards || [],
    author: normalized.author || 'Unknown',
    author_handle: normalizeHandle(normalized.author_handle) || 'unknown',
    published_at: normalized.published_at || new Date(),
    engagement: normalized.engagement || {},
    raw_data: item.raw_data,
    event_ids: item.event_id ? [item.event_id] : []
  };

  // Tenant-scoped dedup: each tenant keeps its own copy of a post even if another
  // tenant monitors the same source/post (content is tenant-partitioned).
  const existing = await Content.findOne({ tenant_id: baseFields.tenant_id, platform: item.platform, content_id: normalized.content_id });
  if (!existing) {
    const created = await Content.create(baseFields);
    return { content: created, shouldAnalyze: true };
  }

  const eventIds = new Set([...(existing.event_ids || []), ...(baseFields.event_ids || [])]);

  const nextMedia = baseFields.media && baseFields.media.length > 0 ? baseFields.media : existing.media;
  const nextQuoted = baseFields.quoted_content || existing.quoted_content;
  const nextCards = baseFields.url_cards && baseFields.url_cards.length > 0 ? baseFields.url_cards : existing.url_cards;
  const nextEngagement = { ...(existing.engagement || {}), ...(baseFields.engagement || {}) };
  const nextRawData = baseFields.raw_data || existing.raw_data;
  const nextEventIds = Array.from(eventIds);

  const hasMeaningfulChange = (
    (baseFields.text || '') !== (existing.text || '') ||
    (baseFields.content_url || '') !== (existing.content_url || '') ||
    JSON.stringify(nextMedia || []) !== JSON.stringify(existing.media || []) ||
    JSON.stringify(nextQuoted || null) !== JSON.stringify(existing.quoted_content || null) ||
    JSON.stringify(nextCards || []) !== JSON.stringify(existing.url_cards || []) ||
    JSON.stringify(nextRawData || null) !== JSON.stringify(existing.raw_data || null) ||
    JSON.stringify(nextEventIds || []) !== JSON.stringify(existing.event_ids || [])
  );

  if (hasMeaningfulChange) {
    existing.text = baseFields.text || existing.text;
    existing.content_url = baseFields.content_url || existing.content_url;
    existing.media = nextMedia;
    existing.quoted_content = nextQuoted;
    existing.url_cards = nextCards;
    existing.engagement = nextEngagement;
    existing.raw_data = nextRawData;
    existing.event_ids = nextEventIds;
    await existing.save();
  }

  return {
    content: existing,
    shouldAnalyze: existing.risk_level == null
  };
}

async function processOneItem(item, settings, keywords) {
  const source = await resolveSource(item);
  const { content, shouldAnalyze } = await upsertContent(item, source);

  if (shouldAnalyze) {
    // Use the content's tenant context for analysis (settings/keywords/AI); fall back to globals.
    const tenantId = content.tenant_id || source?.tenant_id || null;
    let tSettings = settings;
    let tKeywords = keywords;
    let aiContext = null;
    if (tenantId) {
      const ctx = await require('./pipeline/tenantContextService').getContext(tenantId);
      if (ctx) { tSettings = ctx.settings; tKeywords = ctx.keywords; aiContext = ctx.aiContext; }
    }
    await performFullAnalysis(content, tSettings, tKeywords, {
      skipAlert: false,
      requireLLM: isStrictAnalysisMode(),
      tenantContext: aiContext
    });
  }
}

async function markSourceCheckedFromTemp(item) {
  // Grievance/telegram items do not map to the Sources table last_checked semantics.
  if (item.module === 'grievance' || item.module === 'telegram') return;

  const now = new Date();

  if (item.source_id) {
    const byId = await Source.updateOne(
      { id: item.source_id },
      { $set: { last_checked: now } }
    );
    if (byId?.matchedCount) return;
  }

  const identifier = normalizeHandle(item.source_identifier);
  if (!identifier || !item.platform) return;

  await Source.updateOne(
    {
      platform: item.platform,
      identifier: { $in: [identifier, `@${identifier}`] }
    },
    { $set: { last_checked: now } }
  );
}

// Per-cycle cache of each tenant's {settings, keywords} so engine-mode processing
// scopes analysis to the item's OWN tenant — never a global/shared keyword set.
// TTL-bounded so a tenant's settings/keyword changes propagate (and so it stays
// coherent across multiple backend instances) instead of being pinned until restart;
// size-capped so it can't grow without bound as tenant count rises.
const TENANT_CFG_TTL_MS = Math.max(5000, Number(process.env.TEMP_TENANT_CFG_TTL_MS) || 30000);
const TENANT_CFG_MAX = Number(process.env.TEMP_TENANT_CFG_MAX) || 2000;
const tenantCfgCache = new Map(); // tenantId -> { value, expiresAt }
const getTenantCfg = async (tenantId) => {
  if (!tenantId) return { settings: null, keywords: [] };
  const hit = tenantCfgCache.get(tenantId);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  const [settings, keywords] = await Promise.all([
    Settings.findOne({ tenant_id: tenantId, district: '' }),
    Keyword.find({ tenant_id: tenantId, is_active: true })
  ]);
  const cfg = { settings, keywords };
  if (tenantCfgCache.size >= TENANT_CFG_MAX) {
    const oldest = tenantCfgCache.keys().next().value;
    if (oldest !== undefined) tenantCfgCache.delete(oldest);
  }
  tenantCfgCache.set(tenantId, { value: cfg, expiresAt: Date.now() + TENANT_CFG_TTL_MS });
  return cfg;
};

async function processClaimedItem(item) {
  try {
    // Resolve THIS item's tenant config (settings + that tenant's keywords only).
    const tenantId = item.tenant_id || null;
    const { settings, keywords } = await getTenantCfg(tenantId);
    if (!settings) {
      await TempContent.updateOne(
        { _id: item._id },
        { $set: { status: 'done', processed_at: new Date(), error_message: 'no tenant settings — skipped' } }
      );
      return;
    }
    await processOneItem(item, settings, keywords);

    await TempContent.updateOne(
      { _id: item._id },
      { $set: { status: 'done', processed_at: new Date(), error_message: null } }
    );

    await markSourceCheckedFromTemp(item);
  } catch (err) {
    const attempts = (item.attempts || 0) + 1;
    if (String(err?.message || '').includes('Missing content_id in raw temp item')) {
      console.warn(`[TempProcessor] Non-retryable malformed item ${item.platform}:${item._id} — missing content_id even after normalization. Marking done.`);
      await TempContent.updateOne(
        { _id: item._id },
        { $set: { status: 'done', processed_at: new Date(), error_message: err.message || 'malformed temp item: missing content_id' } }
      );
      return;
    }
    console.warn(`[TempProcessor] Attempt ${attempts} failed for ${item.platform}:${(item.raw_data?.id || item._id)}: ${err.message}. Will retry next cycle.`);
    await TempContent.updateOne(
      { _id: item._id },
      { $set: { status: 'failed', error_message: err.message || 'unknown error' } }
    );
  }
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const workers = [];

  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push((async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        await worker(items[current]);
      }
    })());
  }

  await Promise.all(workers);
}

/**
 * One drain pass over the temp queue for whichever tenant is currently in scope.
 * Every model it touches (TempContent, Source, Content, Settings, Keyword) is
 * tenant-scoped, so this must always run inside a tenant context — runCycle()
 * below is what establishes one.
 */
async function runCycleForTenant() {
    // Telegram sync records are control items, not analyzable social posts.
    await TempContent.updateMany(
      { status: 'pending', module: 'telegram' },
      { $set: { status: 'done', processed_at: new Date(), error_message: null } }
    );

    // Per-tenant config is loaded per item inside processClaimedItem (no global
    // settings/keywords). Clear the per-cycle cache so config edits are picked up.
    tenantCfgCache.clear();

    // --- On-Prem Health Gate ---
    // If models are unreachable, items stay in temp DB until models come back.
    const modelsUp = await isOnPremReachable();
    if (!modelsUp && isStrictAnalysisMode()) {
      console.log('[TempProcessor] On-prem models unreachable (strict mode) — items stay in temp DB (will retry next cycle)');
      return 0;
    }
    if (!modelsUp && !isStrictAnalysisMode()) {
      console.log('[TempProcessor] On-prem models unreachable (fallback mode) — proceeding with fallback analysis path');
    }

    // --- Retry failed items indefinitely ---
    // Reset failed items back to pending so they are retried until analysis succeeds.
    await TempContent.updateMany(
      { status: 'failed' },
      { $set: { status: 'pending' } }
    );

    // Recover items stuck in processing state (e.g., process restart/crash mid-item).
    const processingCutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
    await TempContent.updateMany(
      {
        status: 'processing',
        $or: [
          { processing_started_at: { $lt: processingCutoff } },
          { processing_started_at: { $exists: false }, created_at: { $lt: processingCutoff } }
        ]
      },
      {
        $set: {
          status: 'pending',
          error_message: 'recovered stale processing item after timeout'
        }
      }
    );

    // Module-independent batching: each module gets its own quota every cycle.
    // This prevents grievance volume from affecting profile/event monitoring throughput.
    const moduleBatches = await Promise.all(
      INDEPENDENT_MODULES.map(async (moduleName) => {
        const moduleItems = await TempContent.find({ status: 'pending', module: moduleName })
          .sort({ created_at: 1 })
          .limit(MODULE_BATCH_SIZE);
        return { moduleName, items: moduleItems };
      })
    );

    lastCycleBacklogLikely = moduleBatches.some((batch) => batch.items.length >= MODULE_BATCH_SIZE);

    const items = moduleBatches.flatMap((batch) => batch.items);

    if (items.length === 0) return 0;

    const byModule = moduleBatches
      .map((batch) => `${batch.moduleName}:${batch.items.length}`)
      .join(', ');
    console.log(`[TempProcessor] Processing ${items.length} pending temp item(s) [concurrency=${PROCESS_CONCURRENCY}] [${byModule}]`);

    let claimedCount = 0;

    await runWithConcurrency(items, PROCESS_CONCURRENCY, async (item) => {
      const claimed = await TempContent.updateOne(
        { _id: item._id, status: 'pending' },
        { $set: { status: 'processing', processing_started_at: new Date() }, $inc: { attempts: 1 } }
      );

      if (!claimed?.matchedCount) {
        return;
      }

      claimedCount += 1;
      await processClaimedItem(item);
    });

    // Cleanup old done items
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await TempContent.deleteMany({ status: 'done', processed_at: { $lt: cutoff } });
    return claimedCount;
}

/**
 * Drive one drain pass. In shared mode that is a single cycle on the default
 * connection; under per-tenant databases the queue is per tenant, so each active
 * tenant gets its own cycle inside its own context. forEachTenant isolates them:
 * one tenant's failure is logged and the sweep continues.
 */
async function runCycle() {
  if (running) return 0;
  running = true;
  lastCycleBacklogLikely = false;

  try {
    if (!isPerTenant()) return await runCycleForTenant();

    const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } })
      .select('id slug').lean();
    if (tenants.length === 0) return 0;

    let claimed = 0;
    let backlog = false;
    const results = await forEachTenant(tenants, async () => {
      const n = await runCycleForTenant();
      // runCycleForTenant sets the module-level flag for the tenant it just ran;
      // capture it per tenant so one busy tenant still triggers a fast re-drain.
      if (lastCycleBacklogLikely) backlog = true;
      return n;
    });

    for (const r of results) {
      if (r.error) continue;
      claimed += r.value || 0;
    }
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      console.error(`[TempProcessor] ${failed.length}/${tenants.length} tenant(s) failed this cycle`);
    }

    lastCycleBacklogLikely = backlog;
    return claimed;
  } finally {
    running = false;
  }
}

function startTempContentProcessor() {
  if (timer) return;
  console.log(`[TempProcessor] Started (poll every ${Math.floor(POLL_MS / 1000)}s)`);

  const tick = async () => {
    try {
      let claimed = await runCycle();
      while (FAST_DRAIN && claimed > 0 && lastCycleBacklogLikely) {
        claimed = await runCycle();
      }
    } catch (err) {
      console.error(`[TempProcessor] cycle error: ${err.message}`);
    }
  };

  tick();
  timer = setInterval(tick, POLL_MS);
}

module.exports = {
  startTempContentProcessor,
  runCycle
};
