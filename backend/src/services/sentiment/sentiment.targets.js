/**
 * One adapter per analysed collection. The pipeline is generic; each target
 * says what text to send, which districts scope it, and how to store a result.
 */

const { v4: uuidv4 } = require('uuid');
const Content = require('../../models/Content');
const Comment = require('../../models/Comment');
const Grievance = require('../../models/Grievance');
const Analysis = require('../../models/Analysis');
const store = require('./sentiment.store');
const { raiseContentAlert } = require('./sentiment.alerts');
const { buildTextWithTranscript } = require('../mediaTranscriptUtils');

const districtsOf = (doc) => (Array.isArray(doc.districts) ? doc.districts.filter(Boolean) : []);

// Bounded parallelism for text preparation (video transcription is slow).
const mapLimit = async (list, limit, fn) => {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
};

const content = {
  name: 'content',
  Model: Content,
  select: 'id tenant_id text scraped_content media districts platform source_id content_id content_url author author_handle published_at engagement created_at analysis_attempts analysis_retries',
  // Only monitored-source posts are analysed; event (keyword-search) content is fetch-only.
  claimFilter: { source_id: { $exists: true, $nin: [null, ''] } },

  async prepare(docs) {
    return mapLimit(docs, 2, async (doc) => {
      const base = `${doc.text || ''} ${doc.scraped_content || ''}`.trim();
      let text = base;
      try {
        text = await buildTextWithTranscript({
          text: base,
          media: Array.isArray(doc.media) ? doc.media : [],
          transcribeFn: (url) => require('../videoTranscriptionService').transcribeVideoUrl(url),
          tenantId: doc.tenant_id,
        });
      } catch (err) {
        console.warn(`[Sentiment] transcript failed for content ${doc.id}: ${err.message}`);
      }
      return { ref: doc.id, text, districts: districtsOf(doc), platform: doc.platform };
    });
  },

  /** Upsert the one Analysis row, finalise the content, then alert. */
  async persist(doc, token, mapped, { settings }) {
    // Only the current claim holder may write; a superseded worker stops here.
    const owned = await Content.exists({ tenant_id: doc.tenant_id, id: doc.id, analysis_claim_token: token });
    if (!owned) return { stored: false };

    const analysis = await Analysis.findOneAndUpdate(
      { tenant_id: doc.tenant_id, content_id: doc.id },
      {
        $set: { ...mapped.analysisFields, districts: districtsOf(doc) },
        $setOnInsert: { id: uuidv4() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select('id').lean();

    const stored = await store.markDone(Content, doc.tenant_id, token, doc.id, mapped.contentFields);
    if (!stored) return { stored: false };

    await raiseContentAlert(doc, mapped, { analysisId: analysis.id, settings })
      .catch((err) => console.warn(`[Sentiment] alert failed for content ${doc.id}: ${err.message}`));
    return { stored: true };
  },
};

const comment = {
  name: 'comment',
  Model: Comment,
  select: 'id tenant_id text content_id created_at analysis_attempts analysis_retries',

  // Comments carry no districts; they inherit their parent post's.
  async prepare(docs) {
    const parentIds = [...new Set(docs.map((d) => d.content_id).filter(Boolean))];
    const parents = parentIds.length
      ? await Content.find({ id: { $in: parentIds } }).select('id districts').lean()
      : [];
    const districtsById = new Map(parents.map((p) => [p.id, districtsOf(p)]));
    return docs.map((doc) => ({
      ref: doc.id,
      text: doc.text || '',
      districts: districtsById.get(doc.content_id) || [],
      platform: 'youtube',
    }));
  },

  async persist(doc, token, mapped) {
    const stored = await store.markDone(Comment, doc.tenant_id, token, doc.id, {
      sentiment: mapped.sentiment,
      threat_score: mapped.risk_score,
      is_threat: mapped.risk_level !== 'low',
    });
    return { stored };
  },
};

// Facebook stores text-less posts under a placeholder; there is nothing to analyse.
const PLACEHOLDER_TEXT_RE = /^\[(facebook (post|comment) without text|media attachment)\]$/i;

/** Append the quoted / replied-to / thread text, labelled, after the grievance's own text. */
const withContext = (own, parts) => [
  String(own || '').trim(),
  ...parts
    .filter((p) => p.text && String(p.text).trim())
    .map((p) => `[${p.label}]:\n${String(p.text).trim()}`),
].filter(Boolean).join('\n\n');

const grievance = {
  name: 'grievance',
  Model: Grievance,
  select: 'id tenant_id content context districts platform created_at analysis_attempts analysis_retries',
  claimFilter: { is_active: true },

  // A grievance often only tags the police account: the complaint itself is in
  // the post it replies to or quotes, so that text is analysed with it.
  prepare(docs) {
    const postText = (p) => p?.content?.full_text || p?.content?.text || '';
    return docs.map((doc) => {
      const own = String(doc.content?.full_text || doc.content?.text || '').trim();
      const ctx = doc.context || {};
      const chain = Array.isArray(ctx.thread_chain) ? ctx.thread_chain.slice(-2) : [];
      const text = PLACEHOLDER_TEXT_RE.test(own)
        ? ''                       // nothing to analyse -> pipeline marks it skipped
        : withContext(own, [
          { label: 'REPLYING TO', text: postText(ctx.in_reply_to) },
          { label: 'QUOTED POST', text: postText(ctx.quoted) },
          { label: 'THREAD PARENT', text: postText(ctx.thread_parent) },
          ...chain.map((p) => ({ label: 'THREAD', text: postText(p) })),
        ]);
      return { ref: doc.id, text, districts: districtsOf(doc), platform: doc.platform || 'x' };
    });
  },

  /**
   * Stored inline on the grievance, with the SAME mapped block the content
   * pipeline writes to its Analysis document — same fields, same policy
   * mapping, same thresholds. Two deliberate differences:
   *   - no Analysis row: Command Center and analytics aggregate that collection
   *     bare, so a grievance there would be counted as a monitored post;
   *   - no alert: a complaint to the police is not an alert about the public.
   */
  async persist(doc, token, mapped) {
    // Everything the content pipeline stores, written under analysis.* rather
    // than into its own document. Dot-notation so a re-analysis replaces field
    // by field instead of dropping keys a previous run wrote.
    const fields = {};
    for (const [key, value] of Object.entries(mapped.analysisFields)) {
      fields[`analysis.${key}`] = value;
    }

    // Names only grievance readers use (list filters, intelligence dashboard,
    // campaign suggestions). urgency mirrors the risk level because the service
    // has no urgency axis; summary falls back so the card is never blank.
    fields['analysis.urgency'] = mapped.risk_level;
    fields['analysis.keywords'] = mapped.highlights;
    fields['analysis.reasoning'] = mapped.explanation;
    fields['analysis.summary'] = mapped.llm_analysis.summary || mapped.explanation;

    const stored = await store.markDone(Grievance, doc.tenant_id, token, doc.id, fields);
    return { stored };
  },
};

// Order matters: monitored content first, then grievances, then comments.
const TARGETS = [content, grievance, comment];

module.exports = { TARGETS, content, grievance, comment, mapLimit };
