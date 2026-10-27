/**
 * Decode HTML entities (e.g. &amp; → &, &lt; → <) in a string.
 * Uses the browser's DOMParser and extracts textContent, which is safe from XSS.
 */
const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;

export const decodeHtmlEntities = (text) => {
    if (!text || typeof text !== 'string') return text || '';
    if (!parser) return text;
    return parser.parseFromString(text, 'text/html').body.textContent || '';
};
