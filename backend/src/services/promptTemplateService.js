/**
 * promptTemplateService (POLICE)
 * ─────────────────────────────────────────────────────────────────────
 * Single source of truth for the police LLM analysis prompt. Holds the DEFAULT
 * classification template and renders it with runtime variables. A tenant can
 * override the prompt from the Super Admin (Tenant.ai_config.classification_prompt);
 * when set, that template is used instead of the default.
 *
 * Placeholders use {{NAME}}. They are runtime/data values injected per request:
 *   • {{CATEGORIES}}            — the tenant's allowed moderation categories (one per line)
 *   • {{CATEGORY_DEFINITIONS}}  — optional per-category definitions (may be blank)
 *   • {{CONTENT}}               — the post text being analysed
 * In the Super Admin editor these are shown as labelled placeholders (the parts
 * injected automatically at runtime). KEEP {{CONTENT}} and the JSON output block so
 * analysis stays accurate.
 */

const render = (template, vars = {}) => {
  if (!template || typeof template !== 'string') return '';
  let out = template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = vars[key];
    return (v === undefined || v === null) ? m : String(v); // leave unknown placeholders intact
  });
  // Safety net: if a custom template forgot the {{CONTENT}} placeholder, still append
  // the post text so the model has something to analyse.
  if (!/\{\{\s*CONTENT\s*\}\}/.test(template) && vars.CONTENT) {
    out += `\n\n────────────────────────\nTEXT TO ANALYZE:\n<<<\n${vars.CONTENT}\n>>>\n`;
  }
  return out;
};

// ── DEFAULT: police classification (moderation category + intent + sentiment + risk) ──
// Functionally identical to the previously-hardcoded prompt, just parameterised.
const DEFAULT_CLASSIFICATION_TEMPLATE = `You are a multilingual Indian social-media risk classifier.
Return only strict JSON with keys: category, intent, sentiment, risk_score, reasoning.

Allowed categories:
{{CATEGORIES}}

Rules:
- Pick exactly one category from allowed list (use Normal for harmless/neutral content).
- sentiment must be one of: positive, neutral, negative.
- risk_score must be integer 0-100.
- intent must be short (2-8 words).
- reasoning must be concise (1-2 lines) explaining risk/target/context.
- Handle transliterated Indian language correctly.

────────────────────────
TEXT TO ANALYZE:
<<<
{{CONTENT}}
>>>
`;

/**
 * Return the DEFAULT prompt(s) for a tenant, ready to show in the editor. The police
 * classification template has no tenant-config placeholders (no politician/party), so
 * the runtime placeholders ({{CATEGORIES}}, {{CATEGORY_DEFINITIONS}}, {{CONTENT}}) are
 * kept intact as labelled auto-injected parts.
 * @returns {{ classification_prompt: string }}
 */
const getDefaultPrompts = (/* tenantContext */) => {
  return { classification_prompt: DEFAULT_CLASSIFICATION_TEMPLATE };
};

module.exports = {
  render,
  getDefaultPrompts,
  DEFAULT_CLASSIFICATION_TEMPLATE,
};
