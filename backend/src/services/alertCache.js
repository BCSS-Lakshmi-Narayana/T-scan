/**
 * Invalidation for the alert read caches.
 *
 * The alerts list, its stats and the dashboard are cached for 20s. Anything
 * that creates or changes an alert must clear them, or the alert stays
 * invisible until the TTL lapses — which reads as "the alert never fired".
 *
 * It lives here rather than in alertController because the sentiment pipeline
 * is where alerts are actually born, and a service importing a controller
 * invites a require cycle.
 */

const cacheService = require('./cacheService');

const ALERT_CACHE_PREFIXES = [
  'alerts:list:v2',
  'alerts:stats:v2',
  'dashboard:v2',
  'alert_summary',
  'unread_count',
];

/** Never throws: a cold cache is a slow read, not a failed alert. */
const clearAlertCache = async () => {
  try {
    await Promise.all(ALERT_CACHE_PREFIXES.map((p) => cacheService.invalidatePrefix(p)));
  } catch (err) {
    console.warn(`[Alerts] cache invalidation failed: ${err.message}`);
  }
};

module.exports = { clearAlertCache, ALERT_CACHE_PREFIXES };
