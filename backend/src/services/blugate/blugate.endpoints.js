/**
 * Every BluGate route this backend uses, in one place.
 *
 * Paths are transcribed from the BluGate client documentation
 * (blugateapis/*-blugate-documentation.json). Nothing else in the codebase
 * spells out a provider path: callers name an endpoint key, and the client
 * resolves it here. Adding a capability is an entry in this file plus a wrapper
 * in the provider service — never a URL inlined at a call site.
 *
 * `segment` is the gateway path segment (…/api/gateway/<segment>) and `label`
 * is what appears in error messages.
 */

const PLATFORMS = {
  // ── X / Twitter ─ upstream twitter241, same provider this backend used
  //    directly before BluGate, so response shapes are unchanged.
  x: {
    segment: 'twitter',
    label: 'X',
    envKeys: ['BLUGATE_TWITTER_HOST', 'BLUGATE_X_HOST'],
    endpoints: {
      USER_TWEETS:    { method: 'GET', path: '/user-tweets',   usedFor: 'Timeline for one account' },
      USER_BY_NAME:   { method: 'GET', path: '/user',          usedFor: 'Profile by username' },
      USERS_BY_IDS:   { method: 'GET', path: '/get-users',     usedFor: 'Profiles by numeric id' },
      SEARCH:         { method: 'GET', path: '/search',        usedFor: 'Search posts and accounts' },
      TWEET_DETAIL:   { method: 'GET', path: '/tweet-v2',      usedFor: 'One post by id' },
      // BluGate still exposes the older route; kept as a fallback because the
      // v2 endpoint intermittently returns nothing for older posts.
      TWEET_DETAIL_LEGACY: { method: 'GET', path: '/tweet',   usedFor: 'One post by id (deprecated upstream)' },
      TWEET_COMMENTS: { method: 'GET', path: '/comments',      usedFor: 'Replies to a post' },
      TWEET_RETWEETS: { method: 'GET', path: '/retweets',      usedFor: 'Accounts that reposted' },
      TWEET_QUOTES:   { method: 'GET', path: '/quotes',        usedFor: 'Quote posts' },
    },
  },

  // ── Instagram ─ upstream ig-downloader-api. NOTE: this is a DIFFERENT
  //    provider from the instagram120 API used before BluGate, so payload
  //    shapes differ and parsers must be verified per endpoint.
  //    ig-downloader exposes no search endpoint (see docs) — there is
  //    deliberately no SEARCH key here.
  instagram: {
    segment: 'instagram',
    label: 'Instagram',
    envKeys: ['BLUGATE_INSTAGRAM_HOST'],
    // The gateway nests the provider's own prefix under the segment.
    pathPrefix: '/api/instagram',
    endpoints: {
      USER_INFO:         { method: 'POST', path: '/userInfo',         usedFor: 'Profile by username or user id' },
      PROFILE:           { method: 'POST', path: '/profile',          usedFor: 'Public profile by username' },
      POSTS:             { method: 'POST', path: '/posts',            usedFor: 'Post feed (paginate with maxId)' },
      REELS:             { method: 'POST', path: '/reels',            usedFor: 'Reels feed' },
      STORIES:           { method: 'POST', path: '/stories',          usedFor: 'Active stories for a username' },
      STORY:             { method: 'POST', path: '/story',            usedFor: 'One story by id' },
      HIGHLIGHTS:        { method: 'POST', path: '/highlights',       usedFor: 'Highlight collections' },
      HIGHLIGHT_STORIES: { method: 'POST', path: '/highlightStories', usedFor: 'Stories inside a highlight' },
      MEDIA_BY_SHORTCODE:{ method: 'POST', path: '/mediaByShortcode', usedFor: 'Post detail by shortcode' },
      TAGGED_POSTS:      { method: 'POST', path: '/taggedPosts',      usedFor: 'Posts tagging a user' },
      COMMENTS:          { method: 'POST', path: '/comments',         usedFor: 'Comments on a post' },
      LINKS:             { method: 'POST', path: '/links',            usedFor: 'Direct media links for a post' },
      FOLLOWERS:         { method: 'POST', path: '/followers',        usedFor: 'Followers of a user' },
      FOLLOWINGS:        { method: 'POST', path: '/followings',       usedFor: 'Accounts a user follows' },
    },
  },

  // ── Facebook ─ upstream facebook-scraper3, unchanged from before BluGate.
  facebook: {
    segment: 'facebook',
    label: 'Facebook',
    envKeys: ['BLUGATE_FACEBOOK_HOST'],
    endpoints: {
      PAGE_DETAILS:  { method: 'GET', path: '/page/details',   usedFor: 'Page profile and stats' },
      PAGE_ID:       { method: 'GET', path: '/page/page_id',   usedFor: 'Resolve a page URL to its id' },
      PAGE_POSTS:    { method: 'GET', path: '/page/posts',     usedFor: 'Recent posts for a page' },
      POST_DETAIL:   { method: 'GET', path: '/post',           usedFor: 'One post by id or url' },
      POST_COMMENTS: { method: 'GET', path: '/post/comments',  usedFor: 'Comments on a post' },
      SEARCH_PAGES:  { method: 'GET', path: '/search/pages',   usedFor: 'Search pages' },
      SEARCH_POSTS:  { method: 'GET', path: '/search/posts',   usedFor: 'Search posts' },
    },
  },

  // ── YouTube ─ upstream YouTube Data API v3. Previously reached through the
  //    googleapis client library; through BluGate these are plain HTTP calls
  //    with the same query parameters the library used to build.
  youtube: {
    segment: 'youtube',
    label: 'YouTube',
    envKeys: ['BLUGATE_YOUTUBE_HOST'],
    endpoints: {
      SEARCH:          { method: 'GET', path: '/search',        usedFor: 'Search videos and channels' },
      CHANNELS:        { method: 'GET', path: '/channels',      usedFor: 'Channel details' },
      VIDEOS:          { method: 'GET', path: '/videos',        usedFor: 'Video details and statistics' },
      PLAYLIST_ITEMS:  { method: 'GET', path: '/playlistItems', usedFor: 'Videos in a playlist' },
      COMMENT_THREADS: { method: 'GET', path: '/commentThreads',usedFor: 'Top-level comments on a video' },
    },
  },
};

/** The config block for a platform, or a clear error naming the valid slugs. */
const getPlatform = (slug) => {
  const platform = PLATFORMS[slug];
  if (!platform) {
    throw new Error(`Unknown BluGate platform "${slug}". Valid: ${Object.keys(PLATFORMS).join(', ')}`);
  }
  return platform;
};

/** One endpoint definition, or an error listing what the platform supports. */
const getEndpoint = (slug, endpointKey) => {
  const platform = getPlatform(slug);
  const endpoint = platform.endpoints[endpointKey];
  if (!endpoint) {
    throw new Error(
      `Unknown ${platform.label} endpoint "${endpointKey}". Valid: ${Object.keys(platform.endpoints).join(', ')}`
    );
  }
  return endpoint;
};

/**
 * Find an endpoint key by its path.
 *
 * The provider services address endpoints by their upstream path ('user-tweets',
 * '/page/posts'), which is what their call sites have always passed. Rather than
 * rewrite every one of those call sites — and risk a typo in each — they resolve
 * through here, so this map stays the single place a path is written down.
 */
const findEndpointKeyByPath = (slug, rawPath) => {
  const platform = getPlatform(slug);
  const wanted = `/${String(rawPath || '').replace(/^\/+/, '').trim()}`;
  const match = Object.entries(platform.endpoints).find(([, e]) => e.path === wanted);
  if (!match) {
    const err = new Error(
      `${platform.label} has no BluGate endpoint for "${wanted}". ` +
      `Available: ${Object.values(platform.endpoints).map((e) => e.path).join(', ')}`
    );
    err.code = 'ENDPOINT_UNSUPPORTED';
    throw err;
  }
  return match[0];
};

module.exports = { PLATFORMS, getPlatform, getEndpoint, findEndpointKeyByPath };
