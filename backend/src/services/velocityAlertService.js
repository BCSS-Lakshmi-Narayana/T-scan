const Content = require('../models/Content');
const AlertThreshold = require('../models/AlertThreshold');
const Settings = require('../models/Settings');

/**
 * Whether a post is viral: any engagement metric crossed a threshold within the
 * window after posting. Returns virality metadata only — it never changes a
 * post's risk score, risk level or sentiment.
 */
const checkVelocity = async (content, settings) => {
    if (!settings.velocity_alerts_enabled) return null;

    const threshold = await AlertThreshold.findOne({
        tenant_id: content.tenant_id,
        platform: content.platform,
        is_active: true
    });

    if (!threshold) return null;

    const currentEngagement = content.engagement || {};
    const postAge = Date.now() - new Date(content.published_at).getTime();
    const postAgeMinutes = postAge / (1000 * 60);

    // Only check posts that are within the configured time window
    if (postAgeMinutes > threshold.time_window_minutes) return null;

    // Check ALL metrics against the unified threshold
    const metricsToCheck = ['likes', 'retweets', 'comments', 'views'];
    let highestPriority = null;
    let triggeredMetrics = [];

    for (const metric of metricsToCheck) {
        const currentValue = currentEngagement[metric] || 0;

        if (currentValue >= threshold.high_threshold) {
            if (!highestPriority || highestPriority.priority !== 'HIGH') {
                highestPriority = { priority: 'HIGH', thresholdTriggered: threshold.high_threshold };
            }
            triggeredMetrics.push({ metric, value: currentValue, priority: 'HIGH' });
        } else if (currentValue >= threshold.medium_threshold) {
            if (!highestPriority || (highestPriority.priority !== 'HIGH' && highestPriority.priority !== 'MEDIUM')) {
                highestPriority = { priority: 'MEDIUM', thresholdTriggered: threshold.medium_threshold };
            }
            triggeredMetrics.push({ metric, value: currentValue, priority: 'MEDIUM' });
        } else if (currentValue >= threshold.low_threshold) {
            if (!highestPriority) {
                highestPriority = { priority: 'LOW', thresholdTriggered: threshold.low_threshold };
            }
            triggeredMetrics.push({ metric, value: currentValue, priority: 'LOW' });
        }
    }

    if (!highestPriority || triggeredMetrics.length === 0) return null;

    return {
        highestPriority,
        triggeredMetrics,
        threshold,
        postAgeMinutes
    };
};

const updateEngagementHistory = async (contentId, engagement) => {
    try {
        await Content.findOneAndUpdate(
            { id: contentId },
            {
                $push: {
                    engagement_history: {
                        $each: [{
                            timestamp: new Date(),
                            views: engagement.views || 0,
                            likes: engagement.likes || 0,
                            comments: engagement.comments || 0
                        }],
                        $slice: -50
                    }
                }
            }
        );
    } catch (error) {
        console.error(`[ViralAlert] Error updating engagement history: ${error.message}`);
    }
};

const DEFAULT_THRESHOLD_PLATFORMS = ['x', 'instagram', 'facebook', 'youtube'];

// Ensure a tenant has one viral threshold row per platform (idempotent, tenant-scoped).
// Used both at startup (for every active tenant) and lazily when a tenant's
// thresholds are first read. Existing (possibly edited) rows are left untouched.
const ensureTenantThresholds = async (tenantId) => {
    if (!tenantId) return;
    for (const platform of DEFAULT_THRESHOLD_PLATFORMS) {
        await AlertThreshold.findOneAndUpdate(
            { tenant_id: tenantId, platform },
            { $setOnInsert: { tenant_id: tenantId, platform, low_threshold: 100, medium_threshold: 500, high_threshold: 1000, time_window_minutes: 60 } },
            { upsert: true, new: true }
        );
    }
};

// Seed default viral thresholds PER TENANT (each tenant gets its own rows).
const seedDefaultThresholds = async () => {
    try {
        const Tenant = require('../models/Tenant');
        const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] } }).select('id').lean();
        for (const tenant of tenants) {
            await ensureTenantThresholds(tenant.id);
        }
        console.log(`[ViralAlert] Ensured default thresholds for ${tenants.length} tenant(s)`);
    } catch (error) {
        console.error(`[ViralAlert] Error seeding thresholds: ${error.message}`);
    }
};

module.exports = {
    updateEngagementHistory,
    seedDefaultThresholds,
    ensureTenantThresholds,
    checkVelocity
};
