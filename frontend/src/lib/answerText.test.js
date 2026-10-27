/**
 * What survives the strip, and what must not.
 *
 * The backend answers a multi-part question with a labelled section per part.
 * Every body under those labels is rendered properly elsewhere on the page —
 * the count in the header, the breakdown as a table — so the strip removes
 * them, and what it leaves is what the officer reads under "Details".
 */

import { answerProse, leadAnswer, countScope } from './answerText';

// A real multi-part answer: "how many negative posts are there against the
// telangana police and what are most repetitive items".
const MULTI_PART = [
    'Count',
    '716 matching record(s) — all time [E1].',
    'Distribution',
    '716 matching record(s) — all time [E2].',
    'By topics: murder (86), women_safety (46), protest (39) [E3].',
].join('\n');

describe('answerProse', () => {
    it('leaves no section heading standing on its own', () => {
        // Every body here is rendered by the count header and the table, so
        // the labels were all that reached "Details" — the word "Count" above
        // the word "Distribution" and nothing else.
        const out = answerProse(MULTI_PART, { panels: ['table'] });
        expect(out).toBe('');
    });

    it('keeps a heading that still has something under it', () => {
        const text = ['Count', '716 matching record(s) — all time [E1].',
            'Distribution', 'Something only this text says.'].join('\n');
        const out = answerProse(text, { panels: [] });
        expect(out).toContain('Distribution');
        expect(out).toContain('Something only this text says.');
        // "Count" lost its body to the count-line filter, so it goes too.
        expect(out.startsWith('Count')).toBe(false);
    });

    it('still drops the record dump', () => {
        const text = 'A sentence.\n1. @handle · x · 2026-09-21: a post body';
        expect(answerProse(text)).toBe('A sentence.');
    });
});

describe('countScope', () => {
    it('reads the period the count actually covers', () => {
        expect(countScope(MULTI_PART)).toBe('all time');
        expect(countScope('716 matching record(s) in the last 7 day(s).')).toBe('last 7 days');
    });
});

describe('leadAnswer', () => {
    it("leads with the model's reading when there is one", () => {
        const r = { interpretation: 'The scope contains 716 matching records [E1].',
            answer: MULTI_PART };
        expect(leadAnswer(r)).toEqual({
            text: 'The scope contains 716 matching records.', source: 'ai' });
    });

    it('falls back to the template rather than inventing filler', () => {
        expect(leadAnswer({ answer: MULTI_PART }, { panels: ['table'] })).toBeNull();
    });
});
