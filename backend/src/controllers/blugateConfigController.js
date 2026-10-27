/**
 * A tenant's BluGate credentials — read and write.
 *
 * Reached only through the Super Admin service-key routes, because these are
 * provisioned centrally: BluGate issues one API key and client code per tenant,
 * and an operator enters them here. The tenant application never edits its own.
 *
 * Every handler runs with the tenant's database already in scope (the :tenantId
 * router param establishes it), so the record is read and written in that
 * tenant's own database.
 *
 * Credentials go in encrypted and never come back out: responses carry only
 * "is it set" / "is it readable" booleans. That keeps keys out of browsers,
 * proxy logs and network tabs, where they would otherwise sit in plain text.
 */

const BlugateConfig = require('../models/BlugateConfig');
const { PLATFORMS } = require('../services/blugate/blugate.endpoints');
const { encryptSecret, decryptSecret } = require('../utils/platformSecrets');
const blugate = require('../services/blugate');

const SLUGS = Object.keys(PLATFORMS);

/** The wire shape: platform flags plus whether each credential is set/readable. */
const present = (row) => {
  const platforms = SLUGS.map((slug) => ({
    slug,
    label: PLATFORMS[slug].label,
    enabled: row ? row.platforms?.[slug] !== false : false,
  }));

  if (!row) {
    return {
      configured: false,
      is_active: false,
      base_url: '',
      blugate_api_key_set: false,
      client_code_set: false,
      blugate_api_key_invalid: false,
      client_code_invalid: false,
      platforms,
    };
  }

  const keyReadable = Boolean(decryptSecret(row.blugate_api_key));
  const codeReadable = Boolean(decryptSecret(row.client_code));

  return {
    configured: keyReadable && codeReadable && row.is_active !== false,
    is_active: row.is_active !== false,
    base_url: row.base_url || '',
    blugate_api_key_set: Boolean(row.blugate_api_key),
    client_code_set: Boolean(row.client_code),
    // Distinguishes "never configured" from "configured but unreadable" — which
    // otherwise look identical and send someone hunting the wrong problem.
    blugate_api_key_invalid: Boolean(row.blugate_api_key) && !keyReadable,
    client_code_invalid: Boolean(row.client_code) && !codeReadable,
    platforms,
    updated_at: row.updated_at,
  };
};

const blugateConfigController = {
  /** GET /blugate — the tenant's credential state. Never the credentials. */
  get: async (req, res) => {
    try {
      const row = await BlugateConfig.findOne({ tenant_id: req.tenantId }).lean();
      res.json({ ok: true, blugate: present(row) });
    } catch (error) {
      console.error('[blugateConfig.get]', error.message);
      res.status(error.status || 500).json({ message: error.message });
    }
  },

  /**
   * PUT /blugate — create or update the tenant's credentials.
   *
   * Blank credential fields are left untouched rather than cleared: the UI never
   * receives the stored values back, so it cannot echo them, and treating "" as
   * "erase" would wipe a working key whenever someone toggled a platform.
   * Clearing is done explicitly via DELETE.
   */
  upsert: async (req, res) => {
    try {
      const { blugate_api_key, client_code, base_url, is_active, platforms } = req.body || {};

      const set = { tenant_id: req.tenantId, updated_at: new Date() };
      if (typeof base_url === 'string') set.base_url = base_url.trim();
      if (typeof is_active === 'boolean') set.is_active = is_active;

      const apiKey = String(blugate_api_key || '').trim();
      const code = String(client_code || '').trim();
      if (apiKey) set.blugate_api_key = encryptSecret(apiKey);
      if (code) set.client_code = encryptSecret(code);

      // Only accept flags for platforms this backend actually supports, so a
      // stray key in the payload cannot add a field the gateway knows nothing about.
      if (platforms && typeof platforms === 'object') {
        for (const slug of SLUGS) {
          if (typeof platforms[slug] === 'boolean') set[`platforms.${slug}`] = platforms[slug];
        }
      }

      const row = await BlugateConfig.findOneAndUpdate(
        { tenant_id: req.tenantId },
        { $set: set, $setOnInsert: { created_at: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      // Credentials are cached briefly per tenant; drop that copy so a rotated
      // key takes effect on the very next call rather than after the TTL.
      blugate.invalidate(req.tenantId);

      res.json({ ok: true, blugate: present(row) });
    } catch (error) {
      console.error('[blugateConfig.upsert]', error.message);
      res.status(error.status || 500).json({ message: error.message });
    }
  },

  /**
   * DELETE /blugate — remove the tenant's credentials entirely.
   *
   * All monitoring then fails closed with a "not configured" error, which is the
   * intended outcome — there is no environment fallback to quietly take over.
   */
  remove: async (req, res) => {
    try {
      await BlugateConfig.deleteOne({ tenant_id: req.tenantId });
      blugate.invalidate(req.tenantId);
      res.json({ ok: true, message: 'BluGate credentials removed' });
    } catch (error) {
      console.error('[blugateConfig.remove]', error.message);
      res.status(error.status || 500).json({ message: error.message });
    }
  },

  /**
   * POST /blugate/test/:slug — verify the stored credentials against the live
   * gateway for one platform.
   *
   * Without this, a wrong key is only discovered by a monitoring cycle failing
   * quietly hours later. Each platform uses a cheap, read-only endpoint with a
   * well-known argument, so the check costs one call and changes nothing.
   */
  test: async (req, res) => {
    const { slug } = req.params;
    try {
      if (!SLUGS.includes(slug)) {
        return res.status(400).json({ message: `Invalid platform "${slug}". Valid: ${SLUGS.join(', ')}` });
      }

      const probes = {
        x: ['USER_BY_NAME', { username: 'x' }],
        instagram: ['USER_INFO', { username: 'instagram' }],
        facebook: ['PAGE_DETAILS', { url: 'https://www.facebook.com/facebook' }],
        youtube: ['SEARCH', { part: 'snippet', q: 'test', maxResults: 1, type: 'video' }],
      };

      const [endpointKey, params] = probes[slug];
      const started = Date.now();
      await blugate.call(slug, endpointKey, params, { timeout: 20000 });

      res.json({
        ok: true,
        platform: slug,
        endpoint: endpointKey,
        ms: Date.now() - started,
        message: `${PLATFORMS[slug].label} is working`,
      });
    } catch (error) {
      // A failed probe is a valid answer, not a server fault — report what the
      // gateway said so the operator can tell a bad key from an outage.
      console.error('[blugateConfig.test]', error.message);
      res.status(200).json({
        ok: false,
        platform: slug,
        status: error.status || null,
        rate_limited: Boolean(error.isRateLimited),
        auth_failed: Boolean(error.isAuthFailure),
        message: error.message,
      });
    }
  },
};

module.exports = blugateConfigController;
