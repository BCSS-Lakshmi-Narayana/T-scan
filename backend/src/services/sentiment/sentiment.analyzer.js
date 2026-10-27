/**
 * Analyzes posts belonging to ONE tenant, one post per service request (as soceye).
 *
 * Each request goes through the shared dispatcher, bucketed by tenant::district,
 * so tenants and districts take turns. No database access here — callers own
 * claiming and storage.
 *
 * Every input ref gets exactly one outcome:
 *   { status: 'ok', value, mapped }
 *   { status: 'skipped', reason }                      text too short or empty
 *   { status: 'retry', kind, reason, retryAfterS, countsAttempt }
 */

const http = require('./sentiment.http');
const contract = require('./sentiment.contract');
const dispatcher = require('./sentiment.dispatcher');
const { buildPolicyPack, districtSignature } = require('./sentiment.policyPack');
const { matchKeywords } = require('./sentiment.keywords');
const { mapResult } = require('./sentiment.mapper');

const MIN_TEXT_CHARS = 3;

// Links carry no language to analyse, and a post can be mostly links: grievances
// forwarded to a police page routinely open with 1-2 KB of share URLs before the
// complaint itself. Sent as-is they crowd out the text and the service fails on
// them, so they are dropped before the text is measured and sent.
const URL_RE = /https?:\/\/\S+|\bwww\.\S+/gi;
const stripUrls = (text) => String(text || '').replace(URL_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();

// Matched keywords sent per post for the model's in-context judgement. Keep low while the
// service's VLLM_MAX_TOKENS is small (256 cuts the answer off at 2+ keywords).
const maxMatchedKeywords = () => {
  const n = Number(process.env.SENTIMENT_MAX_MATCHED_KEYWORDS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
};

// Only failures caused by the post itself spend an attempt. Busy, down or
// misconfigured service: the post is retried until the service recovers.
const POST_FAILURES = new Set(['item_unusable', 'rejected', 'invalid']);

const retryOutcome = (err) => {
  const kind = err.kind || 'unavailable';
  return {
    status: 'retry',
    kind,
    reason: err.message,
    retryAfterS: err.retryAfterS || null,
    countsAttempt: POST_FAILURES.has(kind),
  };
};

/**
 * @param {Array<{ref: string, text: string, districts?: string[], platform?: string}>} items
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {Array} [opts.keywords]                       tenant keywords (with districts)
 * @param {string} [opts.tenantName]                    tenant display name, sent as prompt context
 * @param {(districts: string[]) => Promise<object|null>} [opts.resolveSettings]
 * @param {'live'|'routine'|'bulk'} [opts.priority]
 * @param {(ref: string) => Promise<void>|void} [opts.onDispatchStart] called when a request leaves the queue
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Map<string, object>>}
 */
const analyzeItems = async (items, opts) => {
  const { tenantId, tenantName = null, keywords = [], resolveSettings = null, priority = 'routine', onDispatchStart = null, timeoutMs } = opts;
  if (!tenantId) throw new Error('analyzeItems requires a tenantId');

  const outcomes = new Map();

  const analyzeOne = async (item) => {
    const text = stripUrls(item.text);
    if (text.length < MIN_TEXT_CHARS) {
      outcomes.set(item.ref, { status: 'skipped', reason: 'text too short or empty (links only)' });
      return;
    }
    const districts = Array.isArray(item.districts) ? item.districts.filter(Boolean) : [];
    const matched = matchKeywords(text, keywords, districts);

    const request = (sendKeywords) => dispatcher.run(async () => {
      if (onDispatchStart) await onDispatchStart(item.ref);
      const body = contract.buildRequest({
        text,
        policyPack: buildPolicyPack(tenantId, districts.length ? districts : null),
        matchedKeywords: sendKeywords,
        // Fair-queue key at the service: unique per tenant, never shown to the model.
        tenantKey: `police:${tenantId}`,
        tenantName,
        timeoutS: http.timeoutMs(timeoutMs) / 1000 - 5,
      });
      return http.postIntelligence(body, { timeoutMs });
    }, { key: `${tenantId}::${districtSignature(districts)}`, priority });

    try {
      // All matches are shown on the alert; only the first few are sent for in-context judgement.
      const sent = matched.slice(0, maxMatchedKeywords());
      let normalized = contract.normalizeItem((await request(sent))?.results?.[0]);
      // Each keyword judgement lengthens the model's answer; a response cut short by the
      // service's token limit comes back source=error. Retry once without keywords.
      if (!normalized.ok && normalized.kind === 'unavailable' && sent.length) {
        normalized = contract.normalizeItem((await request([]))?.results?.[0]);
      }
      if (!normalized.ok) {
        outcomes.set(item.ref, retryOutcome({ kind: normalized.kind, message: normalized.reason }));
        return;
      }
      const settings = resolveSettings ? await Promise.resolve(resolveSettings(districts)).catch(() => null) : null;
      const mapped = mapResult(normalized.value, {
        tenantId, districts, text, platform: item.platform, matched, settings,
      });
      outcomes.set(item.ref, { status: 'ok', value: normalized.value, mapped, settings });
    } catch (err) {
      outcomes.set(item.ref, retryOutcome(err));
    }
  };

  await Promise.all(items.map(analyzeOne));
  return outcomes;
};

module.exports = { analyzeItems, stripUrls, MIN_TEXT_CHARS };
