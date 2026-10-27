import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import PromptGallery from './PromptGallery';
import { PROMPT_CATEGORIES } from './prompts';

global.IS_REACT_ACT_ENVIRONMENT = true;

function render(ui) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    act(() => createRoot(el).render(ui));
    return el;
}

test('the empty state states what the assistant is for', () => {
    const el = render(<PromptGallery onPick={() => {}} />);
    expect(el.textContent).toContain('AI Assistant');
    expect(el.textContent).toContain('Investigate your monitored environment');
    expect(el.textContent).toContain('Suggested investigations');
});

test('starter prompts are the officer questions, not V1 leftovers', () => {
    const el = render(<PromptGallery onPick={() => {}} />);
    expect(el.textContent).toContain('Show me recent high risk activity in Hyderabad.');
    expect(el.textContent).toContain('Compare Hyderabad and Mulugu for high risk content.');
    // the V1 catalogue is gone
    expect(el.textContent).not.toMatch(/velocity|amplifiers|narratives/i);
});

test('one Romanised Telugu example is kept as a regression case', () => {
    const all = PROMPT_CATEGORIES.flatMap((c) => c.prompts);
    expect(all.some((p) => /jarugutundi|ekkada/i.test(p))).toBe(true);
    // ...but English stays the default: most examples are English
    const telugu = all.filter((p) => /jarugutundi|ekkada|emaina/i.test(p));
    expect(telugu.length).toBeLessThan(all.length / 2);
});

test('picking a starter sends that exact question', () => {
    const picked = [];
    const el = render(<PromptGallery onPick={(q) => picked.push(q)} />);
    const btn = [...el.querySelectorAll('button')]
        .find((b) => b.textContent.includes('How many high risk posts are there in Hyderabad?'));
    expect(btn).toBeTruthy();
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(picked).toEqual(['How many high risk posts are there in Hyderabad?']);
});

test('every starter is a real question, not a fragment', () => {
    for (const c of PROMPT_CATEGORIES) {
        for (const p of c.prompts) {
            expect(p.length).toBeGreaterThan(20);
            expect(p).toMatch(/[?.]$/);
        }
    }
});
