/**
 * Alert for analysed content (soceye's createAlertFromCatalogPost).
 *
 *   - only monitored-source posts alert (event/search content has no source)
 *   - every analysed monitored post gets an alert, low risk / Normal included
 *   - one alert per post: re-analysis updates it (workflow status is kept)
 *   - virality shows the Viral badge (alert_type 'velocity') but never changes risk
 */

const Alert = require('../../models/Alert');
const Source = require('../../models/Source');
const { checkVelocity, updateEngagementHistory } = require('../velocityAlertService');
const { sendAlertEmail } = require('../emailService');
const { clearAlertCache } = require('../alertCache');

const QUIET_INTENTS = ['Neutral', 'Unknown', 'Normal', 'Monitor'];

const buildDescription = (mapped) => (mapped.reasons.length
  ? `**Analysis:**\n${mapped.reasons.map((r) => `• ${r}`).join('\n')}`
  : 'Post analyzed via sentiment API.');

/**
 * Raise or refresh the alert for one analysed content document.
 * Runs in the content's tenant scope.
 * @returns {Promise<{created: boolean, updated?: boolean, reason?: string, alertId?: string}>}
 */
const raiseContentAlert = async (content, mapped, { analysisId, settings }) => {
  if (!content.source_id) return { created: false, reason: 'no source (event/search content)' };

  const intent = mapped.intent || mapped.category || 'Monitor';
  const intentStr = intent && !QUIET_INTENTS.includes(intent) ? `${intent} - ` : '';
  const author = content.author || content.author_handle || 'Unknown';

  const analysisData = {
    analysis_id: analysisId,
    risk_level: mapped.risk_level,
    title: `${mapped.risk_level.toUpperCase()} Risk: ${intentStr}${author}`,
    description: buildDescription(mapped),
    classification_explanation: mapped.explanation || '',
    threat_details: {
      intent: mapped.intent,
      reasons: mapped.reasons,
      highlights: mapped.highlights,
      risk_score: mapped.risk_score,
      violated_policies: mapped.violated_policies,
      legal_sections: mapped.legal_sections,
    },
    violated_policies: mapped.violated_policies,
    legal_sections: mapped.legal_sections,
    llm_analysis: mapped.llm_analysis,
    matched_keywords_normalized: mapped.highlights.map((k) => String(k).trim().toLowerCase()).filter(Boolean),
  };
  const baseType = mapped.highlights.length ? 'keyword_risk' : 'ai_risk';

  const existing = await Alert.findOne({ tenant_id: content.tenant_id, content_id: content.id }).select('id alert_type').lean();
  if (existing) {
    await Alert.updateOne(
      { tenant_id: content.tenant_id, id: existing.id },
      { $set: { ...analysisData, alert_type: existing.alert_type === 'velocity' ? 'velocity' : baseType } },
    );
    // The list is cached for 20s; without this the refreshed risk sits behind
    // a stale read and the alert looks unchanged.
    await clearAlertCache();
    return { created: false, updated: true, alertId: existing.id };
  }

  const velocity = settings ? await checkVelocity(content, settings).catch(() => null) : null;
  const source = await Source.findOne({ tenant_id: content.tenant_id, id: content.source_id }).select('id category').lean();

  const alert = await Alert.create({
    ...analysisData,
    tenant_id: content.tenant_id,
    source_id: content.source_id,
    source_category: source?.category || null,
    content_id: content.id,
    content_ref_id: content.id,
    content_published_at: content.published_at || new Date(),
    alert_type: velocity ? 'velocity' : baseType,
    priority: velocity?.highestPriority?.priority || 'LOW',
    velocity_data: velocity ? {
      metric: velocity.triggeredMetrics.map((m) => m.metric).join(', '),
      current_value: Math.max(...velocity.triggeredMetrics.map((m) => m.value)),
      previous_value: 0,
      velocity: Math.max(...velocity.triggeredMetrics.map((m) => m.value)),
      time_window_minutes: velocity.threshold.time_window_minutes,
      threshold_triggered: velocity.highestPriority.thresholdTriggered,
      post_age_minutes: Math.round(velocity.postAgeMinutes),
      triggered_metrics: velocity.triggeredMetrics,
    } : undefined,
    content_url: content.content_url,
    platform: content.platform,
    author,
    author_handle: content.author_handle,
  });

  // Before the email, so the alert is visible the moment anyone looks.
  await clearAlertCache();

  if (settings?.enable_email_alerts && settings.alert_emails?.length) {
    sendAlertEmail(settings.smtp_config, settings.alert_emails, {
      risk_level: mapped.risk_level,
      platform: content.platform,
      author,
      content_url: content.content_url,
      description: analysisData.description,
      triggered_keywords: mapped.highlights,
      created_at: alert.created_at,
    }).catch((err) => console.warn(`[Sentiment] alert email failed: ${err.message}`));
  }

  if (content.engagement) {
    updateEngagementHistory(content.id, content.engagement).catch(() => {});
  }

  return { created: true, alertId: alert.id };
};

module.exports = { raiseContentAlert };
