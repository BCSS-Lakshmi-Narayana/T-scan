/**
 * The single outbound path to the sentiment service.
 *
 * No other module calls the service or knows its URL. The service holds no
 * tenant state — everything tenant-specific travels in the request body.
 */

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 180000;

/** Error kinds let callers decide retry policy without parsing messages. */
class SentimentServiceError extends Error {
  constructor(message, { status = null, kind = 'unavailable', retryAfterS = null } = {}) {
    super(message);
    this.name = 'SentimentServiceError';
    this.status = status;
    // backpressure: service busy, retry later without counting an attempt
    // unavailable:  outage or timeout, retry with backoff
    // item_unusable: the service could not produce usable output for this post
    // rejected:     request is wrong, retrying will not help
    // config:       this backend is not configured to reach the service
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }

  get isBackpressure() {
    return this.kind === 'backpressure';
  }
}

const baseUrl = () => String(process.env.SENTIMENT_SERVICE_URL || '').trim().replace(/\/+$/, '');

const requireBaseUrl = () => {
  const url = baseUrl();
  if (!url) {
    throw new SentimentServiceError('SENTIMENT_SERVICE_URL is not configured', { kind: 'config' });
  }
  return url;
};

const timeoutMs = (override) => {
  const n = Number(override || process.env.SENTIMENT_SERVICE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
};

const headers = () => {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // The service does not check a key today; sent so enabling auth there needs no change here.
  const key = String(process.env.SENTIMENT_SERVICE_API_KEY || '').trim();
  if (key) h['x-api-key'] = key;
  return h;
};

// Service 503 reasons that mean one post's output was unusable (see the
// service's pipeline_fallback validation), as opposed to the service being down.
// Per-post fallback failures; the service names its LLM (vLLM now, Ollama in older builds).
const ITEM_FAILURE_RE = /(ollama|vllm|llm) fallback (translation|sentiment|confidence|response|output)|(ollama|vllm|llm) pipeline fallback failed/i;

const retryAfter = (err, fallback) => {
  const n = Number(err.response?.headers?.['retry-after']);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Map an axios failure onto a typed error. */
const toServiceError = (err) => {
  const status = err.response?.status ?? null;
  const detail = err.response?.data?.detail;
  const reason = typeof detail === 'string'
    ? detail
    : detail ? JSON.stringify(detail).slice(0, 300) : err.message;

  if (status === 429) {
    return new SentimentServiceError(`Sentiment service busy (429): ${reason}`,
      { status, kind: 'backpressure', retryAfterS: retryAfter(err, 15) });
  }
  if (status === 503) {
    // 503 when it cannot produce usable output for the post: a content problem, not an outage.
    if (ITEM_FAILURE_RE.test(reason)) {
      return new SentimentServiceError(`Sentiment service could not process this post: ${reason}`,
        { status, kind: 'item_unusable' });
    }
    if (/queue is at capacity/i.test(reason)) {
      return new SentimentServiceError(`Sentiment service busy (503): ${reason}`,
        { status, kind: 'backpressure', retryAfterS: retryAfter(err, 15) });
    }
    return new SentimentServiceError(`Sentiment service unavailable (503): ${reason}`,
      { status, kind: 'unavailable', retryAfterS: retryAfter(err, 30) });
  }
  // Wrong URL or API key: this backend's configuration, not the post.
  if (status === 401 || status === 403 || status === 404) {
    return new SentimentServiceError(`Sentiment service not reachable with this configuration (HTTP ${status}): ${reason}`,
      { status, kind: 'config' });
  }
  if (status && status >= 400 && status < 500) {
    return new SentimentServiceError(`Sentiment service rejected the request (HTTP ${status}): ${reason}`,
      { status, kind: 'rejected' });
  }
  return new SentimentServiceError(
    `Sentiment service unreachable${status ? ` (HTTP ${status})` : ''}: ${reason}`,
    { status, kind: 'unavailable' });
};

/** POST /analyze/intelligence — returns the raw `{ results: [...] }` body. */
const postIntelligence = async (body, options = {}) => {
  const url = requireBaseUrl();
  try {
    const res = await axios.post(`${url}/analyze/intelligence`, body, {
      headers: headers(),
      timeout: timeoutMs(options.timeoutMs),
    });
    return res.data;
  } catch (err) {
    throw toServiceError(err);
  }
};

/** GET /health — returns the body, or throws a typed error. */
const getHealth = async (options = {}) => {
  const url = requireBaseUrl();
  try {
    const res = await axios.get(`${url}/health`, { headers: headers(), timeout: options.timeoutMs || 5000 });
    return res.data;
  } catch (err) {
    throw toServiceError(err);
  }
};

module.exports = {
  SentimentServiceError,
  postIntelligence,
  getHealth,
  timeoutMs,
  toServiceError,
};
