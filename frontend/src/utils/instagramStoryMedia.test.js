import {
  buildInstagramStoryDedupeKey,
  getInstagramStoryMediaSources,
  mapInstagramStoryToAlert,
  mergeInstagramStoriesByIdentity
} from './instagramStoryMedia';

describe('instagramStoryMedia', () => {
  const s3VideoUrl = 'https://bhaskar-media-storage.s3.eu-north-1.amazonaws.com/instagram-stories/123456789.mp4';
  const s3ThumbUrl = 'https://bhaskar-media-storage.s3.eu-north-1.amazonaws.com/instagram-stories/123456789_thumb.jpg';
  const apiVideoUrl = 'https://video.cdninstagram.com/story-123456789-main.mp4';
  const apiFallbackVideoUrl = 'https://video.cdninstagram.com/story-123456789-480.mp4';
  const apiPreviewUrl = 'https://scontent.cdninstagram.com/story-123456789.jpg';
  const canonicalStoryUrl = 'https://www.instagram.com/stories/demo_user/123456789/';

  it('merges duplicate story variants by story pk instead of transient ids', () => {
    const dbStory = {
      id: '3fb26c32-2bd7-4bf7-b120-1361062d7f7f',
      story_pk: '123456789',
      author: 'Demo User',
      author_handle: 'demo_user',
      media_type: 'video',
      s3_url: s3VideoUrl,
      s3_thumbnail_url: s3ThumbUrl,
      original_url: apiVideoUrl,
      video_versions: [{ url: apiFallbackVideoUrl }],
      published_at: '2026-03-15T08:00:00.000Z'
    };

    const apiStory = {
      id: 'content-story-4',
      story_pk: '123456789',
      author: 'Demo User',
      author_handle: '@demo_user',
      media_type: 'video',
      original_url: apiVideoUrl,
      thumbnail_url: apiPreviewUrl,
      story_url: canonicalStoryUrl,
      media: [{ type: 'video', url: apiVideoUrl, preview: apiPreviewUrl }],
      video_versions: [{ url: apiFallbackVideoUrl }],
      published_at: '2026-03-15T08:00:00.000Z'
    };

    const merged = mergeInstagramStoriesByIdentity([dbStory, apiStory]);

    expect(merged).toHaveLength(1);
    expect(merged[0].story_pk).toBe('123456789');

    const mediaSources = getInstagramStoryMediaSources(merged[0]);
    expect(mediaSources.videoUrls[0]).toBe(s3VideoUrl);
    expect(mediaSources.videoUrls).toEqual(expect.arrayContaining([apiVideoUrl, apiFallbackVideoUrl]));
    expect(mediaSources.publicStoryUrls[0]).toBe(canonicalStoryUrl);
  });

  it('falls back to canonical Instagram story URL when story pk is missing', () => {
    const firstVariant = {
      id: 'db-story-1',
      author_handle: 'demo_user',
      story_url: 'https://www.instagram.com/stories/demo_user/999888777/?hl=en',
      published_at: '2026-03-15T09:00:00.000Z'
    };

    const secondVariant = {
      id: 'content-story-9',
      author_handle: '@demo_user',
      content_url: 'https://www.instagram.com/stories/demo_user/999888777/',
      published_at: '2026-03-15T09:00:00.000Z'
    };

    expect(buildInstagramStoryDedupeKey(firstVariant)).toBe(buildInstagramStoryDedupeKey(secondVariant));
    expect(mergeInstagramStoriesByIdentity([firstVariant, secondVariant])).toHaveLength(1);
  });

  it('maps merged video stories to alert cards with S3-first video and preview fallbacks', () => {
    const mergedStory = mergeInstagramStoriesByIdentity([
      {
        id: 'b4f7f001-9c7f-4f7b-9858-123123123123',
        story_pk: '123456789',
        author: 'Demo User',
        author_handle: 'demo_user',
        media_type: 'video',
        s3_url: s3VideoUrl,
        s3_thumbnail_url: s3ThumbUrl,
        original_url: apiVideoUrl,
        video_versions: [{ url: apiFallbackVideoUrl }],
        published_at: '2026-03-15T08:00:00.000Z'
      },
      {
        id: 'alert-story-22',
        story_pk: '123456789',
        author: 'Demo User',
        author_handle: 'demo_user',
        content_url: canonicalStoryUrl,
        thumbnail_url: apiPreviewUrl,
        original_url: apiVideoUrl,
        media: [{ type: 'video', url: apiVideoUrl, preview: apiPreviewUrl }],
        published_at: '2026-03-15T08:00:00.000Z'
      }
    ])[0];

    const alertCard = mapInstagramStoryToAlert(mergedStory);
    const mediaItem = alertCard.content_details.media[0];

    expect(mediaItem.type).toBe('video');
    expect(mediaItem.url).toBe(s3VideoUrl);
    expect(mediaItem.fallback_urls).toEqual(expect.arrayContaining([apiVideoUrl, apiFallbackVideoUrl]));
    expect(mediaItem.preview).toBe(s3ThumbUrl);
    expect(mediaItem.preview_fallback_urls).toEqual(expect.arrayContaining([apiPreviewUrl]));
    expect(alertCard.content_url).toBe(canonicalStoryUrl);
  });

  it('extracts video and preview fallbacks from raw story payloads for captured stories', () => {
    const rawStory = {
      id: 'a290f0ff-67a6-4f9b-86a8-ffff00001111',
      story_pk: '987654321',
      author: 'Fallback User',
      author_handle: 'fallback_user',
      s3_url: 'https://bhaskar-media-storage.s3.eu-north-1.amazonaws.com/instagram-stories/987654321.mp4',
      raw_data: {
        media_type: 2,
        permalink: 'https://www.instagram.com/stories/fallback_user/987654321/',
        video_versions: [{ url: 'https://video.cdninstagram.com/story-987654321.mp4' }],
        image_versions2: {
          candidates: [{ url: 'https://scontent.cdninstagram.com/story-987654321.jpg' }]
        }
      },
      published_at: '2026-03-15T07:00:00.000Z'
    };

    const alertCard = mapInstagramStoryToAlert(rawStory);
    const mediaItem = alertCard.content_details.media[0];

    expect(mediaItem.type).toBe('video');
    expect(mediaItem.preview).toBe('https://scontent.cdninstagram.com/story-987654321.jpg');
    expect(mediaItem.fallback_urls).toEqual(expect.arrayContaining(['https://video.cdninstagram.com/story-987654321.mp4']));
    expect(alertCard.content_url).toBe('https://www.instagram.com/stories/fallback_user/987654321/');
  });
});
