import React, { useState, useCallback } from 'react';
import { MapPin, Search, ExternalLink, Loader2, AlertCircle, Instagram } from 'lucide-react';
import api, { BACKEND_URL } from '../lib/api';

const NEEDS_PROXY_RE = /(amazonaws\.com|\.fbcdn\.net|\.fbsbx\.com|lookaside\.facebook\.com|cdninstagram\.com|video\.twimg\.com|pbs\.twimg\.com|googlevideo\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|scontent|bhaskar-media-storage)/i;

const proxyMediaUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/') || trimmed.startsWith(BACKEND_URL)) return trimmed;
  if (NEEDS_PROXY_RE.test(trimmed)) return `${BACKEND_URL}/api/media/stream?url=${encodeURIComponent(trimmed)}`;
  return trimmed;
};

const XLogo = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const PlatformBadge = ({ platform }) => {
  if (platform === 'instagram') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-pink-600">
        <Instagram className="h-3.5 w-3.5" /> Instagram
      </span>
    );
  }
  if (platform === 'x') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-900 dark:text-zinc-100">
        <XLogo className="h-3.5 w-3.5" /> X / Twitter
      </span>
    );
  }
  return <span className="text-xs text-zinc-500">{platform}</span>;
};

const PostLocationLookup = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault?.();
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Paste a post link first.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await api.post('/post-location/lookup', { url: trimmed });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Lookup failed');
    } finally {
      setLoading(false);
    }
  }, [url]);

  const loc = result?.location;
  const mapHref = loc
    ? (typeof loc.lat === 'number' && typeof loc.lng === 'number'
        ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.name)}`)
    : null;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <MapPin className="text-rose-500" />
          Post Location Lookup
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Paste an Instagram or X (Twitter) post link to fetch the geotag attached by the author.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.instagram.com/p/... or https://x.com/.../status/..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="px-5 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error && (
        <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden shadow-sm">
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <PlatformBadge platform={result.platform} />
              {result.post?.content_url && (
                <a
                  href={result.post.content_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
                >
                  <ExternalLink className="h-3 w-3" /> Open original
                </a>
              )}
            </div>

            <div className="flex items-center gap-3">
              {result.post?.author_avatar && (
                <img
                  src={proxyMediaUrl(result.post.author_avatar)}
                  alt=""
                  className="h-10 w-10 rounded-full border"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div className="min-w-0">
                <div className="text-sm font-bold text-gray-900 dark:text-white truncate">{result.post?.author}</div>
                <div className="text-xs text-gray-500 truncate">@{result.post?.author_handle}</div>
              </div>
            </div>

            {result.post?.text && (
              <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words line-clamp-6">
                {result.post.text}
              </p>
            )}

            {/* Location result */}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              {loc?.name ? (
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                    {loc.source === 'author_profile' && 'Author profile location'}
                    {loc.source === 'tweet_place' && 'Posted from'}
                    {loc.source === 'tweet_coordinates' && 'GPS coordinates'}
                    {loc.source === 'instagram_post' && 'Tagged location'}
                    {loc.source === 'facebook_place' && 'Tagged location'}
                    {!loc.source && 'Location'}
                  </div>
                  <a
                    href={mapHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/50"
                  >
                    <MapPin className="h-4 w-4" />
                    <span>{loc.name}</span>
                  </a>
                  {result.message && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 italic">{result.message}</p>
                  )}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
                    {loc.address && <><dt className="font-semibold">Address</dt><dd>{loc.address}</dd></>}
                    {loc.city && <><dt className="font-semibold">City</dt><dd>{loc.city}</dd></>}
                    {loc.country && <><dt className="font-semibold">Country</dt><dd>{loc.country}</dd></>}
                    {typeof loc.lat === 'number' && typeof loc.lng === 'number' && (
                      <><dt className="font-semibold">Coords</dt><dd>{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</dd></>
                    )}
                    {loc.place_id && <><dt className="font-semibold">Place ID</dt><dd className="truncate">{loc.place_id}</dd></>}
                  </dl>
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic">
                  {result.message || 'No location attached to this post.'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PostLocationLookup;
