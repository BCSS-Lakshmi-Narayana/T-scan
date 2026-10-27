/**
 * Round 2: the shell and the conversational surfaces.
 *
 * These cover the things a screenshot would show — what the officer is told,
 * in what order, and what is deliberately absent.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import AssistantHeader from './AssistantHeader';
import ChatMessage from './ChatMessage';
import Composer from './Composer';
import PromptGallery from './PromptGallery';
import ThinkingIndicator from './ThinkingIndicator';
import SuggestionRail from './SuggestionRail';
import AnalysisPanel from './AnalysisPanel';
import V2Details from './V2Details';
import { EmptyResult, FailureNotice, StatusBadge } from './ResponseStates';
import * as prompts from './prompts';
import { withoutSeededGreeting } from '../../lib/aiChatStorage';
import { answerProse, leadAnswer, stripCitations, supportingProse } from '../../lib/answerText';

jest.mock('../reports/SoceyeDailyReport', () => () => null);
jest.mock('../../lib/api', () => ({ __esModule: true, default: { post: jest.fn(() => Promise.resolve({})) } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

function render(ui) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    act(() => createRoot(el).render(ui));
    return el;
}
const buttons = (el) => [...el.querySelectorAll('button')];
const click = (n) => act(() => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));

// ------------------------------------------------------------------ naming

test('the product is called AI Assistant, and SOC-EYE appears nowhere', () => {
    const header = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: true }} useDb windowDays={7} onClear={() => {}} canClear={false} />);
    expect(header.textContent).toContain('AI Assistant');

    const empty = render(<PromptGallery onPick={() => {}} />);
    for (const el of [header, empty]) {
        expect(el.textContent).not.toMatch(/soc[- ]?eye/i);
    }
});

test('there is no seeded greeting message to open the conversation with', () => {
    expect(prompts.WELCOME_MESSAGE).toBeUndefined();
});

// ------------------------------------------------------------------ header

test('the header states what the answers are drawn from, and how far back', () => {
    const el = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: true }} useDb windowDays={7} onClear={() => {}} canClear={false} />);
    expect(el.textContent).toContain('Live monitored intelligence');
    expect(el.textContent).toContain('last 7 days');
});

test('general chat mode says the answer will not use the officer\'s data', () => {
    const el = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: true }} useDb={false} windowDays={7} onClear={() => {}} canClear={false} />);
    expect(el.textContent).toMatch(/not your data/i);
});

test('a healthy service is not announced; a degraded one is', () => {
    const ok = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: true }} useDb windowDays={7} onClear={() => {}} canClear={false} />);
    expect(ok.textContent).not.toMatch(/degraded/i);
    const bad = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: false }} useDb windowDays={7} onClear={() => {}} canClear={false} />);
    expect(bad.textContent).toMatch(/degraded/i);
});

// ------------------------------------------------------- no internal terms

const INTERNALS = /\bRAG\b|\bV2\b|QueryPlan|orchestrator|vector search|embedding|pipeline|top_k/i;

test('no internal machinery is named anywhere the officer can read', () => {
    const surfaces = [
        render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
            health={{ healthy: true }} useDb windowDays={7} onClear={() => {}} canClear={false} />),
        render(<PromptGallery onPick={() => {}} />),
        render(<ThinkingIndicator grounded />),
        render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}}
            loading={false} useDb onUseDbChange={() => {}} windowDays={7} onWindowChange={() => {}} />),
    ];
    for (const el of surfaces) expect(el.textContent).not.toMatch(INTERNALS);
});

test('the thinking state describes the work, not the components doing it', () => {
    const el = render(<ThinkingIndicator grounded />);
    expect(el.textContent).toContain('Understanding the question');
    expect(el.textContent).not.toMatch(/collection|database query|tool/i);
});

// ---------------------------------------------------------------- composer

test('the composer invites an investigation and anchors the send control', () => {
    const el = render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}}
        loading={false} useDb onUseDbChange={() => {}} windowDays={7} onWindowChange={() => {}} />);
    const box = el.querySelector('textarea');
    expect(box.getAttribute('placeholder'))
        .toMatch(/activity, alerts, people, locations, or trends/i);
    // nothing to send yet
    expect(buttons(el).find((b) => b.getAttribute('aria-label') === 'Send question').disabled).toBe(true);
});

test('the composer offers Stop while an answer is in flight', () => {
    const el = render(<Composer value="x" onChange={() => {}} onSend={() => {}} onStop={() => {}}
        loading useDb onUseDbChange={() => {}} windowDays={7} onWindowChange={() => {}} />);
    expect(buttons(el).some((b) => b.getAttribute('aria-label') === 'Stop generating')).toBe(true);
    expect(buttons(el).some((b) => b.getAttribute('aria-label') === 'Send question')).toBe(false);
});

test('Enter sends, Shift+Enter does not', () => {
    let sent = 0;
    const el = render(<Composer value="hello" onChange={() => {}} onSend={() => { sent += 1; }}
        onStop={() => {}} loading={false} useDb onUseDbChange={() => {}}
        windowDays={7} onWindowChange={() => {}} />);
    const box = el.querySelector('textarea');
    act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(sent).toBe(1);
    act(() => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(sent).toBe(1);
});

// ----------------------------------------------------------- user message

test('the question is shown back compactly, not as a wall', () => {
    const el = render(<ChatMessage message={{ role: 'user', content: 'Hyderabad lo em nadustundhi?' }} />);
    expect(el.textContent).toBe('Hyderabad lo em nadustundhi?');
    // it is set apart from the answer, on its own surface
    expect(el.innerHTML).toMatch(/justify-end/);
});

// -------------------------------------------------------------- citations

test('raw evidence markers never reach the officer', () => {
    expect(stripCitations('4,560 posts in the last 7 days [E43].'))
        .toBe('4,560 posts in the last 7 days.');
    expect(stripCitations('Two sources agree [E5, E6].')).toBe('Two sources agree.');
    expect(answerProse('Main subjects: murder (149). [E43]')).not.toMatch(/\[E\d+\]/);
});

test('an answer rendered end to end shows no [E] markers anywhere', () => {
    const el = render(<V2Details response={{
        request_id: 'r', status: 'answered',
        answer: '4560 matching record(s) [E43].\n2941 record(s) are rated high risk. [E43]',
        interpretation: 'Activity is concentrated in Hyderabad [E1].',
        facts: [], evidence: [], limitations: [],
    }} />);
    expect(el.textContent).not.toMatch(/\[E\d+/);
    expect(el.textContent).toContain('Activity is concentrated in Hyderabad.');
});

// ------------------------------------------------- prose vs panels, once

test('the trend sentence is dropped when the trend panel states it properly', () => {
    const answer = '4560 matching record(s) in the last 7 day(s). [E43]\n'
        + '4560 in this window against 1962 in the previous one (+132.4%). [E43]\n'
        + '2941 record(s) are rated high risk. [E43]';
    expect(answerProse(answer, { panels: ['trend'] }))
        .toBe('2941 record(s) are rated high risk.');
    // ...and kept when there is no panel to carry it
    expect(answerProse(answer)).toMatch(/in this window against/);
});

test('situation lines the panel already renders are not printed twice', () => {
    const answer = 'Main subjects: murder (149), women safety (112). [E43]\n'
        + 'Most records are in Hyderabad (4560). [E43]\n'
        + 'Accounts appearing repeatedly: @a (11). [E43]\n'
        + '9 related record(s) share an account, target or place with the matches. [E43]\n'
        + '2941 record(s) are rated high risk. [E43]';
    expect(answerProse(answer, { panels: ['situation'] }))
        .toBe('2941 record(s) are rated high risk.');
});

test('the model reading leads the answer, labelled, and the template does not repeat it', () => {
    const response = {
        interpretation: 'Activity in Hyderabad is dominated by reports about women safety [E1].',
        answer: '4560 matching record(s). [E43]\nMain subjects: murder (149). [E43]',
    };
    const lead = leadAnswer(response, { panels: ['situation'] });
    expect(lead.source).toBe('ai');
    expect(lead.text).toBe('Activity in Hyderabad is dominated by reports about women safety.');
    // the situation panel carries "Main subjects", so nothing is left over
    expect(supportingProse(response, { panels: ['situation'] })).toBe('');
});

test('with no model reading, the template sentences become the answer', () => {
    const lead = leadAnswer({ answer: '2941 record(s) are rated high risk. [E43]' });
    expect(lead.source).toBe('template');
    expect(lead.text).toBe('2941 record(s) are rated high risk.');
});

test('a pure lookup invents no answer; the evidence is the answer', () => {
    expect(leadAnswer({ answer: '4241 matching record(s) [E1].\n1. @a · x · 2026-09-16: hi [E2]' }))
        .toBeNull();
});

test('the AI label is attached only when the model actually wrote the answer', () => {
    const ai = render(<V2Details response={{
        request_id: 'r', status: 'answered', answer: 'x',
        interpretation: 'Model wrote this.', facts: [], evidence: [], limitations: [],
    }} />);
    expect(ai.textContent).toContain('AI interpretation');

    const tpl = render(<V2Details response={{
        request_id: 'r', status: 'answered',
        answer: '2941 record(s) are rated high risk. [E43]',
        facts: [], evidence: [], limitations: [],
    }} />);
    expect(tpl.textContent).toContain('2941 record(s) are rated high risk.');
    expect(tpl.textContent).not.toContain('AI interpretation');
});

// --------------------------------------------------------- response states

test('an answered response wears no status badge; the exceptions do', () => {
    expect(render(<StatusBadge status="answered" />).textContent).toBe('');
    expect(render(<StatusBadge status="denied" />).textContent).toContain('Not permitted');
    expect(render(<StatusBadge status="empty" />).textContent).toContain('Nothing found');
});

test('an empty result reads as a finding about the data, not as a fault', () => {
    const composed = [];
    const el = render(<EmptyResult onCompose={(t) => composed.push(t)} />);
    expect(el.textContent).toContain('No matching monitored activity found.');
    expect(el.textContent).not.toMatch(/error|failed|went wrong/i);
    click(buttons(el).find((b) => /Expand time range/.test(b.textContent)));
    expect(composed).toHaveLength(1);
    expect(composed[0]).toMatch(/30 days/);
});

test('a refusal is not dressed up as an empty result', () => {
    const el = render(<V2Details response={{
        request_id: 'r', status: 'denied', answer: '', facts: [], evidence: [], limitations: [],
    }} />);
    expect(el.textContent).toContain('Not permitted');
    expect(el.textContent).toContain('outside your access');
    expect(el.textContent).not.toMatch(/No matching monitored activity/);
});

test('a failure hands the question back rather than a status code', () => {
    const retried = [];
    const el = render(<FailureNotice question="Hyderabad lo em nadustundhi?"
        onRetry={(q) => retried.push(q)} />);
    expect(el.textContent).not.toMatch(/\b[45]\d\d\b|stack|axios|undefined/i);
    click(buttons(el).find((b) => /Retry/.test(b.textContent)));
    expect(retried).toEqual(['Hyderabad lo em nadustundhi?']);
});

// ------------------------------------------------------------------ order

test('the answer comes before the evidence that supports it', () => {
    const el = render(<V2Details response={{
        request_id: 'r', status: 'answered', answer: 'x',
        interpretation: 'Reports about women safety dominate.',
        facts: [], limitations: [],
        evidence: [{ id: 'E2', type: 'record', content: 'a post', url: null,
                     facts: { handle: 'someone', platform: 'x' } }],
    }} />);
    const text = el.textContent;
    expect(text.indexOf('Reports about women safety dominate.'))
        .toBeLessThan(text.indexOf('evidence'));
});

// --------------------------------------------------- count-shaped answers

test('a "how many" question answers with the number, not a one-row table', () => {
    // Live shape from "How many high risk posts are there in Hyderabad?":
    // the only prose was "By risk_level: high (4241)", which spelled a
    // database column at the officer.
    const el = render(<V2Details response={{
        request_id: 'r', status: 'answered',
        answer: '4241 matching record(s) — all time [E1].\nBy risk_level: high (4241) [E2].',
        facts: [{ evidence_id: 'E1', type: 'aggregate', total: 4241, measure: 'matching records' },
                { evidence_id: 'E2', type: 'aggregate', group_by: 'risk_level',
                  rows: [{ value: 'high', count: 4241 }] }],
        evidence: [], limitations: [],
    }} />);
    expect(el.textContent).toContain('4,241');
    expect(el.textContent).toContain('all time');
    expect(el.textContent).not.toMatch(/risk_level/);
});

test('database column names are never shown as written', () => {
    const el = render(<V2Details response={{
        request_id: 'r', status: 'answered', answer: '7214 matching record(s) — all time [E1].',
        facts: [{ evidence_id: 'E1', type: 'aggregate', total: 7214, measure: 'matching records' },
                { evidence_id: 'E2', type: 'aggregate', group_by: 'districts',
                  rows: [{ value: 'Hyderabad', count: 6549 }, { value: 'Mulugu', count: 664 }] }],
        evidence: [], limitations: [],
    }} />);
    expect(el.textContent).toContain('By district');
    expect(el.textContent).not.toMatch(/districts\b/);
});

test('a grouping shown as chips is not repeated as a table underneath', () => {
    const el = render(<V2Details response={{
        request_id: 'r', status: 'answered', answer: 'x',
        analysis: { situation: { volume: 4132, window_days: 7,
            topics: [{ value: 'murder', count: 131 }],
            where: [{ value: 'Hyderabad', count: 4132 }, { value: 'Mulugu', count: 17 }] } },
        facts: [{ evidence_id: 'E1', type: 'aggregate', group_by: 'districts',
                  rows: [{ value: 'Hyderabad', count: 4132 }, { value: 'Mulugu', count: 17 }] },
                { evidence_id: 'E2', type: 'aggregate', group_by: 'risk_level',
                  rows: [{ value: 'high', count: 2665 }, { value: 'low', count: 209 }] }],
        evidence: [], limitations: [],
    }} />);
    expect(el.textContent).toContain('Where');          // chips
    expect(el.textContent).not.toContain('By district'); // ...not again as a table
    expect(el.textContent).toContain('By risk level');   // this one has no chips
});

test('the risk sentence is dropped when the risk table states it', () => {
    // Regression: this pattern once held a literal backspace byte instead of a
    // word boundary, so it silently never matched and the line printed twice.
    const answer = '2665 record(s) are rated high risk. [E43]';
    expect(answerProse(answer, { panels: ['table'] })).toBe('');
    expect(answerProse(answer)).toBe('2665 record(s) are rated high risk.');
});

test('no source file carries a stray control character', () => {
    // How that backspace got in: a patch script collapsed "\b" to "\b".
    const fs = require('fs');
    const path = require('path');
    const bad = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) return walk(full);
        return /\.(jsx?|json)$/.test(d.name) ? [full] : [];
    });
    const offenders = walk(path.join(__dirname, '..', '..', 'lib'))
        .concat(walk(__dirname))
        .filter((f) => bad.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
});

// ------------------------------------------- the greeting that came back

test('the old seeded greeting is dropped from saved history', () => {
    // It was written into every officer's localStorage, so deleting it from
    // the code left it on screen — and because the conversation then was not
    // empty, the starter questions never appeared at all.
    const saved = [
        { role: 'assistant', content: '### 👋 SOC-EYE AI — Investigative Briefer\n...' },
        { role: 'user', content: 'How many high risk posts?', ts: 1758000000000 },
        { role: 'assistant', content: '4,241', ts: 1758000000001 },
    ];
    const kept = withoutSeededGreeting(saved);
    expect(kept).toHaveLength(2);
    expect(kept.every((m) => !/SOC-EYE/i.test(m.content))).toBe(true);
    // a real conversation is left exactly as it was
    expect(kept[0].content).toBe('How many high risk posts?');
});

test('a history of nothing but the greeting comes back empty, so starters show', () => {
    const only = [{ role: 'assistant', content: 'SOC-EYE AI — Investigative Briefer' }];
    expect(withoutSeededGreeting(only)).toEqual([]);
    expect(withoutSeededGreeting(null)).toEqual([]);
    expect(withoutSeededGreeting('nonsense')).toEqual([]);
});

// ------------------------------------------------------------- identity

test('the assistant has a visible mark wherever it speaks', () => {
    const header = render(<AssistantHeader tabs={[]} activeTab="chat" onTabChange={() => {}}
        health={{ healthy: true }} useDb windowDays={7} onClear={() => {}} canClear={false} />);
    const empty = render(<PromptGallery onPick={() => {}} />);
    const thinking = render(<ThinkingIndicator grounded />);
    const answer = render(<ChatMessage message={{ role: 'assistant', content: 'hi', ts: 1 }} />);
    for (const el of [header, empty, thinking, answer]) {
        expect(el.querySelector('svg')).toBeTruthy();
    }
});

test('the officer\'s own question carries no assistant mark', () => {
    const el = render(<ChatMessage message={{ role: 'user', content: 'Anything?', ts: 1 }} />);
    expect(el.querySelector('svg')).toBeNull();
});

// ------------------------------------------------------- the left rail

test('suggestions sit in a rail that stays reachable mid-conversation', () => {
    const picked = [];
    const el = render(<SuggestionRail onPick={(q) => picked.push(q)} />);
    expect(el.querySelector('aside')).toBeTruthy();
    expect(el.textContent).toContain('Suggested investigations');
    const btn = buttons(el).find((b) => b.textContent.includes('Compare Hyderabad and Mulugu'));
    click(btn);
    expect(picked).toEqual(['Compare Hyderabad and Mulugu for high risk content.']);
});

test('every rail suggestion is a validated question, sent exactly as written', () => {
    const picked = [];
    const el = render(<SuggestionRail onPick={(q) => picked.push(q)} />);
    const all = prompts.PROMPT_CATEGORIES.flatMap((c) => c.prompts);
    for (const b of buttons(el)) expect(all).toContain(b.textContent);
});

test('the rail can be disabled while an answer is in flight', () => {
    const el = render(<SuggestionRail onPick={() => {}} disabled />);
    expect(buttons(el).every((b) => b.disabled)).toBe(true);
});

test('the composer floats over the conversation rather than sitting under it', () => {
    const el = render(<Composer value="" onChange={() => {}} onSend={() => {}} onStop={() => {}}
        loading={false} useDb onUseDbChange={() => {}} windowDays={7} onWindowChange={() => {}} />);
    const root = el.firstChild;
    expect(root.className).toMatch(/absolute/);
    // the fade must not swallow clicks meant for the conversation behind it
    expect(root.className).toMatch(/pointer-events-none/);
    expect(el.querySelector('.pointer-events-auto')).toBeTruthy();
});

// ------------------------------------------------ the analysis in progress

test('progress is reported in the officer\'s terms, never the machinery\'s', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j1', status: 'running', evidence_stage: 'initial',
                    stage_text: 'Analysing relevant monitored posts…',
                    progress: { analysed: 74, population: 192, percent: 38 } }}
        counts={{ matching: 4669, analysed: 74, displayed: 20 }} />);
    expect(el.textContent).toContain('Analysing relevant monitored posts');
    expect(el.textContent).toContain('74 / 192 analysed');
    expect(el.textContent).toContain('4,669 matching');
    for (const word of ['batch', 'LLM', 'Qwen', 'vector', 'RRF', 'token', 'prompt']) {
        expect(el.textContent.toLowerCase()).not.toContain(word.toLowerCase());
    }
});

test('while analysing, the evidence on screen is not claimed to be the chosen set', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j1', status: 'running', evidence_stage: 'initial',
                    progress: { analysed: 10, population: 192, percent: 5 } }}
        counts={{ matching: 4669, analysed: 10, displayed: 20 }} />);
    expect(el.textContent).toContain('initial retrieval');
    expect(el.textContent).toContain('20 initial evidence');
});

test('reuse is stated in plain words, not as a cache statistic', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j1', status: 'done', evidence_stage: 'final',
                    progress: { analysed: 192, population: 192, percent: 100,
                                reused: 187, fresh: 5 }, themes: [] }}
        counts={{ matching: 4669, analysed: 192, displayed: 20 }} />);
    expect(el.textContent).toContain('187 previously analysed records reused');
    expect(el.textContent).toContain('5 newly analysed');
    expect(el.textContent.toLowerCase()).not.toContain('cache');
});

test('a cluster is never presented to the officer as one incident', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j1', status: 'done', evidence_stage: 'final',
                    progress: { analysed: 192, population: 192, percent: 100 },
                    clusters: [{ theme: 'women safety', where: 'Hyderabad', size: 6 }],
                    repeated_claims: [{ claim: 'alleges police inaction', accounts: 3 }] }}
        counts={{ matching: 4669, analysed: 192, displayed: 20 }} />);
    expect(el.textContent).toContain('not evidence they describe the same incident');
    expect(el.textContent).toContain('not that any of it is established');
});

test('a failed analysis does not cast doubt on the measured figures', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j1', status: 'error', progress: {} }}
        counts={{ matching: 4669, analysed: 0, displayed: 20 }} />);
    expect(el.textContent).toContain('could not be completed');
    expect(el.textContent).toContain('unaffected');
});

test('a question needing no deep reading shows populations and nothing else', () => {
    const el = render(<AnalysisPanel analysis={{}}
        counts={{ matching: 4241, analysed: 0, displayed: 0 }} />);
    expect(el.textContent).toBe('4,241 matching');
    expect(el.textContent).not.toContain('Analysis');
});

test('the deep briefing leads the answer once it exists', () => {
    const lead = leadAnswer({
        interpretation: 'Written from the handful retrieval returned.',
        analysis: { summary: 'Written after reading 192 posts.' },
        answer: '4241 matching record(s). [E1]',
    });
    expect(lead.text).toBe('Written after reading 192 posts.');
    expect(lead.source).toBe('ai');
});

// ------------------------------------------------- comparison, per side

test('comparison progress is reported per side, never pooled', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j', status: 'running', evidence_stage: 'initial',
            stage_text: 'Analysing relevant monitored posts…',
            progress: { analysed: 260, population: 600, percent: 43 },
            sides: [{ label: 'Hyderabad', matching: 4267, population: 300,
                      analysed: 142, percent: 47 },
                    { label: 'Mulugu', matching: 664, population: 300,
                      analysed: 118, percent: 39 }] }}
        counts={{ matching: 4931, analysed: 260, displayed: 20 }} />);
    expect(el.textContent).toContain('Hyderabad');
    expect(el.textContent).toContain('142 / 300 analysed');
    expect(el.textContent).toContain('Mulugu');
    expect(el.textContent).toContain('118 / 300 analysed');
});

test('each side reports its own matching and analysed counts', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j', status: 'done', evidence_stage: 'final',
            progress: { analysed: 600, population: 600, percent: 100 },
            comparison: { summary: 'x', sides: [
                { label: 'Hyderabad', matching: 4267, analysed: 300,
                  themes: [{ value: 'civic', count: 12 }] },
                { label: 'Mulugu', matching: 664, analysed: 300,
                  themes: [{ value: 'land', count: 4 }] }] } }}
        counts={{ matching: 4931, analysed: 600, displayed: 20 }} />);
    const text = el.textContent;
    expect(text).toContain('4,267 matching · 300 analysed');
    expect(text).toContain('664 matching · 300 analysed');
    expect(text).toContain('civic');
    expect(text).toContain('land');
});

test('a comparison warns that places are monitored to different depths', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j', status: 'done', evidence_stage: 'final',
            progress: {},
            comparison: { sides: [
                { label: 'Hyderabad', matching: 4267, analysed: 300, themes: [] },
                { label: 'Mulugu', matching: 664, analysed: 300, themes: [] }] } }}
        counts={{ matching: 4931, analysed: 600, displayed: 20 }} />);
    expect(el.textContent).toContain('monitored to different depths');
    expect(el.textContent).toContain('does not by itself mean more is happening');
});

test('a single-population answer still shows one pooled progress bar', () => {
    const el = render(<AnalysisPanel
        analysis={{ job_id: 'j', status: 'running', evidence_stage: 'initial',
            progress: { analysed: 74, population: 192, percent: 38 } }}
        counts={{ matching: 4669, analysed: 74, displayed: 20 }} />);
    expect(el.textContent).toContain('74 / 192 analysed');
    expect(el.textContent).toContain('initial retrieval');
});
