const VIDEO_URL_RE = /\.(mp4|webm|mov|mkv|m3u8)(\?|$)/i;
const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;
const INSTAGRAM_STORY_URL_RE = /instagram\.com\/stories\//i;
const S3_URL_RE = /(amazonaws\.com|\bs3[.-]|bhaskar-media-storage)/i;
const GENERATED_STORY_ID_RE = /^(?:content|alert|captured)-story-/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asArray = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value]));

const cleanString = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const uniqueStrings = (...values) => {
  const seen = new Set();
  const items = [];

  const push = (value) => {
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }

    const text = cleanString(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    items.push(text);
  };

  values.forEach(push);
  return items;
};

const normalizeMediaType = (value) => String(value ?? '').trim().toLowerCase();
const isVideoType = (value) => ['video', 'animated_gif', 'gifv', '2'].includes(normalizeMediaType(value));
const isImageType = (value) => ['photo', 'image', '1'].includes(normalizeMediaType(value));
const looksLikeVideoUrl = (url) => typeof url === 'string' && VIDEO_URL_RE.test(url);
const looksLikeImageUrl = (url) => typeof url === 'string' && IMAGE_URL_RE.test(url);
const isS3LikeUrl = (url) => typeof url === 'string' && S3_URL_RE.test(url);

const normalizeHandle = (value) => {
  const handle = cleanString(value);
  if (!handle) return '';

  if (handle.includes('instagram.com/')) {
    try {
      const parsed = new URL(handle.startsWith('http') ? handle : `https://${handle}`);
      const [firstPathPart] = parsed.pathname.split('/').filter(Boolean);
      return cleanString(firstPathPart).replace(/^@/, '').toLowerCase();
    } catch (_) {
      return handle.replace(/^@/, '').toLowerCase();
    }
  }

  return handle.replace(/^@/, '').toLowerCase();
};

export const parseInstagramStoryTimestamp = (value) => {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();

  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }

  const text = cleanString(String(value));
  if (!text) return Number.NaN;

  if (/^\d+$/.test(text)) {
    const num = Number(text);
    return num < 1e12 ? num * 1000 : num;
  }

  const parsed = new Date(text).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
};

const normalizeStoryUrl = (url) => {
  const raw = cleanString(url);
  if (!raw) return '';

  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (!INSTAGRAM_STORY_URL_RE.test(parsed.href)) return '';

    const normalizedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    return `https://www.instagram.com${normalizedPath}`;
  } catch (_) {
    return '';
  }
};

const extractStoryPkFromUrl = (url) => {
  const normalizedUrl = normalizeStoryUrl(url);
  if (!normalizedUrl) return '';
  const match = normalizedUrl.match(/\/stories\/[^/]+\/([^/]+)\//i);
  return cleanString(match?.[1]);
};

const normalizeStoryPkValue = (value) => {
  if (value == null) return '';
  const text = cleanString(String(value));
  if (!text) return '';
  if (UUID_RE.test(text) || GENERATED_STORY_ID_RE.test(text)) return '';
  return text;
};

const firstMeaningful = (...values) => {
  for (const value of values) {
    if (value === false || value === 0) return value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object') return value;
  }
  return '';
};

const urlFromVariant = (variant) => {
  if (typeof variant === 'string') return cleanString(variant);
  if (!variant || typeof variant !== 'object') return '';
  return cleanString(variant.url || variant.src);
};

const collectVariantUrls = (variants) => uniqueStrings(asArray(variants).map(urlFromVariant));

const normalizeMediaEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') return { url: entry };
  return entry?.node || entry?.media || entry?.story || entry?.item || entry;
};

const collectMediaEntries = (story) => {
  const raw = story?.raw_data || {};
  return [
    ...asArray(story?.media),
    ...asArray(raw?.media),
    ...asArray(raw?.items),
    ...asArray(raw?.carousel_media)
  ]
    .map(normalizeMediaEntry)
    .filter(Boolean);
};

const collectMediaVideoUrls = (entries) => {
  const urls = [];

  entries.forEach((entry) => {
    const mediaType = normalizeMediaType(entry?.type || entry?.media_type || entry?.mime_type);
    const versionUrls = uniqueStrings(
      collectVariantUrls(entry?.video_versions),
      collectVariantUrls(entry?.videoVersions)
    );

    const directUrls = uniqueStrings(
      entry?.s3_url,
      entry?.video_url,
      entry?.videoUrl,
      entry?.original_video_url,
      looksLikeVideoUrl(entry?.original_url) ? entry?.original_url : '',
      looksLikeVideoUrl(entry?.url) || isVideoType(mediaType) ? entry?.url : '',
      looksLikeVideoUrl(entry?.src) || isVideoType(mediaType) ? entry?.src : '',
      looksLikeVideoUrl(entry?.playable_url) ? entry?.playable_url : '',
      looksLikeVideoUrl(entry?.hd_url) ? entry?.hd_url : '',
      looksLikeVideoUrl(entry?.sd_url) ? entry?.sd_url : ''
    );

    const isVideoEntry = isVideoType(mediaType)
      || Boolean(entry?.is_video)
      || versionUrls.length > 0
      || directUrls.some(looksLikeVideoUrl);

    if (isVideoEntry) {
      urls.push(...directUrls, ...versionUrls);
    }
  });

  return uniqueStrings(urls);
};

const collectMediaImageUrls = (entries) => {
  const urls = [];

  entries.forEach((entry) => {
    const mediaType = normalizeMediaType(entry?.type || entry?.media_type || entry?.mime_type);
    const imageVariantUrls = uniqueStrings(
      collectVariantUrls(entry?.image_versions2?.candidates),
      collectVariantUrls(entry?.image_versions),
      collectVariantUrls(entry?.display_resources)
    );

    const previewUrls = uniqueStrings(
      entry?.s3_preview,
      entry?.s3_thumbnail_url,
      entry?.preview,
      entry?.preview_url,
      entry?.original_preview,
      entry?.original_preview_url,
      entry?.thumbnail_url,
      entry?.thumbnail_src,
      entry?.image_url,
      entry?.display_url,
      entry?.cover_frame_url
    );

    const mainImageUrls = uniqueStrings(
      !looksLikeVideoUrl(entry?.s3_url) ? entry?.s3_url : '',
      !looksLikeVideoUrl(entry?.original_url) ? entry?.original_url : '',
      (!looksLikeVideoUrl(entry?.url) || isImageType(mediaType)) ? entry?.url : '',
      (!looksLikeVideoUrl(entry?.src) || isImageType(mediaType)) ? entry?.src : ''
    );

    urls.push(...previewUrls, ...mainImageUrls, ...imageVariantUrls);
  });

  return uniqueStrings(urls);
};

export const buildInstagramStoryDedupeKey = (story, index = 0) => {
  const storyPk = firstMeaningful(
    normalizeStoryPkValue(story?.story_pk),
    normalizeStoryPkValue(story?.pk),
    normalizeStoryPkValue(story?.content_id),
    normalizeStoryPkValue(story?.raw_data?.story_pk),
    normalizeStoryPkValue(story?.raw_data?.pk),
    normalizeStoryPkValue(story?.raw_data?.id),
    extractStoryPkFromUrl(story?.story_url),
    extractStoryPkFromUrl(story?.permalink),
    extractStoryPkFromUrl(story?.content_url),
    extractStoryPkFromUrl(story?.url),
    extractStoryPkFromUrl(story?.raw_data?.permalink)
  );

  if (storyPk) return `story_pk:${storyPk}`;

  const normalizedStoryUrl = firstMeaningful(
    normalizeStoryUrl(story?.story_url),
    normalizeStoryUrl(story?.permalink),
    normalizeStoryUrl(story?.content_url),
    normalizeStoryUrl(story?.url),
    normalizeStoryUrl(story?.raw_data?.permalink)
  );

  if (normalizedStoryUrl) return `story_url:${normalizedStoryUrl}`;

  const normalizedHandle = normalizeHandle(story?.author_handle || story?.raw_data?.user?.username || story?.source_meta?.handle);
  const publishedAt = parseInstagramStoryTimestamp(
    story?.published_at
    || story?.created_at
    || story?.updated_at
    || story?.raw_data?.taken_at
    || story?.raw_data?.published_at
  );

  if (normalizedHandle && !Number.isNaN(publishedAt)) {
    return `story:${normalizedHandle}:${publishedAt}`;
  }

  return `story_id:${normalizeStoryPkValue(story?.id) || index}`;
};

const mergeVersionLists = (...lists) => {
  const seen = new Set();
  const merged = [];

  const push = (entry) => {
    if (!entry) return;
    const normalized = typeof entry === 'string'
      ? { url: entry }
      : { ...entry, url: entry.url || entry.src || '' };

    const url = cleanString(normalized.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    merged.push(normalized);
  };

  lists.forEach((list) => {
    asArray(list).forEach(push);
  });

  return merged;
};

const mergeMediaEntries = (...lists) => {
  const seen = new Set();
  const merged = [];

  const push = (entry) => {
    const normalized = normalizeMediaEntry(entry);
    if (!normalized) return;

    const key = cleanString(
      normalized.s3_url
      || normalized.video_url
      || normalized.url
      || normalized.preview
      || normalized.preview_url
      || normalized.thumbnail_url
      || normalized.image_url
    ) || JSON.stringify(normalized);

    if (seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  };

  lists.forEach((list) => {
    asArray(list).forEach(push);
  });

  return merged;
};

const resolveAvailability = (...values) => {
  const explicitValues = values.filter((value) => value === true || value === false);
  if (!explicitValues.length) return true;
  if (explicitValues.some((value) => value === false)) return false;
  return true;
};

export const getInstagramStoryMediaSources = (story) => {
  const raw = story?.raw_data || {};
  const mediaEntries = collectMediaEntries(story);
  const normalizedHandle = normalizeHandle(story?.author_handle || raw?.user?.username || story?.source_meta?.handle);
  const storyPk = firstMeaningful(
    normalizeStoryPkValue(story?.story_pk),
    normalizeStoryPkValue(story?.pk),
    normalizeStoryPkValue(story?.content_id),
    normalizeStoryPkValue(raw?.story_pk),
    normalizeStoryPkValue(raw?.pk),
    normalizeStoryPkValue(raw?.id),
    extractStoryPkFromUrl(story?.story_url),
    extractStoryPkFromUrl(story?.permalink),
    extractStoryPkFromUrl(story?.content_url),
    extractStoryPkFromUrl(story?.url),
    extractStoryPkFromUrl(raw?.permalink)
  );

  const explicitVideo = isVideoType(story?.media_type)
    || isVideoType(raw?.media_type)
    || Boolean(story?.is_video)
    || Boolean(raw?.is_video)
    || Boolean(story?.video_duration)
    || Boolean(raw?.video_duration)
    || asArray(story?.video_versions).length > 0
    || asArray(story?.videoVersions).length > 0
    || asArray(raw?.video_versions).length > 0
    || asArray(raw?.videoVersions).length > 0
    || Boolean(story?.video_url)
    || Boolean(story?.videoUrl)
    || Boolean(raw?.video_url)
    || Boolean(raw?.videoUrl);

  const videoUrls = uniqueStrings(
    story?._videoCandidateUrls,
    story?.s3_url && (explicitVideo || looksLikeVideoUrl(story?.s3_url)) ? story?.s3_url : '',
    story?.original_video_url,
    story?.video_url,
    story?.videoUrl,
    looksLikeVideoUrl(story?.original_url) || explicitVideo ? story?.original_url : '',
    raw?.s3_url && (isVideoType(raw?.media_type) || looksLikeVideoUrl(raw?.s3_url)) ? raw?.s3_url : '',
    raw?.original_video_url,
    raw?.video_url,
    raw?.videoUrl,
    looksLikeVideoUrl(raw?.original_url) || isVideoType(raw?.media_type) ? raw?.original_url : '',
    collectVariantUrls(story?.video_versions),
    collectVariantUrls(story?.videoVersions),
    collectVariantUrls(raw?.video_versions),
    collectVariantUrls(raw?.videoVersions),
    collectMediaVideoUrls(mediaEntries)
  );

  const imageUrls = uniqueStrings(
    story?._imageCandidateUrls,
    !explicitVideo && story?.s3_url ? story?.s3_url : '',
    story?.s3_thumbnail_url,
    story?.preview,
    story?.preview_url,
    story?.thumbnail_url,
    story?.thumbnail_src,
    story?.display_url,
    story?.image_url,
    !explicitVideo && !looksLikeVideoUrl(story?.original_url) ? story?.original_url : '',
    raw?.s3_thumbnail_url,
    raw?.preview,
    raw?.preview_url,
    raw?.thumbnail_url,
    raw?.thumbnail_src,
    raw?.display_url,
    raw?.image_url,
    raw?.cover_frame_url,
    collectVariantUrls(story?.image_versions2?.candidates),
    collectVariantUrls(story?.image_versions),
    collectVariantUrls(story?.display_resources),
    collectVariantUrls(raw?.image_versions2?.candidates),
    collectVariantUrls(raw?.image_versions),
    collectVariantUrls(raw?.display_resources),
    collectMediaImageUrls(mediaEntries)
  );

  const canonicalStoryUrl = normalizedHandle && storyPk
    ? `https://www.instagram.com/stories/${normalizedHandle}/${storyPk}/`
    : '';

  const publicStoryUrls = uniqueStrings(
    story?._publicStoryUrls,
    normalizeStoryUrl(story?.story_url),
    normalizeStoryUrl(story?.permalink),
    normalizeStoryUrl(story?.content_url),
    normalizeStoryUrl(story?.url),
    normalizeStoryUrl(raw?.permalink),
    canonicalStoryUrl
  ).filter((url) => INSTAGRAM_STORY_URL_RE.test(url) && !isS3LikeUrl(url));

  const isVideoStory = explicitVideo || videoUrls.length > 0;

  return {
    storyPk,
    normalizedHandle,
    publicStoryUrls,
    videoUrls,
    imageUrls,
    isVideoStory
  };
};

export const mergeInstagramStoriesByIdentity = (stories = []) => {
  const mergedStories = new Map();

  stories.forEach((story, index) => {
    if (!story || typeof story !== 'object') return;

    const key = buildInstagramStoryDedupeKey(story, index);
    const incomingSources = getInstagramStoryMediaSources(story);
    const existing = mergedStories.get(key);

    if (!existing) {
      mergedStories.set(key, {
        ...story,
        story_pk: firstMeaningful(story?.story_pk, incomingSources.storyPk),
        author_handle: firstMeaningful(story?.author_handle, incomingSources.normalizedHandle),
        _videoCandidateUrls: incomingSources.videoUrls,
        _imageCandidateUrls: incomingSources.imageUrls,
        _publicStoryUrls: incomingSources.publicStoryUrls
      });
      return;
    }

    const existingSources = getInstagramStoryMediaSources(existing);

    mergedStories.set(key, {
      ...existing,
      id: firstMeaningful(existing?.id, story?.id),
      story_pk: firstMeaningful(existing?.story_pk, story?.story_pk, existingSources.storyPk, incomingSources.storyPk),
      author: firstMeaningful(existing?.author, story?.author),
      author_handle: firstMeaningful(existing?.author_handle, story?.author_handle, existingSources.normalizedHandle, incomingSources.normalizedHandle),
      author_avatar: firstMeaningful(existing?.author_avatar, story?.author_avatar),
      media_type: existingSources.isVideoStory || incomingSources.isVideoStory
        ? 'video'
        : firstMeaningful(existing?.media_type, story?.media_type, 'image'),
      story_url: firstMeaningful(existing?.story_url, story?.story_url, existingSources.publicStoryUrls[0], incomingSources.publicStoryUrls[0]),
      permalink: firstMeaningful(existing?.permalink, story?.permalink, existingSources.publicStoryUrls[0], incomingSources.publicStoryUrls[0]),
      content_url: firstMeaningful(existing?.content_url, story?.content_url, existingSources.publicStoryUrls[0], incomingSources.publicStoryUrls[0]),
      s3_url: firstMeaningful(existing?.s3_url, story?.s3_url),
      s3_thumbnail_url: firstMeaningful(existing?.s3_thumbnail_url, story?.s3_thumbnail_url),
      original_url: firstMeaningful(
        existing?.original_url,
        story?.original_url,
        existing?.original_video_url,
        story?.original_video_url,
        existingSources.videoUrls[0],
        incomingSources.videoUrls[0],
        existingSources.imageUrls[0],
        incomingSources.imageUrls[0]
      ),
      original_video_url: firstMeaningful(existing?.original_video_url, story?.original_video_url, existing?.video_url, story?.video_url, story?.videoUrl),
      video_url: firstMeaningful(existing?.video_url, story?.video_url, story?.videoUrl),
      thumbnail_url: firstMeaningful(
        existing?.thumbnail_url,
        story?.thumbnail_url,
        existing?.preview,
        story?.preview,
        existingSources.imageUrls[0],
        incomingSources.imageUrls[0]
      ),
      preview: firstMeaningful(existing?.preview, story?.preview, existingSources.imageUrls[0], incomingSources.imageUrls[0]),
      preview_url: firstMeaningful(existing?.preview_url, story?.preview_url),
      display_url: firstMeaningful(existing?.display_url, story?.display_url),
      image_url: firstMeaningful(existing?.image_url, story?.image_url),
      video_versions: mergeVersionLists(existing?.video_versions, story?.video_versions, story?.videoVersions),
      media: mergeMediaEntries(existing?.media, story?.media),
      raw_data: firstMeaningful(existing?.raw_data, story?.raw_data),
      caption: firstMeaningful(existing?.caption, story?.caption),
      published_at: firstMeaningful(existing?.published_at, story?.published_at, existing?.created_at, story?.created_at),
      created_at: firstMeaningful(existing?.created_at, story?.created_at),
      updated_at: firstMeaningful(story?.updated_at, existing?.updated_at),
      expires_at: firstMeaningful(existing?.expires_at, story?.expires_at),
      is_available: resolveAvailability(existing?.is_available, story?.is_available),
      deleted_at: firstMeaningful(story?.deleted_at, existing?.deleted_at),
      is_archived: Boolean(
        existing?.is_archived
        || story?.is_archived
        || existing?.s3_url
        || story?.s3_url
        || existing?.s3_thumbnail_url
        || story?.s3_thumbnail_url
      ),
      _videoCandidateUrls: uniqueStrings(existing?._videoCandidateUrls, existingSources.videoUrls, incomingSources.videoUrls),
      _imageCandidateUrls: uniqueStrings(existing?._imageCandidateUrls, existingSources.imageUrls, incomingSources.imageUrls),
      _publicStoryUrls: uniqueStrings(existing?._publicStoryUrls, existingSources.publicStoryUrls, incomingSources.publicStoryUrls)
    });
  });

  return Array.from(mergedStories.values());
};

export const mapInstagramStoryToAlert = (story, index = 0) => {
  const mediaSources = getInstagramStoryMediaSources(story);
  const storyPk = firstMeaningful(story?.story_pk, mediaSources.storyPk, story?.id, `story-${index}`);
  const publishedAt = firstMeaningful(story?.published_at, story?.created_at, story?.updated_at, new Date().toISOString());
  const rawMediaType = normalizeMediaType(story?.media_type || story?.raw_data?.media_type);
  const primaryVideoUrl = cleanString(
    firstMeaningful(
      mediaSources.videoUrls[0],
      story?.video_url,
      story?.original_video_url,
      isVideoType(rawMediaType) ? story?.s3_url : '',
      isVideoType(rawMediaType) ? story?.original_url : ''
    )
  );
  const primaryImageUrl = mediaSources.imageUrls[0] || '';
  const resolvedMediaType = (mediaSources.isVideoStory || isVideoType(rawMediaType) || Boolean(primaryVideoUrl)) ? 'video' : 'photo';
  const mediaUrl = resolvedMediaType === 'video'
    ? (primaryVideoUrl || primaryImageUrl)
    : (primaryImageUrl || primaryVideoUrl);
  const previewUrl = primaryImageUrl || mediaUrl || '';
  const publicStoryUrl = mediaSources.publicStoryUrls[0] || '';
  const storyLinkUrl = publicStoryUrl || cleanString(story?.story_url || story?.permalink || story?.content_url || story?.url);
  const previewFallbackUrls = uniqueStrings(
    mediaSources.imageUrls.filter((url) => url !== previewUrl),
    !storyLinkUrl && looksLikeImageUrl(story?.thumbnail_url) ? story?.thumbnail_url : ''
  );

  const mediaItem = mediaUrl ? {
    type: resolvedMediaType,
    media_type: resolvedMediaType,
    url: mediaUrl,
    video_url: primaryVideoUrl || undefined,
    original_url: firstMeaningful(story?.original_url, mediaUrl) || undefined,
    original_video_url: firstMeaningful(story?.original_video_url, primaryVideoUrl) || undefined,
    preview: previewUrl || mediaUrl,
    s3_url: cleanString(story?.s3_url) || undefined,
    s3_preview: cleanString(story?.s3_thumbnail_url) || undefined,
    video_versions: mergeVersionLists(story?.video_versions, story?.videoVersions),
    fallback_urls: resolvedMediaType === 'video'
      ? uniqueStrings(mediaSources.videoUrls.filter((url) => url !== primaryVideoUrl))
      : uniqueStrings(mediaSources.imageUrls.filter((url) => url !== mediaUrl)),
    preview_fallback_urls: previewFallbackUrls
  } : null;

  return {
    id: `captured-story-${storyPk}`,
    platform: 'instagram',
    status: 'active',
    risk_level: 'low',
    alert_type: 'content',
    created_at: publishedAt,
    timestamp: publishedAt,
    content_url: storyLinkUrl,
    author: firstMeaningful(story?.author, story?.author_handle, 'Instagram User'),
    author_handle: cleanString(story?.author_handle),
    is_story_archive: true,
    is_available: story?.is_available,
    content_details: {
      id: storyPk,
      platform: 'instagram',
      content_type: 'story',
      content_url: storyLinkUrl,
      text: firstMeaningful(story?.caption, '') || '',
      author_handle: cleanString(story?.author_handle),
      published_at: publishedAt,
      media: mediaItem ? [mediaItem] : [],
      is_deleted: story?.is_available === false,
      is_available: story?.is_available,
      deleted_at: story?.deleted_at || null,
      is_archived: Boolean(story?.is_archived || story?.s3_url || story?.s3_thumbnail_url),
      s3_url: cleanString(story?.s3_url) || null,
      s3_thumbnail_url: cleanString(story?.s3_thumbnail_url) || null
    },
    source_meta: {
      name: firstMeaningful(story?.author, story?.author_handle, 'Instagram User'),
      handle: cleanString(story?.author_handle),
      profile_image_url: cleanString(story?.author_avatar),
      is_verified: false
    }
  };
};

export const instagramStoryMediaUtils = {
  looksLikeVideoUrl,
  looksLikeImageUrl,
  normalizeHandle
};
