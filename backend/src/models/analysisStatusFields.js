/**
 * Sentiment-analysis work-tracking fields, shared by every analysed collection
 * (Content, Grievance, Comment) so the pipeline treats them identically.
 *
 *   pending     waiting to be claimed (new documents start here)
 *   processing  claimed by a worker; analysis_claim_token identifies the claim
 *   done        analysed and stored
 *   failed      the post itself failed SENTIMENT_MAX_ATTEMPTS times (outages never fail a post)
 *   skipped     nothing analysable (empty/too-short text)
 */

const ANALYSIS_STATUSES = ['pending', 'processing', 'done', 'failed', 'skipped'];

const analysisStatusFields = {
  analysis_status: { type: String, enum: ANALYSIS_STATUSES, default: 'pending' },
  analysis_attempts: { type: Number, default: 0 },   // failures caused by the post itself
  analysis_retries: { type: Number, default: 0 },    // service busy/down retries (never give up)
  analysis_error: { type: String, default: null },
  analysis_claim_token: { type: String, default: null },
  analysis_claimed_at: { type: Date, default: null },
  analysis_next_attempt_at: { type: Date, default: null },
  analyzed_at: { type: Date, default: null },
};

/** Indexes the claim and reaper queries rely on. */
const applyAnalysisStatusIndexes = (schema) => {
  schema.index({ tenant_id: 1, analysis_status: 1, analysis_next_attempt_at: 1, created_at: -1 });
  schema.index({ analysis_claim_token: 1 }, { sparse: true });
  schema.index({ analysis_status: 1, analysis_claimed_at: 1 });
};

module.exports = { ANALYSIS_STATUSES, analysisStatusFields, applyAnalysisStatusIndexes };
