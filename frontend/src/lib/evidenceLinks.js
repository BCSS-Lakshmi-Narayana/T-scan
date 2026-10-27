/**
 * Links for a verified evidence record.
 *
 * Both functions take values that came from the database through verified
 * evidence. Nothing here ever reads model output: an officer following a link
 * must land on the real post, and a URL invented by a language model is exactly
 * the kind of thing that looks right and is not.
 *
 * The profile rules mirror the ones AlertCards already uses, so a handle opens
 * the same place from the assistant as it does from an alert.
 */

/** Only ever http(s). Anything else is not a link we will render. */
function safe(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
}

/**
 * The original post. Authoritative only: the stored content_url carried on the
 * evidence. We do not rebuild it from ids, because a rebuilt link that 404s is
 * worse than no link.
 */
export function postUrl(evidence) {
    if (!evidence) return null;
    return safe(evidence.url) || safe(evidence.facts?.url);
}

/**
 * The author's profile, where the platform has a deterministic form.
 * Returns null when one cannot be established — the caller then renders the
 * handle as plain text rather than guessing.
 */
export function profileUrl(handle, platform) {
    if (!handle || typeof handle !== 'string') return null;
    const raw = handle.trim();
    if (!raw) return null;

    // Facebook sources are stored as the profile URL itself, so it is already
    // the authoritative answer.
    const asUrl = safe(raw);
    if (asUrl) return asUrl;

    const h = raw.replace(/^@+/, '');
    // Account ids are alphanumeric with . _ - only. Anything else is a display
    // name or a fragment of something else, and building a URL from it would
    // produce a link that goes nowhere.
    if (!/^[A-Za-z0-9._-]+$/.test(h)) return null;
    const p = String(platform || '').toLowerCase();

    if (p === 'x' || p === 'twitter') return `https://x.com/${encodeURIComponent(h)}`;
    if (p === 'instagram') return `https://www.instagram.com/${encodeURIComponent(h)}/`;
    if (p === 'facebook') return `https://www.facebook.com/${encodeURIComponent(h)}`;
    // YouTube stores the channel id (UC + 22 chars), which is the canonical
    // channel URL. A display name is not, so it gets no link.
    if (p === 'youtube') {
        return /^UC[\w-]{22}$/.test(h) ? `https://www.youtube.com/channel/${h}` : null;
    }
    return null;
}

const PLATFORM_LABELS = {
    x: 'X', twitter: 'X', facebook: 'Facebook',
    instagram: 'Instagram', youtube: 'YouTube', telegram: 'Telegram',
};

export function platformLabel(platform) {
    if (!platform) return null;
    const p = String(platform).toLowerCase();
    return PLATFORM_LABELS[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "17 Sep 2026" — a date an officer reads, not an ISO string.
 *
 * Formatted by hand rather than through toLocaleDateString, whose month
 * abbreviations follow the runtime's locale data ("Sept" on some, "Sep" on
 * others). Evidence should read identically wherever it is opened.
 */
export function evidenceDate(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
