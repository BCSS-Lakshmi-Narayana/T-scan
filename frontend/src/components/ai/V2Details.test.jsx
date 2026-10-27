import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import V2Details from './V2Details';

// The daily report pulls react-router-dom, which this CRA Jest cannot resolve;
// it is unrelated to the files under test.
jest.mock('../reports/SoceyeDailyReport', () => () => null);
jest.mock('../../lib/api', () => ({ __esModule: true, default: { post: jest.fn(() => Promise.resolve({})) } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

function render(ui) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(ui));
    return { el, root };
}

const response = {
    request_id: 'r1', status: 'partial', answer: '12 matching record(s) [E1].',
    facts: [{ evidence_id: 'E2', type: 'aggregate', group_by: 'platform', rows: [{ value: 'x', count: 7 }, { value: 'facebook', count: 5 }] }],
    interpretation: 'Most activity is on X [E2].',
    limitations: ["'Cyberabad' extends beyond your assigned districts; only Ranga Reddy is included."],
    evidence: [{ id: 'E1', type: 'aggregate', content: '12 matching record(s)', url: null }],
    clarification: null,
};

test('renders facts, interpretation label, limitations and evidence count', () => {
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('Partial answer');
    expect(el.textContent).toContain('facebook');
    expect(el.textContent).toContain('AI interpretation');
    expect(el.textContent).toContain('Ranga Reddy is included');
    expect(el.textContent).toContain('derived figure');
});

test('clarification candidates are offered as follow-up questions', () => {
    const asked = [];
    const { el } = render(<V2Details onFollowup={(q) => asked.push(q)} response={{
        request_id: 'r2', status: 'clarification', answer: 'Which one do you mean?', facts: [], evidence: [],
        limitations: [], clarification: { unresolved: [{ token: 'there', candidates: ['Hyderabad', 'Warangal'] }] },
    }} />);
    const buttons = [...el.querySelectorAll('button')].filter((b) => b.textContent === 'Warangal');
    act(() => buttons[0].click());
    expect(asked).toEqual(['What about Warangal?']);
    expect(el.textContent).toContain('Needs clarification');
});

test('the edited assistant page and message component compile', () => {
    // Import-only: a syntax or import error in the edited files fails here.
    expect(require('../../pages/AiAssistant').default).toBeInstanceOf(Function);
    expect(require('./ChatMessage').default).toBeInstanceOf(Function);
    expect(require('../../contexts/AuthContext').useAuth).toBeInstanceOf(Function);
});

// --------------------------------------------------------------------------
// Evidence provenance. An officer has to be able to reach the original post,
// and that must not depend on the model having produced any prose.
// --------------------------------------------------------------------------

const RECORD = {
    id: 'E2', type: 'record',
    content: 'Post: something happened near the market',
    url: 'https://x.com/Xsecular0/status/2100433289173422299',
    timestamp: '2026-09-17T03:54:54',
    facts: { handle: 'xsecular0', platform: 'x', published_at: '2026-09-17T03:54:54',
             risk_level: 'high' },
};

const RESPONSE_BASE = {
    request_id: 'r1', status: 'answered', answer: 'Answer text.',
    facts: [], evidence: [], limitations: [], clarification: null,
};

function withEvidence(extra) {
    return { ...response, evidence: [RECORD], ...extra };
}

// Record evidence is rendered as cards, always visible. Nothing to open.
function openEvidence() { /* retained so the intent of each test stays readable */ }

test('an evidence record exposes the original post and the author profile', () => {
    const { el } = render(<V2Details response={withEvidence()} />);
    const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('https://x.com/Xsecular0/status/2100433289173422299');
    expect(links).toContain('https://x.com/xsecular0');
    expect(el.textContent).toContain('Open source');
    expect(el.textContent).toContain('@xsecular0');
    expect(el.textContent).toContain('17 Sep 2026');
    expect(el.textContent).toContain('high');
});

test('evidence links open safely in a new tab', () => {
    const { el } = render(<V2Details response={withEvidence()} />);
    const post = [...el.querySelectorAll('a')]
        .find((a) => a.getAttribute('href').includes('/status/'));
    expect(post.getAttribute('target')).toBe('_blank');
    expect(post.getAttribute('rel')).toContain('noopener');
});

test('evidence still renders when the model produced nothing', () => {
    // Synthesis disabled, or the claim check removed the whole draft.
    const { el } = render(<V2Details response={withEvidence({ interpretation: null })} />);
    expect(el.textContent).not.toContain('AI interpretation');
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href')))
        .toContain('https://x.com/Xsecular0/status/2100433289173422299');
});

test('a record with no trustworthy url gets no link, and the handle stays plain', () => {
    const bare = { ...RECORD, url: null,
                   facts: { handle: 'NT Daily Online', platform: 'youtube' } };
    const { el } = render(<V2Details response={{ ...response, evidence: [bare] }} />);
    expect(el.textContent).not.toContain('Open source');
    expect(el.textContent).not.toContain('Open original source');
    expect(el.textContent).toContain('@NT Daily Online');
});

// --------------------------------------------------------------------------
// Measured panels. These render numbers the backend produced; the UI must not
// restate them as anything stronger than what was measured.
// --------------------------------------------------------------------------

test('a comparison shows every side, neutrally', () => {
    const response = {
        ...RESPONSE_BASE,
        facts: [{ evidence_id: 'E1', type: 'comparison',
                  sides: [{ label: 'Hyderabad', count: 4241 }, { label: 'Mulugu', count: 26 }] }],
    };
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('Hyderabad');
    expect(el.textContent).toContain('4,241');
    expect(el.textContent).toContain('Mulugu');
    expect(el.textContent).toContain('26');
    // no ranking language anywhere
    expect(el.textContent).not.toMatch(/winner|highest|worst|best|leads/i);
});

test('a trend is labelled as post volume, not incidents', () => {
    const response = {
        ...RESPONSE_BASE,
        facts: [{ evidence_id: 'E1', type: 'trend', current: 2979, previous: 1254,
                  change_pct: 138.1, direction: 'up', days: 7 }],
    };
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('Monitored post volume');
    expect(el.textContent).toContain('2,979');
    expect(el.textContent).toContain('1,254');
    expect(el.textContent).toContain('+138.1%');
    expect(el.textContent).not.toMatch(/incident|crime rate/i);
});

test('a trend with no prior window says so instead of showing a percentage', () => {
    const response = {
        ...RESPONSE_BASE,
        facts: [{ evidence_id: 'E1', type: 'trend', current: 12, previous: 0,
                  change_pct: null, direction: 'up', days: 7 }],
    };
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('No percentage change can be stated');
});

test('a situation lists its themes and states the limitation', () => {
    const response = {
        ...RESPONSE_BASE,
        analysis: { situation: {
            volume: 3088, window_days: 7,
            topics: [{ value: 'murder', count: 130 }, { value: 'women_safety', count: 103 }],
            where: [{ value: 'Hyderabad', count: 3088 }],
            who: [{ value: 'prakashnag12913', count: 3 }],
            connections: [{ record: 'a' }, { record: 'b' }],
        } },
    };
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('Key themes');
    expect(el.textContent).toContain('Murder');
    expect(el.textContent).toContain('Women safety');      // underscore humanised
    expect(el.textContent).toContain('@prakashnag12913');
    expect(el.textContent).toContain('do not by themselves');
});

test('situation sections absent from the payload are not rendered as empty headings', () => {
    const response = {
        ...RESPONSE_BASE,
        analysis: { situation: { volume: 5, window_days: 7,
                                 topics: [{ value: 'civic', count: 5 }] } },
    };
    const { el } = render(<V2Details response={response} />);
    expect(el.textContent).toContain('Key themes');
    expect(el.textContent).not.toContain('Accounts appearing repeatedly');
    expect(el.textContent).not.toContain('Connected records');
});

test('a situation answer opens its evidence without being asked', () => {
    const response = {
        ...RESPONSE_BASE,
        analysis: { situation: { volume: 5, window_days: 7, topics: [{ value: 'civic', count: 5 }] } },
        evidence: [RECORD],
    };
    const { el } = render(<V2Details response={response} />);
    // no click: the post is already on screen
    expect(el.textContent).toContain('Open source');
});

test('a plain search shows its records as cards too, not as a collapsed list', () => {
    // Round 1: records are never hidden behind a toggle. What IS deferred is
    // each post's full text, which opens per card.
    const { el } = render(<V2Details response={{ ...response, evidence: [RECORD] }} />);
    expect(el.textContent).toContain('Open source');
    expect(el.textContent).toContain('01');                     // numbered card
    expect(el.textContent).not.toContain('Original content');   // until expanded
});

test('a short post offers no expand control, because there is nothing hidden', () => {
    const { el } = render(<V2Details response={{ ...response, evidence: [RECORD] }} />);
    expect(el.textContent).not.toContain('View content');
    expect(el.textContent).toContain('something happened near the market');
});

test('missing facts and analysis render nothing rather than crashing', () => {
    const { el } = render(<V2Details response={{ request_id: 'r', status: 'answered' }} />);
    expect(el.textContent).not.toMatch(/undefined|NaN|\[object/);
});

test('breakdown labels are read as words, not as column values', () => {
    // "women_safety" is how the column is spelled. An officer reading the
    // table should not have to translate the database's underscores.
    const r = {
        ...response,
        facts: [{ evidence_id: 'E3', type: 'aggregate', group_by: 'topics',
            rows: [{ value: 'murder', count: 86 }, { value: 'women_safety', count: 46 }] }],
    };
    const { el } = render(<V2Details response={r} />);
    expect(el.textContent).toContain('Women safety');
    expect(el.textContent).not.toContain('women_safety');
    expect(el.textContent).toContain('By theme');
});

test('a handle keeps its exact spelling', () => {
    // A handle is an identifier an officer types into a search box.
    const r = {
        ...response,
        facts: [{ evidence_id: 'E4', type: 'aggregate', group_by: 'handle',
            rows: [{ value: 'hyd_city_police', count: 7 }, { value: 'TelanganaCOPs', count: 4 }] }],
    };
    const { el } = render(<V2Details response={r} />);
    expect(el.textContent).toContain('hyd_city_police');
    expect(el.textContent).toContain('TelanganaCOPs');
});
