const fs = require('fs');
const path = require('path');
const PolicyMapping = require('../models/PolicyMapping');
const Tenant = require('../models/Tenant');
const { isPerTenant } = require('../config/tenantConnections');
const { forEachTenant } = require('../config/tenantContext');
const { containsTerm } = require('./sentiment/sentiment.keywords');

/**
 * Deterministic Mapping Engine
 * Resolves legal sections and platform policies based on category.
 * Now dynamic: Fetches from MongoDB (cached).
 */
class MappingService {
    constructor() {
        // Tenant-scoped cache: tenant_id -> [category_mappings]. Each police tenant
        // owns its own set of policy/section mappings; nothing is shared across tenants.
        this.byTenant = new Map();
        this.isLoaded = false;
        this.loadFailed = false;          // true only when the DB was never reachable
        this.fallbackCategories = [];     // global file fallback, used ONLY if DB load fails entirely

        // Initial load. This runs at require time, which can be before the database
        // connection is up — so a failure here is expected rather than fatal. Retry
        // on a short timer until one load succeeds, otherwise the first successful
        // read would be up to a full refresh interval away with an empty cache.
        this.loadMappings().then(() => { if (this.loadFailed) this.scheduleStartupRetry(); });

        // Refresh cache every 5 minutes (optional, can be triggered manually too)
        setInterval(() => this.loadMappings(), 5 * 60 * 1000);
    }

    /**
     * Retry the initial load every 10s until one succeeds, then stop. Bounded so a
     * genuinely unreachable database does not retry forever.
     */
    scheduleStartupRetry(attempt = 1) {
        if (attempt > 12) return; // ~2 minutes, then leave it to the 5-minute refresh
        setTimeout(async () => {
            await this.loadMappings();
            if (this.loadFailed) this.scheduleStartupRetry(attempt + 1);
        }, 10000).unref?.();
    }

    /** Normalize one PolicyMapping document into the cached shape. */
    static shape(m) {
        return {
            category_id: m.category_id,
            definition: m.definition,
            severity_level: m.severity_level || 'Medium',
            // Kept so analysis can apply a district's policies only to that
            // district's content. Empty = tenant-wide policy.
            districts: m.districts || [],
            keywords: m.keywords || [],
            country: 'IN', // Default
            legal_sections: m.legal_sections,
            platform_policies: m.platform_policies instanceof Map ?
                Object.fromEntries(m.platform_policies) : (m.platform_policies || {}) // Handle Mongoose Map
        };
    }

    async loadMappings() {
        try {
            // tenant_id -> [category_mappings]; never merged across tenants.
            const map = new Map();
            const collect = (rows, tenantId) => {
                for (const m of rows) {
                    // In per-tenant mode the owning tenant is the database we just read
                    // from, which is authoritative even for rows that predate tenant_id.
                    const tid = tenantId || m.tenant_id;
                    if (!tid) continue; // un-tenanted row in shared mode — would leak
                    if (!map.has(tid)) map.set(tid, []);
                    map.get(tid).push(MappingService.shape(m));
                }
            };

            let total = 0;
            if (isPerTenant()) {
                // Each tenant's mappings live in that tenant's own database, so no
                // single query can see them all. Sweep the active tenants and read
                // each one inside its own context — a bare PolicyMapping.find() here
                // has no tenant in scope and tenantModel refuses to resolve it.
                const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } })
                    .select('id slug').lean();
                const results = await forEachTenant(tenants, async () => {
                    const rows = await PolicyMapping.find({ is_active: true });
                    return rows;
                });
                for (const r of results) {
                    if (r.error || !r.value) continue;
                    collect(r.value, r.tenantId);
                    total += r.value.length;
                }
                const failed = results.filter((r) => r.error);
                if (failed.length) {
                    console.warn(`[MappingService] ${failed.length}/${tenants.length} tenant(s) failed to load: ` +
                        failed.slice(0, 3).map((f) => `${f.tenantId}: ${f.error}`).join('; '));
                }
            } else {
                const rows = await PolicyMapping.find({ is_active: true });
                collect(rows);
                total = rows.length;
            }

            this.byTenant = map;
            this.isLoaded = true;
            this.loadFailed = false;
            console.log(`[MappingService] Loaded ${total} category mappings across ${map.size} tenant(s).`);
        } catch (error) {
            console.error('[MappingService] Error loading mapping data from DB:', error.message);
            // Fallback to file only if the DB was never reachable (startup resilience).
            // Keep the previous per-tenant cache if a periodic refresh fails.
            if (!this.isLoaded) {
                this.loadFailed = true;
                this.loadFallbackFile();
            }
        }
    }

    async waitForLoad() {
        if (this.isLoaded) return;
        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (this.isLoaded) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);
        });
    }

    loadFallbackFile() {
        try {
            const dataPath = path.join(__dirname, '../config/mapping_data.json');
            const rawData = fs.readFileSync(dataPath, 'utf8');
            const parsed = JSON.parse(rawData);
            this.fallbackCategories = parsed.category_mappings || [];
            console.log(`[MappingService] Loaded ${this.fallbackCategories.length} fallback categories from file (DB unavailable).`);
            this.isLoaded = true;
        } catch (e) { console.error("Fallback load failed", e.message); }
    }

    /**
     * Return the category mappings for ONE tenant. The global file fallback is only
     * used when the DB was never reachable (startup), never to borrow another tenant's
     * config.
     * @param {string} tenantId
     * @returns {Array} category_mappings for that tenant ([] if none)
     */
    /**
     * @param {string} tenantId
     * @param {string[]} [districts] - when provided, restricts to policies that apply
     *   to those districts: a policy with NO districts is tenant-wide and always
     *   applies; one WITH districts only applies to those. Omit (default) to get
     *   every policy in the tenant — keeps existing callers behaving as before.
     */
    getTenantCategories(tenantId, districts = null) {
        let list = null;
        if (tenantId && this.byTenant.has(tenantId)) list = this.byTenant.get(tenantId);
        // The file fallback is ONE global config. Handing it to a tenant is only
        // defensible when every tenant shares a database anyway; under per-tenant
        // databases it would serve one tenant's neighbours a config none of them
        // configured, which is the cross-tenant mixing this cache exists to avoid.
        else if (this.loadFailed && !isPerTenant()) list = this.fallbackCategories;
        else {
            if (!tenantId) console.warn('[MappingService] getTenantCategories called without tenantId — returning empty (no cross-tenant fallback).');
            return [];
        }

        const wanted = Array.isArray(districts) ? districts.filter(Boolean) : null;
        if (!wanted || wanted.length === 0) return list;

        return list.filter((m) => {
            const md = Array.isArray(m.districts) ? m.districts.filter(Boolean) : [];
            if (md.length === 0) return true; // tenant-wide policy
            return md.some((d) => wanted.includes(d));
        });
    }

    // Method to force refresh (e.g., after Admin API update). Reloads every tenant.
    async forceRefresh() {
        console.log("[MappingService] Force refreshing mappings...");
        await this.loadMappings();
    }

    /**
     * Resolve legal and policy violations for a given category, scoped to a tenant.
     * @param {string} category - The detected category (e.g., "Hate_Speech")
     * @param {string} text - The input text to extract keywords from.
     * @param {string} platform - The source platform (e.g., "x", "youtube")
     * @param {string} country - The target country (default: "IN")
     * @param {string} tenantId - The tenant whose mappings to use (REQUIRED for isolation)
     * @returns {object} { legal_sections: [], platform_policies: [], triggered_keywords: [] }
     */
    resolveMapping(category, text, platform = 'x', country = 'IN', tenantId = null, districts = null) {
        const platformKey = String(platform || 'x').toLowerCase() === 'twitter' ? 'x' : String(platform || 'x').toLowerCase();

        // Find mapping for category and country WITHIN this tenant's mappings only,
        // further restricted to the content's district(s) when provided.
        const categories = this.getTenantCategories(tenantId, districts);
        const mapping = this.findMapping(categories, category, country);

        const result = {
            category_id: mapping?.category_id || this.normalizeCategoryId(categories, category) || null,
            legal_sections: [],
            platform_policies: [],
            triggered_keywords: []
        };

        if (mapping) {
            result.legal_sections = (mapping.legal_sections || []).map(s => ({
                act: country === 'IN' ? 'BNS 2023' : 'International Law',
                section: s.code,
                description: s.title
            }));

            // Handle both Map object and plain object in case of different load states
            const policiesMap = mapping.platform_policies || {};
            const policies = policiesMap[platformKey] || [];

            result.platform_policies = policies.map(p => ({
                policy_id: p.id,
                policy_name: p.name,
                platform: platformKey
            }));
        } else if (category && categories.length) {
            console.warn(`[MappingService] No mapping found for category: ${category} (tenant: ${tenantId || 'none'}, country: ${country})`);
        }

        // Keywords come from this tenant's own policy for the category — no global list.
        result.triggered_keywords = this.extractKeywords(text, mapping ? mapping.keywords : []);

        return result;
    }

    /**
     * "Hate Speech" / "hate_speech" -> the tenant's own category_id ("Hate_Speech").
     * Unknown labels are returned in the same underscore shape.
     */
    normalizeCategoryId(categories, category) {
        const raw = String(category || '').trim();
        if (!raw) return '';
        const collapsed = raw.replace(/[\s-]+/g, '_');
        const hit = (categories || []).find((m) => String(m.category_id).toLowerCase() === collapsed.toLowerCase());
        if (hit) return hit.category_id;
        return collapsed
            .split('_')
            .filter(Boolean)
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
            .join('_');
    }

    findMapping(categories, category, country = 'IN') {
        const id = this.normalizeCategoryId(categories, category).toLowerCase();
        if (!id) return null;
        const same = (m) => String(m.category_id).toLowerCase() === id;
        return (categories || []).find((m) => same(m) && (m.country || 'IN') === country)
            || (categories || []).find(same)
            || null;
    }

    /** Best non-Normal category by policy keywords found in the text, or null. */
    inferCategoryFromText(categories, text) {
        const hay = String(text || '').toLowerCase();
        if (!hay.trim()) return null;
        let best = null;
        let bestScore = 0;
        for (const m of categories || []) {
            const id = String(m.category_id || '');
            if (!id || /^normal$/i.test(id)) continue;
            let score = 0;
            for (const kw of Array.isArray(m.keywords) ? m.keywords : []) {
                const term = String(kw || '').toLowerCase().trim();
                if (term.length >= 2 && containsTerm(hay, term)) score += Math.min(40, 8 + term.length);
            }
            if (score > bestScore) {
                bestScore = score;
                best = id;
            }
        }
        return bestScore > 0 ? best : null;
    }

    /**
     * Mapping for an analysed post: the service's category, or — when it says
     * Normal/Unknown — the category inferred from this tenant's policy keywords.
     * @returns {object} { category_id, legal_sections, platform_policies, triggered_keywords }
     */
    resolveForAnalysis({ category, text, platform = 'x', country = 'IN', tenantId = null, districts = null } = {}) {
        const categories = this.getTenantCategories(tenantId, districts);
        let cat = this.normalizeCategoryId(categories, category);
        if (!cat || /^(normal|unknown|neutral)$/i.test(cat)) {
            const inferred = this.inferCategoryFromText(categories, text);
            if (inferred) cat = inferred;
        }
        return this.resolveMapping(cat, text, platform, country, tenantId, districts);
    }

    /** Policy keywords present in the text (case-insensitive), sorted. */
    extractKeywords(text, keywords = []) {
        if (!text || !Array.isArray(keywords) || keywords.length === 0) return [];
        const text_norm = String(text).toLowerCase();
        const found = new Set();
        for (const kw of keywords) {
            const term = String(kw || '').trim();
            if (term && containsTerm(text_norm, term)) found.add(term);
        }
        return Array.from(found).sort();
    }
}

module.exports = new MappingService();
