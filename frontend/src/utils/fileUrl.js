import { BACKEND_URL } from '../lib/api';

// Stored file URLs are absolutised by the backend from the request host at the
// moment the file was written (`${proto}://${req.get('host')}/files/<key>`).
// That host can be wrong later: a PDF generated against localhost:8001 and
// opened from a deployed build, or a reverse proxy that forwards only /api and
// has no /files route. Re-point any such URL at this build's backend, using the
// /api/files alias that always survives the proxy.
const FILES_PATH_RE = /\/(?:api\/)?files\/(.+)$/;

export const resolveFileUrl = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return '';

    // Leave off-site links (the post itself, an S3/CDN URL) untouched.
    let pathname = value;
    if (/^https?:\/\//i.test(value)) {
        try {
            pathname = new URL(value).pathname;
        } catch {
            return value;
        }
    }

    const match = FILES_PATH_RE.exec(pathname);
    if (!match) return value;
    return `${BACKEND_URL}/api/files/${match[1]}`;
};

export default resolveFileUrl;
