/**
 * Turning the backend's answer string into something an officer reads.
 *
 * The answer arrives as a template that packs four different things into one
 * blob of text: a count, some measured figures, a situation summary, and the
 * matching records flattened into numbered lines.
 *
 *   "4560 matching record(s) in the last 7 day(s). [E43]
 *    4560 in this window against 1962 in the previous one (+132.4%). [E43]
 *    Main subjects: murder (149), women safety (112). [E43]
 *    1. @bjp4india · x · 2026-09-17: Alert: Normal
 *    Author: @BJP4India ..."
 *
 * Every one of those parts is also in the structured response, and the page
 * renders each properly: counts in the evidence header, figures in the trend
 * and comparison panels, themes as chips, records as cards. Printing the text
 * copy as well would say everything twice — once as a wall, once properly.
 *
 * So this strips what another surface renders better, and keeps the sentences
 * that only exist here. Pure string work; no backend change, and nothing is
 * invented.
 */

/** A line the template emitted for one record: "1. @handle · x · date: ...". */
const RECORD_LINE = /^\s*\d{1,3}\.\s/;

/**
 * Evidence markers: "[E43]", "[E5, E6]".
 *
 * These are how the backend ties a sentence to the evidence it came from. They
 * are a debugging aid in prose — an officer cannot look up "E43" — so they come
 * out of the displayed text, and traceability is carried by the evidence
 * section instead, where every record is listed and linkable.
 */
const CITATION = /\s*\[E\d+(?:\s*,\s*E?\d+)*\]/gi;

/**
 * Lines that state a count in the template's own phrasing. The page shows the
 * same numbers in its result header, in words an officer uses, so keeping
 * these would say it twice — and "record(s) checked" is our vocabulary, not
 * theirs.
 */
const COUNT_LINE = [
    /^\s*\d[\d,]*\s+matching record\(s\)/i,
    /^\s*Of\s+\d[\d,]*\s+record\(s\)\s+checked/i,
    /^\s*\d[\d,]*\s+record\(s\).*examined as evidence/i,
    /^\s*\d[\d,]*\s+of\s+\d[\d,]*\s+matching were examined/i,
    /^\s*\d[\d,]*\s+of them examined as evidence/i,
];

/**
 * Lines a measured panel renders with its semantic label attached.
 *
 * The prose says "4560 in this window against 1962 in the previous one"; the
 * trend panel says the same thing under "Monitored post volume / Current
 * period / Previous period / Change". The panel is the better rendering, so
 * where one is on screen the sentence is dropped rather than repeated.
 */
const PANEL_LINE = {
    situation: [
        /^\s*Main subjects:/i,
        /^\s*Most records are in\b/i,
        /^\s*Accounts appearing repeatedly:/i,
        /^\s*\d[\d,]*\s+related record\(s\)\s+share\b/i,
    ],
    trend: [/^\s*\d[\d,]*\s+in (?:this window|the last\b)[^\n]*\bagainst\b/i],
    comparison: [/^\s*[^:\n]+:\s*\d[\d,]*\s+vs\s+[^:\n]+:\s*\d/i],
    table: [
        /^\s*By\s+[\w ]+:/i,
        // "2665 record(s) are rated high risk." restates the risk_level
        // grouping that the table renders properly.
        /^\s*\d[\d,]*\s+record\(s\)\s+are\s+rated\b/i,
    ],
};

/** Strip the evidence markers out of a line of prose. */
export function stripCitations(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(CITATION, '').replace(/[ \t]+([.,;:])/g, '$1').trim();
}

/**
 * The prose worth showing: the assistant's own sentences.
 *
 * The backend appends the record dump last and returns, so the first numbered
 * line begins it and nothing after it is prose. A post's own text may contain
 * blank lines, so a blank line cannot be read as the end of a record — doing
 * that let fragments of real posts ("T [E6]") leak out as if the assistant
 * had written them.
 *
 * `panels` names the measured surfaces already on screen, so their sentences
 * can be dropped. With none named nothing extra is removed, which is what a
 * caller that only wants the record dump gone gets by default.
 */
export function answerProse(answer, { panels = [] } = {}) {
    if (!answer || typeof answer !== 'string') return '';
    const lines = answer.split('\n');
    let cut = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
        if (RECORD_LINE.test(lines[i])) { cut = i; break; }
    }
    const covered = panels.flatMap((p) => PANEL_LINE[p] || []);
    const kept = lines.slice(0, cut)
        .filter((l) => !COUNT_LINE.some((re) => re.test(l)))
        .filter((l) => !covered.some((re) => re.test(l)))
        .map(stripCitations)
        .filter((l) => l.trim() !== '');
    return dropEmptySections(kept).join('\n').trim();
}

/**
 * A multi-part answer labels each part — "Count", "Distribution" — and those
 * labels are lines of the same string as the bodies under them.
 *
 * Every body is also rendered properly elsewhere on the page, so by the time
 * the filters above are done the labels are all that is left, and "Details"
 * showed the word "Count" above the word "Distribution" and nothing else. A
 * heading with nothing under it is not information; it reads like an answer
 * that failed to load.
 */
const SECTION_HEADING = /^(Count|Distribution|Findings|Matching records|Matching activity|What is being discussed|Change over time|Side by side|Classification)$/i;

export function dropEmptySections(lines) {
    return lines.filter((l, i) => {
        if (!SECTION_HEADING.test(l.trim())) return true;
        const next = lines[i + 1];
        return next !== undefined && !SECTION_HEADING.test(next.trim());
    });
}

/** True when the answer carried a record dump, i.e. cards should replace it. */
export function hasRecordList(answer) {
    if (!answer || typeof answer !== 'string') return false;
    return answer.split('\n').some((l) => RECORD_LINE.test(l));
}

/**
 * The sentences that answer the question, and where they came from.
 *
 * The template opens with counts, not with an answer, so on its own it buries
 * what was asked. When the model produced a reading of the same evidence — and
 * it survived the backend's claim check — that is the part that actually
 * answers, so it leads, labelled as written by the model. Otherwise the
 * template's own sentences lead, and if there are none the answer is the
 * evidence itself and nothing is invented to fill the space.
 */
export function leadAnswer(response, { panels = [] } = {}) {
    // A finished deep analysis read hundreds of records; its briefing is a
    // better answer than one written over the handful retrieval returned.
    const deep = stripCitations(response?.analysis?.summary || '');
    if (deep) return { text: deep, source: 'ai' };
    const ai = stripCitations(response?.interpretation || '');
    if (ai) return { text: ai, source: 'ai' };
    const prose = answerProse(response?.answer, { panels });
    return prose ? { text: prose, source: 'template' } : null;
}

/**
 * What the template says that nothing else on the page covers.
 *
 * Returns nothing when the lead already IS the template prose, so the same
 * sentences are never printed twice in one answer.
 */
export function supportingProse(response, { panels = [] } = {}) {
    if (!response?.interpretation) return '';
    return answerProse(response?.answer, { panels });
}

/**
 * The period the count covers, in the template's own words.
 *
 * "4241 matching record(s) — all time" and "4132 matching record(s) in the
 * last 7 day(s)" mean very different things, and the header's own window is
 * the officer's *setting*, not necessarily what this answer measured.
 */
export function countScope(answer) {
    const m = String(answer || '').match(
        /matching record\(s\)\s*(?:[—-]\s*)?(all time|in the last (\d+) day\(s\))/i);
    if (!m) return null;
    return m[2] ? `last ${m[2]} days` : 'all time';
}

/**
 * The answer to "how many", as a figure rather than a sentence.
 *
 * A count question whose answer is a number should show that number. Without
 * this, "How many high risk posts are there in Hyderabad?" rendered as a
 * one-row table labelled with a database field, and the officer had to read
 * "By risk_level / high / 4,241" to learn the answer was 4,241.
 */
export function countHeadline(response) {
    const fact = (response?.facts || []).find(
        (f) => f && f.type === 'aggregate' && typeof f.total === 'number');
    if (!fact) return null;
    return {
        total: fact.total,
        measure: fact.measure || 'matching records',
        scope: countScope(response?.answer),
    };
}

/**
 * The three populations an answer has, kept apart.
 *
 * Taken from the structured response, never parsed out of the prose.
 *
 * `matching` is what the filters select, `analysed` is what a model actually
 * READ, `displayed` is what is on screen. The backend now sends all three; the
 * fallbacks below only exist for answers produced before it did.
 *
 * The word "examined" is deliberately not used anywhere: it was the single
 * word that let 20 displayed records be reported as though 4,669 had been
 * looked at, and it means nothing precise to an officer.
 */
export function resultCounts(response, shown) {
    // A malformed payload must not take the page down: a null entry here
    // crashed the whole answer, evidence and prose alike.
    const evidence = (response?.evidence || []).filter(Boolean);
    const records = evidence.filter((e) => e.type === 'record' || e.type === 'verdict');
    const pops = response?.populations || {};
    const totalFact = (response?.facts || []).find(
        (f) => f.type === 'aggregate' && typeof f.total === 'number');
    const matching = typeof pops.matching === 'number' ? pops.matching
        : (totalFact ? totalFact.total : null);
    const displayed = typeof shown === 'number'
        ? Math.min(shown, records.length) : records.length;
    return {
        matching,
        analysed: typeof pops.analysed === 'number' ? pops.analysed : 0,
        displayed,
        // Only worth saying when the population is genuinely wider than what
        // is on screen; otherwise it reads as though something was withheld.
        partial: typeof matching === 'number' && matching > displayed,
    };
}

/** "4,669 matching · 192 analysed · 20 key evidence" — never one blended number. */
export function populationsText({ matching, analysed, displayed }, stage = 'final') {
    const n = (v) => Number(v || 0).toLocaleString();
    const parts = [];
    if (typeof matching === 'number') parts.push(`${n(matching)} matching`);
    if (analysed > 0) parts.push(`${n(analysed)} analysed`);
    if (displayed > 0) {
        parts.push(`${n(displayed)} ${stage === 'final' && analysed > 0
            ? 'key evidence' : 'initial evidence'}`);
    }
    return parts.join(' · ');
}

/** The heading over the evidence, which must not overstate how it was chosen. */
export function evidenceHeading(stage, analysed) {
    return stage === 'final' && analysed > 0 ? 'Key evidence' : 'Initial evidence';
}

/** One line saying what was reused rather than read again. */
export function reuseText({ reused, fresh }) {
    if (!reused) return '';
    const n = (v) => Number(v || 0).toLocaleString();
    return fresh
        ? `${n(reused)} previously analysed records reused, ${n(fresh)} newly analysed.`
        : `${n(reused)} previously analysed records reused.`;
}
