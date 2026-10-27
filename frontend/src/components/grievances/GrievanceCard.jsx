import React, { useEffect, useRef, useState } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import {
    Heart, MessageCircle, Repeat2, BarChart3, Bookmark,
    BadgeCheck, Download, Loader2, Eye, Radar, Check
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { normalizeMediaList } from '../AlertCards';
import ReasonModal from '../ReasonModal';
import { cn } from '../../lib/utils';
import { decodeHtmlEntities } from '../../utils/decodeHtml';

let activeInlineVideoElement = null;

/* ═══════════════════════════════════════════════════════════════ */
/*        SENTIMENT ANALYSIS (services/sentiment grievance)       */
/* ═══════════════════════════════════════════════════════════════ */

const SENTIMENT_BADGE = {
    negative: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400',
    positive: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-400',
    neutral: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-400',
};
const SENTIMENT_DOT = { positive: 'bg-emerald-500', neutral: 'bg-amber-500', negative: 'bg-red-500' };
const SENTIMENT_LABEL = { positive: 'Positive', neutral: 'Neutral', negative: 'Negative' };

// Waiting/failed states, so an officer can tell "not analysed yet" from "nothing found".
const ANALYSIS_NOTICE = {
    pending: 'Analysis is queued and will appear here shortly.',
    processing: 'Analysis is running now.',
    failed: 'Analysis could not be completed for this grievance.',
    skipped: 'No text to analyse in this grievance.',
};

/** Banner text while the pipeline has not produced a result yet. */
const getAnalysisNotice = (grievance) => {
    if (grievance?.analysis?.sentiment) return null;
    return ANALYSIS_NOTICE[grievance?.analysis_status] || ANALYSIS_NOTICE.pending;
};

/**
 * The shape ReasonModal reads. Built to match what alertController sends the
 * same modal for a monitored post, so a grievance and an alert render alike.
 * Each field falls back for grievances analysed before the pipeline stored the
 * full block.
 */
const buildAnalysisAlert = (grievance) => {
    const analysis = grievance?.analysis || {};
    const llm = analysis.llm_analysis || null;
    const keywords = (analysis.triggered_keywords?.length ? analysis.triggered_keywords : analysis.keywords) || [];
    const highlights = analysis.highlights?.length ? analysis.highlights : keywords;
    const riskScore = analysis.risk_score ?? llm?.score ?? 0;
    const reasoning = analysis.explanation || analysis.reasoning || llm?.reasoning || '';
    const reasons = analysis.reasons?.length ? analysis.reasons : (reasoning ? [reasoning] : []);
    return {
        llm_analysis: llm,
        risk_level: analysis.risk_level || 'low',
        risk_score: riskScore,
        threat_details: {
            intent: analysis.intent || llm?.intent || '',
            reasons,
            highlights,
            risk_score: riskScore,
        },
        violated_policies: analysis.violated_policies || [],
        legal_sections: analysis.legal_sections || [],
        matched_keywords_normalized: keywords,
        triggered_keywords: keywords,
        classification_explanation: reasoning,
        stance: analysis.stance || null,
        signals: analysis.signals || [],
        description: decodeHtmlEntities(grievance?.content?.full_text || grievance?.content?.text || ''),
        platform: grievance?.platform || 'x',
        content_url: grievance?.tweet_url || null,
    };
};

const SentimentBadge = ({ grievance, onOpen }) => {
    const sentiment = grievance?.analysis?.sentiment;
    const status = grievance?.analysis_status;
    if (!sentiment || !SENTIMENT_LABEL[sentiment]) {
        const notice = ANALYSIS_NOTICE[status];
        if (!notice) return null;
        return <span className="text-[11px] text-slate-400 dark:text-slate-500" title={notice}>Analysis {status}</span>;
    }
    const level = grievance?.analysis?.risk_level;
    const score = grievance?.analysis?.risk_score;
    return (
        <button
            type="button"
            onClick={onOpen}
            title={`View AI analysis${level ? ` · ${level} risk${typeof score === 'number' ? ` (${score})` : ''}` : ''}`}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-all active:scale-95',
                SENTIMENT_BADGE[sentiment]
            )}
        >
            <span className={cn('h-1.5 w-1.5 rounded-full', SENTIMENT_DOT[sentiment])} />
            {SENTIMENT_LABEL[sentiment]}
        </button>
    );
};

const XBrandMark = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
);
const FacebookBrandMark = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M22 12.06C22 6.505 17.523 2 12 2S2 6.505 2 12.06c0 5.02 3.657 9.184 8.438 9.94v-7.03H7.898v-2.91h2.54V9.845c0-2.507 1.492-3.89 3.777-3.89 1.094 0 2.238.196 2.238.196v2.459h-1.26c-1.243 0-1.63.771-1.63 1.562v1.878h2.773l-.443 2.91h-2.33V22c4.78-.756 8.437-4.92 8.437-9.94z" />
    </svg>
);
const WhatsAppBrandMark = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2.05 22l5.25-1.38a9.85 9.85 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.85 9.85 0 0 0 12.04 2z" />
    </svg>
);

const PLATFORM_BADGE_STYLE = {
    x: { bg: 'bg-black dark:bg-white', icon: 'text-white dark:text-black', Icon: XBrandMark },
    facebook: { bg: 'bg-[#1877F2]', icon: 'text-white', Icon: FacebookBrandMark },
    whatsapp: { bg: 'bg-[#25D366]', icon: 'text-white', Icon: WhatsAppBrandMark },
};

// Small circular platform mark, pinned to an avatar's corner — the primary
// "which platform is this" signal now that the All tab mixes X, Facebook and
// WhatsApp cards, which can otherwise look alike at a glance.
const PlatformCornerBadge = ({ platform, className = '' }) => {
    const key = String(platform || '').toLowerCase();
    const style = PLATFORM_BADGE_STYLE[key];
    if (!style) return null;
    const { Icon } = style;
    return (
        <span
            className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ring-2 ring-white dark:ring-slate-900', style.bg, className)}
            title={key === 'x' ? 'X (Twitter)' : key === 'facebook' ? 'Facebook' : 'WhatsApp'}
        >
            <Icon className={cn('h-2.5 w-2.5', style.icon)} />
        </span>
    );
};

const GlobeIcon = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className={className}>
        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM1.6 8a6.4 6.4 0 0 1 12.8 0 6.4 6.4 0 0 1-12.8 0z" />
        <path d="M8 1.5c-1.5 0-2.8 2.9-2.8 6.5s1.3 6.5 2.8 6.5 2.8-2.9 2.8-6.5S9.5 1.5 8 1.5z" />
        <path d="M1.5 8h13M2 5h12M2 11h12" stroke="currentColor" strokeWidth="0.8" fill="none" />
    </svg>
);
const ThumbsUpIcon = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
    </svg>
);
const ShareFBIcon = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
    </svg>
);

/* ─── Helpers ─── */
const formatCount = (n) => {
    if (!n || n === 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
};
const timeAgo = (date) => {
    if (!date) return '';
    try { return formatDistanceToNowStrict(new Date(date), { addSuffix: false }); } catch { return ''; }
};
const formatFullDate = (date) => {
    if (!date) return '';
    try { return format(new Date(date), "h:mm a · MMM d, yyyy"); } catch { return ''; }
};
const highlightMentions = (text) => {
    if (!text) return null;
    return text.split(/([@#]\w+)/g).map((part, i) =>
        part.startsWith('@') || part.startsWith('#')
            ? <span key={i} className="text-[#1d9bf0] hover:underline cursor-pointer">{part}</span>
            : <span key={i}>{part}</span>
    );
};

const hasRenderableThreadContent = (node) => {
    if (!node) return false;
    const text = node?.content?.full_text || node?.content?.text || '';
    const mediaCount = Array.isArray(node?.content?.media) ? node.content.media.length : 0;
    return Boolean(String(text).trim()) || mediaCount > 0;
};

const hasThreadReference = (node) => {
    if (!node) return false;
    return Boolean(node?.tweet_id || node?.tweet_url || node?.url || node?.id);
};

const buildContextPostUrl = (node = {}) => {
    const directUrl = String(node?.tweet_url || node?.url || '').trim();
    if (directUrl) return directUrl;

    const tweetId = String(node?.tweet_id || node?.id || '').trim();
    if (!tweetId) return '';

    const handle = String(node?.posted_by?.handle || '').replace(/^@/, '').trim();
    return handle ? `https://x.com/${handle}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`;
};

const ThreadLoadingPlaceholder = ({ className = '', node = null, label = 'Thread post', onRetry = null, retrying = false }) => {
    const fallbackUrl = buildContextPostUrl(node);
    return (
        <div className={cn('rounded-lg bg-slate-50 dark:bg-slate-800/60 border-l-2 border-[#1d9bf0]/40 px-3 py-2 text-[12px] text-slate-500 dark:text-slate-400 flex items-center flex-wrap gap-x-3 gap-y-1', className)}>
            <span className="font-medium text-slate-600 dark:text-slate-300">{label}</span>
            <span className="text-slate-400">·</span>
            <span>content unavailable</span>
            {onRetry && (
                <button
                    onClick={(e) => { e.stopPropagation(); onRetry(); }}
                    disabled={retrying}
                    className="inline-flex items-center gap-1 text-[#1d9bf0] hover:text-[#1a8cd8] font-medium disabled:opacity-50 transition-colors ml-auto"
                >
                    {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Repeat2 className="h-3 w-3" />}
                    {retrying ? 'Fetching…' : 'Retry'}
                </button>
            )}
            {fallbackUrl && (
                <a
                    href={fallbackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#1d9bf0] hover:underline font-medium"
                    onClick={(e) => e.stopPropagation()}
                >
                    Open on X →
                </a>
            )}
        </div>
    );
};

const uniqueNonEmpty = (list = []) => {
    const seen = new Set();
    const result = [];
    list.forEach((value) => {
        const next = typeof value === 'string' ? value.trim() : '';
        if (!next || seen.has(next)) return;
        seen.add(next);
        result.push(next);
    });
    return result;
};

const buildResolvedUrls = (urls = [], getProxiedMediaUrl, options = {}) => {
    const { includeRawFallback = true } = options;
    const resolved = [];
    urls.forEach((url) => {
        if (!url) return;
        const raw = String(url).trim();
        if (!raw) return;
        const proxied = getProxiedMediaUrl?.(raw) || raw;
        if (proxied) resolved.push(proxied);
        if (includeRawFallback && proxied !== raw) resolved.push(raw);
    });
    return uniqueNonEmpty(resolved);
};

const MediaImage = ({ urls, className = '', objectFit = 'cover' }) => {
    const [activeIndex, setActiveIndex] = useState(0);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const candidates = uniqueNonEmpty(urls);

    if (!candidates.length || failed) {
        return (
            <div className={cn('w-full h-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 text-xs', className)}>
                <span>Image unavailable</span>
            </div>
        );
    }

    return (
        <div className={cn('w-full h-full bg-slate-100 dark:bg-slate-800 relative', className)}>
            <img
                src={candidates[activeIndex]}
                alt=""
                className={cn(
                    'w-full h-full transition-opacity duration-200',
                    objectFit === 'contain' ? 'object-contain' : 'object-cover',
                    loaded ? 'opacity-100' : 'opacity-0'
                )}
                referrerPolicy="no-referrer"
                loading="lazy"
                decoding="async"
                onLoad={() => setLoaded(true)}
                onError={() => {
                    setActiveIndex((prev) => {
                        if (prev < candidates.length - 1) return prev + 1;
                        setFailed(true);
                        return prev;
                    });
                }}
            />
        </div>
    );
};

const InlineVideo = ({ sourceUrls, posterUrls, className = '', autoPlay = false }) => {
    const [activeSource, setActiveSource] = useState(0);
    const [showPosterFallback, setShowPosterFallback] = useState(false);
    const videoRef = useRef(null);
    const candidates = uniqueNonEmpty(sourceUrls);

    useEffect(() => {
        const currentVideo = videoRef.current;
        if (!currentVideo || typeof IntersectionObserver === 'undefined') return undefined;

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries?.[0];
                if (!entry?.isIntersecting && !currentVideo.paused) {
                    currentVideo.pause();
                }
            },
            { threshold: 0.15 }
        );

        observer.observe(currentVideo);

        return () => {
            observer.disconnect();
            if (activeInlineVideoElement === currentVideo) {
                activeInlineVideoElement = null;
            }
        };
    }, [activeSource]);

    if (showPosterFallback || !candidates.length) {
        return <MediaImage urls={posterUrls} className={className} />;
    }

    return (
        <video
            key={candidates[activeSource]}
            ref={videoRef}
            className={cn('w-full h-full object-contain bg-black', className)}
            src={candidates[activeSource]}
            controls
            playsInline
            preload="metadata"
            autoPlay={autoPlay}
            muted={autoPlay}
            loop={autoPlay}
            poster={uniqueNonEmpty(posterUrls)[0] || undefined}
            onPlay={(e) => {
                const currentVideo = e.currentTarget;
                if (activeInlineVideoElement && activeInlineVideoElement !== currentVideo && !activeInlineVideoElement.paused) {
                    activeInlineVideoElement.pause();
                }
                activeInlineVideoElement = currentVideo;
            }}
            onPause={(e) => {
                if (activeInlineVideoElement === e.currentTarget) {
                    activeInlineVideoElement = null;
                }
            }}
            onEnded={(e) => {
                if (activeInlineVideoElement === e.currentTarget) {
                    activeInlineVideoElement = null;
                }
            }}
            onError={() => {
                setActiveSource((prev) => {
                    const next = prev + 1;
                    if (next >= candidates.length) {
                        setShowPosterFallback(true);
                        return prev;
                    }
                    return next;
                });
            }}
        />
    );
};

const InlineMediaTile = ({ item, getProxiedMediaUrl, className = '', objectFit = 'cover' }) => {
    const isVideo = item.type === 'video' || item.type === 'animated_gif';
    const mediaCandidates = buildResolvedUrls([
        item.s3_url,
        item.url,
        ...(item.fallbackUrls || []),
        item.s3_preview,
        item.preview
    ], getProxiedMediaUrl, { includeRawFallback: !isVideo });
    const previewCandidates = buildResolvedUrls([
        item.s3_preview,
        item.preview,
        ...(item.previewFallbackUrls || []),
        item.s3_url,
        item.url,
        ...(item.fallbackUrls || [])
    ], getProxiedMediaUrl);

    return (
        <div className={cn('relative overflow-hidden bg-slate-100 dark:bg-slate-800', className)}>
            {isVideo ? (
                <InlineVideo
                    sourceUrls={mediaCandidates}
                    posterUrls={previewCandidates}
                    autoPlay={false}
                />
            ) : (
                <MediaImage urls={previewCandidates.length ? previewCandidates : mediaCandidates} objectFit={objectFit} />
            )}
            {item.type === 'animated_gif' && (
                <span className="absolute bottom-2 left-2 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                    GIF
                </span>
            )}
        </div>
    );
};

// Platforms this backend can actually monitor as a Source.
const MONITORABLE_PLATFORMS = ['x', 'facebook', 'youtube', 'instagram'];

const ActionButtons = ({ grievance, onAction, isDownloading = false, showDownload = true }) => {
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [addingSource, setAddingSource] = useState(false);
    const [addedSource, setAddedSource] = useState(false);

    const platform = (grievance?.platform || 'x').toLowerCase();
    const handle = grievance?.posted_by?.handle || '';
    const canMonitor = MONITORABLE_PLATFORMS.includes(platform) && !!handle;

    const handleAddToSources = async (e) => {
        e.stopPropagation();
        if (!canMonitor || addingSource || addedSource) return;
        setAddingSource(true);
        const result = await onAction?.('add_to_sources', { grievance });
        setAddingSource(false);
        // Anything but an explicit false counts as success: most onAction wiring
        // returns nothing, and a silent no-op should not look like a failure.
        if (result !== false) setAddedSource(true);
    };
    return (
        <div className="flex items-center gap-1 shrink-0">
            <ReasonModal
                open={showAnalysis}
                onClose={() => setShowAnalysis(false)}
                alert={buildAnalysisAlert(grievance)}
                content={{ text: decodeHtmlEntities(grievance?.content?.full_text || grievance?.content?.text || '') }}
                analysis={grievance?.analysis || null}
                title="Grievance Analysis Details"
                notice={getAnalysisNotice(grievance)}
            />
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-700 bg-slate-100 hover:bg-slate-200 ring-1 ring-slate-200 transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                title="View AI Analysis"
                onClick={(e) => {
                    e.stopPropagation();
                    setShowAnalysis(true);
                }}
            >
                <Eye className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                disabled={!canMonitor || addingSource || addedSource}
                className={cn(
                    'h-7 w-7 ring-1 transition-all duration-150 active:scale-95 active:translate-y-[1px] disabled:opacity-50',
                    addedSource
                        ? 'text-emerald-700 bg-emerald-100 ring-emerald-200'
                        : 'text-teal-800 bg-teal-100 hover:bg-teal-200 ring-teal-200'
                )}
                title={
                    !canMonitor
                        ? 'Monitoring is not available for this post'
                        : addedSource
                            ? `@${String(handle).replace(/^@/, '')} added to monitoring sources`
                            : `Add @${String(handle).replace(/^@/, '')} to monitoring sources`
                }
                onClick={handleAddToSources}
            >
                {addingSource
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : addedSource
                        ? <Check className="h-4 w-4" />
                        : <Radar className="h-4 w-4" />}
            </Button>
            {showDownload && (
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={isDownloading}
                    className="h-7 w-7 text-blue-700 bg-blue-100 hover:bg-blue-200 ring-1 ring-blue-200 disabled:opacity-70 transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                    title={isDownloading ? 'Video is downloading...' : 'Download Media'}
                    onClick={(e) => {
                        e.stopPropagation();
                        onAction?.('download', { grievance });
                    }}
                >
                    {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </Button>
            )}
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-amber-800 bg-amber-100 hover:bg-amber-200 ring-1 ring-amber-200 font-extrabold text-[11px] transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                title="Grievance"
                onClick={(e) => {
                    e.stopPropagation();
                    onAction?.('classify_grievance', { grievance });
                }}
            >
                G
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-purple-800 bg-purple-100 hover:bg-purple-200 ring-1 ring-purple-200 font-extrabold text-[11px] transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                title="Suggestion"
                onClick={(e) => {
                    e.stopPropagation();
                    onAction?.('classify_suggestion', { grievance });
                }}
            >
                S
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-800 bg-red-100 hover:bg-red-200 ring-1 ring-red-200 font-extrabold text-[11px] transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                title="Criticism"
                onClick={(e) => {
                    e.stopPropagation();
                    onAction?.('classify_criticism', { grievance });
                }}
            >
                C
            </Button>
            {/* 
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-sky-800 bg-sky-100 hover:bg-sky-200 ring-1 ring-sky-200 font-extrabold text-[11px] transition-all duration-150 active:scale-95 active:translate-y-[1px]"
                title="Query"
                onClick={(e) => {
                    e.stopPropagation();
                    onAction?.('classify_query', { grievance });
                }}
            >
                Q
            </Button> 
            */}
        </div>
    );
};

const WorkflowMeta = ({ grievance, onAction }) => {
    const gWorkflow = grievance?.grievance_workflow || {};
    const hasGrievanceWorkflow = !!gWorkflow?.unique_code;
    const currentStatus = ['PENDING', 'ESCALATED', 'CLOSED'].includes(gWorkflow?.status)
        ? gWorkflow.status
        : 'PENDING';

    const hasCriticismCode = !!grievance?.criticism?.unique_code;

    const qWorkflow = grievance?.query_workflow || {};
    const hasQueryWorkflow = !!qWorkflow?.unique_code;
    const queryStatus = ['PENDING', 'CLOSED'].includes(qWorkflow?.status) ? qWorkflow.status : 'PENDING';

    const suggestion = grievance?.suggestion || {};
    const hasSuggestion = !!suggestion?.unique_code;

    if (!hasGrievanceWorkflow && !hasCriticismCode && !hasQueryWorkflow && !hasSuggestion) return null;

    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {hasGrievanceWorkflow && (
                <div className="inline-flex items-center rounded-full bg-amber-50 ring-1 ring-amber-200 overflow-hidden">
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAction?.('open_g_report', { grievance, uniqueCode: gWorkflow.unique_code });
                        }}
                        className="px-2 py-0.5 text-[10px] font-mono font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
                        title="Open grievance report"
                    >
                        {gWorkflow.unique_code}
                    </button>
                    <select
                        value={currentStatus}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                            e.stopPropagation();
                            onAction?.('update_g_workflow_status', { grievance, status: e.target.value });
                        }}
                        className="h-5 pl-1 pr-1 border-l border-amber-200 bg-transparent text-[10px] font-semibold text-amber-800 outline-none focus:ring-1 focus:ring-amber-400 cursor-pointer"
                    >
                        <option value="PENDING">PENDING</option>
                        <option value="ESCALATED">ESCALATED</option>
                        <option value="CLOSED">CLOSED</option>
                    </select>
                </div>
            )}

            {hasQueryWorkflow && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 ring-1 ring-sky-200 px-2 py-0.5 text-[10px] font-mono font-semibold text-sky-800">
                    {qWorkflow.unique_code}
                    <span className={cn(
                        "rounded-full px-1.5 text-[9px] font-bold",
                        queryStatus === 'CLOSED' ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                    )}>
                        {queryStatus}
                    </span>
                </span>
            )}

            {hasSuggestion && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onAction?.('open_s_report', { grievance, uniqueCode: suggestion.unique_code });
                    }}
                    className="inline-flex rounded-full bg-purple-50 ring-1 ring-purple-200 px-2 py-0.5 text-[10px] font-mono font-semibold text-purple-800 hover:bg-purple-100 transition-colors"
                    title="Open suggestion report"
                >
                    {suggestion.unique_code}
                </button>
            )}

            {!hasGrievanceWorkflow && !hasQueryWorkflow && !hasSuggestion && hasCriticismCode && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onAction?.('open_c_report', { grievance, uniqueCode: grievance.criticism.unique_code });
                    }}
                    className="inline-flex rounded-full bg-slate-100 ring-1 ring-slate-300 px-2 py-0.5 text-[10px] font-mono font-semibold text-slate-700 hover:bg-slate-200 transition-colors"
                    title="Open criticism report"
                >
                    {grievance.criticism.unique_code}
                </button>
            )}
        </div>
    );
};

/* ─── Media Grid (Twitter style — rounded) ─── */
const MediaGrid = ({ media, getProxiedMediaUrl }) => {
    const normalized = normalizeMediaList(media);
    if (!normalized.length) return null;
    const count = normalized.length;

    const renderItem = (item, index, className = '', objectFit = 'cover') => {
        return (
            <InlineMediaTile
                key={index}
                item={item}
                getProxiedMediaUrl={getProxiedMediaUrl}
                className={className}
                objectFit={objectFit}
            />
        );
    };

    if (count === 1) {
        const item = normalized[0];
        const type = String(item?.type || '').toLowerCase();
        const isVid = type === 'video' || type === 'animated_gif';
        return (
            <div className="rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 mt-3">
                {renderItem(item, 0, isVid ? 'aspect-video' : 'aspect-[16/10] max-h-[480px]', 'contain')}
            </div>
        );
    }
    if (count === 2) return <div className="grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 mt-3">{normalized.slice(0, 2).map((m, i) => renderItem(m, i, 'aspect-[4/3]'))}</div>;
    if (count === 3) return (
        <div className="grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 mt-3 aspect-[4/3]">
            {normalized.slice(0, 3).map((m, i) => renderItem(m, i, cn('w-full h-full', i === 0 && 'row-span-2')))}
        </div>
    );
    if (count >= 4) {
        return (
            <div className="grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 mt-3 aspect-[4/3]">
                {normalized.slice(0, 4).map((m, i) => (
                    <div key={i} className="relative w-full h-full">
                        {renderItem(m, i, 'w-full h-full')}
                        {i === 3 && count > 4 && (
                            <div className="absolute inset-0 bg-black/50 flex items-center justify-center pointer-events-none">
                                <span className="text-white text-xl font-bold">+{count - 4}</span>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        );
    }
    return null;
};

/* ─── Quoted Tweet ─── */
const QuotedTweet = ({ context, getProxiedMediaUrl, onAction, grievance, onRetryEnrich, enriching }) => {
    // Show placeholder while quoted thread content is being enriched
    if (!context) return null;
    const text = decodeHtmlEntities(context?.content?.full_text || context?.content?.text);
    if (!hasRenderableThreadContent(context)) {
        if (hasThreadReference(context)) {
            return <ThreadLoadingPlaceholder className="mt-3" node={context} label="Quoted tweet" onRetry={onRetryEnrich} retrying={enriching} />;
        }
        return null;
    }
    const qHandle = (context.posted_by?.handle || '').replace('@', '');
    const qUrl = context.tweet_url || (qHandle && context.tweet_id ? `https://x.com/${qHandle}/status/${context.tweet_id}` : null);
    return (
        <div className="mt-3 border border-slate-200 dark:border-slate-700 rounded-2xl p-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
                <Avatar className="h-5 w-5"><AvatarImage src={context.posted_by?.profile_image_url} /><AvatarFallback className="text-[8px]">{(context.posted_by?.display_name || qHandle || '?')[0]}</AvatarFallback></Avatar>
                <span className="text-[13px] font-bold text-[#0f1419] truncate">{context.posted_by?.display_name || qHandle || 'Original Post'}</span>
                {context.posted_by?.is_verified && <BadgeCheck className="h-3.5 w-3.5 text-[#1d9bf0] shrink-0" />}
                {qHandle && <span className="text-[13px] text-[#536471] truncate">@{qHandle}</span>}
            </div>
            {text ? (
                <p className="text-[13px] text-[#0f1419] mt-1 whitespace-pre-wrap break-words">{highlightMentions(text)}</p>
            ) : qUrl ? (
                <a
                    href={qUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-[13px] text-[#1d9bf0] mt-1 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                >
                    View quoted tweet →
                </a>
            ) : null}
            {context.content?.media?.length > 0 && <MediaGrid media={context.content.media} getProxiedMediaUrl={getProxiedMediaUrl} />}
        </div>
    );
};

/* ─── Parent Tweet (For Threaded View) ─── */
const ParentTweet = ({ context, getProxiedMediaUrl, onAction, grievance, onRetryEnrich, enriching }) => {
    // Show placeholder while parent thread content is being enriched
    if (!hasRenderableThreadContent(context)) {
        if (hasThreadReference(context)) {
            return <ThreadLoadingPlaceholder className="ml-[52px] mb-2" node={context} label="Parent post" onRetry={onRetryEnrich} retrying={enriching} />;
        }
        return null;
    }

    const user = context.posted_by || {};
    const handle = (user.handle || '').replace('@', '');
    const text = decodeHtmlEntities(context.content?.full_text || context.content?.text || '');
    const media = context.content?.media || [];
    const tweetUrl = context.tweet_url || (handle && context.tweet_id ? `https://x.com/${handle}/status/${context.tweet_id}` : null);

    return (
        <div className="flex gap-3 relative pb-2 group">
            {/* Connection Line - Extended to connect with child */}
            <div className="absolute left-[20px] top-[40px] bottom-[-16px] w-[2px] bg-[#cfd9de] group-hover:bg-[#ccd6dd]" />

            <div className="shrink-0 pt-0.5 z-10">
                <Avatar className="h-10 w-10 ring-4 ring-white">
                    <AvatarImage src={user.profile_image_url} />
                    <AvatarFallback className="text-sm bg-[#1d9bf0] text-white">
                        {(user.display_name || handle || '?')[0]?.toUpperCase()}
                    </AvatarFallback>
                </Avatar>
            </div>
            <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-center gap-1 flex-wrap min-w-0">
                    <span className="font-bold text-[15px] text-[#0f1419] truncate max-w-[140px]">
                        {user.display_name || handle || 'Original Post'}
                    </span>
                    {user.is_verified && <BadgeCheck className="h-4 w-4 text-[#1d9bf0] shrink-0" />}
                    {handle && <span className="text-[14px] text-[#536471] truncate max-w-[120px]">@{handle}</span>}
                    <span className="text-[#536471]">·</span>
                    <span className="text-[14px] text-[#536471]">
                        {context.post_date ? timeAgo(context.post_date) : 'Original Post'}
                    </span>
                </div>
                {text ? (
                    <div className="text-[15px] text-[#0f1419] leading-5 mt-1 whitespace-pre-wrap break-words">
                        {highlightMentions(text)}
                    </div>
                ) : tweetUrl ? (
                    <a
                        href={tweetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block mt-1.5 text-[13px] text-[#1d9bf0] hover:underline"
                        onClick={(e) => e.stopPropagation()}
                    >
                        View original tweet →
                    </a>
                ) : null}
                {media.length > 0 && (
                    <MediaGrid
                        media={media}
                        getProxiedMediaUrl={getProxiedMediaUrl}
                    />
                )}
            </div>
        </div>
    );
};

/* ─── Parent Post (For Facebook Threaded View) ─── */
const ParentFacebookPost = ({ context, getProxiedMediaUrl, onAction, grievance }) => {
    if (!hasRenderableThreadContent(context)) {
        if (hasThreadReference(context)) {
            return <ThreadLoadingPlaceholder className="mb-3" node={context} label="Parent post" />;
        }
        return null;
    }

    const user = context.posted_by || {};
    const text = decodeHtmlEntities(context.content?.full_text || context.content?.text || '');
    const media = context.content?.media || [];

    return (
        <div className="mb-4 pb-4 border-b border-gray-100 dark:border-slate-700 relative">
            <div className="absolute left-5 top-12 bottom-0 w-[2px] bg-slate-200 dark:bg-slate-700" />

            <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10 ring-1 ring-slate-200">
                    <AvatarImage src={user.profile_image_url} />
                    <AvatarFallback className="text-sm bg-[#1877F2] text-white">{(user.display_name || '?')[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-[15px] text-[#050505]">{user.display_name || user.handle}</span>
                        {user.is_verified && <BadgeCheck className="h-4 w-4 text-[#1877F2] shrink-0" />}
                    </div>
                    <div className="flex items-center gap-1.5 text-[13px] text-[#65676b]">
                        <span>{context.post_date ? timeAgo(context.post_date) : 'Original Post'}</span>
                        <span>·</span><GlobeIcon className="h-3 w-3" />
                    </div>
                </div>
            </div>
            {text && <div className="mt-3 text-[15px] text-[#050505] leading-5 whitespace-pre-wrap break-words">{highlightMentions(text)}</div>}
            {media.length > 0 && <div className="mt-3 -mx-4 opacity-80"><FacebookMediaGrid media={media} getProxiedMediaUrl={getProxiedMediaUrl} /></div>}
        </div>
    );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                  X (TWITTER) LAYOUT                     */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const XLayout = ({ grievance, getProxiedMediaUrl, onAction, downloadState = {}, isActioned }) => {
    const user = grievance.posted_by || {};
    const handle = (user.handle || '').replace('@', '');
    const text = decodeHtmlEntities(grievance.content?.full_text || grievance.content?.text || '');
    const media = grievance.content?.media || [];
    const engagement = grievance.engagement || {};
    const ctx = grievance.context || {};
    const [enriching, setEnriching] = useState(false);
    const openDetails = () => onAction?.('view', { grievance });
    const handleRetryEnrich = () => {
        onAction?.('retry_enrich', { grievance });
        setEnriching(true);
        setTimeout(() => setEnriching(false), 8000);
    };
    const openOriginal = () => {
        const url = grievance.tweet_url || grievance.url;
        if (url) window.open(url, '_blank');
        else openDetails();
    };

    // Check if we have parent tweet(s) to display in a thread
    // Prefer thread_parent (original thread root) over in_reply_to (direct parent)
    const threadParent = ctx.thread_parent;
    const inReplyTo = ctx.in_reply_to;
    const hasThreadParentRef = hasThreadReference(threadParent);
    const hasInReplyRef = hasThreadReference(inReplyTo);
    const threadChainNodes = Array.isArray(ctx.thread_chain)
        ? ctx.thread_chain.filter(hasThreadReference)
        : [];

    const fallbackThreadNodes = [];
    if (hasThreadParentRef) {
        fallbackThreadNodes.push(threadParent);
    }
    if (hasInReplyRef && (!hasThreadParentRef || threadParent?.tweet_id !== inReplyTo?.tweet_id)) {
        fallbackThreadNodes.push(inReplyTo);
    }

    const threadNodes = (threadChainNodes.length > 0 ? [...threadChainNodes].reverse() : fallbackThreadNodes)
        .filter((node, index, list) => {
            const id = String(node?.tweet_id || '').trim();
            if (!id) return true;
            return list.findIndex((candidate) => String(candidate?.tweet_id || '').trim() === id) === index;
        });

    const hasThread = threadNodes.length > 0;

    return (
        <div className="flex flex-col">
            {/* THREAD: show all known ancestors (oldest to direct parent) */}
            {threadNodes.map((node, idx) => (
                <ParentTweet
                    key={`${node?.tweet_id || 'thread'}-${idx}`}
                    context={node}
                    getProxiedMediaUrl={getProxiedMediaUrl}
                    onAction={onAction}
                    grievance={grievance}
                    onRetryEnrich={handleRetryEnrich}
                    enriching={enriching}
                />
            ))}

            {/* MAIN TWEET */}
            <div className="flex gap-3">
                <div className="relative shrink-0 pt-0.5 z-10">
                    <Avatar className="h-10 w-10 ring-4 ring-white">
                        <AvatarImage src={user.profile_image_url} />
                        <AvatarFallback className="text-sm bg-[#1d9bf0] text-white">{(user.display_name || handle || '?')[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <PlatformCornerBadge platform={grievance.platform || 'x'} className="absolute -bottom-0.5 -right-0.5" />
                </div>
                <div className="flex-1 min-w-0">
                    {ctx.reposted_from?.tweet_id && (
                        <div className="flex items-center gap-1 text-[13px] text-[#536471] mb-1 -mt-1">
                            <Repeat2 className="h-3.5 w-3.5" />
                            <span className="font-bold">{ctx.reposted_from.posted_by?.display_name || 'Someone'} reposted</span>
                        </div>
                    )}
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                                <span className="font-bold text-[15px] text-[#0f1419] truncate max-w-[140px]">{user.display_name || handle}</span>
                                {user.is_verified && <BadgeCheck className="h-4 w-4 text-[#1d9bf0] shrink-0" />}
                                <span className="text-[14px] text-[#536471] truncate max-w-[120px]">@{handle}</span>
                                <span className="text-[#536471]">·</span>
                                <span className="text-[15px] text-[#536471] hover:underline cursor-pointer" title={formatFullDate(grievance.post_date)}>{timeAgo(grievance.post_date)}</span>
                            </div>
                            <WorkflowMeta grievance={grievance} onAction={onAction} />
                        </div>
                        <ActionButtons grievance={grievance} onAction={onAction} isDownloading={!!downloadState?.downloading} />
                    </div>
                    {/* Only show "Replying to" if we DON'T show the parent thread above (fallback) */}
                    {!hasThread && ctx.in_reply_to?.posted_by?.handle && (
                        <div className="flex items-center gap-1 text-[13px] text-[#536471] mt-0.5">
                            <span>Replying to</span>
                            <span className="text-[#1d9bf0] hover:underline cursor-pointer">@{(ctx.in_reply_to.posted_by.handle || '').replace('@', '')}</span>
                        </div>
                    )}
                    {text && <div className="text-[15px] text-[#0f1419] leading-5 mt-1 whitespace-pre-wrap break-words">{highlightMentions(text)}</div>}
                    {media.length > 0 && <MediaGrid media={media} getProxiedMediaUrl={getProxiedMediaUrl} />}
                    {/* Quoted tweet — shown below the main tweet content */}
                    <QuotedTweet context={ctx.quoted} getProxiedMediaUrl={getProxiedMediaUrl} onAction={onAction} grievance={grievance} onRetryEnrich={handleRetryEnrich} enriching={enriching} />
                    <div className="flex items-center justify-between mt-3 max-w-[425px] -ml-2">
                        {[
                            { icon: MessageCircle, count: engagement.replies, hoverColor: 'hover:bg-[#1d9bf0]/10', textHover: 'group-hover:text-[#1d9bf0]', isComment: true },
                            { icon: Repeat2, count: engagement.retweets, hoverColor: 'hover:bg-[#00ba7c]/10', textHover: 'group-hover:text-[#00ba7c]' },
                            { icon: Heart, count: engagement.likes, hoverColor: 'hover:bg-[#f91880]/10', textHover: 'group-hover:text-[#f91880]' },
                            { icon: BarChart3, count: engagement.views, hoverColor: 'hover:bg-[#1d9bf0]/10', textHover: 'group-hover:text-[#1d9bf0]' },
                        ].map(({ icon: Icon, count, hoverColor, textHover, isComment }, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={isComment ? () => onAction?.('reply_comment', { grievance }) : openDetails}
                                data-comment-btn={isComment ? "true" : undefined}
                                className={cn('flex items-center gap-1.5 group p-2 rounded-full transition-all duration-150 active:scale-95 active:translate-y-[1px]', hoverColor, isComment && isActioned && 'animate-comment-btn-blink')}
                            >
                                <Icon className={cn('h-[18px] w-[18px] text-[#536471]', textHover)} />
                                <span className={cn('text-[13px] text-[#536471]', textHover)}>{formatCount(count)}</span>
                            </button>
                        ))}
                        <button type="button" onClick={openOriginal} className="flex items-center gap-1.5 group p-2 rounded-full hover:bg-[#1d9bf0]/10 transition-all duration-150 active:scale-95 active:translate-y-[1px]">
                            <Bookmark className="h-[18px] w-[18px] text-[#536471] group-hover:text-[#1d9bf0]" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                   FACEBOOK LAYOUT                       */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const FacebookMediaGrid = ({ media, getProxiedMediaUrl }) => {
    const normalized = normalizeMediaList(media);
    if (!normalized.length) return null;
    const count = normalized.length;

    const singleMediaClass = (item) => {
        const type = String(item?.type || '').toLowerCase();
        return type === 'video' || type === 'animated_gif' ? 'aspect-video' : 'min-h-[240px] max-h-[70vh]';
    };

    const renderFBItem = (item, index, className = '') => {
        return (
            <InlineMediaTile
                key={index}
                item={item}
                getProxiedMediaUrl={getProxiedMediaUrl}
                className={className}
            />
        );
    };
    if (count === 1) return renderFBItem(normalized[0], 0, singleMediaClass(normalized[0]));
    if (count === 2) return <div className="grid grid-cols-2 gap-[2px]">{normalized.slice(0, 2).map((m, i) => renderFBItem(m, i, 'aspect-square'))}</div>;
    if (count === 3) return <div className="grid grid-cols-2 gap-[2px]"><div className="col-span-2">{renderFBItem(normalized[0], 0, 'aspect-video')}</div>{normalized.slice(1, 3).map((m, i) => renderFBItem(m, i + 1, 'aspect-square'))}</div>;
    if (count > 4) {
        return (
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <div className="divide-y divide-slate-200 dark:divide-slate-700">
                    {normalized.slice(0, 5).map((m, i) => (
                        <div key={i} className="relative">
                            {renderFBItem(m, i, 'w-full min-h-[220px] max-h-[70vh]')}
                            {i === 4 && count > 5 && (
                                <div className="absolute inset-x-0 bottom-0 bg-black/60 py-1.5 text-center">
                                    <span className="text-white text-sm font-semibold">+{count - 5} more</span>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    return (
        <div className="grid grid-cols-2 gap-[2px]">
            <div className="col-span-2">{renderFBItem(normalized[0], 0, 'aspect-video')}</div>
            {normalized.slice(1, 4).map((m, i) => renderFBItem(m, i + 1, 'aspect-square'))}
        </div>
    );
};

const FacebookLayout = ({ grievance, getProxiedMediaUrl, onAction, downloadState = {}, isActioned }) => {
    const user = grievance.posted_by || {};
    const text = decodeHtmlEntities(grievance.content?.full_text || grievance.content?.text || '');
    const media = grievance.content?.media || [];
    const engagement = grievance.engagement || {};
    const totalReactions = (engagement.likes || 0);
    const openDetails = () => onAction?.('view', { grievance });

    // Parent post from context (for comment threads)
    const ctx = grievance.context || {};
    const parentPost = ctx.in_reply_to;
    const hasParentPost = hasThreadReference(parentPost);

    return (
        <div>
            {/* THREAD: Show original post if this is a comment */}
            {hasParentPost && (
                <ParentFacebookPost
                    context={parentPost}
                    getProxiedMediaUrl={getProxiedMediaUrl}
                    onAction={onAction}
                    grievance={grievance}
                />
            )}

            <div className={cn(hasParentPost ? "pl-4" : "")}> 
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="relative shrink-0">
                            <Avatar className="h-10 w-10 ring-1 ring-slate-200">
                                <AvatarImage src={user.profile_image_url} />
                                <AvatarFallback className="text-sm bg-[#1877F2] text-white">{(user.display_name || '?')[0]?.toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <PlatformCornerBadge platform={grievance.platform || 'facebook'} className="absolute -bottom-0.5 -right-0.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-[15px] text-[#050505]">{user.display_name || user.handle}</span>
                                {user.is_verified && <BadgeCheck className="h-4 w-4 text-[#1877F2] shrink-0" />}
                            </div>
                            <div className="flex items-center gap-1.5 text-[13px] text-[#65676b]">
                                <span>{timeAgo(grievance.post_date)}</span><span>·</span><GlobeIcon className="h-3 w-3" />
                            </div>
                            <WorkflowMeta grievance={grievance} onAction={onAction} />
                        </div>
                    </div>
                    <ActionButtons grievance={grievance} onAction={onAction} isDownloading={!!downloadState?.downloading} />
                </div>
                {text && <div className="mt-3 text-[15px] text-[#050505] leading-5 whitespace-pre-wrap break-words">{highlightMentions(text)}</div>}
                {media.length > 0 && <div className="mt-3 -mx-4"><FacebookMediaGrid media={media} getProxiedMediaUrl={getProxiedMediaUrl} /></div>}
                {totalReactions > 0 && (
                    <div className="flex items-center justify-between px-1 py-2.5 border-b border-[#ced0d4]">
                        <div className="flex items-center gap-1">
                            <div className="flex -space-x-1">
                                <span className="inline-flex items-center justify-center h-[18px] w-[18px] rounded-full bg-[#1877F2] border-2 border-white"><ThumbsUpIcon className="h-2.5 w-2.5 text-white" /></span>
                                <span className="inline-flex items-center justify-center h-[18px] w-[18px] rounded-full bg-red-500 border-2 border-white"><Heart className="h-2.5 w-2.5 text-white fill-white" /></span>
                            </div>
                            <span className="text-[15px] text-[#65676b]">{formatCount(totalReactions)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-[15px] text-[#65676b]">
                            {(engagement.replies || 0) > 0 && <span>{formatCount(engagement.replies)} comments</span>}
                            {(engagement.retweets || 0) > 0 && <span>{formatCount(engagement.retweets)} shares</span>}
                        </div>
                    </div>
                )}
                <div className="flex items-center justify-around pt-1">
                    {[{ icon: ThumbsUpIcon, label: 'Like' }, { icon: MessageCircle, label: 'Comment' }, { icon: ShareFBIcon, label: 'Share' }].map(({ icon: Icon, label }) => (
                        <button
                            type="button"
                            key={label}
                            onClick={label === 'Comment' ? () => onAction?.('reply_comment', { grievance }) : openDetails}
                            data-comment-btn={label === 'Comment' ? "true" : undefined}
                            className={cn("flex-1 flex items-center justify-center gap-2 py-2 rounded-lg hover:bg-[#f0f2f5] transition-all duration-150 active:scale-[0.98] active:translate-y-[1px] text-[#65676b]", label === 'Comment' && isActioned && 'animate-comment-btn-blink')}
                        >
                            <Icon className="h-5 w-5" /><span className="text-[15px] font-semibold">{label}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                   WHATSAPP LAYOUT                       */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const WhatsAppLayout = ({ grievance, getProxiedMediaUrl, onAction, downloadState = {} }) => {
    const user = grievance.posted_by || {};
    const text = decodeHtmlEntities(grievance.content?.full_text || grievance.content?.text || '');
    const media = grievance.content?.media || [];
    const displayName = user.display_name || grievance.complainant_phone || 'Unknown';
    const phone = grievance.complainant_phone || user.handle || '';

    return (
        <div className="bg-[#efeae2] dark:bg-[#1a1e23] rounded-xl p-3 relative" style={{
            backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'200\' height=\'200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cdefs%3E%3Cpattern id=\'p\' width=\'40\' height=\'40\' patternUnits=\'userSpaceOnUse\' patternTransform=\'rotate(30)\'%3E%3Ccircle cx=\'20\' cy=\'20\' r=\'1\' fill=\'%23d4cfc4\' opacity=\'.3\'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width=\'200\' height=\'200\' fill=\'url(%23p)\'/%3E%3C/svg%3E")',
        }}>
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                        <PlatformCornerBadge platform="whatsapp" />
                        <p className="truncate text-[12.5px] font-semibold text-[#0f172a]">{displayName}</p>
                    </div>
                    <WorkflowMeta grievance={grievance} onAction={onAction} />
                </div>
                <ActionButtons grievance={grievance} onAction={onAction} isDownloading={!!downloadState?.downloading} />
            </div>
            <div className="flex justify-center mb-3">
                <span className="bg-[#e1f3fb] text-[#54656f] text-[11px] font-medium px-3 py-1 rounded-lg shadow-sm">
                    {grievance.post_date ? format(new Date(grievance.post_date), 'MMMM d, yyyy') : 'Today'}
                </span>
            </div>
            <div className="max-w-[85%]">
                <div className="bg-white dark:bg-slate-800 rounded-xl rounded-tl-sm p-2.5 shadow-sm relative">
                    <div className="absolute -left-2 top-0 w-0 h-0 border-t-[8px] border-t-white dark:border-t-slate-800 border-l-[8px] border-l-transparent" />
                    <p className="text-[12.5px] font-semibold text-[#00a884] mb-0.5">
                        {displayName}
                        {phone && phone !== displayName && <span className="text-[11px] font-normal text-[#667781] ml-2">~{phone}</span>}
                    </p>
                    {media.length > 0 && (
                        <div className="mb-1.5 rounded-lg overflow-hidden">
                            {media.map((item, i) => {
                                const normalized = normalizeMediaList([item]);
                                if (!normalized.length) return null;
                                const n = normalized[0];
                                return (
                                    <div key={i} className="rounded-lg overflow-hidden mb-1">
                                        <InlineMediaTile
                                            item={n}
                                            getProxiedMediaUrl={getProxiedMediaUrl}
                                            className="aspect-video max-h-52"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {text && <p className="text-[14.2px] text-[#111b21] leading-[19px] whitespace-pre-wrap break-words">{text}</p>}
                    <div className="flex items-center justify-end gap-1 mt-1">
                        <span className="text-[11px] text-[#667781]">{grievance.post_date ? format(new Date(grievance.post_date), 'h:mm a') : ''}</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/*                 MAIN GRIEVANCE CARD                     */
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const GrievanceCard = ({ grievance, onAction, getProxiedMediaUrl, downloadState = {}, isActioned = false, isSelected = false, compact = false }) => {
    const [showAnalysis, setShowAnalysis] = useState(false);
    const platform = (grievance.platform || 'x').toLowerCase();
    const isX = platform === 'x' || platform === 'twitter';
    const isFB = platform === 'facebook';
    const isWA = platform === 'whatsapp';
    const isDownloading = !!downloadState?.downloading;
    const downloadProgress = Math.max(0, Math.min(100, Math.round(downloadState?.progress || 0)));

    return (
        <Card id={`grievance-card-${grievance.id}`} className={cn(
            "overflow-hidden shadow-sm border transition-shadow",
            isActioned ? "animate-card-action-blink border-green-400 z-10" : "border-slate-200 dark:border-slate-700 hover:shadow-md"
        )}>

            {(isDownloading || downloadState?.error) && (
                <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700 bg-blue-50/40 dark:bg-blue-950/20">
                    {isDownloading && (
                        <>
                            <div className="flex items-center justify-between text-[11px] font-semibold text-blue-700 mb-1">
                                <span>{downloadState?.status || 'Video is downloading...'}</span>
                                <span>{downloadProgress}%</span>
                            </div>
                            <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
                                <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${downloadProgress}%` }} />
                            </div>
                        </>
                    )}
                    {!isDownloading && downloadState?.error && (
                        <div className="text-[11px] font-semibold text-red-600">{downloadState.error}</div>
                    )}
                </div>
            )}

            {/* Platform-native Content */}
            <CardContent className={cn('p-4', isWA && 'p-3')}>
                {isX && <XLayout grievance={grievance} getProxiedMediaUrl={getProxiedMediaUrl} onAction={onAction} downloadState={downloadState} isActioned={isActioned} />}
                {isFB && <FacebookLayout grievance={grievance} getProxiedMediaUrl={getProxiedMediaUrl} onAction={onAction} downloadState={downloadState} isActioned={isActioned} />}
                {isWA && <WhatsAppLayout grievance={grievance} getProxiedMediaUrl={getProxiedMediaUrl} onAction={onAction} downloadState={downloadState} />}
            </CardContent>

            {/* Footer */}
            <div className="bg-slate-50/80 dark:bg-slate-800/80 border-t border-slate-100 dark:border-slate-700 px-4 py-1.5 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500">
                <div className="flex items-center gap-2">
                    <span>Detected {timeAgo(grievance.detected_date || grievance.created_at)} ago</span>
                    <SentimentBadge grievance={grievance} onOpen={() => setShowAnalysis(true)} />
                </div>
                <button type="button" className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 flex items-center gap-1 transition-all duration-150 active:scale-95 active:translate-y-[1px]" onClick={() => onAction?.('view', { grievance })}>
                    Details <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m9 18 6-6-6-6" /></svg>
                </button>
            </div>

            <ReasonModal
                open={showAnalysis}
                onClose={() => setShowAnalysis(false)}
                alert={buildAnalysisAlert(grievance)}
                content={{ text: decodeHtmlEntities(grievance?.content?.full_text || grievance?.content?.text || '') }}
                analysis={grievance?.analysis || null}
                title="Grievance Analysis Details"
                notice={getAnalysisNotice(grievance)}
            />
        </Card>
    );
};

export default GrievanceCard;
