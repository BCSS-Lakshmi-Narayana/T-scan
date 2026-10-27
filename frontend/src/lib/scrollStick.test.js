import { isAtBottom, STICK_THRESHOLD_PX } from './scrollStick';

const box = (scrollTop, scrollHeight = 2000, clientHeight = 600) =>
    ({ scrollTop, scrollHeight, clientHeight });

test('a reader at the bottom keeps following new content', () => {
    expect(isAtBottom(box(1400))).toBe(true);           // exactly at the end
    expect(isAtBottom(box(1400 - STICK_THRESHOLD_PX))).toBe(true);  // within reach
});

test('a reader who scrolled up to the evidence is left alone', () => {
    // The bug: deep analysis rewrote the answer every 2.5s and this returned
    // true regardless, so the page jumped to the bottom while they were reading.
    expect(isAtBottom(box(200))).toBe(false);
    expect(isAtBottom(box(0))).toBe(false);
    expect(isAtBottom(box(1400 - STICK_THRESHOLD_PX - 1))).toBe(false);
});

test('content shorter than the viewport is always "at the bottom"', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
});

test('before anything has rendered, the next turn should be visible', () => {
    expect(isAtBottom(null)).toBe(true);
    expect(isAtBottom(undefined)).toBe(true);
});

test('a partly-rendered element does not read as "scrolled away"', () => {
    expect(isAtBottom({})).toBe(true);
});
