import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ComparisonPanel, SituationPanel, TrendPanel } from './FactPanels';

global.IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return { el, root: createRoot(el) };
}

const TREND = { current: 2979, previous: 1254, change_pct: 138.1, direction: 'up', days: 7 };

test('a panel re-rendered from empty to populated keeps its hook order', () => {
    // The regression: TrendPanel called a hook after `if (!fact) return null`,
    // so going from no-trend to trend changed the number of hooks between
    // renders and React threw. Rendering both states at the same tree position
    // is what catches it.
    const { el, root } = mount();
    const errors = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    try {
        act(() => root.render(<TrendPanel fact={null} />));
        expect(el.textContent).toBe('');
        act(() => root.render(<TrendPanel fact={TREND} />));
        expect(el.textContent).toContain('2,979');
        act(() => root.render(<TrendPanel fact={null} />));
        expect(errors.join(' ')).not.toMatch(/hook/i);
    } finally {
        spy.mockRestore();
    }
});

test('each panel renders nothing when its payload is absent', () => {
    const { el, root } = mount();
    act(() => root.render(
        <div>
            <TrendPanel fact={null} />
            <ComparisonPanel fact={null} />
            <SituationPanel situation={null} />
        </div>
    ));
    expect(el.textContent).toBe('');
});

test('a comparison needs at least two sides to mean anything', () => {
    const { el, root } = mount();
    act(() => root.render(<ComparisonPanel fact={{ sides: [{ label: 'Hyderabad', count: 5 }] }} />));
    expect(el.textContent).toBe('');
});

test('a situation with only empty sections renders nothing', () => {
    const { el, root } = mount();
    act(() => root.render(<SituationPanel situation={{ volume: 0, topics: [], where: [], who: [] }} />));
    expect(el.textContent).toBe('');
});

test('counts are grouped so they read as quantities', () => {
    const { el, root } = mount();
    act(() => root.render(<ComparisonPanel
        fact={{ sides: [{ label: 'A', count: 4241 }, { label: 'B', count: 26 }] }} />));
    expect(el.textContent).toContain('4,241');   // not "4241", which scans as a year
});

test('a downward trend is not coloured as an alarm', () => {
    const { el, root } = mount();
    act(() => root.render(<TrendPanel
        fact={{ ...TREND, current: 100, previous: 400, change_pct: -75, direction: 'down' }} />));
    expect(el.textContent).toContain('-75%');
    expect(el.innerHTML).toMatch(/emerald/);     // down = calmer, not rose
});
