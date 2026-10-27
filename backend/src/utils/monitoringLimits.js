// Per-officer monitoring VOLUME limits — shared logic for storage resolution,
// input sanitisation, and enforcement.
//
// A State Admin caps, per District Officer:
//   • the number of ACTIVE monitoring profiles (Sources) per platform,
//   • the number of actively-monitored MANUAL events,
//   • the number of keywords per manual event.
// Officers may STAGE unlimited profiles (paused); only the capped number may be
// active (fetching) — which is the real API-quota lever.
//
// Enforcement applies ONLY to District Officers (role 'level-1'). State Admins
// and superadmins are fully exempt, consistent with every other gate.

const { withTenant } = require('./tenantFilter');

// Canonical Source platform keys (must match Source.js's enum exactly — note
// 'x', never 'twitter', which would fail Mongoose enum validation).
const PLATFORMS = ['x', 'instagram', 'facebook', 'youtube'];

// The officer's OWN assigned-district filter for an enforcement COUNT — built
// directly from req.user.districts, deliberately NOT scopedDistrictQuery.
// scopedDistrictQuery honours the client-supplied X-District-Filter header,
// which would let an officer narrow the count to a single district and thus
// under-count (activating `limit` per district instead of `limit` total). This
// basis is header-independent and matches reconcileActiveToLimits, so the
// activation gate, the usage meter, and reconcile all measure the same pool.
const officerDistrictFilter = (req) => {
  const districts = (req.user && req.user.districts ? req.user.districts : []).filter(Boolean);
  if (!districts.length) return { districts: '__none__' }; // fail closed
  return { districts: { $in: districts } };
};

// System defaults, applied when a limit is unset (null/undefined) — so existing
// and un-configured officers keep working with generous headroom rather than a
// hard cap of 0. Chosen with the State Admin: 100 active profiles per platform,
// 10 active manual events, 50 keywords per manual event.
const DEFAULT_LIMITS = Object.freeze({
  per_platform: Object.freeze({ x: 100, instagram: 100, facebook: 100, youtube: 100 }),
  max_active_events: 10,
  max_keywords_per_event: 50,
});

// Only District Officers are capped. Admin/superadmin bypass entirely.
const isCappedRole = (role) => role === 'level-1';

// Coerce a single incoming limit value to a non-negative integer, or null
// (null = "use the system default"). Rejects garbage/negatives by treating them
// as unset rather than throwing, so the admin form can't wedge on a bad value.
const coerceLimit = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

// Sanitise an incoming monitoring_limits payload (from the Access Management
// form) into the exact stored shape, dropping unknown keys. Returns null when
// nothing usable was supplied (so we don't write an empty object).
const sanitizeLimitsInput = (input) => {
  if (!input || typeof input !== 'object') return null;
  const pp = input.per_platform && typeof input.per_platform === 'object' ? input.per_platform : {};
  const out = {
    per_platform: {
      x: coerceLimit(pp.x),
      instagram: coerceLimit(pp.instagram),
      facebook: coerceLimit(pp.facebook),
      youtube: coerceLimit(pp.youtube),
    },
    max_active_events: coerceLimit(input.max_active_events),
    max_keywords_per_event: coerceLimit(input.max_keywords_per_event),
  };
  return out;
};

// Merge a user's stored limits with the system defaults → the EFFECTIVE limits
// actually enforced. Any unset field falls back to its default.
const resolveLimits = (user) => {
  const stored = (user && user.monitoring_limits) || {};
  const sp = stored.per_platform || {};
  const pick = (v, d) => (v === null || v === undefined ? d : v);
  return {
    per_platform: {
      x: pick(sp.x, DEFAULT_LIMITS.per_platform.x),
      instagram: pick(sp.instagram, DEFAULT_LIMITS.per_platform.instagram),
      facebook: pick(sp.facebook, DEFAULT_LIMITS.per_platform.facebook),
      youtube: pick(sp.youtube, DEFAULT_LIMITS.per_platform.youtube),
    },
    max_active_events: pick(stored.max_active_events, DEFAULT_LIMITS.max_active_events),
    max_keywords_per_event: pick(stored.max_keywords_per_event, DEFAULT_LIMITS.max_keywords_per_event),
  };
};

const platformLabel = (p) => ({ x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' }[p] || p);

// "1 profile" / "3 profiles"
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Canonicalise a limits object for equality comparison. Treats an all-null
// object as equivalent to null (both mean "no explicit limits set / use
// defaults"), so a form that round-trips blank fields doesn't read as a change.
const canonicalLimits = (ml) => {
  if (!ml || typeof ml !== 'object') return null;
  const pp = ml.per_platform || {};
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const norm = {
    x: n(pp.x), instagram: n(pp.instagram), facebook: n(pp.facebook), youtube: n(pp.youtube),
    max_active_events: n(ml.max_active_events), max_keywords_per_event: n(ml.max_keywords_per_event),
  };
  return Object.values(norm).every((v) => v === null) ? null : norm;
};

// True when two limits values are equivalent (so we only reconcile / rewrite
// when the admin ACTUALLY changed something — an unrelated officer edit that
// merely round-trips the existing limits must NOT trigger auto-pause).
const limitsEqual = (a, b) => JSON.stringify(canonicalLimits(a)) === JSON.stringify(canonicalLimits(b));

/**
 * Gate an officer ABOUT TO ACTIVATE `count` more monitoring profiles of a
 * platform. Counts the officer's currently-active profiles for that platform,
 * scoped to their own district(s), and reports whether the activation fits.
 *
 * Admins/superadmins: always allowed (isCappedRole false).
 *
 * @param {object} req        the authenticated request (officer)
 * @param {Model}  SourceModel the Source mongoose model
 * @param {string} platform   canonical platform key
 * @param {object} [opts]
 * @param {number} [opts.count=1]      how many are being activated in this action
 * @param {string} [opts.excludeId]    a Source `id` to exclude from the count
 *                                     (the one being toggled — not yet active)
 * @returns {Promise<{ok:boolean, limit:number, active:number, message?:string}>}
 */
const checkProfileActivation = async (req, SourceModel, platform, opts = {}) => {
  if (!isCappedRole(req.user && req.user.role)) return { ok: true, limit: Infinity, active: 0 };

  const count = Number.isFinite(opts.count) ? opts.count : 1;
  const limit = resolveLimits(req.user).per_platform[platform];
  // Unknown platform (shouldn't happen) → don't block.
  if (limit === undefined) return { ok: true, limit: Infinity, active: 0 };

  const filter = { ...officerDistrictFilter(req), platform, is_active: true };
  if (opts.excludeId) filter.id = { $ne: opts.excludeId };
  const active = await SourceModel.countDocuments(withTenant(req, filter));

  if (active + count > limit) {
    // A limit of 0 means nothing was allocated for this platform. Telling the
    // officer to "pause one" would be nonsense (there is nothing active), so
    // explain the real cause and who to ask.
    const message = limit === 0
      ? `You are out of your allocated limit. No active ${platformLabel(platform)} profiles are allocated to you, so this profile cannot be activated.`
      : `You are out of your allocated limit for ${platformLabel(platform)}. You are using all ${plural(limit, 'allowed active profile')}. Pause an active ${platformLabel(platform)} profile to free a slot.`;
    return { ok: false, limit, active, message };
  }
  return { ok: true, limit, active };
};

/**
 * Gate an officer ABOUT TO ACTIVATE one more MANUAL event. Counts active
 * manual events (origin 'manual', status 'active') in the officer's district(s).
 * Recurring/non-recurring calendar-origin events are excluded.
 *
 * @returns {Promise<{ok:boolean, limit:number, active:number, message?:string}>}
 */
const checkEventActivation = async (req, EventModel, opts = {}) => {
  if (!isCappedRole(req.user && req.user.role)) return { ok: true, limit: Infinity, active: 0 };

  const limit = resolveLimits(req.user).max_active_events;
  const filter = { ...officerDistrictFilter(req), origin: 'manual', status: 'active' };
  if (opts.excludeId) filter.id = { $ne: opts.excludeId };
  const active = await EventModel.countDocuments(withTenant(req, filter));

  if (active + 1 > limit) {
    // limit 0 = no allocation at all; "pause one" would be misleading because
    // there is nothing active to pause.
    const message = limit === 0
      ? `You are out of your allocated limit. No active events are allocated to you, so this event cannot be activated.`
      : `You are out of your allocated limit. You are using all ${plural(limit, 'allowed active event')}. Pause or archive an active event to free a slot.`;
    return { ok: false, limit, active, message };
  }
  return { ok: true, limit, active };
};

/**
 * Validate that a manual event's keyword count is within the officer's cap.
 * Officers only; admins exempt. Returns {ok:false,message} to 400 on violation.
 */
const checkKeywordCount = (user, keywordCount) => {
  if (!isCappedRole(user && user.role)) return { ok: true };
  const limit = resolveLimits(user).max_keywords_per_event;
  if (keywordCount > limit) {
    const message = limit === 0
      ? `You are out of your allocated limit. No keywords are allocated per event.`
      : `You are out of your allocated limit. This event has ${plural(keywordCount, 'keyword')} but only ${limit} are allowed per event. Remove ${keywordCount - limit} to continue.`;
    return { ok: false, limit, message };
  }
  return { ok: true, limit };
};

/**
 * Reconcile an officer's CURRENTLY-ACTIVE profiles/events down to newly-saved
 * limits — used when a State Admin lowers a cap below what's already active.
 * Pauses the NEWEST excess (keeps older, established items running) so the
 * active count fits the new cap. Keywords are never retroactively trimmed
 * (that would silently lose configured data) — the keyword cap applies only at
 * event create/update time.
 *
 * Runs in the ADMIN's request/tenant context but scopes strictly to the edited
 * OFFICER's own district(s) — never the admin's wider scope, and never another
 * tenant (withTenant enforces the tenant boundary).
 *
 * @param {object} adminReq    the admin's authenticated request (tenant context)
 * @param {object} officerUser the officer User doc being edited (role, districts, monitoring_limits)
 * @returns {Promise<{paused_profiles:number, paused_events:number}>}
 */
const reconcileActiveToLimits = async (adminReq, officerUser) => {
  const result = { paused_profiles: 0, paused_events: 0 };
  if (!isCappedRole(officerUser && officerUser.role)) return result;

  const Source = require('../models/Source');
  const Event = require('../models/Event');
  const limits = resolveLimits(officerUser);
  const districts = (officerUser.districts || []).filter(Boolean);
  // An officer with no districts owns nothing to reconcile.
  if (!districts.length) return result;
  const districtFilter = { districts: { $in: districts } };

  // Profiles — per platform, pause the newest active beyond the cap.
  for (const platform of PLATFORMS) {
    const limit = limits.per_platform[platform];
    const baseFilter = withTenant(adminReq, { ...districtFilter, platform, is_active: true });
    const active = await Source.countDocuments(baseFilter);
    if (active > limit) {
      const excess = active - limit;
      const toPause = await Source.find(baseFilter).sort({ created_at: -1 }).limit(excess).select('id').lean();
      const ids = toPause.map((s) => s.id).filter(Boolean);
      if (ids.length) {
        await Source.updateMany(withTenant(adminReq, { id: { $in: ids } }), { $set: { is_active: false } });
        result.paused_profiles += ids.length;
      }
    }
  }

  // Manual events — pause the newest active beyond the cap (calendar-origin
  // recurring/non-recurring events are excluded).
  const eventLimit = limits.max_active_events;
  const eventFilter = withTenant(adminReq, { ...districtFilter, origin: 'manual', status: 'active' });
  const activeEvents = await Event.countDocuments(eventFilter);
  if (activeEvents > eventLimit) {
    const excess = activeEvents - eventLimit;
    const toPause = await Event.find(eventFilter).sort({ _id: -1 }).limit(excess).select('id').lean();
    const ids = toPause.map((e) => e.id).filter(Boolean);
    if (ids.length) {
      await Event.updateMany(withTenant(adminReq, { id: { $in: ids } }), { $set: { status: 'paused' } });
      result.paused_events += ids.length;
    }
  }

  return result;
};

module.exports = {
  PLATFORMS,
  DEFAULT_LIMITS,
  isCappedRole,
  sanitizeLimitsInput,
  resolveLimits,
  platformLabel,
  officerDistrictFilter,
  limitsEqual,
  checkProfileActivation,
  checkEventActivation,
  checkKeywordCount,
  reconcileActiveToLimits,
};
