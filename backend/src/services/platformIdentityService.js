const { buildYouTubeClient } = require('./youtube.service');
const blugate = require('./blugate');
const rapidApiXService = require('./rapidApiXService');
const rapidApiInstagramService = require('./rapidApiInstagramService');
const rapidApiFacebookService = require('./rapidApiFacebookService');

const isLikelyYouTubeChannelId = (value = '') => /^UC[A-Za-z0-9_-]{20,}$/.test(String(value || '').trim());

const parseYouTubeIdentifier = (input = '') => {
  const raw = String(input || '').trim();
  if (!raw) return { channelId: null, handle: null, username: null, query: null };

  if (isLikelyYouTubeChannelId(raw)) {
    return { channelId: raw, handle: null, username: null, query: raw };
  }

  const out = { channelId: null, handle: null, username: null, query: raw };

  if (raw.startsWith('@')) {
    out.handle = raw.slice(1).trim();
    out.query = out.handle;
    return out;
  }

  if (/youtube\.com|youtu\.be/i.test(raw)) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const parts = (url.pathname || '').split('/').filter(Boolean);

      const channelIdx = parts.findIndex((p) => p.toLowerCase() === 'channel');
      if (channelIdx !== -1 && parts[channelIdx + 1] && isLikelyYouTubeChannelId(parts[channelIdx + 1])) {
        out.channelId = parts[channelIdx + 1];
      }

      const atPart = parts.find((p) => p.startsWith('@'));
      if (atPart) {
        out.handle = atPart.slice(1);
      }

      const userIdx = parts.findIndex((p) => p.toLowerCase() === 'user');
      if (userIdx !== -1 && parts[userIdx + 1]) {
        out.username = parts[userIdx + 1];
      }

      const cIdx = parts.findIndex((p) => p.toLowerCase() === 'c');
      if (!out.handle && cIdx !== -1 && parts[cIdx + 1]) {
        out.handle = parts[cIdx + 1];
      }

      const qpChannel = url.searchParams.get('channel_id');
      if (!out.channelId && qpChannel && isLikelyYouTubeChannelId(qpChannel)) {
        out.channelId = qpChannel;
      }

      out.query = out.handle || out.username || out.channelId || out.query;
    } catch {
      // fall through with raw query
    }
  }

  return out;
};

const parseInstagramProfile = (payload) => {
  if (!payload || typeof payload !== 'object') return null;

  const resultArr = payload.result || payload.results;
  const firstResult = Array.isArray(resultArr) ? (resultArr[0]?.user || resultArr[0]) : null;
  const user = firstResult || payload.data || payload.user || payload;

  if (!user || typeof user !== 'object') return null;

  const id = String(user.pk || user.pk_id || user.id || '').trim();
  const username = String(user.username || '').trim();
  const fullName = String(user.full_name || user.name || '').trim();
  const profileImageUrl =
    user.profile_pic_url ||
    user.profile_pic_url_hd ||
    user.hd_profile_pic_url_info?.url ||
    '';

  if (!id && !username) return null;

  return {
    id: id || null,
    username: username || null,
    name: fullName || null,
    profileImageUrl: profileImageUrl || null
  };
};

const parseInstagramHandleFromIdentifier = (identifier = '') => {
  const raw = String(identifier || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || /instagram\.com\//i.test(raw)) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const parts = (url.pathname || '').split('/').filter(Boolean);
      return String(parts[0] || '').replace(/^@/, '').toLowerCase();
    } catch {
      return raw.replace(/^@/, '').toLowerCase();
    }
  }
  return raw.replace(/^@/, '').toLowerCase();
};

const resolveYouTubeIdentity = async (identifier) => {
  const parsed = parseYouTubeIdentifier(identifier);

  if (parsed.channelId) {
    return {
      platformUserId: parsed.channelId,
      normalizedIdentifier: parsed.channelId,
      resolvedDisplayName: null,
      profileImageUrl: null,
      method: 'channel-id'
    };
  }

  // YouTube reaches the provider through BluGate, so availability depends on
  // this tenant's credentials rather than a shared environment key.
  if (!(await blugate.isConfigured('youtube'))) {
    return { platformUserId: null, normalizedIdentifier: parsed.query || identifier, method: 'youtube-not-configured' };
  }

  const youtube = buildYouTubeClient();

  const tryForHandle = async (handle) => {
    if (!handle) return null;
    try {
      const response = await youtube.channels.list({ part: ['snippet'], forHandle: handle, maxResults: 1 });
      const item = response?.data?.items?.[0];
      if (!item?.id) return null;
      return {
        platformUserId: item.id,
        normalizedIdentifier: item.id,
        resolvedDisplayName: item.snippet?.title || null,
        profileImageUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
        method: 'forHandle'
      };
    } catch {
      return null;
    }
  };

  const tryForUsername = async (username) => {
    if (!username) return null;
    try {
      const response = await youtube.channels.list({ part: ['snippet'], forUsername: username, maxResults: 1 });
      const item = response?.data?.items?.[0];
      if (!item?.id) return null;
      return {
        platformUserId: item.id,
        normalizedIdentifier: item.id,
        resolvedDisplayName: item.snippet?.title || null,
        profileImageUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
        method: 'forUsername'
      };
    } catch {
      return null;
    }
  };

  const trySearch = async (query) => {
    if (!query) return null;
    try {
      const searchRes = await youtube.search.list({ part: ['snippet'], q: query, type: ['channel'], maxResults: 1 });
      const item = searchRes?.data?.items?.[0];
      const channelId = item?.snippet?.channelId || item?.id?.channelId;
      if (!channelId) return null;
      return {
        platformUserId: channelId,
        normalizedIdentifier: channelId,
        resolvedDisplayName: item.snippet?.channelTitle || item.snippet?.title || null,
        profileImageUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
        method: 'search'
      };
    } catch {
      return null;
    }
  };

  return (
    (await tryForHandle(parsed.handle || parsed.query)) ||
    (await tryForUsername(parsed.username || parsed.query)) ||
    (await trySearch(parsed.query)) ||
    { platformUserId: null, normalizedIdentifier: parsed.query || identifier, method: 'unresolved' }
  );
};

const resolveXIdentity = async (identifier) => {
  const clean = String(identifier || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return { platformUserId: null, normalizedIdentifier: clean, method: 'invalid' };

  const profile = await rapidApiXService.fetchUserProfile(clean);
  return {
    platformUserId: profile?.id ? String(profile.id) : null,
    normalizedIdentifier: (profile?.screenName || clean).toLowerCase(),
    resolvedDisplayName: profile?.name || null,
    profileImageUrl: profile?.profileImageUrl || null,
    isVerified: !!profile?.isVerified,
    method: profile?.id ? 'rapidapi' : 'unresolved'
  };
};

const resolveXIdentityFromSource = async (source) => {
  const stableId = String(source?.platform_user_id || '').trim();
  if (stableId && rapidApiXService.fetchUserProfileById) {
    const byId = await rapidApiXService.fetchUserProfileById(stableId);
    if (byId?.id) {
      let resolvedScreenName = byId.screenName || null;

      // Some RapidAPI user-by-id payloads provide id but omit screen name.
      // In that case, search by display hints and match by stable id.
      if (!resolvedScreenName && typeof rapidApiXService.searchUsers === 'function') {
        const idAsString = String(byId.id);
        const identifierHint = String(source?.identifier || '').replace(/^@/, '').trim();
        const identifierBaseHint = identifierHint.replace(/[0-9_]+$/g, '').trim();
        const queryCandidates = [
          String(source?.display_name || '').trim(),
          identifierHint,
          identifierBaseHint
        ].filter((q) => q && q.length >= 3);

        const seen = new Set();
        for (const query of queryCandidates) {
          const qKey = query.toLowerCase();
          if (seen.has(qKey)) continue;
          seen.add(qKey);

          const users = await rapidApiXService.searchUsers(query);
          const match = Array.isArray(users)
            ? users.find((u) => String(u?.id || '') === idAsString)
            : null;

          if (match?.screen_name) {
            resolvedScreenName = String(match.screen_name).replace(/^@/, '').trim();
            break;
          }
        }
      }

      return {
        platformUserId: String(byId.id),
        normalizedIdentifier: (resolvedScreenName || String(source?.identifier || '')).toLowerCase(),
        resolvedDisplayName: byId.name || null,
        profileImageUrl: byId.profileImageUrl || null,
        isVerified: !!byId.isVerified,
        method: 'rapidapi-by-id'
      };
    }
  }
  return resolveXIdentity(source?.identifier || '');
};

const resolveInstagramIdentity = async (identifier) => {
  const clean = String(identifier || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return { platformUserId: null, normalizedIdentifier: clean, method: 'invalid' };

  const profileRaw = await rapidApiInstagramService.fetchUserProfile(clean);
  const profile = parseInstagramProfile(profileRaw);

  return {
    platformUserId: profile?.id ? String(profile.id) : null,
    normalizedIdentifier: (profile?.username || clean).toLowerCase(),
    resolvedDisplayName: profile?.name || null,
    profileImageUrl: profile?.profileImageUrl || null,
    method: profile?.id ? 'rapidapi' : 'unresolved'
  };
};

const resolveInstagramIdentityFromSource = async (source) => {
  const currentHandle = parseInstagramHandleFromIdentifier(source?.identifier || '');
  const oldHandles = Array.isArray(source?.old_identifiers)
    ? source.old_identifiers.map((h) => parseInstagramHandleFromIdentifier(h)).filter(Boolean)
    : [];

  const candidateHandles = Array.from(new Set([currentHandle, ...oldHandles].filter(Boolean)));
  let inferredHandle = '';
  if (typeof rapidApiInstagramService.inferUsernameFromProfileUrl === 'function' && candidateHandles.length > 0) {
    for (const candidate of candidateHandles) {
      const inferred = await rapidApiInstagramService.inferUsernameFromProfileUrl(candidate);
      if (inferred) {
        inferredHandle = String(inferred).replace(/^@/, '').toLowerCase();
        break;
      }
    }
  }

  const stableId = String(source?.platform_user_id || '').trim();
  if (stableId && typeof rapidApiInstagramService.fetchUserProfileById === 'function') {
    const profileRaw = await rapidApiInstagramService.fetchUserProfileById(stableId);
    const profile = parseInstagramProfile(profileRaw);
    if (profile?.id || profile?.username) {
      const profileHandle = (profile?.username || currentHandle || '').toLowerCase();
      const normalizedIdentifier = inferredHandle || profileHandle;
      return {
        platformUserId: profile?.id ? String(profile.id) : stableId,
        normalizedIdentifier,
        resolvedDisplayName: profile?.name || null,
        profileImageUrl: profile?.profileImageUrl || null,
        method: inferredHandle && inferredHandle !== profileHandle ? 'rapidapi-by-id+links-fallback' : 'rapidapi-by-id'
      };
    }
  }

  const handle = inferredHandle || currentHandle;
  if (!handle) return { platformUserId: stableId || null, normalizedIdentifier: '', method: 'invalid' };
  const resolved = await resolveInstagramIdentity(handle);
  if (inferredHandle) {
    return {
      ...resolved,
      normalizedIdentifier: inferredHandle,
      method: resolved?.method === 'rapidapi' ? 'rapidapi+links-fallback' : (resolved?.method || 'links-fallback')
    };
  }
  return resolved;
};

const resolveFacebookIdentity = async (identifier) => {
  const details = await rapidApiFacebookService.fetchPageDetails(identifier);
  return {
    platformUserId: details?.id ? String(details.id) : null,
    normalizedIdentifier: details?.url || identifier,
    resolvedDisplayName: details?.name || null,
    profileImageUrl: details?.image || null,
    isVerified: details?.is_verified ?? null,
    method: details?.id ? 'rapidapi' : 'unresolved'
  };
};

const resolveFacebookIdentityFromSource = async (source) => {
  const stableId = String(source?.platform_user_id || '').trim();
  if (stableId) {
    const byId = await resolveFacebookIdentity(stableId);
    if (byId?.platformUserId) {
      return {
        ...byId,
        normalizedIdentifier: byId?.normalizedIdentifier || source?.identifier || ''
      };
    }
  }
  return resolveFacebookIdentity(source?.identifier || '');
};

const resolveYouTubeIdentityFromSource = async (source) => {
  const channelId = String(source?.platform_user_id || source?.identifier || '').trim();
  if (isLikelyYouTubeChannelId(channelId)) {
    if (!(await blugate.isConfigured('youtube'))) {
      return {
        platformUserId: channelId,
        normalizedIdentifier: channelId,
        resolvedDisplayName: null,
        method: 'channel-id-no-api'
      };
    }

    try {
      const youtube = buildYouTubeClient();
      const response = await youtube.channels.list({ part: ['snippet'], id: [channelId], maxResults: 1 });
      const item = response?.data?.items?.[0];
      const custom = item?.snippet?.customUrl || null;
      const normalizedHandle = custom ? (custom.startsWith('@') ? custom : `@${custom}`) : (source?.identifier || channelId);

      return {
        platformUserId: channelId,
        normalizedIdentifier: channelId,
        currentHandle: normalizedHandle,
        resolvedDisplayName: item?.snippet?.title || null,
        profileImageUrl: item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.default?.url || null,
        method: 'youtube-channel-id'
      };
    } catch {
      return {
        platformUserId: channelId,
        normalizedIdentifier: channelId,
        method: 'youtube-channel-id-fallback'
      };
    }
  }

  return resolveYouTubeIdentity(source?.identifier || '');
};

const resolvePlatformIdentity = async (platform, identifier) => {
  const p = String(platform || '').toLowerCase();
  if (!identifier) {
    return { platformUserId: null, normalizedIdentifier: identifier, method: 'invalid' };
  }

  try {
    if (p === 'youtube') return await resolveYouTubeIdentity(identifier);
    if (p === 'x' || p === 'twitter') return await resolveXIdentity(identifier);
    if (p === 'instagram') return await resolveInstagramIdentity(identifier);
    if (p === 'facebook') return await resolveFacebookIdentity(identifier);
  } catch (error) {
    return {
      platformUserId: null,
      normalizedIdentifier: identifier,
      method: 'error',
      error: error.message
    };
  }

  return { platformUserId: null, normalizedIdentifier: identifier, method: 'unsupported' };
};

const refreshPlatformIdentity = async (source) => {
  const p = String(source?.platform || '').toLowerCase();
  if (!p) {
    return { platformUserId: null, normalizedIdentifier: source?.identifier || '', method: 'invalid' };
  }

  try {
    if (p === 'youtube') return await resolveYouTubeIdentityFromSource(source);
    if (p === 'x' || p === 'twitter') return await resolveXIdentityFromSource(source);
    if (p === 'instagram') return await resolveInstagramIdentityFromSource(source);
    if (p === 'facebook') return await resolveFacebookIdentityFromSource(source);
  } catch (error) {
    return {
      platformUserId: source?.platform_user_id || null,
      normalizedIdentifier: source?.identifier || '',
      method: 'error',
      error: error.message
    };
  }

  return { platformUserId: null, normalizedIdentifier: source?.identifier || '', method: 'unsupported' };
};

module.exports = {
  resolvePlatformIdentity,
  refreshPlatformIdentity
};
