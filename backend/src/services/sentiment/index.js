/**
 * Sentiment analysis — the only way this backend analyses content.
 *
 *   const sentiment = require('../services/sentiment');
 *   sentiment.kick();                                  // after ingesting content/comments
 *   const r = await sentiment.analyzeText(text, { tenantId, districts, platform });   // investigation
 *
 * New Content and Comment documents start as analysis_status='pending'.
 * The per-tenant pipeline claims them and sends each post to the sentiment service
 * through one shared, fair dispatcher.
 */

const { runTenant, kick } = require('./sentiment.pipeline');
const { startScheduler } = require('./sentiment.scheduler');
const { analyzeText, AnalysisUnavailableError } = require('./sentiment.interactive');
const dispatcher = require('./sentiment.dispatcher');
const http = require('./sentiment.http');

/** Dispatcher state plus service reachability, for health and Command Center. */
const getStatus = async () => {
  let service;
  try {
    const health = await http.getHealth();
    service = {
      reachable: true,
      healthy: health?.healthy === true,
      device: health?.device || null,
      intelligence: health?.intelligence?.reachable === true,
    };
  } catch (err) {
    service = { reachable: false, error: err.message };
  }
  return { service, dispatcher: dispatcher.stats() };
};

module.exports = {
  runTenant,
  kick,
  startScheduler,
  analyzeText,
  AnalysisUnavailableError,
  getStatus,
  dispatcherStats: dispatcher.stats,
};
