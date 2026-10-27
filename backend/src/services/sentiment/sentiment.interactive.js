/**
 * Synchronous analysis for an officer waiting on screen (investigations).
 *
 * Same service, contract and mapping as the pipeline, dispatched in the 'live'
 * lane so it goes ahead of background work. Throws on failure — never returns
 * an invented verdict.
 */

const tenantContextService = require('../pipeline/tenantContextService');
const { getSettingsForDistricts } = require('../settingsResolver');
const { analyzeItems } = require('./sentiment.analyzer');

const MAX_TRIES = 3;
// Kept under the investigation queue's job timeout (INVESTIGATION_QUEUE_JOB_TIMEOUT_MS, 180s).
const interactiveBudgetMs = () => Number(process.env.SENTIMENT_INTERACTIVE_BUDGET_MS) || 150000;

class AnalysisUnavailableError extends Error {
  constructor(message, { kind = 'unavailable', retryAfterS = null } = {}) {
    super(message);
    this.name = 'AnalysisUnavailableError';
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }
}

/**
 * @param {string} text
 * @param {{tenantId: string, districts?: string[]|null, platform?: string}} opts
 * @returns {Promise<object>} the mapped result (see sentiment.mapper)
 */
const analyzeText = async (text, { tenantId, districts = null, platform = 'x' } = {}) => {
  if (!tenantId) throw new Error('analyzeText requires a tenantId');
  const scope = Array.isArray(districts) ? districts.filter(Boolean) : [];
  const ctx = await tenantContextService.getContext(tenantId);

  // The officer is waiting: a busy or briefly unavailable service is retried
  // while the time budget allows; a failure caused by the post itself is not.
  const deadline = Date.now() + interactiveBudgetMs();
  let outcome = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const outcomes = await analyzeItems([{ ref: 'interactive', text, districts: scope, platform }], {
      tenantId,
      keywords: ctx?.keywords || [],
      tenantName: ctx?.name || ctx?.slug,
      priority: 'live',
      resolveSettings: (d) => getSettingsForDistricts(tenantId, d),
      timeoutMs: Number(process.env.SENTIMENT_INTERACTIVE_TIMEOUT_MS) || undefined,
    });
    outcome = outcomes.get('interactive');
    if (outcome?.status === 'ok') return outcome.mapped;
    if (outcome?.status === 'skipped') {
      throw new AnalysisUnavailableError('Text too short or empty', { kind: 'skipped' });
    }

    const waitMs = Math.min(15000, (outcome?.retryAfterS || 5) * 1000);
    const retryable = outcome && !outcome.countsAttempt;
    if (!retryable || attempt === MAX_TRIES || Date.now() + waitMs + 20000 > deadline) break;
    console.warn(`[Sentiment] investigation attempt ${attempt} failed (${outcome.reason}); retrying in ${waitMs / 1000}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new AnalysisUnavailableError(outcome?.reason || 'Sentiment analysis unavailable', {
    kind: outcome?.kind,
    retryAfterS: outcome?.retryAfterS,
  });
};

module.exports = { analyzeText, AnalysisUnavailableError };
