jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn()
}), { virtual: true });

jest.mock('react-player', () => () => null);

jest.mock('../lib/api', () => ({
  __esModule: true,
  default: {},
  BACKEND_URL: 'http://localhost:5000'
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn()
  }
}));

jest.mock('./ui/scroll-area', () => ({ ScrollArea: ({ children }) => children || null }));
jest.mock('./ui/badge', () => ({ Badge: ({ children }) => children || null }));
jest.mock('./ui/button', () => ({ Button: ({ children }) => children || null }));
jest.mock('./ui/dialog', () => ({
  Dialog: ({ children }) => children || null,
  DialogContent: ({ children }) => children || null,
  DialogHeader: ({ children }) => children || null,
  DialogTitle: ({ children }) => children || null,
  DialogFooter: ({ children }) => children || null
}));
jest.mock('./ui/tabs', () => ({
  Tabs: ({ children }) => children || null,
  TabsList: ({ children }) => children || null,
  TabsTrigger: ({ children }) => children || null,
  TabsContent: ({ children }) => children || null
}));
jest.mock('./ui/textarea', () => ({ Textarea: () => null }));
jest.mock('./ui/hover-card', () => ({
  HoverCard: ({ children }) => children || null,
  HoverCardTrigger: ({ children }) => children || null,
  HoverCardContent: ({ children }) => children || null
}));
jest.mock('./ui/popover', () => ({
  Popover: ({ children }) => children || null,
  PopoverContent: ({ children }) => children || null,
  PopoverTrigger: ({ children }) => children || null
}));
jest.mock('./ui/calendar', () => ({ Calendar: () => null }));
jest.mock('./ReasonModal', () => () => null);

import { normalizeMediaItem, normalizeMediaList, pickCardMediaItems, extractYouTubeVideoId, isLikelyYouTubeUrl } from './AlertCards';

describe('AlertCards Facebook media normalization', () => {
  it('prefers playable Facebook video URLs over thumbnail images', () => {
    const playableUrl = 'https://video.xx.fbcdn.net/v/t42.1790-2/123456789_987654321.mp4?_nc_cat=101&ccb=1-7';
    const thumbnailUrl = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/123456789_987654321_n.jpg?_nc_cat=101&ccb=1-7';

    const normalized = normalizeMediaItem({
      type: 'video',
      playable_url_quality_hd: playableUrl,
      image: { uri: thumbnailUrl }
    });

    expect(normalized).toMatchObject({
      type: 'video',
      url: playableUrl,
      preview: thumbnailUrl
    });
    expect(normalized.fallbackUrls).not.toContain(thumbnailUrl);
  });

  it('expands Facebook subattachments and preserves nested video/image items', () => {
    const playableUrl = 'https://video.xx.fbcdn.net/v/t42.1790-2/111111111_222222222.mp4?_nc_cat=100&ccb=1-7';
    const videoThumbnailUrl = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/111111111_222222222_n.jpg?_nc_cat=100&ccb=1-7';
    const imageUrl = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/333333333_444444444_n.jpg?_nc_cat=100&ccb=1-7';

    const normalized = normalizeMediaList([
      {
        subattachments: {
          data: [
            {
              __typename: 'Video',
              browser_native_hd_url: playableUrl,
              image: { uri: videoThumbnailUrl }
            },
            {
              image: { uri: imageUrl },
              type: 'photo'
            }
          ]
        }
      }
    ]);

    expect(normalized).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'video',
        url: playableUrl,
        preview: videoThumbnailUrl
      }),
      expect.objectContaining({
        type: 'photo',
        url: imageUrl
      })
    ]));
  });

  it('prefers resolved Facebook video media over stale inline image duplicates', () => {
    const cardMediaItems = pickCardMediaItems({
      platform: 'facebook',
      inlineMediaItems: [
        { type: 'photo', url: 'https://scontent.xx.fbcdn.net/stale-preview.jpg', preview: 'https://scontent.xx.fbcdn.net/stale-preview.jpg' }
      ],
      fallbackInlineMedia: [],
      resolvedFacebookMediaItems: [
        { type: 'video', url: 'https://video.xx.fbcdn.net/real-video', preview: 'https://scontent.xx.fbcdn.net/resolved-preview.jpg' }
      ]
    });

    expect(cardMediaItems).toEqual([
      expect.objectContaining({
        type: 'video',
        url: 'https://video.xx.fbcdn.net/real-video'
      })
    ]);
  });
});

describe('AlertCards YouTube URL helpers', () => {
  it('extracts video id from watch, shorts and youtu.be links', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ?si=test')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('detects YouTube domains reliably', () => {
    expect(isLikelyYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isLikelyYouTubeUrl('https://m.youtube.com/live/dQw4w9WgXcQ')).toBe(true);
    expect(isLikelyYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isLikelyYouTubeUrl('https://example.com/video.mp4')).toBe(false);
  });
});
