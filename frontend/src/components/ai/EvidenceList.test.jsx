import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import EvidenceList from './EvidenceList';
import { answerProse, hasRecordList, populationsText, resultCounts } from '../../lib/answerText';

global.IS_REACT_ACT_ENVIRONMENT = true;

function render(ui) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    act(() => createRoot(el).render(ui));
    return el;
}

const LONG = 'Hyderabad: Bandlaguda RTO mein rishwat ke ilzamaat, cash ginte hue visuals viral! '
    + 'ACB ne karyavahi shuru ki hai aur jaanch jaari hai. '.repeat(6);

function record(i, over = {}) {
    return {
        id: `E${i + 2}`, type: 'record',
        content: over.content ?? `${LONG} #${i}`,
        url: over.url ?? `https://x.com/user${i}/status/${1000 + i}`,
        timestamp: '2026-09-22T10:00:00',
        districts: ['Hyderabad'],
        facts: {
            handle: `user${i}`, platform: 'x', published_at: '2026-09-22T10:00:00',
            risk_level: 'high', sentiment: 'negative', category: 'Normal',
            topics: ['corruption'], ...(over.facts || {}),
        },
        ...over,
    };
}

const many = (n) => ({
    request_id: 'r', status: 'answered',
    facts: [{ evidence_id: 'E1', type: 'aggregate', total: 54, measure: 'matching records' }],
    evidence: [{ id: 'E1', type: 'aggregate', content: '54 matching record(s)' },
               ...Array.from({ length: n }, (_, i) => record(i))],
});

const buttons = (el) => [...el.querySelectorAll('button')];
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));

// ---------------------------------------------------------------- cards

test('twenty results render as twenty separate cards', () => {
    const el = render(<EvidenceList response={many(20)} />);
    expect(el.querySelectorAll('li').length).toBe(20);
});

test('cards are siblings, not one combined block', () => {
    const el = render(<EvidenceList response={many(5)} />);
    const items = [...el.querySelectorAll('li')];
    expect(items).toHaveLength(5);
    // no card contains another card
    for (const li of items) expect(li.querySelectorAll('li').length).toBe(0);
    // each carries its own numbering
    expect(el.textContent).toContain('01');
    expect(el.textContent).toContain('05');
});

test('a collapsed card shows the source line and a preview, not the whole post', () => {
    const el = render(<EvidenceList response={many(1)} />);
    expect(el.textContent).toContain('@user0');
    expect(el.textContent).toContain('X');
    expect(el.textContent).toContain('22 Sep 2026');
    expect(el.textContent).toContain('…');                    // preview is cut
    expect(el.textContent).not.toContain('Original content');  // full text hidden
});

// ---------------------------------------------------------------- expand

test('View content reveals the full post, and collapses again', () => {
    const el = render(<EvidenceList response={many(1)} />);
    const toggle = buttons(el).find((b) => /View content/.test(b.textContent));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    click(toggle);
    expect(el.textContent).toContain('Original content');
    expect(buttons(el).find((b) => /Show less/.test(b.textContent))).toBeTruthy();

    // Collapsing animates out, so the node lingers for the exit transition.
    // aria-expanded is the state, and is what a screen reader reports.
    click(buttons(el).find((b) => /Show less/.test(b.textContent)));
    expect(buttons(el).find((b) => /View content/.test(b.textContent))
        .getAttribute('aria-expanded')).toBe('false');
});

test('metadata appears only when expanded, and only for fields present', () => {
    const el = render(<EvidenceList response={{
        ...many(0),
        evidence: [record(0, { facts: { handle: 'u', platform: 'x', risk_level: 'high' } })],
    }} />);
    expect(el.textContent).not.toContain('Platform');
    click(buttons(el).find((b) => /View content/.test(b.textContent)));
    expect(el.textContent).toContain('Platform');
    expect(el.textContent).toContain('Risk');
    expect(el.textContent).not.toContain('Sentiment');   // absent from this record
    expect(el.textContent).not.toContain('Category');
});

// ---------------------------------------------------------------- links

test('the source link is the stored url, opened safely', () => {
    const el = render(<EvidenceList response={many(1)} />);
    const a = [...el.querySelectorAll('a')].find((x) => /status/.test(x.getAttribute('href')));
    expect(a.getAttribute('href')).toBe('https://x.com/user0/status/1000');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
});

test('an unsafe url is never rendered as a link', () => {
    const el = render(<EvidenceList response={{
        ...many(0), evidence: [record(0, { url: 'javascript:alert(1)' })],
    }} />);
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => /javascript:/i.test(h))).toBe(false);
    expect(el.textContent).not.toContain('Open source');
});

// ---------------------------------------------------------------- paging

test('only a page of cards mounts, and Show more reveals the next page', () => {
    const el = render(<EvidenceList response={many(54)} />);
    expect(el.querySelectorAll('li').length).toBe(20);
    expect(el.textContent).toContain('Showing 20 of 54');

    click(buttons(el).find((b) => /Show 20 more/.test(b.textContent)));
    expect(el.querySelectorAll('li').length).toBe(40);
    expect(el.textContent).toContain('Showing 40 of 54');
});

test('the three populations are stated apart, never blended into one number', () => {
    const el = render(<EvidenceList response={many(20)} />);
    expect(el.textContent).toContain('54 matching');
    expect(el.textContent).toContain('20 initial evidence');
    // "examined" stood for all three at once and meant none of them precisely
    expect(el.textContent).not.toMatch(/examined/i);
});

test('evidence is "initial" until the deep reading has actually read something', () => {
    const running = render(<EvidenceList response={{
        ...many(3), populations: { matching: 54, analysed: 0, displayed: 3 },
        analysis: { status: 'running', evidence_stage: 'initial' },
    }} />);
    expect(running.textContent).toContain('Initial evidence');
    expect(running.textContent).not.toContain('Key evidence');

    const done = render(<EvidenceList response={{
        ...many(3), populations: { matching: 54, analysed: 192, displayed: 3 },
        analysis: { status: 'done', evidence_stage: 'final' },
    }} />);
    expect(done.textContent).toContain('Key evidence');
    expect(done.textContent).toContain('192 analysed');
});

test('a finished analysis is never reported as "20 of 4,669"', () => {
    // The acceptance criterion: 4,669 matching, 192 analysed, 20 key evidence.
    const el = render(<EvidenceList response={{
        ...many(20), populations: { matching: 4669, analysed: 192, displayed: 20 },
        analysis: { status: 'done', evidence_stage: 'final' },
    }} />);
    const text = el.textContent;
    expect(text).toContain('4,669 matching');
    expect(text).toContain('192 analysed');
    expect(text).toContain('20 key evidence');
    expect(text).not.toMatch(/20 of 4,669/);
});

test('no paging control when everything already fits', () => {
    const el = render(<EvidenceList response={many(3)} />);
    expect(buttons(el).some((b) => /Show \d+ more/.test(b.textContent))).toBe(false);
    expect(el.textContent).not.toContain('Showing');
});

// ---------------------------------------------------------------- edges

test('no records means no evidence section at all', () => {
    const el = render(<EvidenceList response={{ evidence: [{ id: 'E1', type: 'aggregate' }] }} />);
    expect(el.textContent).toBe('');
});

test('malformed evidence does not crash the page', () => {
    const el = render(<EvidenceList response={{
        evidence: [null, { id: 'E2', type: 'record' }, { type: 'record', facts: null }],
    }} />);
    expect(el.textContent).not.toMatch(/undefined|NaN|\[object/);
});

test('long content wraps rather than overflowing', () => {
    const el = render(<EvidenceList response={many(1)} />);
    click(buttons(el).find((b) => /View content/.test(b.textContent)));
    const body = [...el.querySelectorAll('p')].find((p) => p.textContent.includes('Bandlaguda'));
    expect(body.className).toMatch(/break-words/);
    expect(body.className).toMatch(/whitespace-pre-line/);
});

// ---------------------------------------------------------------- prose

test('the duplicated record dump is stripped from the answer text', () => {
    const answer = '4241 matching record(s) — all time [E1].\n'
        + '1. @bjp4india · x · 2026-09-16: Alert: Critique [E2]\n'
        + '2. @other · instagram · 2026-08-25: Alert: Something [E3]';
    expect(hasRecordList(answer)).toBe(true);
    const prose = answerProse(answer);
    expect(prose).not.toContain('1. @bjp4india');
    expect(prose).not.toContain('2. @other');
    expect(prose).not.toContain('matching record(s)');   // the header states this
});

test('debug phrasing never reaches the officer', () => {
    const answer = 'Of 54 record(s) checked: nadustundhi 9 [E1].\n1. @a · x · 2026-09-22: text [E2]';
    expect(answerProse(answer)).not.toMatch(/record\(s\) checked/);
});

test('real prose is kept', () => {
    const answer = '3088 matching record(s) in the last 7 day(s). [E43]\n'
        + 'Main subjects: murder (130), women safety (103). [E43]\n'
        + '1. @a · x · 2026-09-22: text [E2]';
    const prose = answerProse(answer);
    expect(prose).toContain('Main subjects: murder (130)');
    expect(prose).not.toContain('1. @a');
});

test('counts keep matching, analysed and displayed as three separate facts', () => {
    const c = resultCounts({ ...many(20),
        populations: { matching: 4669, analysed: 192, displayed: 20 } }, 20);
    expect(c).toMatchObject({ matching: 4669, analysed: 192, displayed: 20, partial: true });
    expect(populationsText(c, 'final')).toBe('4,669 matching · 192 analysed · 20 key evidence');

    // retrieval alone: nothing has been READ, so analysed stays zero
    const retrieved = resultCounts(many(20), 20);
    expect(retrieved.analysed).toBe(0);
    expect(populationsText(retrieved, 'initial')).toBe('54 matching · 20 initial evidence');
});

test('a blank line inside a post does not leak its text into the prose', () => {
    // Real shape from "Hyderabad lo em nadustundhi?": posts contain blank
    // lines, and treating one as the end of a record leaked "T [E6]".
    const answer = '4560 matching record(s) in the last 7 day(s). [E43]\n'
        + 'Main subjects: murder (149), women safety (112). [E43]\n'
        + '4. @shh_ji20 · x · 2026-09-17: Post: The story of 1948\n'
        + '\n'
        + 'September 17 is celebrated as "Hyderabad Liberation Day." [E5]\n'
        + '5. @aimim_national · x · 2026-09-18: Post: Hyderabad mein\n'
        + '\n'
        + 'T [E6]';
    const prose = answerProse(answer);
    expect(prose).toContain('Main subjects: murder (149)');
    expect(prose).not.toContain('Hyderabad Liberation Day');
    expect(prose).not.toContain('T [E6]');
    expect(prose).not.toContain('@shh_ji20');
});

test('a lookup whose whole answer is a count and records leaves no prose', () => {
    // Real shape from "Show me high risk posts in Hyderabad.": the header
    // states the count in plainer words and the cards carry the records, so
    // there is nothing left to say. ChatMessage renders no bubble for this.
    const answer = '4241 matching record(s) — all time [E1].\n'
        + '1. @a · x · 2026-09-16: Alert: something [E2]';
    expect(answerProse(answer)).toBe('');
});
