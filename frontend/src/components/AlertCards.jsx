
import React, { useState, useRef, useEffect, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Repeat, Heart, BarChart2, MoreHorizontal, Share, CheckCircle2, ThumbsUp, Eye, ExternalLink, MessageSquare, Zap, Info, X, AlertTriangle, Shield, ShieldCheck, Download, Loader2, FileText, Share2, Check, XCircle, AlertCircle, FilePlus, ChevronDown, ChevronRight, Image, Video, Pause, Play, Plus, Twitter, Instagram, Facebook, Users, Trash2, Clock, Globe, Network, UserPlus, CalendarDays, Search, Tags, MapPin, HelpCircle } from 'lucide-react';
import { formatDistanceToNow, format, startOfDay, startOfWeek, endOfDay } from 'date-fns';

import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { HoverCard, HoverCardTrigger, HoverCardContent } from './ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Calendar } from './ui/calendar';
import api, { BACKEND_URL } from '../lib/api';
import { decodeHtmlEntities } from '../utils/decodeHtml';
import { toast } from 'sonner';
import ReasonModal from './ReasonModal';

const WHATSAPP_GROUP_LINK = 'https://chat.whatsapp.com/HGGWZCyNXBmHfp4KvYxlXu';
let activeVideoElement = null;
const mediaResolveCache = new Map();

/**
 * Route S3 / CDN media URLs through our backend proxy to avoid CORS issues.
 * The backend /api/media/stream endpoint already supports S3, Instagram CDN,
 * Facebook CDN, Twitter CDN, and YouTube CDN hosts.
 */
const NEEDS_PROXY_RE = /(amazonaws\.com|\.fbcdn\.net|\.fbsbx\.com|lookaside\.facebook\.com|cdninstagram\.com|video\.twimg\.com|pbs\.twimg\.com|googlevideo\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|scontent|bhaskar-media-storage)/i;

// ─── Location chip ────────────────────────────────────────────────────────
// Renders on every alert card. Behavior:
//   • content.location.name present  → green chip linking to Google Maps
//   • media_location.status === 'pending' or absent → nothing (chip back-fills
//     once the async extraction worker has run)
//   • media_location.status is any terminal state with no GPS → grey
//     "Unknown location" chip so the user knows we checked.
export const AlertLocationChip = ({ content }) => {
    if (!content) return null;
    const loc = content.location;
    const mediaStatus = content.media_location?.status;

    if (loc?.name) {
        const href = (typeof loc.lat === 'number' && typeof loc.lng === 'number')
            ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.name)}`;
        const titleParts = [];
        if (loc.source === 'author_profile') titleParts.push('Author profile location');
        else if (loc.source === 'media_exif') titleParts.push('Extracted from media EXIF');
        else if (loc.source === 'tweet_place') titleParts.push('Tweet place tag');
        else if (loc.source === 'tweet_coordinates') titleParts.push('Tweet GPS');
        else if (loc.source === 'instagram_post') titleParts.push('Instagram tagged location');
        else if (loc.source === 'facebook_place') titleParts.push('Facebook checked-in');
        const detail = [loc.address, loc.city, loc.country].filter(Boolean).join(', ');
        if (detail && detail !== loc.name) titleParts.push(detail);
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={titleParts.join(' · ') || loc.name}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 max-w-full"
            >
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">
                    {loc.source === 'author_profile' ? `~ ${loc.name}` : loc.name}
                </span>
            </a>
        );
    }

    // No location available. Show "Unknown location" only after the async
    // extractor has actually run — otherwise the chip will pop in seconds later.
    const terminalNoLocation = ['checked_no_gps', 'no_media', 'failed'].includes(mediaStatus);
    if (!terminalNoLocation) return null;

    return (
        <span
            title="No geotag on the post and no GPS in the attached media (most social media platforms strip EXIF on upload)."
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400 max-w-full"
        >
            <HelpCircle className="h-3 w-3 shrink-0" />
            <span>Unknown location</span>
        </span>
    );
};

const proxyMediaUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl || '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    // Already proxied or local
    if (trimmed.startsWith('/') || trimmed.startsWith(BACKEND_URL)) return trimmed;
    // Needs proxying
    if (NEEDS_PROXY_RE.test(trimmed)) {
        return `${BACKEND_URL}/api/media/stream?url=${encodeURIComponent(trimmed)}`;
    }
    return trimmed;
};

const resolvePostMediaFallback = async (postUrl) => {
    if (!postUrl || typeof postUrl !== 'string') return null;
    const trimmed = postUrl.trim();
    if (!trimmed) return null;

    if (!mediaResolveCache.has(trimmed)) {
        const request = api.get('/media/resolve', {
            params: { url: trimmed }
        })
            .then((response) => {
                const payload = response?.data || null;
                return payload && payload.success ? payload : null;
            })
            .catch(() => null);
        mediaResolveCache.set(trimmed, request);
    }

    return mediaResolveCache.get(trimmed);
};

const openWhatsAppGroupShare = async (text) => {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
    let finalText = text || '';
    if (finalText && !/^(Good\sMorning|Good\sAfternoon|Good\sEvening)/i.test(finalText.trim())) {
        finalText = `${greeting} sir,\n\n${finalText}`;
    }
    try {
        if (finalText && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(finalText);
        }
    } catch (error) {
        console.error('Clipboard copy failed:', error);
        toast.error('Unable to copy message. Please copy manually.');
    }

    window.open(WHATSAPP_GROUP_LINK, '_blank');

    if (finalText) {
        toast.success('Message copied. Paste it into the WhatsApp group.');
    }
};

const correctFilenameForContentType = (filename, contentType) => {
    if (!contentType) return filename;
    const ct = contentType.split(';')[0].trim().toLowerCase();
    const ext = filename.replace(/^.*\./, '').toLowerCase();
    const videoExts = ['mp4', 'webm', 'mkv', 'mov', 'avi'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    // If content is video but filename has image extension (or vice versa), fix it
    if (ct.startsWith('video/') && imageExts.includes(ext)) {
        const videoExt = ct === 'video/webm' ? 'webm' : ct === 'video/quicktime' ? 'mov' : 'mp4';
        return filename.replace(/\.[^.]+$/, `.${videoExt}`);
    }
    if (ct.startsWith('image/') && videoExts.includes(ext)) {
        const imgExt = ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : ct === 'image/gif' ? 'gif' : 'jpg';
        return filename.replace(/\.[^.]+$/, `.${imgExt}`);
    }
    return filename;
};

const triggerBlobDownload = async (url, filename, expectedMediaType = null) => {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const blob = await response.blob();
        const ct = (blob.type || '').split(';')[0].trim().toLowerCase();

        // If we expected video but got image (or HTML), reject so caller can try next URL
        if (expectedMediaType === 'video' && (ct.startsWith('image/') || ct.startsWith('text/'))) {
            console.warn(`Expected video but got ${ct} from ${url}`);
            return false;
        }
        if (expectedMediaType === 'image' && ct.startsWith('text/')) {
            console.warn(`Expected image but got ${ct} from ${url}`);
            return false;
        }

        const correctedFilename = correctFilenameForContentType(filename, ct);
        const blobUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = correctedFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
        return true;
    } catch (error) {
        console.error('Blob download failed:', error);
        return false;
    }
};

const VIDEO_URL_RE = /\.(mp4|webm|mkv|mov|avi|m3u8)(\?|$)/i;
const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;
const YOUTUBE_HOST_RE = /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

export const isLikelyYouTubeUrl = (url) => {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        return YOUTUBE_HOST_RE.test(host);
    } catch (_) {
        return /(youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(trimmed);
    }
};

export const extractYouTubeVideoId = (value) => {
    const input = String(value || '').trim();
    if (!input) return '';
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

    try {
        const parsed = new URL(input);
        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

        if (host === 'youtu.be') {
            const segment = parsed.pathname.split('/').filter(Boolean)[0];
            if (segment) return segment;
        }

        if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
            const direct = parsed.searchParams.get('v');
            if (direct) return direct;

            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const markerIndex = pathParts.findIndex((part) => ['embed', 'shorts', 'live', 'v'].includes(part));
            if (markerIndex >= 0 && pathParts[markerIndex + 1]) {
                return pathParts[markerIndex + 1];
            }
        }
    } catch (_) {
        // no-op
    }

    const inlineMatch = input.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i);
    return inlineMatch?.[1] || '';
};

const normalizeMediaType = (value) => String(value ?? '').trim().toLowerCase();
const isVideoType = (value) => ['video', 'animated_gif', 'gifv', '2'].includes(normalizeMediaType(value));
const isImageType = (value) => ['photo', 'image', '1'].includes(normalizeMediaType(value));

const isLikelyVideoUrl = (url) => typeof url === 'string' && (
    url.includes('video.twimg.com') ||
    /video[^.]*\.fbcdn\.net/i.test(url) ||
    /\.fbcdn\.net\/v\/t\d+\.\d+-\d+/i.test(url) ||
    VIDEO_URL_RE.test(url)
);

const isLikelyImageUrl = (url) => typeof url === 'string' && IMAGE_URL_RE.test(url);

const isPrivateStorageUrl = (url) => typeof url === 'string' && /(amazonaws\.com|\bs3[.-]|bhaskar-media-storage)/i.test(url);
const toPublicExternalUrl = (url) => {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed || isPrivateStorageUrl(trimmed)) return '';
    return trimmed;
};

const readUrlFromValue = (value, depth = 0) => {
    if (depth > 3 || value === null || value === undefined) return '';

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || '';
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = readUrlFromValue(item, depth + 1);
            if (found) return found;
        }
        return '';
    }

    if (typeof value === 'object') {
        const directKeys = [
            's3_url',
            'video_url',
            'videoUrl',
            'url',
            'uri',
            'src',
            'source',
            'href',
            'hd_url',
            'sd_url',
            'playable_url',
            'playable_url_quality_hd',
            'playable_url_quality_sd',
            'playable_url_hd',
            'playable_url_sd',
            'browser_native_hd_url',
            'browser_native_sd_url',
            'browser_native_src',
            'download_url',
            'secure_url',
            'image_url',
            'thumbnail_url',
            'thumbnail_src',
            'preview_url',
            'preview_image_url',
            'display_url',
            'cover_frame_url',
            'poster',
            'poster_url',
            'original_url',
            'original_video_url',
            'original_preview',
            'original_preview_url'
        ];

        for (const key of directKeys) {
            const found = readUrlFromValue(value[key], depth + 1);
            if (found) return found;
        }

        const thumbnailObj = value.thumbnails;
        if (thumbnailObj && typeof thumbnailObj === 'object') {
            const thumbPriority = ['maxres', 'high', 'medium', 'default', 'small'];
            for (const key of thumbPriority) {
                const found = readUrlFromValue(thumbnailObj[key], depth + 1);
                if (found) return found;
            }
            const fallbackThumb = readUrlFromValue(Object.values(thumbnailObj), depth + 1);
            if (fallbackThumb) return fallbackThumb;
        }

        const nestedKeys = ['image', 'video', 'thumbnail', 'preview', 'media', 'picture', 'attachment', 'node', 'cover', 'poster'];
        for (const key of nestedKeys) {
            const found = readUrlFromValue(value[key], depth + 1);
            if (found) return found;
        }

        const listKeys = ['images', 'media', 'items', 'data', 'attachments', 'subattachments', 'children', 'nodes', 'edges', 'sources', 'video_versions', 'videoVersions'];
        for (const key of listKeys) {
            const found = readUrlFromValue(value[key], depth + 1);
            if (found) return found;
        }
    }

    return '';
};

const collectResolvedUrls = (...values) => {
    const seen = new Set();
    const urls = [];

    const visit = (value, depth = 0) => {
        if (depth > 4 || value === null || value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach((entry) => visit(entry, depth + 1));
            return;
        }

        const resolved = readUrlFromValue(value);
        if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            urls.push(resolved);
        }
    };

    values.forEach((value) => visit(value));
    return urls;
};

const isDownloadableSocialLink = (url) => typeof url === 'string' && /(?:twitter\.com|x\.com|instagram\.com\/(?:reels?|stories|p|tv)\/|facebook\.com|fb\.watch|youtube\.com|youtu\.be)/i.test(url);

const isVideoMediaItem = (item) => {
    const url = String(item?.url || item?.preview || '');
    return isVideoType(item?.type) || isVideoType(item?.media_type) || Boolean(item?.is_video) || isLikelyVideoUrl(url);
};

const isImageMediaItem = (item) => {
    const url = String(item?.url || item?.preview || '');
    if (isVideoMediaItem(item)) return false;
    return isImageType(item?.type) || isImageType(item?.media_type) || isLikelyImageUrl(url);
};

const XBrandIcon = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2h3.308l-7.227 8.26L23 22h-6.73l-5.27-6.89L4.97 22H1.66l7.73-8.84L1 2h6.9l4.76 6.29L18.244 2zm-1.16 18h1.833L6.91 3.895H4.943L17.084 20z" />
    </svg>
);

const normalizePlatformKey = (platform = '') => {
    const normalized = String(platform || '').toLowerCase();
    if (normalized === 'twitter') return 'x';
    return normalized || 'x';
};

const PlatformLogoBadge = ({ platform = 'x', className = '' }) => {
    const platformKey = normalizePlatformKey(platform);
    const badgeBaseClass = `h-6 min-w-[46px] px-2.5 rounded-sm border text-white flex items-center justify-center shrink-0 ${className}`;

    if (platformKey === 'instagram') {
        return (
            <div className={`${badgeBaseClass} border-[#E4405F]/70 bg-gradient-to-r from-[#E4405F] via-[#E4405F] to-[#FF69B4]`}>
                <Instagram className="h-4 w-4" />
            </div>
        );
    }

    if (platformKey === 'facebook') {
        return (
            <div className={`${badgeBaseClass} border-[#1877F2]/70 bg-gradient-to-r from-[#1877F2] via-[#1877F2] to-[#FF69B4]`}>
                <Facebook className="h-4 w-4" />
            </div>
        );
    }

    if (platformKey === 'youtube') {
        return (
            <div className={`${badgeBaseClass} border-[#FF0000]/70 bg-gradient-to-r from-[#FF0000] via-[#FF0000] to-[#FF69B4]`}>
                <Video className="h-4 w-4" />
            </div>
        );
    }

    return (
        <div className={`${badgeBaseClass} border-foreground/40 bg-gradient-to-r from-foreground via-foreground to-[#FF69B4] text-background`}>
            <XBrandIcon className="h-4 w-4" />
        </div>
    );
};

// Download Menu Dropdown Component
export const DownloadMenu = ({
    mediaItems = [],
    mediaUrl,
    contentId,
    onDownloadStart,
    onDownloadComplete,
    onDownloadError,
    downloading = false,
    downloadProgress = 0,
    downloadStatus = '',
    downloadError = null,
    showLabel = true
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [downloadType, setDownloadType] = useState(null); // 'images' | 'videos' | 'generic'
    const menuRef = useRef(null);

    // Detect media types
    const validItems = Array.isArray(mediaItems) ? mediaItems : [];
    const hasImages = validItems.some((m) => isImageMediaItem(m));
    const hasVideos = validItems.some((m) => isVideoMediaItem(m));

    // Allow download if:
    // 1. Explicit media items exist
    // 2. OR it's a supported social media link (we can try scraping it for media even if frontend didn't detect it yet)
    const isLink = mediaUrl && (
        mediaUrl.includes('twitter.com') || mediaUrl.includes('x.com') ||
        mediaUrl.includes('facebook.com') || mediaUrl.includes('fb.watch') ||
        mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be') ||
        mediaUrl.includes('instagram.com')
    );
    const hasMedia = hasImages || hasVideos || isLink;

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);



    const handleDownloadImages = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        setDownloadType('images');
        onDownloadStart?.();

        try {
            // Filter image items
            const imageItems = validItems.filter((m) => isImageMediaItem(m));

            if (imageItems.length === 0) {
                onDownloadError?.('No images found to download');
                return;
            }

            // Prepare image URLs with twitter high quality
            const imageUrls = imageItems.map(m => {
                let url = m.s3_url || m.url || m.preview;
                // For Twitter images, get highest quality (only for non-S3 URLs)
                if (url && !url.includes('amazonaws.com') && url.includes('pbs.twimg.com') && !url.includes('name=')) {
                    url = `${url}${url.includes('?') ? '&' : '?'}name=orig`;
                }
                return url;
            }).filter(Boolean);

            // Strategy 1: Try direct download via stream proxy (same as video player)
            const directImageUrls = imageUrls.filter(u => NEEDS_PROXY_RE.test(u) || IMAGE_URL_RE.test(u));
            if (directImageUrls.length > 0 && directImageUrls.length === imageUrls.length) {
                let allSucceeded = true;
                for (let i = 0; i < directImageUrls.length; i++) {
                    const proxiedUrl = proxyMediaUrl(directImageUrls[i]);
                    const ext = directImageUrls[i].match(/\.(jpe?g|png|gif|webp)/i)?.[1] || 'jpg';
                    const filename = `image_${i + 1}.${ext}`;
                    const success = await triggerBlobDownload(proxiedUrl, filename, 'image');
                    if (!success) {
                        allSucceeded = false;
                        break;
                    }
                    if (i < directImageUrls.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                if (allSucceeded) {
                    onDownloadComplete?.();
                    return;
                }
                // If direct download failed, fall through to backend API
            }

            // Strategy 2: Fall back to backend download-images API
            const response = await api.post('/media/download-images', {
                image_urls: imageUrls,
                content_id: contentId
            });

            // console.log('Backend response:', response.data);

            if (response.data.items && response.data.items.length > 0) {
                // Download each image file sequentially
                for (let i = 0; i < response.data.items.length; i++) {
                    const item = response.data.items[i];
                    const downloadUrl = item.download_url;
                    const filename = item.filename || `image_${i + 1}.jpg`;

                    // console.log(`Triggering download for ${filename} from ${downloadUrl}`);

                    const result = await triggerBlobDownload(downloadUrl, filename);
                    if (!result) console.error(`Failed to download ${filename}`);
                    // Small delay between downloads to prevent browser blocking
                    if (i < response.data.items.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                onDownloadComplete?.();
            } else {
                onDownloadError?.('No images returned from server');
            }
        } catch (error) {
            // console.error('Image download failed:', error);
            onDownloadError?.(error.response?.data?.error || 'Image download failed');
        }
    };

    const handleDownloadVideos = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        setDownloadType('videos');
        onDownloadStart?.();

        try {
            // Filter video items
            const videoItems = validItems.filter((m) => isVideoMediaItem(m));

            // Strategy 1: Try direct download via stream proxy (same method the video player uses)
            // This works reliably when we have direct CDN/S3 video URLs
            const directVideoUrls = videoItems
                .map(v => {
                    // Gather all URL candidates for the video item
                    const candidates = [v.s3_url, v.url, ...(v.fallbackUrls || [])].filter(Boolean);
                    // Prefer URLs that are actually video URLs over thumbnails
                    return candidates.find(u => isLikelyVideoUrl(u)) || candidates.find(u => NEEDS_PROXY_RE.test(u)) || candidates[0];
                })
                .filter(Boolean)
                .filter(u => !isLikelyYouTubeUrl(u) && (VIDEO_URL_RE.test(u) || NEEDS_PROXY_RE.test(u)));

            if (directVideoUrls.length > 0) {
                let allSucceeded = true;
                for (let i = 0; i < directVideoUrls.length; i++) {
                    const proxiedUrl = proxyMediaUrl(directVideoUrls[i]);
                    const filename = `video_${i + 1}.mp4`;
                    const success = await triggerBlobDownload(proxiedUrl, filename, 'video');
                    if (!success) {
                        allSucceeded = false;
                        break;
                    }
                    if (i < directVideoUrls.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                if (allSucceeded) {
                    onDownloadComplete?.();
                    return;
                }
                // If direct download failed, fall through to backend API
            }

            // Strategy 2: Fall back to backend download-video API (uses RapidAPI / yt-dlp)
            const response = await api.post('/media/download-video', {
                media_url: mediaUrl || videoItems[0]?.url,
                video_urls: videoItems.map(v => v.url).filter(Boolean),
                content_id: contentId
            });

            if (response.data.items && response.data.items.length > 0) {
                // Download each video file
                for (let i = 0; i < response.data.items.length; i++) {
                    const item = response.data.items[i];
                    const downloadUrl = item.download_url;
                    const filename = item.filename || `video_${i + 1}.mp4`;

                    await triggerBlobDownload(downloadUrl, filename, 'video');
                    if (i < response.data.items.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                onDownloadComplete?.();
            } else if (response.data.download_url) {
                // Single video
                const downloadUrl = response.data.download_url;
                const filename = response.data.filename || 'video.mp4';
                await triggerBlobDownload(downloadUrl, filename, 'video');
                onDownloadComplete?.();
            } else {
                onDownloadError?.('No videos returned from server');
            }
        } catch (error) {
            // console.error('Video download failed:', error);
            onDownloadError?.(error.response?.data?.error || 'Video download failed');
        }
    };

    const handleDownloadGenericMedia = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        setDownloadType('generic');
        onDownloadStart?.();

        const runItemDownloads = async (items = []) => {
            for (let i = 0; i < items.length; i++) {
                const item = items[i] || {};
                const downloadUrl = item.download_url || item.s3_url || item.url;
                if (!downloadUrl) continue;
                const fallbackExt = isVideoMediaItem(item) ? 'mp4' : 'jpg';
                const filename = item.filename || `media_${i + 1}.${fallbackExt}`;
                await triggerBlobDownload(downloadUrl, filename);
                if (i < items.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        };

        try {
            const payload = {
                media_url: mediaUrl,
                content_id: contentId
            };
            if (validItems.length > 0) {
                payload.media_items = validItems;
            }

            const response = await api.post('/media/download', payload);
            const data = response.data || {};

            if (Array.isArray(data.items) && data.items.length > 0) {
                await runItemDownloads(data.items);
                onDownloadComplete?.();
                return;
            }

            if (Array.isArray(data.download_urls) && data.download_urls.length > 0) {
                const syntheticItems = data.download_urls.map((downloadUrl, idx) => ({
                    download_url: downloadUrl,
                    filename: `media_${idx + 1}${isLikelyVideoUrl(downloadUrl) ? '.mp4' : '.jpg'}`
                }));
                await runItemDownloads(syntheticItems);
                onDownloadComplete?.();
                return;
            }

            if (data.download_url) {
                const filename = data.filename || (isLikelyVideoUrl(data.download_url) ? 'media.mp4' : 'media.jpg');
                await triggerBlobDownload(data.download_url, filename);
                onDownloadComplete?.();
                return;
            }

            onDownloadError?.('No media returned from server');
        } catch (error) {
            onDownloadError?.(error.response?.data?.error || 'Media download failed');
        }
    };

    if (!hasMedia) return null;

    const imageLabel = hasImages && (!hasVideos)
        ? (validItems.filter((m) => isImageMediaItem(m)).length > 1 ? 'Download Images' : 'Download Image')
        : 'Download';

    const videoLabel = hasVideos && (!hasImages)
        ? (validItems.filter((m) => isVideoMediaItem(m)).length > 1 ? 'Download Videos' : 'Download Video')
        : 'Download';

    // If only link (no explicit items detected/passed yet), label as "Download Media"
    const simpleMode = !hasImages && !hasVideos && isLink;

    return (
        <div className="relative" ref={menuRef}>
            <button
                type="button"
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Direct action logic
                    if (simpleMode) {
                        handleDownloadGenericMedia(e);
                        return;
                    }
                    if (hasImages && !hasVideos) {
                        handleDownloadImages(e);
                        return;
                    }
                    if (hasVideos && !hasImages) {
                        handleDownloadVideos(e);
                        return;
                    }
                    setIsOpen(!isOpen);
                }}
                disabled={downloading}
                className={`flex items-center gap-1 text-xs font-medium z-20 ${downloading ? 'text-gray-400 cursor-wait' :
                    downloadError ? 'text-red-600' :
                        'text-green-600 hover:text-green-700 hover:underline'
                    }`}
                title={downloadError || 'Download Media'}
            >
                {downloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <Download className="h-4 w-4" />
                )}
                <span className={showLabel ? 'hidden sm:inline' : 'hidden'}>
                    {downloading ? 'Downloading...' : downloadError ? 'Failed' :
                        (simpleMode ? 'Download' :
                            (hasImages && !hasVideos ? imageLabel :
                                (hasVideos && !hasImages ? videoLabel : 'Download')))}
                </span>
                {!downloading && !simpleMode && hasImages && hasVideos && <ChevronDown className="h-3 w-3" />}
            </button>

            {isOpen && !downloading && hasImages && hasVideos && (
                <div className="absolute top-full right-0 mt-1 w-44 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
                    {hasImages && (
                        <button
                            type="button"
                            onClick={handleDownloadImages}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
                        >
                            <Image className="h-4 w-4 text-blue-500" />
                            {imageLabel}
                        </button>
                    )}
                    {hasVideos && (
                        <button
                            type="button"
                            onClick={handleDownloadVideos}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
                        >
                            <Video className="h-4 w-4 text-purple-500" />
                            {videoLabel}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

// Helper for formatting numbers (e.g., 1.2k)
const formatMetric = (num) => {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
};

// Helper for highlighting text matches
const HighlightText = ({ text, highlight }) => {
    if (!highlight || !text || typeof text !== 'string') return <span>{text}</span>;
    // Escape regex characters in highlight string
    const safeHighlight = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${safeHighlight})`, 'gi'));
    return (
        <span>
            {parts.map((part, i) =>
                part.toLowerCase() === highlight.toLowerCase() ? (
                    <span key={i} className="bg-yellow-200 dark:bg-yellow-800/30 text-gray-900 dark:text-gray-100 rounded px-0.5 font-medium border border-yellow-300 dark:border-yellow-700/50">{part}</span>
                ) : (
                    part
                )
            )}
        </span>
    );
};




export const normalizeMediaItem = (item) => {
    if (!item) return null;

    if (typeof item === 'string') {
        const directUrl = item.trim();
        if (!directUrl) return null;
        return {
            type: isLikelyVideoUrl(directUrl) ? 'video' : 'photo',
            url: directUrl,
            preview: directUrl,
            fallbackUrls: []
        };
    }

    const typeHint = normalizeMediaType(
        item.type || item.media_type || item.mime_type || item.kind || item.__typename || item.mediaType
    );

    const directVideoCandidates = collectResolvedUrls(
        item.s3_url,
        item.video_url,
        item.videoUrl,
        item.original_video_url,
        item.hd_url,
        item.sd_url,
        item.playable_url,
        item.playable_url_quality_hd,
        item.playable_url_quality_sd,
        item.playable_url_hd,
        item.playable_url_sd,
        item.browser_native_hd_url,
        item.browser_native_sd_url,
        item.browser_native_src,
        item.source,
        item.sources,
        item.video_versions,
        item.videoVersions,
        item.video?.playable_url,
        item.video?.playable_url_quality_hd,
        item.video?.playable_url_quality_sd,
        item.video?.playable_url_hd,
        item.video?.playable_url_sd,
        item.video?.browser_native_hd_url,
        item.video?.browser_native_sd_url,
        item.video?.browser_native_src,
        item.video?.hd_url,
        item.video?.sd_url,
        item.video?.video_url,
        item.video?.url,
        item.video?.src,
        item.video?.uri,
        item.video?.source,
        item.video?.sources,
        item.video?.video_versions,
        item.media_url_https,
        item.media_url
    );

    const directImageCandidates = collectResolvedUrls(
        item.s3_preview,
        item.s3_thumbnail_url,
        item.preview,
        item.preview_url,
        item.original_preview,
        item.original_preview_url,
        item.thumbnail_url,
        item.thumbnail_src,
        item.preview_image_url,
        item.image_url,
        item.display_url,
        item.cover_frame_url,
        item.poster,
        item.poster_url,
        item.image,
        item.picture,
        item.thumbnail,
        item.thumbnails,
        item.photo_image,
        item.media_image,
        item.image_lowres,
        item.imageHigh,
        item.image_highres,
        item.imageHighRes,
        item.image_versions2?.candidates,
        item.image_versions,
        item.display_resources
    );

    const generalCandidates = collectResolvedUrls(
        item.url,
        item.uri,
        item.src,
        item.href,
        item.original_url,
        item.secure_url,
        item.download_url,
        item.attachment,
        item.attachments,
        item.subattachments,
        item.all_subattachments,
        item
    );

    const generalVideoCandidates = generalCandidates.filter((candidate) => isLikelyVideoUrl(candidate));
    const generalImageCandidates = generalCandidates.filter((candidate) => !isLikelyVideoUrl(candidate));

    const hasExplicitVideoSignal =
        isVideoType(typeHint)
        || /\bvideo\b/.test(typeHint)
        || Boolean(
            item.video_info
            || item.is_video
            || item.video
            || item.video_url
            || item.videoUrl
            || item.hd_url
            || item.sd_url
            || item.playable_url
            || item.playable_url_quality_hd
            || item.playable_url_quality_sd
            || item.browser_native_hd_url
            || item.browser_native_sd_url
            || (Array.isArray(item.video_versions) && item.video_versions.length > 0)
            || (Array.isArray(item.videoVersions) && item.videoVersions.length > 0)
        );

    const hasVideoUrl = [...directVideoCandidates, ...generalVideoCandidates].some((candidate) => isLikelyVideoUrl(candidate));
    const hasExplicitImageSignal = isImageType(typeHint) || /\b(photo|image|picture)\b/.test(typeHint);
    const type = (hasExplicitVideoSignal || (hasVideoUrl && !hasExplicitImageSignal)) ? 'video' : 'photo';

    const primaryCandidates = type === 'video'
        ? [...directVideoCandidates, ...generalVideoCandidates, ...directImageCandidates, ...generalImageCandidates]
        : [...directImageCandidates, ...generalImageCandidates, ...directVideoCandidates, ...generalVideoCandidates];
    const url = primaryCandidates.find(Boolean) || '';

    if (!url) return null;

    const previewCandidates = type === 'video'
        ? [...directImageCandidates, ...generalImageCandidates, ...directVideoCandidates, ...generalVideoCandidates]
        : [...directImageCandidates, ...generalImageCandidates, url];
    const preview = previewCandidates.find(Boolean) || url;

    const s3Url = collectResolvedUrls(item.s3_url)[0] || '';
    const s3Preview = collectResolvedUrls(item.s3_preview, item.s3_thumbnail_url)[0] || '';

    const fallbackCandidates = type === 'video'
        ? collectResolvedUrls(item.fallback_urls, item.fallbackUrls, directVideoCandidates, generalVideoCandidates)
        : collectResolvedUrls(item.fallback_urls, item.fallbackUrls, directImageCandidates, generalImageCandidates);
    const fallbackUrls = fallbackCandidates.filter((candidate) => candidate && candidate !== url);

    const previewFallbackCandidates = collectResolvedUrls(
        item.preview_fallback_urls,
        item.previewFallbackUrls,
        directImageCandidates,
        generalImageCandidates
    );
    const previewFallbackUrls = previewFallbackCandidates.filter((candidate) => {
        if (!candidate || candidate === preview) return false;
        if (type === 'video' && isLikelyVideoUrl(candidate)) return false;
        return true;
    });

    return {
        type,
        url,
        preview: preview || url,
        fallbackUrls,
        previewFallbackUrls,
        ...(s3Url ? { s3_url: s3Url } : {}),
        ...(s3Preview ? { s3_preview: s3Preview } : {})
    };
};

export const normalizeMediaList = (media) => {
    const sourceItems = Array.isArray(media) ? media : (media ? [media] : []);

    const expandedItems = sourceItems.flatMap((entry) => {
        if (!entry) return [];
        if (Array.isArray(entry)) return entry;

        if (typeof entry === 'object') {
            const nested = [
                ...(Array.isArray(entry.media) ? entry.media : []),
                ...(Array.isArray(entry.images) ? entry.images : []),
                ...(Array.isArray(entry.items) ? entry.items : []),
                ...(Array.isArray(entry.data) ? entry.data : []),
                ...(Array.isArray(entry.attachments) ? entry.attachments : []),
                ...(Array.isArray(entry.attachments?.data) ? entry.attachments.data : []),
                ...(Array.isArray(entry.attachments?.media) ? entry.attachments.media : []),
                ...(Array.isArray(entry.attachment?.media) ? entry.attachment.media : []),
                ...(Array.isArray(entry.subattachments) ? entry.subattachments : []),
                ...(Array.isArray(entry.subattachments?.data) ? entry.subattachments.data : []),
                ...(Array.isArray(entry.all_subattachments) ? entry.all_subattachments : []),
                ...(Array.isArray(entry.all_subattachments?.nodes) ? entry.all_subattachments.nodes : []),
                ...(Array.isArray(entry.children) ? entry.children : []),
                ...(Array.isArray(entry.nodes) ? entry.nodes : []),
                ...(Array.isArray(entry.edges) ? entry.edges : [])
            ];

            const hasDirectMediaValue = Boolean(readUrlFromValue([
                entry.s3_url,
                entry.video_url,
                entry.videoUrl,
                entry.url,
                entry.uri,
                entry.src,
                entry.hd_url,
                entry.sd_url,
                entry.playable_url,
                entry.playable_url_quality_hd,
                entry.playable_url_quality_sd,
                entry.browser_native_hd_url,
                entry.browser_native_sd_url,
                entry.image_url,
                entry.thumbnail_url,
                entry.preview_url,
                entry.preview_image_url,
                entry.original_url,
                entry.original_video_url
            ]));

            if (nested.length > 0) {
                return hasDirectMediaValue ? [entry, ...nested] : nested;
            }

            return [entry];
        }

        return [entry];
    });

    const normalized = expandedItems.map(normalizeMediaItem).filter(Boolean);
    const seen = new Set();

    return normalized.filter((item) => {
        const key = `${item.type}::${item.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

export const pickCardMediaItems = ({
    platform = '',
    inlineMediaItems = [],
    fallbackInlineMedia = [],
    resolvedFacebookMediaItems = []
}) => {
    const normalizedPlatform = String(platform || '').toLowerCase();

    if (normalizedPlatform === 'facebook' || normalizedPlatform === 'instagram') {
        const resolvedHasVideo = resolvedFacebookMediaItems.some((item) => isVideoMediaItem(item));
        const inlineHasVideo = inlineMediaItems.some((item) => isVideoMediaItem(item));

        if (resolvedHasVideo) return resolvedFacebookMediaItems;
        if (inlineHasVideo) return inlineMediaItems;
        if (resolvedFacebookMediaItems.length > 0) return resolvedFacebookMediaItems;
    }

    const merged = [];
    const seen = new Set();

    const pushItems = (items = []) => {
        items.forEach((item) => {
            if (!item?.url) return;
            const fallbackKey = Array.isArray(item.fallbackUrls) ? item.fallbackUrls.join('|') : '';
            const key = `${item.type || 'photo'}::${item.url}::${item.preview || ''}::${fallbackKey}`;
            if (seen.has(key)) return;
            seen.add(key);
            merged.push(item);
        });
    };

    pushItems(inlineMediaItems);
    pushItems(fallbackInlineMedia);
    return merged;
};

const normalizeText = (text) => {
    if (text === null || text === undefined) return '';
    try {
        return text
            .toString()
            .normalize('NFKC')
            .replace(/[\u200B-\u200D\u2060\uFE0F]/g, '')
            .replace(/\s+/g, ' ')
            .toLowerCase()
            .trim();
    } catch (e) {
        return '';
    }
};

const filterRiskFactors = (content) => {
    if (!content?.risk_factors || !Array.isArray(content.risk_factors)) return [];
    const textNormalized = normalizeText(content.text || '');
    return content.risk_factors.filter((factor) => {
        const keyword = (factor.keyword || '').toString();
        if (!keyword) return false;
        if (keyword.toLowerCase().startsWith('[ai]')) return true;
        if (!textNormalized) return true;
        return textNormalized.includes(normalizeText(keyword));
    });
};

// Report Status Tracker Component - Delivery-style tracking UI
const ReportStatusTracker = ({ report }) => {
    if (!report) return null;

    const statuses = [
        { key: 'generated', label: 'Report Generated', icon: FilePlus },
        { key: 'sent_to_intermediary', label: 'Sent to Intermediary', icon: Share },
        { key: 'closed', label: 'Closed', icon: CheckCircle2 }
    ];

    const getStatusIndex = (status) => {
        const statusMap = {
            'generated': 0,
            'sent_to_intermediary': 1,
            'closed': 2,
            'resolved': 2
        };
        return statusMap[status] ?? 0;
    };

    const currentIndex = getStatusIndex(report.status);

    return (
        <div className="p-4 space-y-4">
            {/* Report Header */}
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3">
                <div>
                    <div className="text-xs text-gray-500 uppercase font-medium">Report ID</div>
                    <div className="text-sm font-mono font-bold text-blue-600">{report.serial_number}</div>
                </div>
                <div className="text-right">
                    <div className="text-xs text-gray-500 uppercase font-medium">Generated</div>
                    <div className="text-sm text-gray-700 dark:text-gray-300">
                        {report.generated_at ? new Date(report.generated_at).toLocaleDateString() : 'N/A'}
                    </div>
                </div>
            </div>

            {/* Status Tracker - Delivery Style */}
            <div className="relative">
                {statuses.map((status, index) => {
                    const isCompleted = index <= currentIndex;
                    const isCurrent = index === currentIndex;
                    const Icon = status.icon;

                    return (
                        <div key={status.key} className="flex items-start gap-3 relative">
                            {/* Vertical Line */}
                            {index < statuses.length - 1 && (
                                <div className={`absolute left-[11px] top-6 w-0.5 h-8 ${index < currentIndex ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
                                    }`} />
                            )}

                            {/* Status Icon */}
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 z-10 ${isCompleted
                                ? 'bg-green-500 text-white'
                                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500'
                                } ${isCurrent ? 'ring-2 ring-green-300 dark:ring-green-700' : ''}`}>
                                {isCompleted ? (
                                    <Check className="h-3.5 w-3.5" />
                                ) : (
                                    <Icon className="h-3 w-3" />
                                )}
                            </div>

                            {/* Status Label */}
                            <div className={`pb-8 ${index === statuses.length - 1 ? 'pb-0' : ''}`}>
                                <div className={`text-sm font-medium ${isCompleted ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-gray-500'
                                    }`}>
                                    {status.label}
                                </div>
                                {isCurrent && (
                                    <div className="text-xs text-green-600 dark:text-green-400 font-medium mt-0.5">
                                        Current Status
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* View Report Link */}
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                <a
                    href={`/reports/generate/${report.alert_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                >
                    <ExternalLink className="h-3 w-3" />
                    View Full Report
                </a>
            </div>
        </div>
    );
};


const WhatsAppShareModal = ({ isOpen, onClose, initialText }) => {
    const [text, setText] = React.useState(initialText);

    React.useEffect(() => {
        setText(initialText);
    }, [initialText]);

    const handleShare = async () => {
        await openWhatsAppGroupShare(text);
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[700px] bg-white dark:bg-[#0f0f0f] border-gray-200 dark:border-gray-800">
                <DialogHeader>
                    <DialogTitle className="text-gray-900 dark:text-gray-100 flex items-center gap-2">
                        <Share2 className="h-5 w-5 text-green-500" />
                        Format & Share to WhatsApp
                    </DialogTitle>
                </DialogHeader>
                <div className="py-4">
                    <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        className="min-h-[300px] bg-gray-50 dark:bg-[#1a1a1a] border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100 resize-none focus-visible:ring-1 focus-visible:ring-gray-300 dark:focus-visible:ring-gray-700 text-sm"
                        placeholder="Edit share message..."
                    />
                </div>
                <DialogFooter className="flex gap-2 sm:justify-end">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleShare}
                        className="bg-green-500 hover:bg-green-600 text-white gap-2"
                    >
                        <Share2 className="h-4 w-4" />
                        Share
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export const VideoPlayer = ({ url, preview, type, autoPlay = false, onError, fallbackUrls = [], previewFallbackUrls = [], platform = '', contentUrl = '' }) => {
    const videoRef = React.useRef(null);
    const hlsRef = React.useRef(null);
    const pendingPlayRef = React.useRef(false);
    const stallTimerRef = React.useRef(null);
    const blobUrlRef = React.useRef(null);
    const [hasLoadedMedia, setHasLoadedMedia] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [videoFailed, setVideoFailed] = useState(false);
    const [activeSourceIndex, setActiveSourceIndex] = useState(0);
    const [posterSourceIndex, setPosterSourceIndex] = useState(0);
    const [posterFailed, setPosterFailed] = useState(false);
    const [resolvedVideoUrl, setResolvedVideoUrl] = useState('');
    const [resolvedPosterUrl, setResolvedPosterUrl] = useState('');
    const [attemptedPlatformResolve, setAttemptedPlatformResolve] = useState(false);
    const failedUrlsRef = React.useRef(new Set());

    // Build ordered candidate list: proxy all S3/CDN URLs through backend to avoid CORS
    const allVideoUrls = React.useMemo(() => {
        const seen = new Set();
        const urls = [];
        const push = (u) => {
            if (typeof u === 'string' && u.trim() && !seen.has(u.trim())) {
                seen.add(u.trim());
                urls.push(u.trim());
            }
        };
        const rawCandidates = [resolvedVideoUrl, url, ...(Array.isArray(fallbackUrls) ? fallbackUrls : [])];
        for (const raw of rawCandidates) {
            if (!raw || typeof raw !== 'string') continue;
            const proxied = proxyMediaUrl(raw.trim());
            push(proxied);
            // NEVER add raw S3/CDN URLs — they cause CORS errors in the browser
        }
        return urls;
    }, [resolvedVideoUrl, url, fallbackUrls]);

    const currentUrl = allVideoUrls[activeSourceIndex] || '';

    const allPosterUrls = React.useMemo(() => {
        const seen = new Set();
        const urls = [];
        const push = (candidate) => {
            if (typeof candidate === 'string' && candidate.trim() && !seen.has(candidate.trim())) {
                seen.add(candidate.trim());
                urls.push(candidate.trim());
            }
        };

        [resolvedPosterUrl, preview, ...(Array.isArray(previewFallbackUrls) ? previewFallbackUrls : [])].forEach(push);
        return urls;
    }, [resolvedPosterUrl, preview, previewFallbackUrls]);
    const posterFallbackKey = React.useMemo(() => allPosterUrls.join('|'), [allPosterUrls]);

    const clearStallTimer = React.useCallback(() => {
        if (stallTimerRef.current) {
            clearTimeout(stallTimerRef.current);
            stallTimerRef.current = null;
        }
    }, []);

    const revokeBlobUrl = React.useCallback(() => {
        if (blobUrlRef.current) {
            try { URL.revokeObjectURL(blobUrlRef.current); } catch (_) { }
            blobUrlRef.current = null;
        }
    }, []);

    const destroyHls = React.useCallback(() => {
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
    }, []);

    const tryNextSource = React.useCallback(() => {
        clearStallTimer();
        failedUrlsRef.current.add(currentUrl);
        const nextIdx = activeSourceIndex + 1;
        if (nextIdx < allVideoUrls.length) {
            setActiveSourceIndex(nextIdx);
            setHasLoadedMedia(false);
            setIsPlaying(false);
            pendingPlayRef.current = false;
            destroyHls();
            revokeBlobUrl();
            return true;
        }
        setVideoFailed(true);
        if (onError) onError(new Error('All video sources failed'));
        return false;
    }, [activeSourceIndex, allVideoUrls, currentUrl, destroyHls, onError, clearStallTimer, revokeBlobUrl]);

    // Try loading via fetch + blob URL (ultimate CORS bypass for same-origin proxy)
    const tryBlobLoad = React.useCallback(async (videoUrl) => {
        try {
            const resp = await fetch(videoUrl);
            if (!resp.ok) return false;
            const blob = await resp.blob();
            if (!blob || blob.size === 0) return false;
            const objUrl = URL.createObjectURL(blob);
            blobUrlRef.current = objUrl;
            const video = videoRef.current;
            if (!video) {
                URL.revokeObjectURL(objUrl);
                return false;
            }
            video.src = objUrl;
            video.load();
            setHasLoadedMedia(true);
            if (pendingPlayRef.current) {
                video.play().catch(() => {});
                pendingPlayRef.current = false;
            }
            return true;
        } catch (_err) {
            return false;
        }
    }, []);

    const loadVideoSource = React.useCallback(async () => {
        const video = videoRef.current;
        if (!video || hasLoadedMedia || !currentUrl) return;

        const isHLS = currentUrl.includes('.m3u8') || type === 'application/x-mpegURL';

        if (isHLS) {
            try {
                const Hls = require('hls.js');
                if (Hls.isSupported()) {
                    const hls = new Hls({ xhrSetup: (xhr) => { xhr.withCredentials = false; } });
                    hlsRef.current = hls;
                    hls.loadSource(currentUrl);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        if (pendingPlayRef.current) { video.play().catch(() => {}); pendingPlayRef.current = false; }
                    });
                    hls.on(Hls.Events.ERROR, (_event, data) => {
                        if (data.fatal) { hls.destroy(); hlsRef.current = null; tryNextSource(); }
                    });
                    setHasLoadedMedia(true);
                    return;
                }
            } catch (_) { /* hls.js unavailable */ }
        }

        // Strategy 1: Set src directly (works when proxied or same-origin)
        video.src = currentUrl;
        video.load();
        setHasLoadedMedia(true);

        // Start a stall timer: if video hasn't started playing within 8s, try next
        clearStallTimer();
        stallTimerRef.current = setTimeout(() => {
            const v = videoRef.current;
            if (v && v.readyState < 2 && !isPlaying) {
                // Video stalled, try blob load as fallback before moving to next
                tryBlobLoad(currentUrl).then((success) => {
                    if (!success) tryNextSource();
                });
            }
        }, 8000);

        if (pendingPlayRef.current) {
            video.play().catch(() => {});
            pendingPlayRef.current = false;
        }
    }, [hasLoadedMedia, type, currentUrl, tryNextSource, clearStallTimer, isPlaying, tryBlobLoad]);

    const requestVideoLoadAndPlay = React.useCallback(() => {
        if (!currentUrl || hasLoadedMedia || videoFailed) return;
        pendingPlayRef.current = true;
        loadVideoSource();
    }, [currentUrl, hasLoadedMedia, videoFailed, loadVideoSource]);

    // Cleanup on unmount
    React.useEffect(() => {
        const currentVideo = videoRef.current;
        return () => {
            clearStallTimer();
            destroyHls();
            revokeBlobUrl();
            if (currentVideo && activeVideoElement === currentVideo) activeVideoElement = null;
        };
    }, [destroyHls, clearStallTimer, revokeBlobUrl]);

    // Reset when primary url/type changes externally
    React.useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        clearStallTimer();
        destroyHls();
        revokeBlobUrl();
        if (activeVideoElement === video) activeVideoElement = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
        pendingPlayRef.current = false;
        failedUrlsRef.current.clear();
        setActiveSourceIndex(0);
        setHasLoadedMedia(false);
        setIsPlaying(false);
        setVideoFailed(false);
        setResolvedVideoUrl('');
        setResolvedPosterUrl('');
        setAttemptedPlatformResolve(false);
    }, [url, type, contentUrl, destroyHls, clearStallTimer, revokeBlobUrl]);

    React.useEffect(() => {
        setPosterSourceIndex(0);
        setPosterFailed(false);
    }, [posterFallbackKey]);

    // When activeSourceIndex changes (fallback rotation), auto-load the new source
    React.useEffect(() => {
        if (activeSourceIndex > 0 && !hasLoadedMedia && currentUrl) {
            const video = videoRef.current;
            if (!video) return;
            clearStallTimer();
            destroyHls();
            revokeBlobUrl();
            video.pause();
            video.removeAttribute('src');
            video.load();
            pendingPlayRef.current = true;
            const timer = setTimeout(() => loadVideoSource(), 80);
            return () => clearTimeout(timer);
        }
    }, [activeSourceIndex, hasLoadedMedia, currentUrl, destroyHls, loadVideoSource, clearStallTimer, revokeBlobUrl]);

    const handleVideoError = React.useCallback(() => {
        // Before giving up on this URL, try blob-loading it (fetch + createObjectURL)
        tryBlobLoad(currentUrl).then((success) => {
            if (!success) tryNextSource();
        });
    }, [tryNextSource, tryBlobLoad, currentUrl]);

    const handleCanPlay = React.useCallback(() => {
        clearStallTimer();
    }, [clearStallTimer]);

    const togglePlayback = React.useCallback(() => {
        const video = videoRef.current;
        if (!video) return;

        if (!hasLoadedMedia) {
            requestVideoLoadAndPlay();
            return;
        }

        if (video.paused) {
            video.play().catch(() => {});
        } else {
            video.pause();
        }
    }, [hasLoadedMedia, requestVideoLoadAndPlay]);

    const handlePosterError = React.useCallback(() => {
        const nextIdx = posterSourceIndex + 1;
        if (nextIdx < allPosterUrls.length) {
            setPosterSourceIndex(nextIdx);
            return;
        }
        setPosterFailed(true);
    }, [allPosterUrls.length, posterSourceIndex]);

    React.useEffect(() => {
        if (!videoFailed || !['facebook', 'instagram'].includes(String(platform || '').toLowerCase()) || !contentUrl || attemptedPlatformResolve) return;

        let cancelled = false;
        setAttemptedPlatformResolve(true);

        resolvePostMediaFallback(contentUrl).then((resolved) => {
            if (cancelled || !resolved) return;

            if (resolved.image_url) {
                setResolvedPosterUrl(resolved.image_url);
                setPosterFailed(false);
                setPosterSourceIndex(0);
            }

            if (resolved.video_url) {
                setResolvedVideoUrl(resolved.video_url);
                setVideoFailed(false);
                setActiveSourceIndex(0);
                setHasLoadedMedia(false);
                setIsPlaying(false);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [attemptedPlatformResolve, contentUrl, platform, videoFailed]);

    // Fallback: show poster image when all video sources fail
    if (videoFailed) {
        const posterSrc = posterFailed ? '' : (proxyMediaUrl(allPosterUrls[posterSourceIndex]) || '');
        return (
            <div className="w-full h-full relative flex items-center justify-center bg-black" onClick={(e) => e.stopPropagation()}>
                {posterSrc ? (
                    <img
                        src={posterSrc}
                        alt="Video thumbnail"
                        className="w-full h-full object-contain"
                        onError={handlePosterError}
                    />
                ) : (
                    <div className="flex flex-col items-center gap-2 text-white/60">
                        <Video className="h-8 w-8" />
                        <span className="text-xs">Video unavailable</span>
                    </div>
                )}
                <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-2 p-4 text-center">
                    <AlertTriangle className="h-5 w-5 text-amber-400" />
                    <div className="space-y-1">
                        <span className="text-[10px] text-white/90 font-medium block">Video could not be loaded</span>
                        {contentUrl && ['facebook', 'instagram', 'x', 'twitter'].includes(String(platform || '').toLowerCase()) && (
                            <Button 
                                size="sm" 
                                variant="outline" 
                                className="h-7 px-3 bg-white/10 border-white/20 hover:bg-white/20 text-white text-[10px] uppercase tracking-wider font-bold mt-2"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(contentUrl, '_blank');
                                }}
                            >
                                {String(platform || '').toLowerCase() === 'instagram' ? (
                                    <Instagram className="w-3 h-3 mr-1.5 text-[#E4405F]" />
                                ) : ['x', 'twitter'].includes(String(platform || '').toLowerCase()) ? (
                                    <Twitter className="w-3 h-3 mr-1.5 text-white" />
                                ) : (
                                    <Facebook className="w-3 h-3 mr-1.5 text-[#1877F2] fill-[#1877F2] stroke-none" />
                                )}
                                View on {['x', 'twitter'].includes(String(platform || '').toLowerCase()) ? 'X' : 'Source'}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full relative flex items-center justify-center bg-black group/video" onClick={(e) => e.stopPropagation()}>
            <video
                ref={videoRef}
                poster={posterFailed ? '' : proxyMediaUrl(allPosterUrls[posterSourceIndex] || preview)}
                controls
                autoPlay={false}
                loop={Boolean(autoPlay) && hasLoadedMedia}
                muted
                preload="none"
                playsInline
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain"
                onError={handleVideoError}
                onCanPlay={handleCanPlay}
                onClickCapture={requestVideoLoadAndPlay}
                onKeyDownCapture={(event) => {
                    if ((event.key === 'Enter' || event.key === ' ') && !hasLoadedMedia) {
                        event.preventDefault();
                        requestVideoLoadAndPlay();
                    }
                }}
                onPlay={(e) => {
                    clearStallTimer();
                    const currentVideo = e.currentTarget;
                    if (activeVideoElement && activeVideoElement !== currentVideo && !activeVideoElement.paused) {
                        activeVideoElement.pause();
                    }
                    activeVideoElement = currentVideo;
                    setIsPlaying(true);
                }}
                onPause={(e) => {
                    if (activeVideoElement === e.currentTarget) activeVideoElement = null;
                    setIsPlaying(false);
                }}
                onEnded={(e) => {
                    if (activeVideoElement === e.currentTarget) activeVideoElement = null;
                    setIsPlaying(false);
                }}
                onClick={(e) => e.stopPropagation()}
            />
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover/video:opacity-100">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        togglePlayback();
                    }}
                    className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
                    title={isPlaying ? 'Pause' : 'Play'}
                >
                    {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                </button>
            </div>
        </div>
    );
};

// Image component with automatic fallback URL rotation + proxy support
const ImageWithFallback = ({ src, fallbackUrls = [], alt = '', className = '', platform = '', contentUrl = '' }) => {
    const [currentSrcIndex, setCurrentSrcIndex] = useState(0);
    const [allFailed, setAllFailed] = useState(false);
    const [resolvedFallbackUrl, setResolvedFallbackUrl] = useState('');
    const [attemptedPlatformResolve, setAttemptedPlatformResolve] = useState(false);

    // Build proxied candidates — never load raw S3/CDN URLs directly (CORS)
    const allSources = React.useMemo(() => {
        const seen = new Set();
        const urls = [];
        const push = (u) => {
            if (typeof u === 'string' && u.trim() && !seen.has(u.trim())) {
                seen.add(u.trim());
                urls.push(u.trim());
            }
        };
        const rawCandidates = [src, ...(Array.isArray(fallbackUrls) ? fallbackUrls : []), resolvedFallbackUrl];
        for (const raw of rawCandidates) {
            if (!raw || typeof raw !== 'string') continue;
            const proxied = proxyMediaUrl(raw.trim());
            push(proxied);
            // NEVER add raw S3/CDN URLs — they cause CORS errors in the browser
        }
        return urls;
    }, [resolvedFallbackUrl, src, fallbackUrls]);

    const currentSrc = allSources[currentSrcIndex] || '';

    const handleError = React.useCallback(() => {
        const nextIdx = currentSrcIndex + 1;
        if (nextIdx < allSources.length) {
            setCurrentSrcIndex(nextIdx);
        } else {
            setAllFailed(true);
        }
    }, [currentSrcIndex, allSources.length]);

    // Reset on src change
    React.useEffect(() => {
        setCurrentSrcIndex(0);
        setAllFailed(false);
        setResolvedFallbackUrl('');
        setAttemptedPlatformResolve(false);
    }, [src, contentUrl]);

    React.useEffect(() => {
        if (!allFailed || !['facebook', 'instagram'].includes(String(platform || '').toLowerCase()) || !contentUrl || attemptedPlatformResolve) return;

        let cancelled = false;
        setAttemptedPlatformResolve(true);

        resolvePostMediaFallback(contentUrl).then((resolved) => {
            const nextUrl = resolved?.image_url || '';
            if (cancelled || !nextUrl) return;
            setResolvedFallbackUrl(nextUrl);
            setCurrentSrcIndex(allSources.length);
            setAllFailed(false);
        });

        return () => {
            cancelled = true;
        };
    }, [allFailed, allSources.length, attemptedPlatformResolve, contentUrl, platform]);

    if (allFailed || !currentSrc) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-muted text-muted-foreground gap-1.5 p-4 text-center group">
                <Image className="h-6 w-6 opacity-40" />
                <span className="text-[10px] opacity-60">Image unavailable</span>
                {['facebook', 'instagram'].includes(String(platform || '').toLowerCase()) && contentUrl && (
                    <Button 
                        size="sm" 
                        variant="secondary" 
                        className="h-7 px-3 bg-background/80 hover:bg-background border-border text-[9px] uppercase tracking-widest font-black mt-1 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => { e.stopPropagation(); window.open(contentUrl, '_blank'); }}
                    >
                        {String(platform || '').toLowerCase() === 'instagram' ? (
                            <Instagram className="w-3 h-3 mr-1 text-[#E4405F]" />
                        ) : (
                            <Facebook className="w-3 h-3 mr-1 text-[#1877F2] fill-[#1877F2] stroke-none" />
                        )}
                        View Source
                    </Button>
                )}
                {['facebook', 'instagram'].includes(String(platform || '').toLowerCase()) && contentUrl && <div className="absolute inset-0 cursor-pointer" onClick={() => window.open(contentUrl, '_blank')} />}
            </div>
        );
    }

    return (
        <img
            src={currentSrc}
            alt={alt}
            className={className}
            referrerPolicy="no-referrer"
            onError={handleError}
        />
    );
};

// URL Card Component for link previews
const URLCard = ({ card }) => {
    if (!card || !card.expanded_url) return null;

    // Extract domain for display
    const getDomain = (url) => {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.replace('www.', '');
        } catch {
            return card.display_url || url;
        }
    };

    return (
        <a
            href={card.expanded_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="block mb-3 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-900/30 transition-colors"
        >
            {card.image && (
                <div className="w-full aspect-[2/1] bg-gray-100 dark:bg-gray-800">
                    <img
                        src={card.image}
                        alt={card.title || 'Link preview'}
                        className="w-full h-full object-cover"
                        onError={(e) => { e.target.style.display = 'none'; }}
                    />
                </div>
            )}
            <div className="p-3">
                <div className="text-[13px] text-gray-500 dark:text-gray-400 mb-1">
                    {getDomain(card.expanded_url)}
                </div>
                {card.title && (
                    <div className="text-[15px] font-medium text-gray-900 dark:text-gray-100 line-clamp-2 mb-1">
                        {card.title}
                    </div>
                )}
                {card.description && (
                    <div className="text-[14px] text-gray-500 dark:text-gray-400 line-clamp-2">
                        {card.description}
                    </div>
                )}
            </div>
        </a>
    );
};

// Single consistent color for all retweeter nodes
const getNodeColor = () => '#f65959';

/* ── SVG Radial Tree ── */
const RetweetTree = ({ sourceHandle, sourceName, sourceAvatar, topRetweeters, totalRetweeters, onNodeClick, isMonitored }) => {
    const W = 580, H = 440;
    const cx = W / 2, cy = H / 2 - 10;
    const SRC_R = 34, NODE_R = 28, ORBIT = 155;
    const items = topRetweeters.slice(0, 8);
    const n = items.length;

    if (n === 0) {
        return (
            <div className="h-56 flex flex-col items-center justify-center text-muted-foreground gap-2">
                <Network className="h-10 w-10 opacity-25" />
                <span className="text-sm">No retweet data for this period.</span>
                <span className="text-xs">Try a wider date range.</span>
            </div>
        );
    }

    const step = (Math.PI * 2) / n;
    const startA = -Math.PI / 2;
    const maxT = Math.max(1, ...items.map(r => r.tweet_count || 1));

    return (
        <div className="flex justify-center w-full overflow-hidden">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[540px]" style={{ maxHeight: 420 }}>
                <defs>
                    <filter id="nShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.08" /></filter>
                    <filter id="srcGlow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="b" /><feFlood floodColor="#3b82f6" floodOpacity="0.12" /><feComposite in2="b" operator="in" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                </defs>

                {/* orbit ring */}
                <circle cx={cx} cy={cy} r={ORBIT} fill="none" stroke="#3b82f6" strokeOpacity="0.08" strokeWidth="1" strokeDasharray="5 5" />

                {/* edges */}
                {items.map((rt, i) => {
                    const a = startA + step * i;
                    const nx = cx + ORBIT * Math.cos(a), ny = cy + ORBIT * Math.sin(a);
                    const mx = cx + ORBIT * 0.45 * Math.cos(a), my = cy + ORBIT * 0.45 * Math.sin(a);
                    const w = Math.max(1.5, (rt.tweet_count / maxT) * 4.5);
                    const c = getNodeColor(rt.tweet_count);
                    const path = `M ${cx} ${cy} Q ${mx + (ny-cy)*0.12} ${my - (nx-cx)*0.12} ${nx} ${ny}`;
                    return (
                        <g key={`e-${i}`}>
                            <path d={path} fill="none" stroke={c} strokeWidth={w} strokeOpacity="0.3" strokeLinecap="round" />
                            <circle r="2" fill={c} opacity="0.5"><animateMotion path={path} dur={`${2.8 + i*0.3}s`} repeatCount="indefinite" /></circle>
                        </g>
                    );
                })}

                {/* retweeter nodes */}
                {items.map((rt, i) => {
                    const a = startA + step * i;
                    const nx = cx + ORBIT * Math.cos(a), ny = cy + ORBIT * Math.sin(a);
                    const c = getNodeColor(rt.tweet_count);
                    const monitored = isMonitored(rt.handle);
                    const init = (rt.name || rt.handle || '?')[0].toUpperCase();
                    const lblY = ny < cy - 30 ? ny - NODE_R - 8 : ny + NODE_R + 14;
                    return (
                        <g key={`n-${i}`} className="cursor-pointer" onClick={() => onNodeClick(rt)}>
                            {/* outer ring */}
                            <circle cx={nx} cy={ny} r={NODE_R + 3} fill="none" stroke={c} strokeWidth="2.5" strokeOpacity="0.45" />
                            {/* bg */}
                            <circle cx={nx} cy={ny} r={NODE_R} fill="white" stroke="#e5e7eb" strokeWidth="1" filter="url(#nShadow)" />
                            {/* avatar / initial */}
                            {rt.avatar ? (
                                <>
                                    <clipPath id={`cr-${i}`}><circle cx={nx} cy={ny} r={NODE_R-1} /></clipPath>
                                    <image href={rt.avatar} x={nx-NODE_R+1} y={ny-NODE_R+1} width={(NODE_R-1)*2} height={(NODE_R-1)*2} clipPath={`url(#cr-${i})`} />
                                </>
                            ) : (
                                <text x={nx} y={ny+1} textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="700" fill="#374151">{init}</text>
                            )}
                            {/* tweet count badge top-right */}
                            <circle cx={nx+NODE_R-3} cy={ny-NODE_R+3} r="10" fill={c} stroke="white" strokeWidth="1.5" />
                            <text x={nx+NODE_R-3} y={ny-NODE_R+4} textAnchor="middle" dominantBaseline="central" fontSize="8" fontWeight="700" fill="white">{rt.tweet_count}</text>
                            {/* verified */}
                            {rt.verified && <>
                                <circle cx={nx+NODE_R-3} cy={ny+NODE_R-3} r="7" fill="#3b82f6" stroke="white" strokeWidth="1" />
                                <text x={nx+NODE_R-3} y={ny+NODE_R-2} textAnchor="middle" dominantBaseline="central" fontSize="7" fill="white">✓</text>
                            </>}
                            {/* redirect to X profile top-left */}
                            <g className="cursor-pointer" onClick={(e) => { e.stopPropagation(); window.open(`https://x.com/${rt.handle}`, '_blank', 'noopener,noreferrer'); }}>
                                <circle cx={nx-NODE_R+3} cy={ny-NODE_R+3} r="9" fill="#6b7280" stroke="white" strokeWidth="1.5" />
                                <g transform={`translate(${nx-NODE_R+3},${ny-NODE_R+3}) scale(0.55)`}>
                                    <path d="M-5,1 L-5,5 a1,1,0,0,0,1,1 L0,6 a1,1,0,0,0,1,-1 L1,1 a1,1,0,0,0,-1,-1 L-4,0" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    <line x1="-2" y1="4" x2="5" y2="-3" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                                    <polyline points="1,-3 5,-3 5,1" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </g>
                            </g>
                            {/* label */}
                            <text x={nx} y={lblY} textAnchor="middle" fontSize="9" fontWeight="600" fill="#374151">@{rt.handle.length > 13 ? rt.handle.slice(0,11)+'…' : rt.handle}</text>
                        </g>
                    );
                })}

                {/* center source */}
                <g filter="url(#srcGlow)">
                    <circle cx={cx} cy={cy} r={SRC_R+3} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeOpacity="0.35" />
                    <circle cx={cx} cy={cy} r={SRC_R} fill="#2563eb" stroke="white" strokeWidth="2" />
                    {sourceAvatar ? (
                        <><clipPath id="cSrc"><circle cx={cx} cy={cy} r={SRC_R-2} /></clipPath><image href={sourceAvatar} x={cx-SRC_R+2} y={cy-SRC_R+2} width={(SRC_R-2)*2} height={(SRC_R-2)*2} clipPath="url(#cSrc)" /></>
                    ) : (
                        <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="central" fontSize="15" fontWeight="700" fill="white">{(sourceName||sourceHandle||'S')[0].toUpperCase()}</text>
                    )}
                </g>
                <text x={cx} y={cy+SRC_R+16} textAnchor="middle" fontSize="11" fontWeight="700" fill="#1e40af">@{sourceHandle}</text>
                <text x={cx} y={cy+SRC_R+29} textAnchor="middle" fontSize="9" fill="#6b7280">{totalRetweeters} unique retweeters</text>
            </svg>
        </div>
    );
};

/* ── On-Demand Engager Analysis Dialog ── */
const FREQ_ROW_COLORS = {
    'super-active': 'bg-red-100 dark:bg-red-900/40',
    regular: 'bg-orange-100 dark:bg-orange-900/35',
    occasional: 'bg-amber-50 dark:bg-amber-900/25',
    'one-time': ''
};
const FREQ_LEGEND = [
    { key: 'super-active', label: 'Frequent', color: 'bg-red-300 dark:bg-red-700' },
    { key: 'regular', label: 'Regular', color: 'bg-orange-300 dark:bg-orange-700' },
    { key: 'occasional', label: 'Occasional', color: 'bg-amber-200 dark:bg-amber-700' },
    { key: 'one-time', label: 'One-time', color: 'bg-gray-300 dark:bg-gray-600' }
];

const RetweetNetworkDialog = ({ open, onOpenChange, sourceId, sourceHandle, sourceName, contentId, onAddSource, monitoredHandles = [] }) => {
    const [analyzing, setAnalyzing] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [analysis, setAnalysis] = useState(null);
    const [activeTab, setActiveTab] = useState('hierarchy');
    const [engagerPage, setEngagerPage] = useState(1);
    const [retweetSearch, setRetweetSearch] = useState('');
    const [history, setHistory] = useState([]);
    const [showHistory, setShowHistory] = useState(false);
    const PAGE_SIZE = 20;

    const handleClean = String(sourceHandle || '').replace(/^@/, '').trim();

    const isMonitored = (handle) => {
        if (!handle || !Array.isArray(monitoredHandles) || monitoredHandles.length === 0) return false;
        const clean = String(handle).replace(/^@/, '').toLowerCase().trim();
        return monitoredHandles.some(h => h && String(h).replace(/^@/, '').toLowerCase().trim() === clean);
    };

    const handleAddSource = (rt) => {
        if (!onAddSource) return;
        onAddSource({ platform: 'x', identifier: rt.handle, display_name: rt.name || rt.handle, category: 'unknown' });
    };

    // Load latest analysis when dialog opens
    const loadLatest = async () => {
        if (!handleClean) return;
        setLoading(true);
        setError('');
        try {
            const res = await api.get('/x/engager-analysis/latest', { params: { handle: handleClean } });
            setAnalysis(res.data);
        } catch (err) {
            if (err?.response?.status !== 404) {
                setError(err?.response?.data?.error || 'Failed to load analysis');
            }
            setAnalysis(null);
        } finally { setLoading(false); }
    };

    // Load analysis history
    const loadHistory = async () => {
        if (!handleClean) return;
        try {
            const res = await api.get('/x/engager-analysis/history', { params: { handle: handleClean } });
            setHistory(res.data?.analyses || []);
        } catch { setHistory([]); }
    };

    // Load a specific past analysis
    const loadAnalysisById = async (id) => {
        setLoading(true);
        setError('');
        try {
            const res = await api.get(`/x/engager-analysis/${id}`);
            setAnalysis(res.data);
            setShowHistory(false);
            setActiveTab('hierarchy');
            setEngagerPage(1);
            setRetweetSearch('');
        } catch (err) {
            setError(err?.response?.data?.error || 'Failed to load analysis');
        } finally { setLoading(false); }
    };

    // Trigger a new analysis
    const runAnalysis = async () => {
        if (!handleClean) return;
        setAnalyzing(true);
        setError('');
        try {
            const res = await api.post('/x/engager-analysis', { handle: handleClean, period_days: 30, source_id: sourceId || undefined });
            setAnalysis(res.data);
            setActiveTab('hierarchy');
            setEngagerPage(1);
            setRetweetSearch('');
            toast.success(`Analysis complete for @${handleClean}`);
            loadHistory();
        } catch (err) {
            setError(err?.response?.data?.error || 'Analysis failed');
            toast.error('Engager analysis failed');
        } finally { setAnalyzing(false); }
    };

    useEffect(() => {
        if (open && handleClean) {
            loadLatest();
            loadHistory();
            setShowHistory(false);
            setActiveTab('hierarchy');
            setEngagerPage(1);
            setRetweetSearch('');
        }
    }, [open]);

    const engagers = analysis?.engagers || [];
    const tweets = analysis?.tweets || [];
    const sourceLabel = analysis?.display_name || sourceName || handleClean || 'Source';
    const sourceAvatar = analysis?.avatar || null;

    // Search filter
    const searchTerm = retweetSearch.trim().toLowerCase();
    const filteredEngagers = searchTerm
        ? engagers.filter(e => (e.handle || '').toLowerCase().includes(searchTerm) || (e.name || '').toLowerCase().includes(searchTerm))
        : engagers;

    // Build "This Tweet" retweeter list — find retweeters for this specific tweet and enrich with cross-tweet frequency
    const thisTweetRetweeters = (() => {
        if (!contentId || !analysis) return [];
        const thisTweet = tweets.find(t => String(t.tweet_id) === String(contentId));
        if (!thisTweet) return [];
        // Find all engagers who retweeted this specific tweet
        return engagers
            .filter(e => e.tweet_ids && e.tweet_ids.includes(String(contentId)))
            .map(e => ({ ...e }))
            .sort((a, b) => b.tweets_retweeted - a.tweets_retweeted);
    })();
    const thisTweetInfo = contentId ? tweets.find(t => String(t.tweet_id) === String(contentId)) : null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[65vw] w-[65vw] max-h-[82vh] p-0 gap-0 overflow-hidden">
                {/* Header */}
                <div className="px-5 pt-4 pb-3 border-b border-border">
                    <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0 shadow-md">
                                {sourceAvatar ? (
                                    <img src={sourceAvatar} alt="" className="h-9 w-9 rounded-full object-cover" />
                                ) : (
                                    <Users className="h-4 w-4 text-white" />
                                )}
                            </div>
                            <div className="min-w-0">
                                <h2 className="text-sm font-semibold truncate">Frequent Engagers</h2>
                                <p className="text-xs text-muted-foreground">@{handleClean} · {sourceLabel}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            {history.length > 0 && (
                                <Button size="sm" variant="outline" className="h-7 text-[10px] px-2.5 gap-1" onClick={() => setShowHistory(!showHistory)}>
                                    <Clock className="h-3 w-3" />
                                    History ({history.length})
                                </Button>
                            )}
                            <Button size="sm" className="h-7 text-[10px] px-3 gap-1.5" onClick={runAnalysis} disabled={analyzing || !handleClean}>
                                {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                                {analyzing ? 'Analyzing…' : analysis ? 'Re-Analyze' : 'Analyze Now'}
                            </Button>
                        </div>
                    </div>
                    {analysis && (
                        <div className="text-[10px] text-muted-foreground">
                            Last analyzed: {format(new Date(analysis.analyzed_at), 'MMM d, yyyy h:mm a')} · {analysis.tweets_analyzed} tweets · {analysis.period_days}-day window
                        </div>
                    )}
                </div>

                {error && <div className="text-xs text-red-600 px-5 pt-2">{error}</div>}

                {/* History dropdown */}
                {showHistory && (
                    <div className="px-5 py-3 border-b border-border bg-muted/30 max-h-48 overflow-y-auto">
                        <div className="text-[11px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">Past Analyses</div>
                        <div className="space-y-1.5">
                            {history.map(h => (
                                <button key={h.id} onClick={() => loadAnalysisById(h.id)} className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors hover:bg-accent ${analysis?.id === h.id ? 'bg-accent ring-1 ring-primary/30' : 'bg-background'}`}>
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">{format(new Date(h.analyzed_at), 'MMM d, yyyy h:mm a')}</span>
                                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${h.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-950/30 dark:text-green-400' : h.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                                            {h.status}
                                        </span>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground mt-0.5">
                                        {h.tweets_analyzed} tweets · {h.unique_retweeters} engagers · {h.period_days}d window
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {analyzing ? (
                    <div className="h-64 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                        <span className="text-sm font-medium">Analyzing @{handleClean}'s engagers…</span>
                        <span className="text-[10px] text-muted-foreground">Fetching tweets & retweeters from Twitter. This may take a minute.</span>
                    </div>
                ) : loading ? (
                    <div className="h-64 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                        <span className="text-xs">Loading analysis…</span>
                    </div>
                ) : !analysis ? (
                    <div className="h-72 flex flex-col items-center justify-center gap-4 text-muted-foreground px-8">
                        <div className="h-16 w-16 rounded-full bg-muted/60 flex items-center justify-center">
                            <Users className="h-8 w-8 opacity-30" />
                        </div>
                        <div className="text-center space-y-1.5">
                            <p className="text-sm font-medium text-foreground">No analysis yet for @{handleClean}</p>
                            <p className="text-xs text-muted-foreground max-w-sm">
                                Click <strong>"Analyze Now"</strong> to fetch this user's recent tweets and identify who retweets them most frequently.
                            </p>
                        </div>
                        <Button size="sm" className="gap-1.5" onClick={runAnalysis} disabled={analyzing}>
                            <Zap className="h-3.5 w-3.5" /> Start Analysis
                        </Button>
                    </div>
                ) : analysis.status === 'failed' ? (
                    <div className="h-48 flex flex-col items-center justify-center gap-3 text-muted-foreground px-8">
                        <AlertCircle className="h-8 w-8 text-red-400" />
                        <p className="text-sm text-center">Analysis failed: {analysis.error || 'Unknown error'}</p>
                        <Button size="sm" variant="outline" className="gap-1.5" onClick={runAnalysis}>
                            <Zap className="h-3.5 w-3.5" /> Retry
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col lg:flex-row overflow-hidden" style={{ height: 'calc(82vh - 140px)' }}>
                        {/* ═══ LEFT PANEL — Network Map ═══ */}
                        <div className="lg:w-[45%] w-full shrink-0 border-b lg:border-b-0 lg:border-r border-border flex flex-col">
                            <div className="px-4 py-2 border-b border-border bg-muted/10 shrink-0">
                                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                                    <Network className="h-3.5 w-3.5" /> Network Map
                                </div>
                            </div>
                            <div className="flex-1 flex items-center justify-center p-3">
                                <RetweetTree
                                    sourceHandle={handleClean}
                                    sourceName={sourceLabel}
                                    sourceAvatar={sourceAvatar}
                                    topRetweeters={engagers.slice(0, 8).map(e => ({ ...e, tweet_count: e.tweets_retweeted }))}
                                    totalRetweeters={analysis.unique_retweeters || 0}
                                    onNodeClick={handleAddSource}
                                    isMonitored={isMonitored}
                                />
                            </div>
                            <div className="flex items-start gap-2 px-3 py-2 border-t border-border bg-muted/10 shrink-0">
                                <Info className="h-3 w-3 text-blue-500 mt-0.5 shrink-0" />
                                <p className="text-[9px] text-muted-foreground leading-relaxed">
                                    Click on any profile to <strong>add them into monitoring list</strong>.
                                </p>
                            </div>
                        </div>

                        {/* ═══ RIGHT PANEL — Engager Table ═══ */}
                        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                            {/* Mini tab bar + search */}
                            <div className="px-3 pt-2 pb-0 shrink-0 space-y-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex border-b border-border">
                                        {[
                                            ...(contentId ? [{ key: 'this-tweet', label: 'This Tweet', icon: Repeat, count: thisTweetRetweeters.length }] : []),
                                            { key: 'hierarchy', label: 'All Engagers', icon: Users, count: analysis.unique_retweeters }
                                        ].map(tab => (
                                            <button key={tab.key} onClick={() => { setActiveTab(tab.key); setEngagerPage(1); setRetweetSearch(''); }} className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium border-b-2 transition-colors -mb-px ${activeTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                                                <tab.icon className="h-3 w-3" />
                                                {tab.label}
                                                {tab.count > 0 && <span className={`ml-0.5 text-[9px] px-1 py-0.5 rounded-full font-bold ${activeTab === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{tab.count}</span>}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="flex-1" />
                                    {/* Search (all engagers tab only) */}
                                    {activeTab === 'hierarchy' && (
                                        <div className="relative w-48">
                                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                            <input
                                                type="text"
                                                placeholder="Search…"
                                                value={retweetSearch}
                                                onChange={(e) => { setRetweetSearch(e.target.value); setEngagerPage(1); }}
                                                className="w-full pl-6 pr-6 py-1 text-[11px] rounded border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                                            />
                                            {retweetSearch && (
                                                <button onClick={() => { setRetweetSearch(''); setEngagerPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                    <X className="h-3 w-3" />
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {activeTab === 'hierarchy' && searchTerm && <div className="text-[9px] text-muted-foreground">{filteredEngagers.length} result{filteredEngagers.length !== 1 ? 's' : ''}</div>}
                            </div>

                            {/* Table content */}
                            <ScrollArea className="flex-1">
                                <div className="px-3 py-2">
                                    {/* ═══ THIS TWEET TABLE ═══ */}
                                    {activeTab === 'this-tweet' && contentId && (() => {
                                        const totalPages = Math.ceil(thisTweetRetweeters.length / PAGE_SIZE);
                                        const paged = thisTweetRetweeters.slice((engagerPage - 1) * PAGE_SIZE, engagerPage * PAGE_SIZE);
                                        return (
                                        <div className="space-y-2">
                                            {thisTweetInfo && (
                                                <div className="p-2 rounded-lg border bg-muted/30 text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                                                    {thisTweetInfo.text || '(no text)'}
                                                </div>
                                            )}
                                            {thisTweetRetweeters.length === 0 ? (
                                                <div className="h-32 flex flex-col items-center justify-center text-muted-foreground gap-2">
                                                    <Repeat className="h-6 w-6 opacity-25" />
                                                    <span className="text-xs">No retweeters found for this tweet.</span>
                                                </div>
                                            ) : (<>
                                                <div className="border rounded-lg overflow-hidden">
                                                    <table className="w-full table-fixed text-[11px]">
                                                        <colgroup>
                                                            <col style={{ width: '55%' }} />
                                                            <col style={{ width: '25%' }} />
                                                            <col style={{ width: '20%' }} />
                                                        </colgroup>
                                                        <thead className="bg-muted/50">
                                                            <tr>
                                                                <th className="text-left px-2 py-1.5 font-semibold">Engager</th>
                                                                <th className="text-center px-2 py-1.5 font-semibold">Retweeted</th>
                                                                <th className="text-center px-2 py-1.5 font-semibold">Monitor</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {paged.map((rt) => {
                                                                const already = isMonitored(rt.handle);
                                                                const freq = rt.frequency || 'one-time';
                                                                return (
                                                                    <tr key={rt.handle} className={`border-t transition-colors ${FREQ_ROW_COLORS[freq] || ''}`}>
                                                                        <td className="px-2 py-1.5 align-middle">
                                                                            <div className="flex items-center gap-1.5">
                                                                                {rt.avatar ? (
                                                                                    <img src={rt.avatar} alt="" className="h-5 w-5 rounded-full object-cover shrink-0" />
                                                                                ) : (
                                                                                    <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[8px] font-bold shrink-0">
                                                                                        {(rt.name || rt.handle || '?')[0].toUpperCase()}
                                                                                    </div>
                                                                                )}
                                                                                <a href={`https://x.com/${rt.handle}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-[11px] break-all leading-tight">@{rt.handle}</a>
                                                                                {rt.verified && <CheckCircle2 className="h-2.5 w-2.5 text-blue-500 shrink-0" />}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-2 py-1.5 text-center align-middle">
                                                                            <span className="font-bold">{rt.tweets_retweeted}</span>
                                                                            <span className="text-[9px] text-muted-foreground"> / {analysis.tweets_analyzed}</span>
                                                                        </td>
                                                                        <td className="px-2 py-1.5 text-center align-middle">
                                                                            {onAddSource && !already ? (
                                                                                <Button size="sm" variant="outline" className="h-5 gap-0.5 text-[9px] px-1.5 border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950/20 dark:text-green-400 dark:border-green-800" onClick={() => handleAddSource(rt)}>
                                                                                    <UserPlus className="h-2.5 w-2.5" /> Add
                                                                                </Button>
                                                                            ) : already ? (
                                                                                <span className="inline-flex items-center gap-0.5 text-[9px] text-green-600 font-medium"><Check className="h-2.5 w-2.5" /> Monitored</span>
                                                                            ) : null}
                                                                        </td>
                                                                    </tr>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                {totalPages > 1 && (
                                                    <div className="flex items-center justify-between pt-1">
                                                        <span className="text-[9px] text-muted-foreground">{thisTweetRetweeters.length} total · Page {engagerPage}/{totalPages}</span>
                                                        <div className="flex gap-1">
                                                            <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage <= 1} onClick={() => setEngagerPage(p => p - 1)}>Prev</Button>
                                                            <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage >= totalPages} onClick={() => setEngagerPage(p => p + 1)}>Next</Button>
                                                        </div>
                                                    </div>
                                                )}
                                            </>)}
                                        </div>
                                        );
                                    })()}

                                    {/* ═══ ALL ENGAGERS TABLE ═══ */}
                                    {activeTab === 'hierarchy' && (() => {
                                        const totalPages = Math.ceil(filteredEngagers.length / PAGE_SIZE);
                                        const paged = filteredEngagers.slice((engagerPage - 1) * PAGE_SIZE, engagerPage * PAGE_SIZE);
                                        return (
                                        <div className="space-y-2">
                                            {filteredEngagers.length === 0 ? (
                                                <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">
                                                    {searchTerm ? 'No engagers match your search.' : 'No retweeters found.'}
                                                </div>
                                            ) : (<>
                                                <div className="border rounded-lg overflow-hidden">
                                                    <table className="w-full table-fixed text-[11px]">
                                                        <colgroup>
                                                            <col style={{ width: '55%' }} />
                                                            <col style={{ width: '25%' }} />
                                                            <col style={{ width: '20%' }} />
                                                        </colgroup>
                                                        <thead className="bg-muted/50">
                                                            <tr>
                                                                <th className="text-left px-2 py-1.5 font-semibold">Engager</th>
                                                                <th className="text-center px-2 py-1.5 font-semibold">Retweeted</th>
                                                                <th className="text-center px-2 py-1.5 font-semibold">Monitor</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {paged.map((rt) => {
                                                                const already = isMonitored(rt.handle);
                                                                const freq = rt.frequency || 'one-time';
                                                                return (
                                                                    <tr key={rt.handle} className={`border-t transition-colors ${FREQ_ROW_COLORS[freq] || ''}`}>
                                                                        <td className="px-2 py-1.5 align-middle">
                                                                            <div className="flex items-center gap-1.5">
                                                                                {rt.avatar ? (
                                                                                    <img src={rt.avatar} alt="" className="h-5 w-5 rounded-full object-cover shrink-0" />
                                                                                ) : (
                                                                                    <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[8px] font-bold shrink-0">
                                                                                        {(rt.name || rt.handle || '?')[0].toUpperCase()}
                                                                                    </div>
                                                                                )}
                                                                                <a href={`https://x.com/${rt.handle}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-[11px] break-all leading-tight">@{rt.handle}</a>
                                                                                {rt.verified && <CheckCircle2 className="h-2.5 w-2.5 text-blue-500 shrink-0" />}
                                                                            </div>
                                                                        </td>
                                                                        <td className="px-2 py-1.5 text-center align-middle">
                                                                            <span className="font-bold">{rt.tweets_retweeted}</span>
                                                                            <span className="text-[9px] text-muted-foreground"> / {analysis.tweets_analyzed}</span>
                                                                        </td>
                                                                        <td className="px-2 py-1.5 text-center align-middle">
                                                                            {onAddSource && !already ? (
                                                                                <Button size="sm" variant="outline" className="h-5 gap-0.5 text-[9px] px-1.5 border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950/20 dark:text-green-400 dark:border-green-800" onClick={() => handleAddSource(rt)}>
                                                                                    <UserPlus className="h-2.5 w-2.5" /> Add
                                                                                </Button>
                                                                            ) : already ? (
                                                                                <span className="inline-flex items-center gap-0.5 text-[9px] text-green-600 font-medium"><Check className="h-2.5 w-2.5" /> Monitored</span>
                                                                            ) : null}
                                                                        </td>
                                                                    </tr>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                {totalPages > 1 && (
                                                    <div className="flex items-center justify-between pt-1">
                                                        <span className="text-[9px] text-muted-foreground">{filteredEngagers.length} total · Page {engagerPage}/{totalPages}</span>
                                                        <div className="flex gap-1">
                                                            <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage <= 1} onClick={() => setEngagerPage(p => p - 1)}>Prev</Button>
                                                            <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage >= totalPages} onClick={() => setEngagerPage(p => p + 1)}>Next</Button>
                                                        </div>
                                                    </div>
                                                )}
                                            </>)}
                                        </div>
                                        );
                                    })()}
                                </div>
                            </ScrollArea>

                            {/* Color legend footer */}
                            <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border bg-muted/10 shrink-0 flex-wrap">
                                {FREQ_LEGEND.map(f => (
                                    <div key={f.key} className="flex items-center gap-1">
                                        <div className={`w-2.5 h-2.5 rounded-sm ${f.color}`} />
                                        <span className="text-[9px] text-muted-foreground">{f.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};

/* ── Frequent Engagers Panel (top-bar dialog) ── */
export const FrequentEngagersDialog = ({ open, onOpenChange, onAddSource, monitoredHandles = [] }) => {
    const [analyses, setAnalyses] = useState([]);
    const [loading, setLoading] = useState(false);
    const [selectedHandle, setSelectedHandle] = useState(null);
    const [selectedAnalysis, setSelectedAnalysis] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [activeTab, setActiveTab] = useState('hierarchy');
    const [engagerPage, setEngagerPage] = useState(1);
    const [retweetSearch, setRetweetSearch] = useState('');
    const [listSearch, setListSearch] = useState('');
    const [listPage, setListPage] = useState(1);
    const LIST_PAGE_SIZE = 20;
    const PAGE_SIZE = 20;

    const isMonitored = (handle) => {
        if (!handle || !Array.isArray(monitoredHandles) || monitoredHandles.length === 0) return false;
        const clean = String(handle).replace(/^@/, '').toLowerCase().trim();
        return monitoredHandles.some(h => h && String(h).replace(/^@/, '').toLowerCase().trim() === clean);
    };

    const handleAddSource = (rt) => {
        if (!onAddSource) return;
        onAddSource({ platform: 'x', identifier: rt.handle, display_name: rt.name || rt.handle, category: 'unknown' });
    };

    const retriggerAnalysis = async (handle) => {
        try {
            const res = await api.post('/x/engager-analysis', { handle, period_days: 30 });
            const status = res.data?.status;
            if (status === 'already_processing') {
                toast.warning(`Analysis for @${handle} is already in progress.`);
                return;
            }
            if (status === 'blocked') {
                toast.warning(`Another analysis (@${res.data?.blocked_by}) is still processing. Please wait.`);
                return;
            }
            toast.success(`Re-analysis started for @${handle}`);
            // Optimistically update the local state to show "processing" immediately
            setAnalyses(prev => prev.map(a => a.handle?.toLowerCase() === handle.toLowerCase() ? { ...a, status: 'processing', error: null, analyzed_at: new Date().toISOString() } : a));
        } catch {
            toast.error('Failed to start analysis');
        }
    };

    const loadAnalyses = async () => {
        setLoading(true);
        try {
            const res = await api.get('/x/engager-analysis-all');
            setAnalyses(res.data?.analyses || []);
        } catch { setAnalyses([]); }
        finally { setLoading(false); }
    };

    const openDetail = async (handle) => {
        setSelectedHandle(handle);
        setDetailLoading(true);
        setActiveTab('hierarchy');
        setEngagerPage(1);
        setRetweetSearch('');
        try {
            const res = await api.get('/x/engager-analysis/latest', { params: { handle } });
            setSelectedAnalysis(res.data);
        } catch {
            setSelectedAnalysis(null);
        } finally { setDetailLoading(false); }
    };

    const goBack = () => {
        setSelectedHandle(null);
        setSelectedAnalysis(null);
        loadAnalyses();
    };

    useEffect(() => {
        if (open) {
            loadAnalyses();
            setSelectedHandle(null);
            setSelectedAnalysis(null);
            setListSearch('');
            setListPage(1);
        }
    }, [open]);

    // Auto-poll every 5s while any analysis is processing
    useEffect(() => {
        if (!open || selectedHandle) return;
        const hasProcessing = analyses.some(a => a.status === 'processing');
        if (!hasProcessing) return;
        const iv = setInterval(loadAnalyses, 5000);
        return () => clearInterval(iv);
    }, [open, selectedHandle, analyses]);

    // Analysis detail view computed values
    const analysis = selectedAnalysis;
    const engagers = analysis?.engagers || [];
    const tweets = analysis?.tweets || [];
    const sourceLabel = analysis?.display_name || selectedHandle || '';
    const sourceAvatar = analysis?.avatar || null;
    const searchTerm = retweetSearch.trim().toLowerCase();
    const filteredEngagers = searchTerm
        ? engagers.filter(e => (e.handle || '').toLowerCase().includes(searchTerm) || (e.name || '').toLowerCase().includes(searchTerm))
        : engagers;

    // List view computed values
    const listSearchTerm = listSearch.trim().toLowerCase();
    const filteredAnalyses = listSearchTerm
        ? analyses.filter(a => (a.handle || '').toLowerCase().includes(listSearchTerm) || (a.display_name || '').toLowerCase().includes(listSearchTerm))
        : analyses;
    const listTotalPages = Math.max(1, Math.ceil(filteredAnalyses.length / LIST_PAGE_SIZE));
    const pagedAnalyses = filteredAnalyses.slice((listPage - 1) * LIST_PAGE_SIZE, listPage * LIST_PAGE_SIZE);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[65vw] w-[65vw] max-h-[82vh] p-0 gap-0 overflow-hidden">
                {!selectedHandle ? (
                    /* ═══ LIST VIEW — all analyzed handles ═══ */
                    <>
                        <div className="px-5 pt-4 pb-3 border-b border-border">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h2 className="text-sm font-semibold">Frequent Engagers</h2>
                                    <p className="text-[10px] text-muted-foreground mt-0.5">All analyzed Twitter accounts and their engager data</p>
                                </div>
                                {analyses.length > 0 && (
                                    <div className="relative w-52">
                                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                        <input type="text" placeholder="Search accounts…" value={listSearch}
                                            onChange={(e) => { setListSearch(e.target.value); setListPage(1); }}
                                            className="w-full pl-6 pr-6 py-1 text-[11px] rounded border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                                        />
                                        {listSearch && (
                                            <button onClick={() => { setListSearch(''); setListPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                <X className="h-3 w-3" />
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        <ScrollArea className="flex-1" style={{ maxHeight: 'calc(82vh - 80px)' }}>
                            <div className="p-4">
                                {loading ? (
                                    <div className="h-48 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>
                                ) : analyses.length === 0 ? (
                                    <div className="h-48 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                                        <Users className="h-10 w-10 opacity-25" />
                                        <p className="text-sm">No analyses yet</p>
                                        <p className="text-xs text-muted-foreground">Click the engagers button on any Twitter alert card to start an analysis.</p>
                                    </div>
                                ) : (
                                    <>
                                    <div className="border rounded-lg overflow-hidden">
                                        <table className="w-full text-xs">
                                            <thead className="bg-muted/50">
                                                <tr>
                                                    <th className="text-left px-3 py-2 font-semibold">Account</th>
                                                    <th className="text-center px-3 py-2 font-semibold">Status</th>
                                                    <th className="text-center px-3 py-2 font-semibold">Tweets</th>
                                                    <th className="text-center px-3 py-2 font-semibold">Engagers</th>
                                                    <th className="text-center px-3 py-2 font-semibold">Last Analyzed</th>
                                                    <th className="text-center px-3 py-2 font-semibold w-16"></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {pagedAnalyses.map(a => (
                                                    <tr key={a.id || a._id || a.handle_lower}
                                                        className={`border-t transition-colors ${a.status === 'completed' ? 'cursor-pointer hover:bg-accent/50' : ''} ${a.status === 'processing' ? 'bg-yellow-50 dark:bg-yellow-950/10' : a.status === 'failed' ? 'bg-red-50/50 dark:bg-red-950/5' : ''}`}
                                                        onClick={() => a.status === 'completed' ? openDetail(a.handle) : null}
                                                    >
                                                        <td className="px-3 py-2">
                                                            <div className="flex items-center gap-2">
                                                                {a.avatar ? (
                                                                    <img src={a.avatar} alt="" className="h-6 w-6 rounded-full object-cover shrink-0" />
                                                                ) : (
                                                                    <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[9px] font-bold shrink-0">
                                                                        {(a.display_name || a.handle || '?')[0].toUpperCase()}
                                                                    </div>
                                                                )}
                                                                <div>
                                                                    <span className="font-medium">@{a.handle}</span>
                                                                    {a.display_name && a.display_name !== a.handle && <span className="text-[10px] text-muted-foreground ml-1.5">{a.display_name}</span>}
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2 text-center">
                                                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                                                                a.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-950/30 dark:text-green-400' :
                                                                a.status === 'processing' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-400' :
                                                                a.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400' :
                                                                'bg-gray-100 text-gray-600'
                                                            }`}>
                                                                {a.status === 'processing' && <Loader2 className="h-2.5 w-2.5 animate-spin inline mr-0.5" />}
                                                                {a.status}
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2 text-center font-medium">{a.tweets_analyzed || '-'}</td>
                                                        <td className="px-3 py-2 text-center font-medium">{a.unique_retweeters || '-'}</td>
                                                        <td className="px-3 py-2 text-center text-muted-foreground">
                                                            {a.analyzed_at ? format(new Date(a.analyzed_at), 'MMM d, h:mm a') : '-'}
                                                        </td>
                                                        <td className="px-3 py-2 text-center">
                                                            {a.status === 'failed' && (
                                                                <Button size="sm" variant="outline" className="h-5 text-[9px] px-1.5" onClick={(e) => { e.stopPropagation(); retriggerAnalysis(a.handle); }}>
                                                                    Retry
                                                                </Button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    {listTotalPages > 1 && (
                                        <div className="flex items-center justify-between pt-3">
                                            <span className="text-[9px] text-muted-foreground">{filteredAnalyses.length} account{filteredAnalyses.length !== 1 ? 's' : ''} · Page {listPage}/{listTotalPages}</span>
                                            <div className="flex gap-1">
                                                <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={listPage <= 1} onClick={() => setListPage(p => p - 1)}>Prev</Button>
                                                <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={listPage >= listTotalPages} onClick={() => setListPage(p => p + 1)}>Next</Button>
                                            </div>
                                        </div>
                                    )}
                                    {listSearchTerm && filteredAnalyses.length === 0 && (
                                        <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">No accounts match "{listSearch}"</div>
                                    )}
                                    </>
                                )}
                            </div>
                        </ScrollArea>
                    </>
                ) : (
                    /* ═══ DETAIL VIEW — specific handle analysis ═══ */
                    <>
                        <div className="px-5 pt-4 pb-3 border-b border-border">
                            <div className="flex items-center gap-3">
                                <button onClick={goBack} className="text-muted-foreground hover:text-foreground transition-colors">
                                    <ChevronRight className="h-4 w-4 rotate-180" />
                                </button>
                                <div className="flex items-center gap-2 min-w-0">
                                    {sourceAvatar ? (
                                        <img src={sourceAvatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                                    ) : (
                                        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
                                            <Users className="h-4 w-4 text-white" />
                                        </div>
                                    )}
                                    <div>
                                        <h2 className="text-sm font-semibold">@{selectedHandle}</h2>
                                        {analysis && <p className="text-[10px] text-muted-foreground">{analysis.tweets_analyzed} tweets · {analysis.unique_retweeters} engagers · {analysis.period_days}-day window</p>}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {detailLoading ? (
                            <div className="h-64 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>
                        ) : !analysis ? (
                            <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No completed analysis found.</div>
                        ) : (
                            <div className="flex flex-col lg:flex-row overflow-hidden" style={{ height: 'calc(82vh - 100px)' }}>
                                {/* LEFT — Network Map */}
                                <div className="lg:w-[45%] w-full shrink-0 border-b lg:border-b-0 lg:border-r border-border flex flex-col">
                                    <div className="px-4 py-2 border-b border-border bg-muted/10 shrink-0">
                                        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                                            <Network className="h-3.5 w-3.5" /> Network Map
                                        </div>
                                    </div>
                                    <div className="flex-1 flex items-center justify-center p-3">
                                        <RetweetTree
                                            sourceHandle={selectedHandle}
                                            sourceName={sourceLabel}
                                            sourceAvatar={sourceAvatar}
                                            topRetweeters={engagers.slice(0, 8).map(e => ({ ...e, tweet_count: e.tweets_retweeted }))}
                                            totalRetweeters={analysis.unique_retweeters || 0}
                                            onNodeClick={handleAddSource}
                                            isMonitored={isMonitored}
                                        />
                                    </div>
                                    <div className="flex items-start gap-2 px-3 py-2 border-t border-border bg-muted/10 shrink-0">
                                        <Info className="h-3 w-3 text-blue-500 mt-0.5 shrink-0" />
                                        <p className="text-[9px] text-muted-foreground leading-relaxed">
                                            Click any node to <strong>add them as a monitoring source</strong>.
                                        </p>
                                    </div>
                                </div>

                                {/* RIGHT — Engager Table */}
                                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                                    <div className="px-3 pt-2 pb-0 shrink-0 space-y-2">
                                        <div className="flex items-center gap-2">
                                            <div className="flex border-b border-border">
                                                <button onClick={() => { setActiveTab('hierarchy'); setEngagerPage(1); setRetweetSearch(''); }} className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium border-b-2 transition-colors -mb-px ${activeTab === 'hierarchy' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                                                    <Users className="h-3 w-3" /> All Engagers
                                                    <span className={`ml-0.5 text-[9px] px-1 py-0.5 rounded-full font-bold ${activeTab === 'hierarchy' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{analysis.unique_retweeters}</span>
                                                </button>
                                            </div>
                                            <div className="flex-1" />
                                            <div className="relative w-48">
                                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                                <input type="text" placeholder="Search…" value={retweetSearch}
                                                    onChange={(e) => { setRetweetSearch(e.target.value); setEngagerPage(1); }}
                                                    className="w-full pl-6 pr-6 py-1 text-[11px] rounded border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                                                />
                                                {retweetSearch && (
                                                    <button onClick={() => { setRetweetSearch(''); setEngagerPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                        <X className="h-3 w-3" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        {searchTerm && <div className="text-[9px] text-muted-foreground">{filteredEngagers.length} result{filteredEngagers.length !== 1 ? 's' : ''}</div>}
                                    </div>

                                    <ScrollArea className="flex-1">
                                        <div className="px-3 py-2">
                                            {(() => {
                                                const totalPages = Math.ceil(filteredEngagers.length / PAGE_SIZE);
                                                const paged = filteredEngagers.slice((engagerPage - 1) * PAGE_SIZE, engagerPage * PAGE_SIZE);
                                                return (
                                                <div className="space-y-2">
                                                    {filteredEngagers.length === 0 ? (
                                                        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">
                                                            {searchTerm ? 'No engagers match your search.' : 'No retweeters found.'}
                                                        </div>
                                                    ) : (<>
                                                        <div className="border rounded-lg overflow-hidden">
                                                            <table className="w-full table-fixed text-[11px]">
                                                                <colgroup>
                                                                    <col style={{ width: '55%' }} />
                                                                    <col style={{ width: '25%' }} />
                                                                    <col style={{ width: '20%' }} />
                                                                </colgroup>
                                                                <thead className="bg-muted/50">
                                                                    <tr>
                                                                        <th className="text-left px-2 py-1.5 font-semibold">Engager</th>
                                                                        <th className="text-center px-2 py-1.5 font-semibold">Retweeted</th>
                                                                        <th className="text-center px-2 py-1.5 font-semibold">Monitor</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    {paged.map((rt) => {
                                                                        const already = isMonitored(rt.handle);
                                                                        const freq = rt.frequency || 'one-time';
                                                                        return (
                                                                            <tr key={rt.handle} className={`border-t transition-colors ${FREQ_ROW_COLORS[freq] || ''}`}>
                                                                                <td className="px-2 py-1.5 align-middle">
                                                                                    <div className="flex items-center gap-1.5">
                                                                                        {rt.avatar ? (
                                                                                            <img src={rt.avatar} alt="" className="h-5 w-5 rounded-full object-cover shrink-0" />
                                                                                        ) : (
                                                                                            <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[8px] font-bold shrink-0">
                                                                                                {(rt.name || rt.handle || '?')[0].toUpperCase()}
                                                                                            </div>
                                                                                        )}
                                                                                        <div className="flex flex-col min-w-0">
                                                                                            <a href={`https://x.com/${rt.handle}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline text-[11px] break-all leading-tight">@{rt.handle}</a>
                                                                                            {rt.name && rt.name !== rt.handle && <span className="text-[9px] text-muted-foreground leading-tight truncate">{rt.name}</span>}
                                                                                        </div>
                                                                                        {rt.verified && <CheckCircle2 className="h-2.5 w-2.5 text-blue-500 shrink-0" />}
                                                                                    </div>
                                                                                </td>
                                                                                <td className="px-2 py-1.5 text-center align-middle">
                                                                                    <span className="font-bold">{rt.tweets_retweeted}</span>
                                                                                    <span className="text-[9px] text-muted-foreground"> / {analysis.tweets_analyzed}</span>
                                                                                </td>
                                                                                <td className="px-2 py-1.5 text-center align-middle">
                                                                                    {onAddSource && !already ? (
                                                                                        <Button size="sm" variant="outline" className="h-5 gap-0.5 text-[9px] px-1.5 border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950/20 dark:text-green-400 dark:border-green-800" onClick={() => handleAddSource(rt)}>
                                                                                            <UserPlus className="h-2.5 w-2.5" /> Add
                                                                                        </Button>
                                                                                    ) : already ? (
                                                                                        <span className="inline-flex items-center gap-0.5 text-[9px] text-green-600 font-medium"><Check className="h-2.5 w-2.5" /> Monitored</span>
                                                                                    ) : null}
                                                                                </td>
                                                                            </tr>
                                                                        );
                                                                    })}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                        {totalPages > 1 && (
                                                            <div className="flex items-center justify-between pt-1">
                                                                <span className="text-[9px] text-muted-foreground">{filteredEngagers.length} total · Page {engagerPage}/{totalPages}</span>
                                                                <div className="flex gap-1">
                                                                    <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage <= 1} onClick={() => setEngagerPage(p => p - 1)}>Prev</Button>
                                                                    <Button size="sm" variant="outline" className="h-6 text-[9px] px-2" disabled={engagerPage >= totalPages} onClick={() => setEngagerPage(p => p + 1)}>Next</Button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </>)}
                                                </div>
                                                );
                                            })()}
                                        </div>
                                    </ScrollArea>

                                    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border bg-muted/10 shrink-0 flex-wrap">
                                        {FREQ_LEGEND.map(f => (
                                            <div key={f.key} className="flex items-center gap-1">
                                                <div className={`w-2.5 h-2.5 rounded-sm ${f.color}`} />
                                                <span className="text-[9px] text-muted-foreground">{f.label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
};

export const TwitterAlertCard = ({ alert, content, source, onResolve, onAddSource, onTriggerEngagerAnalysis, monitoredHandles = [], viewMode = 'list', searchQuery, hideActions = false, report = null, isInvestigatedResult = false, customClass = '' }) => {
    const [showReasonModal, setShowReasonModal] = useState(false);
    const [showFullTextModal, setShowFullTextModal] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStatus, setDownloadStatus] = useState('');
    const [downloadError, setDownloadError] = useState(null);
    const [isMonitored, setIsMonitored] = useState(alert?.is_monitored || false);
    const navigate = useNavigate();

    // Sync isMonitored state when alert prop changes
    useEffect(() => {
        setIsMonitored(alert?.is_monitored || false);
    }, [alert?.is_monitored, alert?.id]);

    const handleDownloadStart = () => {
        setDownloading(true);
        setDownloadError(null);
        setDownloadProgress(0);
        setDownloadStatus('Downloading...');
    };

    const handleDownloadComplete = () => {
        setDownloadProgress(100);
        setDownloadStatus('Complete!');
        setTimeout(() => {
            setDownloading(false);
            setDownloadProgress(0);
            setDownloadStatus('');
        }, 1000);
    };

    const handleDownloadError = (error) => {
        setDownloadError(error);
        setDownloading(false);
        setDownloadProgress(0);
        setDownloadStatus('');
        setTimeout(() => setDownloadError(null), 3000);
    };

    // Helper to check if a handle is already monitored
    const isMonitoredHandle = (handle) => {
        if (!handle || !Array.isArray(monitoredHandles) || monitoredHandles.length === 0) return false;

        const cleanHandle = String(handle).replace(/^@/, '').toLowerCase().trim();
        return monitoredHandles.some(h => {
            if (!h) return false;
            return String(h).replace(/^@/, '').toLowerCase().trim() === cleanHandle;
        });
    };

    // Parsing date
    const dateObj = content?.published_at ? new Date(content.published_at) : null;
    const timeStr = dateObj ? dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = dateObj ? dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

    const mediaItems = normalizeMediaList(content?.media);
    const quotedMediaItems = normalizeMediaList(content?.quoted_content?.media);

    // Gather additional media references (retweets, reposts, attachments, etc.) so downloads remain exhaustive
    const extraMediaSources = [
        content?.original_media,
        content?.reposted_content?.media,
        content?.retweeted_content?.media,
        content?.retweeted_content?.quoted_content?.media,
        content?.referenced_tweet?.media,
        content?.parent?.media,
        content?.extended_entities?.media,
        content?.media_entities,
        content?.image,
        content?.images,
        content?.video,
        content?.thumbnail,
        content?.thumbnails?.high,
        content?.thumbnails?.medium,
        content?.thumbnails?.default,
        content?.attachments?.media,
        content?.attachments,
        content?.cards_media,
        // Facebook-specific fields (from raw_data or direct API)
        content?.full_picture,
        content?.picture,
        content?.source,
        content?.raw_data?.full_picture,
        content?.raw_data?.picture,
        content?.raw_data?.image,
        content?.raw_data?.video,
        content?.raw_data?.source,
        content?.raw_data?.video_thumbnail,
        ...(Array.isArray(content?.raw_data?.album_preview)
            ? content.raw_data.album_preview.map(a => a?.url || a)
            : []),
        ...(Array.isArray(content?.raw_data?.images) ? content.raw_data.images : [])
    ];
    const extraMediaItems = extraMediaSources.flatMap((m) => normalizeMediaList(m));

    const inlineMediaItems = [];
    const seenInlineMediaUrls = new Set();
    for (const item of [...mediaItems, ...extraMediaItems]) {
        if (!item || !item.url) continue;
        if (seenInlineMediaUrls.has(item.url)) continue;
        seenInlineMediaUrls.add(item.url);
        inlineMediaItems.push(item);
    }

    const aggregatedMediaItems = [...mediaItems, ...quotedMediaItems, ...extraMediaItems];
    const uniqueMediaItems = [];
    const seenMediaUrls = new Set();
    for (const item of aggregatedMediaItems) {
        if (!item || !item.url) continue;
        if (seenMediaUrls.has(item.url)) continue;
        seenMediaUrls.add(item.url);
        uniqueMediaItems.push(item);
    }

    // Engagement
    const metrics = content?.engagement || {};
    const contentText = decodeHtmlEntities(content?.text || alert.description || '');
    const shouldShowReadMore = contentText.length > 150 || (contentText.match(/\n/g) || []).length >= 2;
    const quotedContentText = decodeHtmlEntities(content?.quoted_content?.text || '');
    const shouldShowQuotedReadMore = quotedContentText.length > 130 || (quotedContentText.match(/\n/g) || []).length >= 2;

    const [showActionDropdown, setShowActionDropdown] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [isTranslated, setIsTranslated] = useState(false);
    const [translatedText, setTranslatedText] = useState('');
    const [translatedQuotedText, setTranslatedQuotedText] = useState('');
    const [isTranslating, setIsTranslating] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isQuotedExpanded, setIsQuotedExpanded] = useState(false);
    const [showRetweetNetworkDialog, setShowRetweetNetworkDialog] = useState(false);
    const [triggeringAnalysis, setTriggeringAnalysis] = useState(false);
    const dropdownRef = useRef(null);
    const sourceIdForRetweetNetwork = content?.source_id || alert?.source_id || null;
    const sourceHandleForRetweetNetwork = content?.author_handle || source?.handle || alert?.author_handle || null;
    const canOpenRetweetNetwork = (alert?.platform === 'x' || alert?.platform === 'twitter') && (sourceIdForRetweetNetwork || sourceHandleForRetweetNetwork);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setShowActionDropdown(false);
            }
        };

        if (showActionDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showActionDropdown]);

    const [showRiskSubmenu, setShowRiskSubmenu] = React.useState(false);
    const [showCategorySubmenu, setShowCategorySubmenu] = React.useState(false);

    const categoryOptions = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];
    const categoryLabels = { political: 'Political', communal: 'Communal', trouble_makers: 'Trouble Makers', defamation: 'Defamation', narcotics: 'Narcotics', history_sheeters: 'History Sheeters', others: 'Others' };
    const categoryColors = { political: 'bg-blue-500', communal: 'bg-orange-500', trouble_makers: 'bg-red-500', defamation: 'bg-purple-500', narcotics: 'bg-pink-500', history_sheeters: 'bg-yellow-500', others: 'bg-gray-500' };
    const categoryTextColors = { political: 'text-blue-600', communal: 'text-orange-600', trouble_makers: 'text-red-600', defamation: 'text-purple-600', narcotics: 'text-pink-600', history_sheeters: 'text-yellow-600', others: 'text-gray-600' };
    const currentCategory = (alert.source_category || content?.source_category || 'unknown').toLowerCase();
    const filteredCategoryOptions = categoryOptions.filter(cat => cat !== currentCategory);

    const handleChangeCategory = async (newCategory) => {
        setActionLoading(true);
        try {
            await api.put(`/alerts/${alert.id}/change-category`, { category: newCategory });
            if (onResolve) onResolve({ ...alert, source_category: newCategory });
            setShowActionDropdown(false);
            setShowCategorySubmenu(false);
            toast.success(`Category changed to ${categoryLabels[newCategory] || newCategory}`);
        } catch (error) {
            console.error('Failed to change category:', error);
            toast.error('Failed to change category: ' + (error.response?.data?.error || error.response?.data?.message || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const handleUpdateStatus = async (status) => {
        setActionLoading(true);
        try {
            if (status === 'escalated') {
                await api.put(`/alerts/${alert.id}`, { status: 'escalated' });
            } else {
                await api.put(`/alerts/${alert.id}`, { status });
            }
            if (onResolve) onResolve({ ...alert, status });
            setShowActionDropdown(false);
        } catch (error) {
            console.error('Failed to update status:', error);
            toast.error('Failed to update status: ' + (error.response?.data?.error || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const handleUpdateRiskLevel = async (newRiskLevel) => {
        if (newRiskLevel === alert.risk_level) return;
        setActionLoading(true);
        try {
            await api.put(`/alerts/${alert.id}`, { risk_level: newRiskLevel });
            if (onResolve) onResolve({ ...alert, risk_level: newRiskLevel });
            setShowActionDropdown(false);
            setShowRiskSubmenu(false);
        } catch (error) {
            console.error('Failed to update risk level:', error);
            toast.error('Failed to update risk level: ' + (error.response?.data?.error || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const riskLevelOptions = ['low', 'medium', 'high'].filter(level => level !== alert.risk_level);
    const riskLevelColors = { low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-red-500' };
    const riskLevelTextColors = { low: 'text-emerald-600', medium: 'text-amber-600', high: 'text-red-600' };

    const analysis = content?.analysis || {};
    const intentLabel = alert.threat_details?.intent || analysis.intent || analysis.topic || '';
    const reasons = alert.threat_details?.reasons || analysis.reasons || analysis.threat_model?.reasons || [];
    const highlights = alert.threat_details?.highlights || analysis.highlights || analysis.threat_model?.highlighted_phrases || [];
    const hasReasons = true;
    const publicAlertContentUrl = toPublicExternalUrl(alert?.content_url || '');
    const publicContentDetailsUrl = toPublicExternalUrl(content?.content_url || '');
    const publicDirectUrl = toPublicExternalUrl(content?.url || content?.link || '');
    const mediaUrl = publicAlertContentUrl || publicDirectUrl || publicContentDetailsUrl;
    const cardOpenUrl = publicAlertContentUrl || publicContentDetailsUrl || publicDirectUrl;
    const [resolvedPlatformMediaItems, setResolvedPlatformMediaItems] = useState([]);
    const fallbackInlineMedia = (!inlineMediaItems.length && (isLikelyVideoUrl(mediaUrl) || isLikelyImageUrl(mediaUrl)))
        ? normalizeMediaList([{ type: isLikelyVideoUrl(mediaUrl) ? 'video' : 'photo', url: mediaUrl, preview: mediaUrl }])
        : [];
    const cardMediaItems = React.useMemo(() => pickCardMediaItems({
        platform: alert?.platform,
        inlineMediaItems,
        fallbackInlineMedia,
        resolvedFacebookMediaItems: resolvedPlatformMediaItems
    }), [alert?.platform, fallbackInlineMedia, inlineMediaItems, resolvedPlatformMediaItems]);
    const isDownloadableLink = isDownloadableSocialLink(mediaUrl);

    // Merge uniqueMediaItems with resolved platform media for downloads
    // This ensures DownloadMenu has the same resolved video URLs that VideoPlayer uses
    const downloadMediaItems = React.useMemo(() => {
        const merged = [];
        const seen = new Set();
        // Prefer cardMediaItems (includes resolved Facebook/Instagram video URLs)
        for (const item of cardMediaItems) {
            if (!item?.url || seen.has(item.url)) continue;
            seen.add(item.url);
            merged.push(item);
        }
        // Add any additional media from uniqueMediaItems not already covered
        for (const item of uniqueMediaItems) {
            if (!item?.url || seen.has(item.url)) continue;
            seen.add(item.url);
            merged.push(item);
        }
        return merged;
    }, [cardMediaItems, uniqueMediaItems]);

    const canDownload = uniqueMediaItems.length > 0 || cardMediaItems.length > 0 || isDownloadableLink;



    // Share Modal State
    const [isShareModalOpen, setIsShareModalOpen] = React.useState(false);
    const [shareText, setShareText] = React.useState('');

    useEffect(() => {
        if (!['facebook', 'instagram'].includes(String(alert?.platform || '').toLowerCase()) || !cardOpenUrl) {
            setResolvedPlatformMediaItems([]);
            return;
        }

        let cancelled = false;
        resolvePostMediaFallback(cardOpenUrl).then((resolved) => {
            if (cancelled || !resolved) return;

            const resolvedItems = [];
            const resolvedVideoCandidates = [
                resolved.video_url,
                ...(Array.isArray(resolved.video_urls) ? resolved.video_urls : [])
            ].filter(Boolean);
            const resolvedImageCandidates = [
                resolved.image_url,
                ...(Array.isArray(resolved.image_urls) ? resolved.image_urls : [])
            ].filter(Boolean);

            if (resolvedVideoCandidates.length > 0) {
                resolvedItems.push({
                    type: 'video',
                    url: resolvedVideoCandidates[0],
                    preview: resolvedImageCandidates[0] || resolvedVideoCandidates[0],
                    fallbackUrls: resolvedVideoCandidates.slice(1),
                    previewFallbackUrls: resolvedImageCandidates.slice(1)
                });
            } else if (resolvedImageCandidates.length > 0) {
                resolvedItems.push({
                    type: 'photo',
                    url: resolvedImageCandidates[0],
                    preview: resolvedImageCandidates[0],
                    fallbackUrls: [],
                    previewFallbackUrls: resolvedImageCandidates.slice(1)
                });
            }

            setResolvedPlatformMediaItems(normalizeMediaList(resolvedItems));
        });

        return () => {
            cancelled = true;
        };
    }, [alert?.platform, cardOpenUrl]);

    const generateShareText = () => {
        // Dynamic greeting
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';

        // Data extraction
        const name = content?.is_repost ? (content.original_author_name || content.original_author) : (source?.name || alert.author || 'Unknown');
        const handle = content?.is_repost ? (content.original_author) : (content?.author_handle || source?.handle || 'unknown');
        const description = content?.text || alert.description || '';
        const link = cardOpenUrl || '';
        const views = metrics.views || 0;
        const reposts = metrics.retweets || 0;

        // Extract detected content
        let riskInfo = '';
        const visibleRiskFactors = filterRiskFactors(content);
        if (visibleRiskFactors.length > 0) {
            const risks = visibleRiskFactors.map(r => r.keyword || r.context).filter(Boolean);
            if (risks.length > 0) {
                riskInfo = `\n\nDetected Content: ${risks.join(', ')}`;
            }
        }

        // Construct message - simplified format without media links
        return {
            text: `${greeting} sir,\n\n*Posted by:* ${name} (@${handle.replace('@', '')})\n\n*Description:*\n${description}${riskInfo}\n\n*Tweet URL:* ${link}\n\n*Engagement:*\nViews: ${views} | Reposts: ${reposts}`
        };
    };

    const handleFormatClick = (e) => {
        e.stopPropagation();
        const { text } = generateShareText();
        setShareText(text);
        setIsShareModalOpen(true);
    };

    const handleQuickShare = async (e) => {
        e.stopPropagation();
        const { text } = generateShareText();
        await openWhatsAppGroupShare(text);
    };

    const handleProfileClick = async (e) => {
        e.stopPropagation();
        const handle = content?.is_repost
            ? (content.original_author || content.author_handle)
            : (content?.author_handle || source?.handle || alert.author_handle);
        if (!handle) return;

        const sanitizedHandle = handle.replace(/^@/, '');
        const platform = alert?.platform || 'x';
        const sourceId = content?.source_id || alert?.source_id || '';

        try {
            const res = await api.get(`/poi/by-source/${sourceId || 'none'}?handle=${encodeURIComponent(sanitizedHandle)}&platform=${encodeURIComponent(platform)}`);
            if (res.data?._id) {
                navigate(`/person-of-interest/${res.data._id}`, { state: { poi: res.data, selectedPlatform: platform === 'twitter' ? 'x' : platform } });
                return;
            }
        } catch (_) { /* no POI found, fallback */ }

        const isUrl = /^https?:\/\//i.test(handle);
        if (platform === 'instagram') {
            window.open(isUrl ? handle : `https://www.instagram.com/${sanitizedHandle}/`, '_blank');
        } else if (platform === 'facebook') {
            window.open(isUrl ? handle : `https://www.facebook.com/${sanitizedHandle}`, '_blank');
        } else {
            navigate(`/x-monitor?handle=${sanitizedHandle}`);
        }
    };

    const handleTranslate = async (e) => {
        e.stopPropagation();
        if (isTranslated) {
            setIsTranslated(false);
            return;
        }

        if (translatedText || translatedQuotedText) {
            setIsTranslated(true);
            return;
        }

        setIsTranslating(true);
        try {
            const promises = [api.post('/alerts/translate', { text: contentText })];
            const hasQuoted = content?.quoted_content?.text;

            if (hasQuoted) {
                promises.push(api.post('/alerts/translate', { text: content.quoted_content.text }));
            }

            const results = await Promise.all(promises);
            setTranslatedText(results[0].data.translatedText);

            if (hasQuoted && results[1]) {
                setTranslatedQuotedText(results[1].data.translatedText);
            }

            setIsTranslated(true);
        } catch (error) {
            console.error('Translation failed:', error);
            toast.error('Translation failed. Please try again.');
        } finally {
            setIsTranslating(false);
        }
    };

    const handleCardClick = (e) => {
        // Prevent navigation if clicking on interactive elements
        if (e.target.closest('button') || e.target.closest('a') || (e.target.tagName === 'IMG' && !e.target.closest('.grid'))) {
            // We allow IMG clicks in the media grid (handled there), but avatar IMG is handled by handleProfileClick.
            // Actually, providing specific handlers ensures control.
            return;
        }
        if (cardOpenUrl) {
            window.open(cardOpenUrl, '_blank');
        }
    };

    const timeAgo = dateObj ? formatDistanceToNow(dateObj, { addSuffix: true }) : '';
    const isStoryCard = Boolean(alert?.is_story_archive || String(content?.content_type || '').toLowerCase() === 'story');

    return (
        <>
            <ReasonModal
                open={showReasonModal}
                onClose={() => setShowReasonModal(false)}
                alert={alert}
                content={content}
                analysis={analysis}
            />
            <Dialog open={showFullTextModal} onOpenChange={setShowFullTextModal}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Alert Content</DialogTitle>
                    </DialogHeader>
                    <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                        {contentText || 'No content available.'}
                    </div>
                </DialogContent>
            </Dialog>
            <div className={`bg-card dark:bg-[#0d1117] border border-border rounded-md hover:shadow-md transition-shadow duration-200 font-sans relative flex flex-col ${viewMode === 'list' ? (isStoryCard ? 'max-w-[360px] w-full self-start shadow-sm' : 'max-w-md w-full self-start shadow-sm') : 'w-full h-full shadow-sm'} ${isStoryCard ? 'mx-auto' : ''} ${isInvestigatedResult ? 'ring-1 ring-amber-300/50' : ''} ${customClass}`}>
                {/* Risk Level Left Border Indicator */}
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${(alert.risk_level === 'high' || alert.risk_level === 'critical') ? 'bg-red-500' :
                    (alert.risk_level === 'medium') ? 'bg-amber-500' :
                        'bg-emerald-500'
                    }`} />

                <div className={isStoryCard ? 'p-3 pl-4' : 'p-4 pl-5'}>
                    {/* Risk & Viral Badges (same row, absolute positioned) */}
                    <div className="absolute left-0 top-2.5 z-10 flex items-center gap-1.5">
                        <div className={`rounded-r-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm ${(alert.risk_level === 'high' || alert.risk_level === 'critical') ? 'bg-red-600 text-white' :
                            (alert.risk_level === 'medium') ? 'bg-amber-500 text-black' :
                                'bg-emerald-500 text-white'
                            }`}>
                            {alert.risk_level}
                        </div>
                        {alert.alert_type === 'velocity' && (
                            <div className="rounded-r-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm bg-white text-blue-900">
                                Viral
                            </div>
                        )}
                        {/* Content availability status */}
                        {content?.is_deleted && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white bg-red-600 px-2 py-0.5 rounded-full">
                                <Trash2 className="h-2.5 w-2.5" />
                                Deleted{content.deleted_at ? ` · ${new Date(content.deleted_at).toLocaleDateString()}` : ''}
                            </span>
                        )}
                        {content?.is_expired && !content?.is_deleted && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white bg-amber-500 px-2 py-0.5 rounded-full">
                                <Clock className="h-2.5 w-2.5" />
                                Expired
                            </span>
                        )}
                    </div>
                    {/* Action Controls - right-aligned, wraps left on smaller screens */}
                    <div className="flex items-center gap-2 flex-wrap justify-end mt-3 mb-2">

                        {/* Action Button */}
                        {!hideActions && alert.status === 'active' && (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setShowActionDropdown(!showActionDropdown);
                                        setShowRiskSubmenu(false);
                                        setShowCategorySubmenu(false);
                                    }}
                                    className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                >
                                    <Zap className="h-3.5 w-3.5" />
                                    <span>Action</span>
                                </button>

                                {showActionDropdown && (
                                    <div className="absolute top-full left-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                        >
                                            <Check className="h-3 w-3 text-primary" />
                                            Acknowledge
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('escalated'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors"
                                        >
                                            <AlertCircle className="h-3 w-3" />
                                            Escalate
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                        >
                                            <XCircle className="h-3 w-3" />
                                            False Positive
                                        </button>
                                        <div className="border-t border-border my-1" />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Shield className="h-3 w-3" />
                                                Change Risk Level
                                            </span>
                                            {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showRiskSubmenu && (
                                            <div className="py-1 pl-4">
                                                {riskLevelOptions.map(level => (
                                                    <button
                                                        key={level}
                                                        onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                        disabled={actionLoading}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                        {level.charAt(0).toUpperCase() + level.slice(1)}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Tags className="h-3 w-3" />
                                                Change Category
                                            </span>
                                            {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showCategorySubmenu && (
                                            <div className="py-1 pl-4">
                                                {categoryOptions.map(cat => (
                                                    <button
                                                        key={cat}
                                                        onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                        disabled={actionLoading || cat === currentCategory}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                        {categoryLabels[cat]}
                                                        {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {!hideActions && alert.status === 'escalated' && (
                            <div className="flex items-center gap-1.5">
                                <div className="relative" ref={dropdownRef}>
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setShowActionDropdown(!showActionDropdown);
                                            setShowRiskSubmenu(false);
                                            setShowCategorySubmenu(false);
                                        }}
                                        className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                    >
                                        <Zap className="h-3.5 w-3.5" />
                                        <span>Action</span>
                                    </button>

                                    {showActionDropdown && (
                                        <div className="absolute top-full left-0 mt-1 w-44 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-1">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <Check className="h-3 w-3 text-primary" />
                                                Move to Acknowledged
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <XCircle className="h-3 w-3" />
                                                Move to False Positive
                                            </button>
                                            <div className="border-t border-gray-200 dark:border-gray-800 my-1" />
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Shield className="h-3 w-3" />
                                                    Change Risk Level
                                                </span>
                                                {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                            </button>
                                            {showRiskSubmenu && (
                                                <div className="py-1 pl-4">
                                                    {riskLevelOptions.map(level => (
                                                        <button
                                                            key={level}
                                                            onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                            disabled={actionLoading}
                                                            className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                        >
                                                            <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                            {level.charAt(0).toUpperCase() + level.slice(1)}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Tags className="h-3 w-3" />
                                                    Change Category
                                                </span>
                                                {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                            </button>
                                            {showCategorySubmenu && (
                                                <div className="py-1 pl-4">
                                                    {categoryOptions.map(cat => (
                                                        <button
                                                            key={cat}
                                                            onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                            disabled={actionLoading || cat === currentCategory}
                                                            className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                        >
                                                            <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                            {categoryLabels[cat]}
                                                            {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {report ? (
                                    <HoverCard>
                                        <HoverCardTrigger asChild>
                                            <button
                                                className="text-xs font-medium text-emerald-600 flex items-center gap-1 z-20 cursor-default p-1.5 rounded-md bg-emerald-50 dark:bg-emerald-900/20"
                                            >
                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                Generated
                                            </button>
                                        </HoverCardTrigger>
                                        <HoverCardContent
                                            className="w-[320px] p-0 bg-popover border border-border shadow-lg"
                                            side="bottom"
                                            align="center"
                                        >
                                            <ReportStatusTracker report={report} />
                                        </HoverCardContent>
                                    </HoverCard>
                                ) : (
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            window.open(`/reports/generate/${alert.id}`, '_blank');
                                        }}
                                        className="text-xs font-medium text-destructive hover:text-destructive/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-destructive/10 transition-colors"
                                    >
                                        <FilePlus className="h-3.5 w-3.5" />
                                        Generate
                                    </button>
                                )}
                            </div>
                        )}

                        {!hideActions && (alert.status === 'acknowledged' || alert.status === 'false_positive') && (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setShowActionDropdown(!showActionDropdown);
                                        setShowRiskSubmenu(false);
                                        setShowCategorySubmenu(false);
                                    }}
                                    className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                >
                                    <Zap className="h-3.5 w-3.5" />
                                    <span>Action</span>
                                </button>

                                {showActionDropdown && (
                                    <div className="absolute top-full left-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1">

                                        {/* Show Acknowledge option only if currently false_positive */}
                                        {alert.status === 'false_positive' && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <Check className="h-3 w-3 text-primary" />
                                                Move to Acknowledged
                                            </button>
                                        )}

                                        {/* Show False Positive option only if currently acknowledged */}
                                        {alert.status === 'acknowledged' && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <XCircle className="h-3 w-3" />
                                                Move to False Positive
                                            </button>
                                        )}

                                        {/* Escalate - always available */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('escalated'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors"
                                        >
                                            <AlertCircle className="h-3 w-3" />
                                            Escalate
                                        </button>

                                        <div className="border-t border-border my-1" />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Shield className="h-3 w-3" />
                                                Change Risk Level
                                            </span>
                                            {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showRiskSubmenu && (
                                            <div className="py-1 pl-4">
                                                {riskLevelOptions.map(level => (
                                                    <button
                                                        key={level}
                                                        onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                        disabled={actionLoading}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                        {level.charAt(0).toUpperCase() + level.slice(1)}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Tags className="h-3 w-3" />
                                                Change Category
                                            </span>
                                            {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showCategorySubmenu && (
                                            <div className="py-1 pl-4">
                                                {categoryOptions.map(cat => (
                                                    <button
                                                        key={cat}
                                                        onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                        disabled={actionLoading || cat === currentCategory}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                        {categoryLabels[cat]}
                                                        {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            onClick={handleFormatClick}
                            className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 px-2 py-1.5 rounded-md hover:bg-accent transition-colors"
                            title="Format & Share"
                        >
                            <FileText className="h-3.5 w-3.5" />
                            {alert.status !== 'escalated' && <span>Format & Share</span>}
                        </button>

                        {canDownload && (
                            <DownloadMenu
                                mediaItems={downloadMediaItems}
                                mediaUrl={mediaUrl}
                                contentId={content?.id}
                                onDownloadStart={handleDownloadStart}
                                onDownloadComplete={handleDownloadComplete}
                                onDownloadError={handleDownloadError}
                                downloading={downloading}
                                downloadProgress={downloadProgress}
                                downloadStatus={downloadStatus}
                                downloadError={downloadError}
                                showLabel={false}
                            />
                        )}

                        {/* Relation button */}
                        <button
                            onClick={async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (!canOpenRetweetNetwork || triggeringAnalysis) return;
                                setTriggeringAnalysis(true);
                                try {
                                    const res = await api.post('/x/engager-analysis', {
                                        handle: sourceHandleForRetweetNetwork,
                                        period_days: 30,
                                        source_id: sourceIdForRetweetNetwork || undefined
                                    });
                                    const status = res.data?.status;
                                    if (status === 'already_processing') {
                                        toast.warning(`Analysis for @${sourceHandleForRetweetNetwork} is already in progress.`, { duration: 4000 });
                                    } else if (status === 'blocked') {
                                        toast.warning(`Another analysis (@${res.data?.blocked_by}) is still processing. Please wait for it to complete.`, { duration: 4000 });
                                    } else {
                                        toast.success(`Analysis started for @${sourceHandleForRetweetNetwork}`, {
                                            description: 'View detailed analysis in Frequent Engagers'
                                        });
                                        if (onTriggerEngagerAnalysis) onTriggerEngagerAnalysis();
                                    }
                                } catch (err) {
                                    toast.error('Failed to start analysis');
                                } finally {
                                    setTriggeringAnalysis(false);
                                }
                            }}
                            disabled={!canOpenRetweetNetwork || triggeringAnalysis}
                            className={`p-2 rounded-md transition-colors z-20 relative ${canOpenRetweetNetwork && !triggeringAnalysis ? 'hover:bg-accent text-muted-foreground hover:text-accent-foreground' : 'text-muted-foreground/40 cursor-not-allowed'}`}
                            title={canOpenRetweetNetwork ? 'Analyze Frequent Engagers' : 'Only available for X (Twitter)'}
                        >
                            {triggeringAnalysis ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                            {!canOpenRetweetNetwork && <span className="absolute inset-0 flex items-center justify-center"><span className="block w-5 h-[1.5px] bg-muted-foreground/50 rotate-[-45deg] rounded-full" /></span>}
                        </button>

                        {/* View Details button - always visible */}
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setShowReasonModal(true);
                            }}
                            className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors z-20"
                            title="View Details"
                        >
                            <div className="flex flex-col items-center gap-1">
                                <PlatformLogoBadge platform={alert.platform || 'x'} />
                                <Eye className="h-4 w-4" />
                            </div>
                        </button>
                    </div>

                    {/* Alert Title/Reason Removed to save space */}

                    {/* Repost Header */}
                    {content?.is_repost && (
                        <div className="flex items-center gap-2 mb-2 text-[13px] text-muted-foreground font-medium pl-10 min-w-0">
                            <Repeat className="h-4 w-4 flex-shrink-0" />
                            <span
                                className="hover:underline cursor-pointer truncate"
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    const repostHandle = content?.author_handle || source?.handle || alert.author_handle;
                                    if (!repostHandle) return;
                                    const h = repostHandle.replace('@', '');
                                    const sid = content?.source_id || alert?.source_id || '';
                                    try {
                                        const res = await api.get(`/poi/by-source/${sid || 'none'}?handle=${encodeURIComponent(h)}&platform=x`);
                                        if (res.data?._id) { navigate(`/person-of-interest/${res.data._id}`, { state: { poi: res.data, selectedPlatform: 'x' } }); return; }
                                    } catch (_) {}
                                    navigate(`/x-monitor?handle=${h}`);
                                }}
                            >
                                <HighlightText text={source?.name || alert.author} highlight={searchQuery} /> reposted
                            </span>
                        </div>
                    )}

                    {/* Header: Avatar | Name/Handle | Platform */}
                    <div className="flex justify-between items-start gap-2 mb-3">
                        <div className="flex gap-2.5 min-w-0 flex-1">
                            <div
                                className="flex-shrink-0 cursor-pointer"
                                onClick={handleProfileClick}
                            >
                                <div className="h-9 w-9 rounded-full bg-muted overflow-hidden ring-1 ring-border">
                                    <img
                                        src={content?.is_repost
                                            ? (content.original_author_avatar || `https://unavatar.io/twitter/${content.original_author}`)
                                            : (source?.profile_image_url || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png')}
                                        alt={content?.is_repost ? (content.original_author_name || content.original_author) : source?.name}
                                        className="h-full w-full object-cover"
                                        onError={(e) => { e.target.src = 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'; }}
                                    />
                                </div>
                            </div>
                            <div className="flex flex-col min-w-0 flex-1 cursor-pointer" onClick={handleProfileClick}>
                                <div className="flex items-center gap-1 group">
                                    <span className="font-semibold text-sm text-foreground leading-5 hover:underline truncate">
                                        <HighlightText text={content?.is_repost
                                            ? (content.original_author_name || content.original_author || 'Unknown User')
                                            : (source?.name || alert.author)} highlight={searchQuery} />
                                    </span>
                                    {!content?.is_repost && source?.is_verified && <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 fill-blue-500 flex-shrink-0" />}
                                </div>
                                <div className="text-xs text-muted-foreground leading-5 truncate">
                                    <HighlightText text={(content?.is_repost
                                        ? (content.original_author || 'unknown')
                                        : (content?.author_handle || source?.handle || 'user')).replace(/^@?/, '@')} highlight={searchQuery} />
                                </div>
                                <div className="mt-1">
                                    <AlertLocationChip content={content} />
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            {(() => {
                                const targetHandle = content?.is_repost
                                    ? (content.original_author || content.original_author_handle)
                                    : (content?.author_handle || source?.handle || alert.author_handle);

                                const reposterHandle = content?.author_handle || source?.handle || alert.author_handle;
                                const isSelfRepost = content?.is_repost &&
                                    targetHandle?.replace(/^@/, '').toLowerCase() === reposterHandle?.replace(/^@/, '').toLowerCase();

                                if (onAddSource && !isMonitoredHandle(targetHandle) && !isSelfRepost) {
                                    return (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 w-7 p-0 border-primary/30 text-primary hover:bg-primary/5 rounded-md flex-shrink-0"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                const sourceData = {
                                                    platform: alert.platform || 'x',
                                                    identifier: targetHandle,
                                                    display_name: content?.is_repost
                                                        ? (content.original_author_name || content.original_author)
                                                        : (source?.name || alert.author),
                                                    category: 'unknown'
                                                };
                                                onAddSource(sourceData);
                                            }}
                                        >
                                            <Plus className="h-4 w-4" />
                                        </Button>
                                    );
                                }
                                return null;
                            })()}
                        </div>
                    </div>

                    <div className={`text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words mb-2 ${!isExpanded ? (isStoryCard ? 'line-clamp-2' : 'line-clamp-3') : ''}`}>
                        <HighlightText text={isTranslated ? translatedText : contentText} highlight={searchQuery} />
                    </div>
                    <div className="flex items-center gap-3 mb-3">
                        {shouldShowReadMore && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setIsExpanded(!isExpanded);
                                }}
                                className="text-[11px] font-medium text-primary hover:text-primary/80"
                            >
                                {isExpanded ? 'Read less' : 'Read more'}
                            </button>
                        )}
                        <button
                            onClick={handleTranslate}
                            disabled={isTranslating}
                            className="text-[11px] font-medium text-primary hover:text-primary/80 flex items-center gap-1"
                        >
                            {isTranslating ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Globe className="h-3 w-3" />
                            )}
                            <span>{isTranslated ? 'Show Original' : (isTranslating ? 'Translating...' : 'Translate')}</span>
                        </button>
                    </div>

                    {/* Media Grid */}
                    {cardMediaItems.length > 0 && (
                        <div className={`mb-3 grid gap-0.5 rounded-md overflow-hidden border border-border ${cardMediaItems.length === 1 ? 'grid-cols-1' :
                            cardMediaItems.length === 2 ? 'grid-cols-2' :
                                cardMediaItems.length === 3 ? 'grid-cols-2' :
                                    'grid-cols-2'
                            } ${viewMode === 'list' ? 'max-w-md' : ''} ${isStoryCard && cardMediaItems.length === 1 ? 'max-w-[260px] mx-auto' : ''}`}>
                            {cardMediaItems.slice(0, 4).map((item, idx) => {
                                const { url, type, preview, fallbackUrls = [], previewFallbackUrls = [], s3_url: itemS3Url, s3_preview: itemS3Preview } = item;
                                const isInstagramReel = alert?.platform === 'instagram'
                                    && cardMediaItems.length === 1
                                    && (type === 'video' || type === 'animated_gif');
                                const mediaAspectClass = cardMediaItems.length > 1
                                    ? 'aspect-[4/3]'
                                    : (isStoryCard
                                        ? 'aspect-[3/4] max-h-[360px]'
                                        : (isInstagramReel
                                        ? 'aspect-[9/16]'
                                        : (type === 'video' || type === 'animated_gif' ? 'aspect-video' : 'max-h-[500px]')));

                                // Build comprehensive image fallback list
                                const imageFallbacks = [itemS3Url, itemS3Preview, preview, ...previewFallbackUrls, ...fallbackUrls].filter(
                                    (u) => u && typeof u === 'string' && u.trim() && u.trim() !== url
                                );

                                return (
                                    <div key={idx} className={`relative bg-muted ${cardMediaItems.length === 3 && idx === 0 ? 'row-span-2' : ''
                                        } ${mediaAspectClass}`}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {type === 'video' || type === 'animated_gif' ? (
                                                <VideoPlayer
                                                    url={url}
                                                    preview={preview}
                                                    type={type}
                                                    autoPlay={type === 'animated_gif'}
                                                    fallbackUrls={fallbackUrls}
                                                    previewFallbackUrls={previewFallbackUrls}
                                                    platform={alert?.platform}
                                                    contentUrl={cardOpenUrl}
                                                />
                                            ) : (
                                                <ImageWithFallback
                                                    src={url}
                                                    fallbackUrls={imageFallbacks}
                                                    alt={`Media ${idx + 1}`}
                                                    className="w-full h-full object-cover hover:opacity-95 transition-opacity"
                                                    platform={alert?.platform}
                                                    contentUrl={cardOpenUrl}
                                                />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* URL Cards (Link Previews) */}
                    {content?.url_cards && Array.isArray(content.url_cards) && content.url_cards.length > 0 && (
                        <div className="space-y-2">
                            {content.url_cards.slice(0, 1).map((card, idx) => (
                                <URLCard key={idx} card={card} />
                            ))}
                        </div>
                    )}

                    {/* Quoted Tweet */}
                    {content?.quoted_content && (
                        <div className="mb-3 rounded-md border border-border overflow-hidden hover:bg-muted/30 transition-colors cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); window.open(`https://x.com/${content.quoted_content.author_handle}`, '_blank'); }}>

                            <div className="p-3">
                                <div className="flex items-center gap-1 mb-1">
                                    <div className="h-5 w-5 rounded-full bg-muted overflow-hidden mr-1">
                                        <img src={content.quoted_content.profile_image_url || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'}
                                            className="h-full w-full object-cover" />
                                    </div>
                                    <span className="font-semibold text-sm text-foreground truncate">{content.quoted_content.author_name}</span>
                                    <span className="text-xs text-muted-foreground truncate">@{content.quoted_content.author_handle}</span>
                                    {(() => {
                                        const quotedHandle = content.quoted_content.author_handle;
                                        const mainAuthorHandle = content?.author_handle || source?.handle || alert.author_handle;
                                        const isSameUser = quotedHandle?.replace(/^@/, '').toLowerCase() === mainAuthorHandle?.replace(/^@/, '').toLowerCase();

                                        if (onAddSource && !isMonitoredHandle(quotedHandle) && !isSameUser) {
                                            return (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-5 px-1.5 text-[9px] gap-1 text-primary hover:bg-primary/5 ml-1"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        const sourceData = {
                                                            platform: 'x',
                                                            identifier: quotedHandle,
                                                            display_name: content.quoted_content.author_name,
                                                            category: 'others'
                                                        };
                                                        onAddSource(sourceData);
                                                    }}
                                                >
                                                    <Plus className="h-3 w-3" />
                                                </Button>
                                            );
                                        }
                                        return null;
                                    })()}
                                    <span className="text-xs text-muted-foreground">·</span>
                                    <span className="text-xs text-muted-foreground">{content.quoted_content.created_at ? new Date(content.quoted_content.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
                                </div>
                                <div className={`text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words ${!isQuotedExpanded ? 'line-clamp-3' : ''}`}>
                                    {isTranslated ? translatedQuotedText : content.quoted_content.text}
                                </div>
                                {shouldShowQuotedReadMore && (
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setIsQuotedExpanded(!isQuotedExpanded);
                                        }}
                                        className="text-[11px] font-medium text-primary hover:text-primary/80 mt-1"
                                    >
                                        {isQuotedExpanded ? 'Read less' : 'Read more'}
                                    </button>
                                )}
                                <button
                                    onClick={handleTranslate}
                                    disabled={isTranslating}
                                    className="text-[11px] font-medium text-primary hover:text-primary/80 flex items-center gap-1 mt-1"
                                >
                                    {isTranslating ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Globe className="h-3 w-3" />
                                    )}
                                    <span>{isTranslated ? 'Show Original' : (isTranslating ? 'Translating...' : 'Translate')}</span>
                                </button>
                            </div>

                            {/* Quoted Media */}
                            {quotedMediaItems.length > 0 && (
                                <div className={`mt-0 grid gap-0.5 border-t border-border ${quotedMediaItems.length === 1 ? 'grid-cols-1' :
                                    quotedMediaItems.length === 2 ? 'grid-cols-2' : 'grid-cols-2'}`}>
                                    {quotedMediaItems.slice(0, 4).map((item, idx) => {
                                        const { url, type, preview, fallbackUrls: qFallbacks = [], previewFallbackUrls: qPreviewFallbacks = [], s3_url: qS3, s3_preview: qS3Preview } = item;
                                        const qImageFallbacks = [qS3, qS3Preview, preview, ...qPreviewFallbacks, ...qFallbacks].filter(
                                            (u) => u && typeof u === 'string' && u.trim() && u.trim() !== url
                                        );
                                        return (
                                            <div key={idx} className={`relative bg-muted ${quotedMediaItems.length > 1 ? 'aspect-[4/3]' : (type === 'video' || type === 'animated_gif' ? 'aspect-video' : 'max-h-[300px]')}`}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {type === 'video' || type === 'animated_gif' ? (
                                                    <VideoPlayer url={url} preview={preview} type={type} autoPlay={type === 'animated_gif'} fallbackUrls={qFallbacks} previewFallbackUrls={qPreviewFallbacks} />
                                                ) : (
                                                    <ImageWithFallback src={url} fallbackUrls={qImageFallbacks} alt={`Quoted media ${idx + 1}`} className="w-full h-full object-cover" />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Metadata Line */}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2.5 border-y border-border/50">
                        <span>{timeStr}</span>
                        <span className="text-border">·</span>
                        <span>{dateStr}</span>
                        <span className="text-border">·</span>
                        <span className="font-semibold text-foreground">{formatMetric(metrics.views || 0)}</span>
                        <span className="ml-0.5">Views</span>
                    </div>

                    {/* Engagement Stats Bar */}
                    <div className="flex justify-between items-center py-1.5 px-1">
                        <div className="group flex items-center gap-1 cursor-pointer text-muted-foreground hover:text-blue-500 transition-colors p-1.5">
                            <div className="p-1 rounded-full group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-colors">
                                <MessageCircle className="h-4 w-4" />
                            </div>
                            <span className="text-[11px] group-hover:text-blue-500">{metrics.replies > 0 ? formatMetric(metrics.replies) : ''}</span>
                        </div>

                        <div className="group flex items-center gap-1 cursor-pointer text-muted-foreground hover:text-emerald-500 transition-colors p-1.5">
                            <div className="p-1 rounded-full group-hover:bg-emerald-50 dark:group-hover:bg-emerald-900/20 transition-colors">
                                <Repeat className="h-4 w-4" />
                            </div>
                            <span className="text-[11px] group-hover:text-emerald-500">{metrics.retweets > 0 ? formatMetric(metrics.retweets) : ''}</span>
                        </div>

                        <div className="group flex items-center gap-1 cursor-pointer text-muted-foreground hover:text-pink-600 transition-colors p-1.5">
                            <div className="p-1 rounded-full group-hover:bg-pink-50 dark:group-hover:bg-pink-900/20 transition-colors">
                                <Heart className="h-4 w-4" />
                            </div>
                            <span className="text-[11px] group-hover:text-pink-600">{metrics.likes > 0 ? formatMetric(metrics.likes) : ''}</span>
                        </div>

                        <div className="group flex items-center gap-1 cursor-pointer text-muted-foreground hover:text-blue-500 transition-colors p-1.5">
                            <div className="p-1 rounded-full group-hover:bg-blue-50 dark:group-hover:bg-blue-900/20 transition-colors">
                                <Share className="h-4 w-4" />
                            </div>
                        </div>
                    </div>
                </div>{/* End of p-4 pl-5 content wrapper */}

                <WhatsAppShareModal
                    isOpen={isShareModalOpen}
                    onClose={() => setIsShareModalOpen(false)}
                    initialText={shareText}
                />
            </div>
        </>
    );
};
TwitterAlertCard.displayName = 'TwitterAlertCard';

export const YoutubeAlertCard = ({ alert, content, source, onResolve, onAddSource, monitoredHandles = [], viewMode = 'list', searchQuery = '', hideActions = false, report = null, isInvestigatedResult = false, customClass = '' }) => {
    const [showReasonModal, setShowReasonModal] = useState(false);
    const [showFullTextModal, setShowFullTextModal] = useState(false);
    const [showActionDropdown, setShowActionDropdown] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [isMonitored, setIsMonitored] = useState(alert?.is_monitored || false);
    const [isTranslated, setIsTranslated] = useState(false);
    const [translatedText, setTranslatedText] = useState('');
    const [isTranslating, setIsTranslating] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [youtubeFallbackLevel, setYoutubeFallbackLevel] = useState(0); // 0: nocookie iframe, 1: standard iframe, 2: image fallback
    const dropdownRef = useRef(null);

    // Sync isMonitored state when alert prop changes
    useEffect(() => {
        setIsMonitored(alert?.is_monitored || false);
    }, [alert?.is_monitored, alert?.id]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setShowActionDropdown(false);
            }
        };

        if (showActionDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showActionDropdown]);

    const [showRiskSubmenu, setShowRiskSubmenu] = React.useState(false);
    const [showCategorySubmenu, setShowCategorySubmenu] = React.useState(false);

    const categoryOptions = ['political', 'communal', 'trouble_makers', 'defamation', 'narcotics', 'history_sheeters', 'others'];
    const categoryLabels = { political: 'Political', communal: 'Communal', trouble_makers: 'Trouble Makers', defamation: 'Defamation', narcotics: 'Narcotics', history_sheeters: 'History Sheeters', others: 'Others' };
    const categoryColors = { political: 'bg-blue-500', communal: 'bg-orange-500', trouble_makers: 'bg-red-500', defamation: 'bg-purple-500', narcotics: 'bg-pink-500', history_sheeters: 'bg-yellow-500', others: 'bg-gray-500' };
    const categoryTextColors = { political: 'text-blue-600', communal: 'text-orange-600', trouble_makers: 'text-red-600', defamation: 'text-purple-600', narcotics: 'text-pink-600', history_sheeters: 'text-yellow-600', others: 'text-gray-600' };
    const currentCategory = (alert.source_category || content?.source_category || 'unknown').toLowerCase();
    const filteredCategoryOptions = categoryOptions.filter(cat => cat !== currentCategory);

    const handleChangeCategory = async (newCategory) => {
        setActionLoading(true);
        try {
            await api.put(`/alerts/${alert.id}/change-category`, { category: newCategory });
            if (onResolve) onResolve({ ...alert, source_category: newCategory });
            setShowActionDropdown(false);
            setShowCategorySubmenu(false);
            toast.success(`Category changed to ${categoryLabels[newCategory] || newCategory}`);
        } catch (error) {
            console.error('Failed to change category:', error);
            toast.error('Failed to change category: ' + (error.response?.data?.error || error.response?.data?.message || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const handleUpdateStatus = async (status) => {
        setActionLoading(true);
        try {
            if (status === 'escalated') {
                await api.put(`/alerts/${alert.id}`, { status: 'escalated' });
            } else {
                await api.put(`/alerts/${alert.id}`, { status });
            }
            if (onResolve) onResolve({ ...alert, status });
            setShowActionDropdown(false);
        } catch (error) {
            console.error('Failed to update status:', error);
            toast.error('Failed to update status: ' + (error.response?.data?.error || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const handleUpdateRiskLevel = async (newRiskLevel) => {
        if (newRiskLevel === alert.risk_level) return;
        setActionLoading(true);
        try {
            await api.put(`/alerts/${alert.id}`, { risk_level: newRiskLevel });
            if (onResolve) onResolve({ ...alert, risk_level: newRiskLevel });
            setShowActionDropdown(false);
            setShowRiskSubmenu(false);
        } catch (error) {
            console.error('Failed to update risk level:', error);
            toast.error('Failed to update risk level: ' + (error.response?.data?.error || error.message));
        } finally {
            setActionLoading(false);
        }
    };

    const riskLevelOptions = ['low', 'medium', 'high'].filter(level => level !== alert.risk_level);
    const riskLevelColors = { low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-red-500' };
    const riskLevelTextColors = { low: 'text-emerald-600', medium: 'text-amber-600', high: 'text-red-600' };

    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStatus, setDownloadStatus] = useState('');
    const [downloadError, setDownloadError] = useState(null);

    const handleDownloadStart = () => {
        setDownloading(true);
        setDownloadError(null);
        setDownloadProgress(0);
        setDownloadStatus('Downloading...');
    };

    const handleDownloadComplete = () => {
        setDownloadProgress(100);
        setDownloadStatus('Complete!');
        setTimeout(() => {
            setDownloading(false);
            setDownloadProgress(0);
            setDownloadStatus('');
        }, 1000);
    };

    const handleDownloadError = (error) => {
        setDownloadError(error);
        setDownloading(false);
        setDownloadProgress(0);
        setDownloadStatus('');
        setTimeout(() => setDownloadError(null), 3000);
    };

    // Helper to check if a handle is already monitored
    const isMonitoredHandle = (handle) => {
        if (!handle || !Array.isArray(monitoredHandles) || monitoredHandles.length === 0) return false;
        const cleanHandle = String(handle).toLowerCase().trim();
        return monitoredHandles.some(h => {
            if (!h) return false;
            return String(h).toLowerCase().trim() === cleanHandle;
        });
    };

    const metrics = content?.engagement || {};
    const publishedAtDate = content?.published_at ? new Date(content.published_at) : null;
    const timeStr = publishedAtDate ? publishedAtDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const dateStr = publishedAtDate ? publishedAtDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const isGrid = viewMode === 'grid';
    const contentText = decodeHtmlEntities(content?.text || alert.description || '');
    const shouldShowReadMore = contentText.length > 150 || (contentText.match(/\n/g) || []).length >= 2;
    const channelHandleRaw = String(content?.author_handle || source?.handle || alert?.author_handle || '').replace(/^@+/, '');
    const channelHandle = channelHandleRaw ? `@${channelHandleRaw}` : '@youtube';
    const channelAvatar = source?.profile_image_url
        || content?.author_avatar
        || (channelHandleRaw ? `https://unavatar.io/youtube/${channelHandleRaw}` : 'https://www.gravatar.com/avatar/?d=mp');
    const analysis = content?.analysis || {};
    const intentLabel = alert.threat_details?.intent || analysis.intent || analysis.topic || '';
    const reasons = alert.threat_details?.reasons || analysis.reasons || analysis.threat_model?.reasons || [];
    const highlights = alert.threat_details?.highlights || analysis.highlights || analysis.threat_model?.highlighted_phrases || [];
    const hasReasons = intentLabel || reasons.length > 0 || highlights.length > 0;
    const rawMediaUrl = alert?.content_url || content?.url || content?.link || content?.content_url || '';
    const youtubeUrlCandidates = React.useMemo(() => {
        const candidates = collectResolvedUrls(
            rawMediaUrl,
            content?.youtube_url,
            content?.video_url,
            content?.media_url,
            content?.media_urls,
            content?.content_url,
            content?.url,
            content?.link,
            content?.media,
            alert?.content_url
        );
        return candidates.filter((candidate) => candidate && (isLikelyYouTubeUrl(candidate) || isLikelyVideoUrl(candidate)));
    }, [alert?.content_url, content?.content_url, content?.link, content?.media, content?.media_url, content?.media_urls, content?.url, content?.video_url, content?.youtube_url, rawMediaUrl]);
    const youtubeVideoId = React.useMemo(() => {
        const fromCandidates = youtubeUrlCandidates.map((candidate) => extractYouTubeVideoId(candidate)).find(Boolean);
        return fromCandidates || extractYouTubeVideoId(content?.content_id) || extractYouTubeVideoId(alert?.content_id) || '';
    }, [alert?.content_id, content?.content_id, youtubeUrlCandidates]);
    const mediaUrl = React.useMemo(() => {
        if (youtubeVideoId) return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
        return youtubeUrlCandidates.find((candidate) => isLikelyYouTubeUrl(candidate)) || rawMediaUrl || '';
    }, [rawMediaUrl, youtubeUrlCandidates, youtubeVideoId]);
    const youtubeNoCookieEmbedUrl = youtubeVideoId
        ? `https://www.youtube-nocookie.com/embed/${youtubeVideoId}?rel=0&modestbranding=1&playsinline=1`
        : '';
    const youtubeEmbedUrl = youtubeVideoId
        ? `https://www.youtube.com/embed/${youtubeVideoId}?rel=0&modestbranding=1&playsinline=1`
        : '';
    const thumbnailUrl = React.useMemo(() => {
        const fromContent = content?.thumbnails?.maxres?.url
            || content?.thumbnails?.high?.url
            || content?.thumbnails?.medium?.url
            || content?.thumbnails?.default?.url;
        if (fromContent) return fromContent;
        if (youtubeVideoId) return `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`;
        return 'https://img.youtube.com/vi/placeholder/mqdefault.jpg';
    }, [content?.thumbnails?.default?.url, content?.thumbnails?.high?.url, content?.thumbnails?.maxres?.url, content?.thumbnails?.medium?.url, youtubeVideoId]);
    const isYoutubeShort = React.useMemo(() => {
        const normalizedMediaUrl = String(mediaUrl || '').toLowerCase();
        const titleAndText = `${alert?.title || ''} ${contentText}`;
        return normalizedMediaUrl.includes('/shorts/') || /#shorts?/i.test(titleAndText);
    }, [alert?.title, contentText, mediaUrl]);
    // Share Modal State
    const [isShareModalOpen, setIsShareModalOpen] = React.useState(false);
    const [shareText, setShareText] = React.useState('');

    const generateShareText = () => {
        // Dynamic greeting
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';

        // Data extraction
        const name = source?.name || alert.author || 'Unknown';
        const description = content?.text || alert.description || '';
        const link = mediaUrl || alert.content_url || '';
        const views = metrics.views || 0;

        // Extract detected content
        let riskInfo = '';
        const visibleRiskFactors = filterRiskFactors(content);
        if (visibleRiskFactors.length > 0) {
            const risks = visibleRiskFactors.map(r => r.keyword || r.context).filter(Boolean);
            if (risks.length > 0) {
                riskInfo = `\n\nDetected Content: ${risks.join(', ')}`;
            }
        }

        // Construct message for YouTube
        return {
            text: `${greeting} sir,\n\nThis was posted by ${name} YouTube channel\n\nDescription: ${description}${riskInfo}\n\nLink: ${link}\n\nViews:${views}`
        };
    };

    const handleTranslate = async (e) => {
        e.stopPropagation();
        if (isTranslated) {
            setIsTranslated(false);
            return;
        }

        if (translatedText) {
            setIsTranslated(true);
            return;
        }

        setIsTranslating(true);
        try {
            const response = await api.post('/alerts/translate', { text: contentText });
            setTranslatedText(response.data.translatedText);
            setIsTranslated(true);
        } catch (error) {
            console.error('Translation failed:', error);
            toast.error('Translation failed. Please try again.');
        } finally {
            setIsTranslating(false);
        }
    };

    const handleFormatClick = (e) => {
        e.stopPropagation();
        const { text } = generateShareText();
        setShareText(text);
        setIsShareModalOpen(true);
    };

    useEffect(() => {
        if (youtubeNoCookieEmbedUrl) {
            setYoutubeFallbackLevel(0);
            return;
        }
        if (youtubeEmbedUrl || mediaUrl) {
            setYoutubeFallbackLevel(1);
            return;
        }
        setYoutubeFallbackLevel(2);
    }, [mediaUrl, youtubeEmbedUrl, youtubeNoCookieEmbedUrl]);

    const advanceYoutubeFallback = React.useCallback(() => {
        setYoutubeFallbackLevel((prev) => {
            const next = prev + 1;
            if (next === 1 && !youtubeEmbedUrl) return 2;
            return Math.min(next, 2);
        });
    }, [youtubeEmbedUrl]);

    return (
        <>
            <ReasonModal
                open={showReasonModal}
                onClose={() => setShowReasonModal(false)}
                alert={alert}
                content={content}
                analysis={analysis}
            />
            <Dialog open={showFullTextModal} onOpenChange={setShowFullTextModal}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Alert Content</DialogTitle>
                    </DialogHeader>
                    <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                        {contentText || 'No content available.'}
                    </div>
                </DialogContent>
            </Dialog>
            <div className={`bg-card dark:bg-[#0d1117] border border-border rounded-md hover:shadow-md transition-shadow duration-200 font-sans relative flex flex-col ${isGrid ? 'w-full h-full shadow-sm' : 'max-w-md w-full self-start shadow-sm'} ${isInvestigatedResult ? 'ring-1 ring-amber-300/50' : ''} ${customClass}`}>
                {/* Risk Level Left Border Indicator */}
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${(alert.risk_level === 'high' || alert.risk_level === 'critical') ? 'bg-red-500' :
                    (alert.risk_level === 'medium') ? 'bg-amber-500' :
                        (alert.risk_level === 'low') ? 'bg-emerald-500' :
                            'bg-slate-300 dark:bg-slate-700'
                    }`} />

                <div className="p-4 pl-5">
                    {/* Risk & Viral Badges (same row, absolute positioned) */}
                    <div className="absolute left-0 top-2.5 z-10 flex items-center gap-1.5">
                        <div className={`rounded-r-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shadow-sm ${(alert.risk_level === 'high' || alert.risk_level === 'critical') ? 'bg-red-600 text-white' :
                            (alert.risk_level === 'medium') ? 'bg-amber-500 text-black' :
                                (alert.risk_level === 'low') ? 'bg-emerald-500 text-white' :
                                    'bg-slate-400 text-white'
                            }`}>
                            {alert.risk_level}
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        {/* Content availability status */}
                        {content?.is_deleted && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white bg-red-600 px-2 py-0.5 rounded-full">
                                <Trash2 className="h-2.5 w-2.5" />
                                Deleted{content.deleted_at ? ` · ${new Date(content.deleted_at).toLocaleDateString()}` : ''}
                            </span>
                        )}
                        {content?.is_expired && !content?.is_deleted && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-white bg-amber-500 px-2 py-0.5 rounded-full">
                                <Clock className="h-2.5 w-2.5" />
                                Expired
                            </span>
                        )}
                    </div>
                    {/* Action Controls - right-aligned, wraps left on smaller screens */}
                    <div className="flex items-center gap-2 flex-wrap justify-end mt-3 mb-2">
                        {(() => {
                            const targetHandle = content?.channelId || alert.author_handle;
                            if (onAddSource && targetHandle && !isMonitoredHandle(targetHandle)) {
                                return (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 w-7 p-0 border-primary/30 text-primary hover:bg-primary/5 rounded-md flex-shrink-0"
                                        title="Monitor Profile"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const sourceData = {
                                                platform: 'youtube',
                                                identifier: targetHandle,
                                                display_name: content?.author_name || alert.author,
                                                category: 'others'
                                            };
                                            onAddSource(sourceData);
                                        }}
                                    >
                                        <Plus className="h-4 w-4" />
                                    </Button>
                                );
                            }
                            return null;
                        })()}

                        {!hideActions && alert.status === 'active' && (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setShowActionDropdown(!showActionDropdown);
                                        setShowRiskSubmenu(false);
                                        setShowCategorySubmenu(false);
                                    }}
                                    className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                >
                                    <Zap className="h-3.5 w-3.5" />
                                    <span>Action</span>
                                </button>

                                {showActionDropdown && (
                                    <div className="absolute top-full left-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                        >
                                            <Check className="h-3 w-3 text-primary" />
                                            Acknowledge
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('escalated'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors"
                                        >
                                            <AlertCircle className="h-3 w-3" />
                                            Escalate
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                        >
                                            <XCircle className="h-3 w-3" />
                                            False Positive
                                        </button>
                                        <div className="border-t border-border my-1" />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Shield className="h-3 w-3" />
                                                Change Risk Level
                                            </span>
                                            {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showRiskSubmenu && (
                                            <div className="py-1 pl-4">
                                                {riskLevelOptions.map(level => (
                                                    <button
                                                        key={level}
                                                        onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                        disabled={actionLoading}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                        {level.charAt(0).toUpperCase() + level.slice(1)}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Tags className="h-3 w-3" />
                                                Change Category
                                            </span>
                                            {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showCategorySubmenu && (
                                            <div className="py-1 pl-4">
                                                {categoryOptions.map(cat => (
                                                    <button
                                                        key={cat}
                                                        onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                        disabled={actionLoading || cat === currentCategory}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                        {categoryLabels[cat]}
                                                        {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {!hideActions && alert.status === 'escalated' && (
                            <div className="flex items-center gap-1.5">
                                <div className="relative" ref={dropdownRef}>
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setShowActionDropdown(!showActionDropdown);
                                            setShowRiskSubmenu(false);
                                            setShowCategorySubmenu(false);
                                        }}
                                        className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                    >
                                        <Zap className="h-3.5 w-3.5" />
                                        <span>Action</span>
                                    </button>

                                    {showActionDropdown && (
                                        <div className="absolute top-full left-0 mt-1 w-44 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-1">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <Check className="h-3 w-3 text-primary" />
                                                Move to Acknowledged
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <XCircle className="h-3 w-3" />
                                                Move to False Positive
                                            </button>
                                            <div className="border-t border-gray-200 dark:border-gray-800 my-1" />
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Shield className="h-3 w-3" />
                                                    Change Risk Level
                                                </span>
                                                {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                            </button>
                                            {showRiskSubmenu && (
                                                <div className="py-1 pl-4">
                                                    {riskLevelOptions.map(level => (
                                                        <button
                                                            key={level}
                                                            onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                            disabled={actionLoading}
                                                            className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                        >
                                                            <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                            {level.charAt(0).toUpperCase() + level.slice(1)}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Tags className="h-3 w-3" />
                                                    Change Category
                                                </span>
                                                {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                            </button>
                                            {showCategorySubmenu && (
                                                <div className="py-1 pl-4">
                                                    {categoryOptions.map(cat => (
                                                        <button
                                                            key={cat}
                                                            onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                            disabled={actionLoading || cat === currentCategory}
                                                            className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                        >
                                                            <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                            {categoryLabels[cat]}
                                                            {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {report ? (
                                    <HoverCard>
                                        <HoverCardTrigger asChild>
                                            <button
                                                className="text-xs font-medium text-emerald-600 flex items-center gap-1 z-20 cursor-default p-1.5 rounded-md bg-emerald-50 dark:bg-emerald-900/20"
                                            >
                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                                Generated
                                            </button>
                                        </HoverCardTrigger>
                                        <HoverCardContent
                                            className="w-[320px] p-0 bg-popover border border-border shadow-lg"
                                            side="bottom"
                                            align="center"
                                        >
                                            <ReportStatusTracker report={report} />
                                        </HoverCardContent>
                                    </HoverCard>
                                ) : (
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            window.open(`/reports/generate/${alert.id}`, '_blank');
                                        }}
                                        className="text-xs font-medium text-destructive hover:text-destructive/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-destructive/10 transition-colors"
                                    >
                                        <FilePlus className="h-3.5 w-3.5" />
                                        Generate
                                    </button>
                                )}
                            </div>
                        )}

                        {!hideActions && (alert.status === 'acknowledged' || alert.status === 'false_positive') && (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setShowActionDropdown(!showActionDropdown);
                                        setShowRiskSubmenu(false);
                                        setShowCategorySubmenu(false);
                                    }}
                                    className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 p-1.5 rounded-md hover:bg-accent transition-colors"
                                >
                                    <Zap className="h-3.5 w-3.5" />
                                    <span>Action</span>
                                </button>

                                {showActionDropdown && (
                                    <div className="absolute top-full left-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1">

                                        {alert.status === 'false_positive' && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('acknowledged'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <Check className="h-3 w-3 text-primary" />
                                                Move to Acknowledged
                                            </button>
                                        )}

                                        {alert.status === 'acknowledged' && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleUpdateStatus('false_positive'); }}
                                                disabled={actionLoading}
                                                className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent flex items-center gap-2 transition-colors"
                                            >
                                                <XCircle className="h-3 w-3" />
                                                Move to False Positive
                                            </button>
                                        )}

                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleUpdateStatus('escalated'); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors"
                                        >
                                            <AlertCircle className="h-3 w-3" />
                                            Escalate
                                        </button>

                                        <div className="border-t border-border my-1" />
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowRiskSubmenu(!showRiskSubmenu); setShowCategorySubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Shield className="h-3 w-3" />
                                                Change Risk Level
                                            </span>
                                            {showRiskSubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showRiskSubmenu && (
                                            <div className="py-1 pl-4">
                                                {riskLevelOptions.map(level => (
                                                    <button
                                                        key={level}
                                                        onClick={(e) => { e.stopPropagation(); handleUpdateRiskLevel(level); }}
                                                        disabled={actionLoading}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-2 rounded transition-colors ${riskLevelTextColors[level]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${riskLevelColors[level]}`} />
                                                        {level.charAt(0).toUpperCase() + level.slice(1)}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowCategorySubmenu(!showCategorySubmenu); setShowRiskSubmenu(false); }}
                                            disabled={actionLoading}
                                            className="w-full text-left px-3 py-2 text-xs font-medium text-foreground hover:bg-accent flex items-center justify-between transition-colors"
                                        >
                                            <span className="flex items-center gap-2">
                                                <Tags className="h-3 w-3" />
                                                Change Category
                                            </span>
                                            {showCategorySubmenu ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        {showCategorySubmenu && (
                                            <div className="py-1 pl-4">
                                                {categoryOptions.map(cat => (
                                                    <button
                                                        key={cat}
                                                        onClick={(e) => { e.stopPropagation(); if (cat !== currentCategory) handleChangeCategory(cat); }}
                                                        disabled={actionLoading || cat === currentCategory}
                                                        className={`w-full text-left px-3 py-1.5 text-xs font-medium flex items-center gap-2 rounded transition-colors ${cat === currentCategory ? "bg-accent font-semibold" : "hover:bg-accent"} ${categoryTextColors[cat]}`}
                                                    >
                                                        <span className={`h-2 w-2 rounded-full ${categoryColors[cat]}`} />
                                                        {categoryLabels[cat]}
                                                        {cat === currentCategory && <Check className="h-3 w-3 ml-auto" />}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            onClick={handleFormatClick}
                            className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 z-20 px-2 py-1.5 rounded-md hover:bg-accent transition-colors"
                            title="Format & Share"
                        >
                            <FileText className="h-3.5 w-3.5" />
                            {alert.status !== 'escalated' && <span>Format & Share</span>}
                        </button>

                        {mediaUrl && (
                            <DownloadMenu
                                mediaItems={[{ type: 'video', url: mediaUrl }]}
                                mediaUrl={mediaUrl}
                                contentId={content?.id}
                                onDownloadStart={handleDownloadStart}
                                onDownloadComplete={handleDownloadComplete}
                                onDownloadError={handleDownloadError}
                                downloading={downloading}
                                downloadProgress={downloadProgress}
                                downloadStatus={downloadStatus}
                                downloadError={downloadError}
                                showLabel={false}
                            />
                        )}

                        <button
                            disabled
                            className="p-2 rounded-md text-muted-foreground/40 cursor-not-allowed transition-colors relative"
                            title="Only available for X (Twitter)"
                        >
                            <Users className="h-4 w-4" />
                            <span className="absolute inset-0 flex items-center justify-center"><span className="block w-5 h-[1.5px] bg-muted-foreground/50 rotate-[-45deg] rounded-full" /></span>
                        </button>

                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setShowReasonModal(true);
                            }}
                            className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors z-20"
                            title="View Details"
                        >
                            <div className="flex flex-col items-center gap-1">
                                <PlatformLogoBadge platform={alert.platform || 'youtube'} />
                                <Eye className="h-4 w-4" />
                            </div>
                        </button>
                    </div>
                    {/* Header: Avatar | Channel */}
                    <div className="flex justify-between items-start gap-2 mb-3">
                        <div className="flex gap-2.5 min-w-0 flex-1">
                            <div className="flex-shrink-0">
                                <div className="h-9 w-9 rounded-full bg-muted overflow-hidden ring-1 ring-border">
                                    <img
                                        src={channelAvatar}
                                        alt={source?.name || alert.author || 'YouTube'}
                                        className="h-full w-full object-cover"
                                        onError={(e) => { e.target.src = 'https://www.gravatar.com/avatar/?d=mp'; }}
                                    />
                                </div>
                            </div>
                            <div className="flex flex-col min-w-0 flex-1">
                                <span className="font-semibold text-sm text-foreground leading-5 truncate">{source?.name || alert.author || 'YouTube'}</span>
                                <span className="text-xs text-muted-foreground leading-5 truncate">{channelHandle}</span>
                                <div className="mt-1">
                                    <AlertLocationChip content={content} />
                                </div>
                            </div>
                        </div>
                    </div>

                    <a
                        href={mediaUrl || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block mb-1.5"
                    >
                        <h3 className="text-sm font-semibold text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors">
                            {alert.title}
                        </h3>
                    </a>

                    <div className={`text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words mb-2 ${!isExpanded ? 'line-clamp-3' : ''}`}>
                        {isTranslated ? translatedText : contentText}
                    </div>
                    <div className="flex items-center gap-3 mb-3">
                        {shouldShowReadMore && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setIsExpanded(!isExpanded);
                                }}
                                className="text-[11px] font-medium text-primary hover:text-primary/80"
                            >
                                {isExpanded ? 'Read less' : 'Read more'}
                            </button>
                        )}
                        <button
                            onClick={handleTranslate}
                            disabled={isTranslating}
                            className="text-[11px] font-medium text-primary hover:text-primary/80 flex items-center gap-1"
                        >
                            {isTranslating ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Globe className="h-3 w-3" />
                            )}
                            <span>{isTranslated ? 'Show Original' : (isTranslating ? 'Translating...' : 'Translate')}</span>
                        </button>
                    </div>

                    {/* Inline YouTube Player */}
                    <div className={`relative mb-3 w-full overflow-hidden rounded-md border border-border bg-black ${isYoutubeShort ? 'max-w-[320px] mx-auto aspect-[9/16]' : 'aspect-video'}`}>
                    {youtubeFallbackLevel === 0 && youtubeNoCookieEmbedUrl && (
                        <iframe
                            key={`yt-nocookie-${youtubeVideoId || alert?.id || mediaUrl}`}
                            src={youtubeNoCookieEmbedUrl}
                            title={alert.title || 'YouTube video'}
                            className="absolute inset-0 w-full h-full"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            referrerPolicy="strict-origin-when-cross-origin"
                            loading="lazy"
                            allowFullScreen
                            onError={advanceYoutubeFallback}
                        />
                    )}

                    {youtubeFallbackLevel === 1 && (youtubeEmbedUrl || mediaUrl) && (
                        <iframe
                            key={`yt-embed-${youtubeVideoId || alert?.id || mediaUrl}`}
                            src={youtubeEmbedUrl || mediaUrl}
                            title={alert.title || 'YouTube video'}
                            className="absolute inset-0 w-full h-full"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            referrerPolicy="strict-origin-when-cross-origin"
                            loading="lazy"
                            allowFullScreen
                            onError={advanceYoutubeFallback}
                        />
                    )}

                    {youtubeFallbackLevel >= 2 && (
                        <div className="relative w-full h-full">
                            <ImageWithFallback
                                src={thumbnailUrl}
                                fallbackUrls={youtubeVideoId ? [
                                    `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`,
                                    `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`
                                ] : []}
                                alt={alert.title || 'YouTube thumbnail'}
                                className="w-full h-full object-cover"
                            />
                            {mediaUrl && (
                                <a
                                    href={mediaUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 hover:bg-black/45 transition-colors"
                                    title="Open on YouTube"
                                >
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-black/80 px-3 py-1.5 text-xs font-semibold text-white">
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        Open on YouTube
                                    </span>
                                </a>
                            )}
                        </div>
                    )}

                    {mediaUrl && youtubeFallbackLevel < 2 && (
                        <a
                            href={mediaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-1.5 right-1.5 z-20 bg-black/70 hover:bg-black/85 text-white p-1 rounded-md transition-colors"
                            title="Open on YouTube"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                    )}

                    {/* Download Progress Overlay */}
                    {downloading && (
                        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 backdrop-blur-sm rounded-md z-30">
                            <Download className="h-8 w-8 text-white animate-bounce" />
                            <div className="w-3/4">
                                <div className="flex justify-between text-xs text-white mb-1">
                                    <span>{downloadStatus}</span>
                                    <span>{Math.round(downloadProgress)}%</span>
                                </div>
                                <div className="w-full bg-gray-600 rounded-full h-2 overflow-hidden">
                                    <div
                                        className="bg-green-500 h-full rounded-full transition-all duration-300 ease-out"
                                        style={{ width: `${downloadProgress}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs font-medium px-1.5 py-0.5 rounded z-20">
                        {content?.duration || '0:00'}
                    </div>

                    </div>

                {/* Info Section */}
                <div className="flex flex-col flex-grow min-w-0 px-4 pl-5 pb-4">
                    <a
                        href={mediaUrl || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block mb-1.5"
                    >
                        <h3 className="text-sm font-semibold text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors">
                            <HighlightText text={alert.title} highlight={searchQuery} />
                        </h3>
                    </a>

                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-2">
                        <span className="font-medium text-foreground/80 hover:underline"><HighlightText text={source?.name || alert.author} highlight={searchQuery} /></span>
                        <span className="text-border">•</span>
                        <span>{formatMetric(metrics.views || 0)} views</span>
                        <span className="text-border">•</span>
                        <span>{dateStr || '—'}</span>
                    </div>

                    <div className={`text-xs text-muted-foreground mb-2 ${!isExpanded ? 'line-clamp-3' : ''} leading-relaxed`}>
                        <HighlightText text={isTranslated ? translatedText : contentText} highlight={searchQuery} />
                    </div>
                    <div className="flex items-center gap-3">
                        {shouldShowReadMore && (
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setIsExpanded(!isExpanded);
                                }}
                                className="text-[11px] font-medium text-primary hover:text-primary/80"
                            >
                                {isExpanded ? 'Read less' : 'Read more'}
                            </button>
                        )}
                        <button
                            onClick={handleTranslate}
                            disabled={isTranslating}
                            className="text-[11px] font-medium text-primary hover:text-primary/80 flex items-center gap-1"
                        >
                            {isTranslating ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <Globe className="h-3 w-3" />
                            )}
                            <span>{isTranslated ? 'Show Original' : (isTranslating ? 'Translating...' : 'Translate')}</span>
                        </button>
                    </div>

                    {/* Metadata Line */}
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground py-2.5 border-y border-border/50 mb-3">
                        {timeStr && <span>{timeStr}</span>}
                        {timeStr && dateStr && <span className="text-border">·</span>}
                        {dateStr && <span>{dateStr}</span>}
                        {(timeStr || dateStr) && <span className="text-border">·</span>}
                        <span className="font-semibold text-foreground">{formatMetric(metrics.views || 0)}</span>
                        <span className="ml-0.5">Views</span>
                    </div>

                    {/* Risk Factors */}
                    {filterRiskFactors(content).length > 0 && (
                        <div className="mb-3 flex flex-wrap gap-1.5">
                            {filterRiskFactors(content).map((factor, idx) => (
                                <div key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-[10px] font-medium text-red-700 dark:text-red-400">
                                    <Zap className="h-2.5 w-2.5 fill-red-700 dark:fill-red-400" />
                                    <span>
                                        {factor.keyword ? `Matched: "${factor.keyword}"` : factor.context || 'Risk Detected'}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Threat Summary */}
                    {hasReasons && (
                        <div className="mb-3 flex items-center justify-between p-2 rounded-md bg-muted/50 border border-border">
                            <div className="flex items-center gap-2 flex-wrap">
                                {intentLabel && (
                                    <span className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${intentLabel.toLowerCase().includes('violence') ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                        intentLabel.toLowerCase().includes('political') ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' :
                                            intentLabel.toLowerCase().includes('communal') ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                                                'bg-muted text-muted-foreground'
                                        }`}>
                                        {intentLabel}
                                    </span>
                                )}
                                {highlights.length > 0 && (
                                    <div className="flex items-center gap-1">
                                        <span className="text-[10px] text-muted-foreground">Flagged:</span>
                                        {highlights.slice(0, 2).map((phrase, idx) => (
                                            <span key={idx} className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-1.5 py-0.5 rounded-full text-[10px] font-medium">
                                                {phrase}
                                            </span>
                                        ))}
                                        {highlights.length > 2 && (
                                            <span className="text-[10px] text-muted-foreground">+{highlights.length - 2}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    setShowReasonModal(true);
                                }}
                                className="flex items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80 px-2 py-1 rounded-md hover:bg-accent transition-colors shrink-0"
                                title="View Details"
                            >
                                <Info className="h-3 w-3" />
                            </button>
                        </div>
                    )}

                    <div className="flex items-center justify-between text-muted-foreground pt-2 border-t border-border/50">
                        <div className="flex gap-4">
                            <div className="flex items-center gap-1 text-[11px]">
                                <ThumbsUp className="h-3 w-3" />
                                <span>{formatMetric(metrics.likes || 0)}</span>
                            </div>
                            <div className="flex items-center gap-1 text-[11px]">
                                <MessageSquare className="h-3 w-3" />
                                <span>{formatMetric(metrics.comments || 0)}</span>
                            </div>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] font-medium">
                            <AlertTriangleIcon level={alert.risk_level} />
                            <span className={`${alert.risk_level === 'high' || alert.risk_level === 'critical' ? 'text-red-500' : alert.risk_level === 'low' ? 'text-emerald-500' : 'text-amber-500'}`}>Risk: {content?.risk_score || alert.threat_details?.risk_score || 0}%</span>
                        </div>
                    </div>
                </div>
            </div>
            </div>
            <WhatsAppShareModal
                isOpen={isShareModalOpen}
                onClose={() => setIsShareModalOpen(false)}
                initialText={shareText}
            />
        </>
    );
};
YoutubeAlertCard.displayName = 'YoutubeAlertCard';

const AlertTriangleIcon = ({ level }) => {
    const color = level === 'high' || level === 'critical' ? '#ef4444' : '#f59e0b';
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
        </svg>
    )
}
