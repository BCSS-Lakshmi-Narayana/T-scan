import { evidenceDate, platformLabel, postUrl, profileUrl } from './evidenceLinks';

describe('postUrl', () => {
    it('uses the stored url from verified evidence', () => {
        expect(postUrl({ url: 'https://x.com/a/status/1' })).toBe('https://x.com/a/status/1');
    });

    it('falls back to the url carried in facts', () => {
        expect(postUrl({ facts: { url: 'https://www.instagram.com/p/Ct/' } }))
            .toBe('https://www.instagram.com/p/Ct/');
    });

    it('returns null rather than inventing one', () => {
        expect(postUrl({ facts: { handle: 'someone', platform: 'x' } })).toBeNull();
        expect(postUrl(null)).toBeNull();
    });

    it('refuses anything that is not http(s)', () => {
        // The url reaches the page as data; a scheme check keeps a bad one from
        // becoming a clickable action.
        expect(postUrl({ url: 'javascript:alert(1)' })).toBeNull();
        expect(postUrl({ url: 'data:text/html,<script>' })).toBeNull();
        expect(postUrl({ url: 'file:///etc/passwd' })).toBeNull();
    });
});

describe('profileUrl', () => {
    it('builds the platform form for a bare handle', () => {
        expect(profileUrl('xsecular0', 'x')).toBe('https://x.com/xsecular0');
        expect(profileUrl('@xsecular0', 'twitter')).toBe('https://x.com/xsecular0');
        expect(profileUrl('hyderabadcityvibes', 'instagram'))
            .toBe('https://www.instagram.com/hyderabadcityvibes/');
        expect(profileUrl('nbstelangana', 'facebook'))
            .toBe('https://www.facebook.com/nbstelangana');
    });

    it('passes a handle that is already a profile url straight through', () => {
        // Facebook sources are stored this way.
        expect(profileUrl('https://www.facebook.com/nbstelangana', 'facebook'))
            .toBe('https://www.facebook.com/nbstelangana');
    });

    it('uses the channel id form for youtube', () => {
        expect(profileUrl('UCtFQDgA8J8_iiwc5-KoAQlg', 'youtube'))
            .toBe('https://www.youtube.com/channel/UCtFQDgA8J8_iiwc5-KoAQlg');
    });

    it('gives no link for a youtube display name', () => {
        // Not a channel id, so any url built from it would be a guess.
        expect(profileUrl('NT Daily Online', 'youtube')).toBeNull();
        expect(profileUrl('ntdaily', 'youtube')).toBeNull();
    });

    it('gives no link when it cannot be established', () => {
        expect(profileUrl('', 'x')).toBeNull();
        expect(profileUrl(null, 'x')).toBeNull();
        expect(profileUrl('some name', 'x')).toBeNull();      // display name
        expect(profileUrl('a/b', 'x')).toBeNull();            // path, not a handle
        expect(profileUrl('someone', 'telegram')).toBeNull(); // no known form
        expect(profileUrl('someone', undefined)).toBeNull();
    });

    it('refuses a non-http handle that looks like a url', () => {
        expect(profileUrl('javascript:alert(1)', 'x')).toBeNull();
    });
});

describe('presentation helpers', () => {
    it('labels platforms the way an officer reads them', () => {
        expect(platformLabel('x')).toBe('X');
        expect(platformLabel('twitter')).toBe('X');
        expect(platformLabel('facebook')).toBe('Facebook');
        expect(platformLabel('youtube')).toBe('YouTube');
        expect(platformLabel(null)).toBeNull();
    });

    it('formats a date, and ignores an unusable one', () => {
        expect(evidenceDate('2026-09-17T03:54:54')).toBe('17 Sep 2026');
        expect(evidenceDate('not a date')).toBeNull();
        expect(evidenceDate(null)).toBeNull();
    });
});
