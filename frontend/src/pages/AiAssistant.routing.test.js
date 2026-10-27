/**
 * The toggle must choose the PATH, not just set a flag on one path.
 *
 * The defect: the v2 branch was entered on `if (v2Enabled)` alone and always
 * returned, so the legacy branch — the only one that reads `use_db` — was
 * unreachable whenever v2 was on. v2 is on in production, so "General chat"
 * silently sent every question to the grounded pipeline. Asking "who is the
 * prime minister of India" came back as 1,077 posts about the BJP, because the
 * grounded path has no other move.
 *
 * Rendering the whole page needs the auth context, the api client and a dozen
 * child components; this reads the routing decision out of the source instead,
 * which is exactly where the bug was.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'AiAssistant.js'), 'utf8');

describe('AI Assistant request routing', () => {
    test('the grounded path is taken only when the toggle asks for the database', () => {
        expect(SOURCE).toMatch(/if\s*\(\s*v2Enabled\s*&&\s*useDb\s*\)/);
        // The exact shape of the bug: v2 entered on its own.
        expect(SOURCE).not.toMatch(/if\s*\(\s*v2Enabled\s*\)\s*\{/);
    });

    test('general chat reaches the endpoint that answers without retrieval', () => {
        const legacy = SOURCE.slice(SOURCE.indexOf("'/rag/query'"));
        expect(legacy).toContain('use_db: useDb');
    });

    test('the grounded path is the only one that posts to the v2 endpoint', () => {
        const hits = SOURCE.match(/'\/rag\/v2\/query'/g) || [];
        expect(hits).toHaveLength(1);
    });

    test('the time window is only sent when the database is being queried', () => {
        expect(SOURCE).toMatch(/time_window_days:\s*useDb\s*\?/);
    });

    test('both paths remain abortable, so Stop works either way', () => {
        // The signal belongs in axios's config argument, not the body.
        const calls = SOURCE.match(/\{\s*signal:\s*ctrl\.signal\s*\}/g) || [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });
});
