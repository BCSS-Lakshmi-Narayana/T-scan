import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNotification } from '../context/NotificationContext';
import api, { ALERTS_CACHE_KEY } from '../lib/api';
import { AlertTriangle, CheckCircle, Flag, XCircle, Zap, Activity, MessageSquare, Filter, ExternalLink, Search, Calendar, Download, Loader2, ArrowUpCircle, Plus, LayoutGrid, LayoutList, Twitter, Youtube, Facebook, Instagram, Users, X, Sparkles } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { toast } from 'sonner';
import { TwitterAlertCard, YoutubeAlertCard, FrequentEngagersDialog } from '../components/AlertCards';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import ReportsContent from '../components/ReportsContent';
import AddSourceModal from '../components/AddSourceModal';
import { useRbac } from '../contexts/RbacContext';
import { mapInstagramStoryToAlert, mergeInstagramStoriesByIdentity } from '../utils/instagramStoryMedia';

const ALERT_STATUS_TABS = [
  { value: 'active', label: 'Active' },
  { value: 'false_positive', label: 'False Positive' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'reports', label: 'Reports' }
];

const ALERTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const SOURCE_CATEGORY_OPTIONS = [
  { value: 'political', label: 'Political' },
  { value: 'communal', label: 'Communal' },
  { value: 'trouble_makers', label: 'Trouble Makers' },
  { value: 'defamation', label: 'Defamation' },
  { value: 'narcotics', label: 'Narcotics' },
  { value: 'history_sheeters', label: 'History Sheeters' },
  { value: 'others', label: 'Others' }
];

const PLATFORM_DISPLAY_ORDER = ['x', 'youtube', 'facebook', 'instagram', 'whatsapp'];

export default function Alerts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const isFirstLoadRef = useRef(true);
  const [activeTab, setActiveTab] = useState('active'); // Always start on Active tab
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth >= 1024);
  const [monitoredHandles, setMonitoredHandles] = useState([]);
  const [monitoredSources, setMonitoredSources] = useState([]);
  const [sourcesMetaLoading, setSourcesMetaLoading] = useState(false);
  const [sourcesMetaLoaded, setSourcesMetaLoaded] = useState(false);
  const [profilesMatrixOpen, setProfilesMatrixOpen] = useState(false);
  const [frequentEngagersOpen, setFrequentEngagersOpen] = useState(false);
  const [pendingAnalysisCount, setPendingAnalysisCount] = useState(0);
  const [viewMode, setViewMode] = useState('grid');
  const [alertCategory, setAlertCategory] = useState('all'); // 'all', 'risk', 'viral', 'new_post'
  const [totalResults, setTotalResults] = useState(0);
  const [alertStats, setAlertStats] = useState(null);
  const [downloadStates, setDownloadStates] = useState({});
  const [newAlertCount, setNewAlertCount] = useState(0); // Count of new alerts since last scroll-to-top
  const [pendingNewAlerts, setPendingNewAlerts] = useState([]);
  const scrollAnchorRef = useRef({ shouldRestore: false, prevHeight: 0, prevScroll: 0 });

  // Search & Pagination States
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [keywordFilter, setKeywordFilter] = useState('all');
  // Detected-intent drill-down (from the Command Centre). null = no filter.
  const [intentFilter, setIntentFilter] = useState(null);
  const [availableKeywords, setAvailableKeywords] = useState([]);
  const [sourceCategoryFilter, setSourceCategoryFilter] = useState('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [instagramContentFilter, setInstagramContentFilter] = useState('all_posts_reels');
  const [instagramStoriesStatusFilter, setInstagramStoriesStatusFilter] = useState('all');
  const [capturedStories, setCapturedStories] = useState([]);
  const [capturedStoriesLoading, setCapturedStoriesLoading] = useState(false);
  const [recentStories, setRecentStories] = useState([]);
  const [recentStoriesLoading, setRecentStoriesLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState(null);
  const observerTarget = useRef(null);
  const scrollContainerRef = useRef(null);
  const mainStartDateInputRef = useRef(null);
  const mainEndDateInputRef = useRef(null);
  const igStartDateInputRef = useRef(null);
  const igEndDateInputRef = useRef(null);
  const isFetchingRef = useRef(false);
  const lastFetchKeyRef = useRef('');
  const fetchAbortRef = useRef(null);
  const fetchRequestSeqRef = useRef(0);
  const capturedStoriesReqIdRef = useRef(0);
  const recentStoriesReqIdRef = useRef(0);

  // Link Investigation States
  const [isInvestigating, setIsInvestigating] = useState(false);
  const [investigatedAlerts, setInvestigatedAlerts] = useState([]);

  // Top-50 AI Alerts Full Page
  const [topAlertsOpen, setTopAlertsOpen] = useState(false);
  const [topAlertsData, setTopAlertsData] = useState(null);
  const [topAlertsLoading, setTopAlertsLoading] = useState(false);
  const [topAlertsError, setTopAlertsError] = useState(null);
  const [topAlertsHours, setTopAlertsHours] = useState(24);
  const [topAlertsCatFilter, setTopAlertsCatFilter] = useState('all');

  const { markAllRead } = useNotification();
  const { hasFeatureAccess } = useRbac();

  const visibleStatusTabs = useMemo(
    () => ALERT_STATUS_TABS.filter((tab) => hasFeatureAccess('/alerts', tab.value)),
    [hasFeatureAccess]
  );
  const hasAnyAlertFeature = visibleStatusTabs.length > 0;
  const isStories24hView = platformFilter === 'instagram' && instagramContentFilter === 'stories_24h';
  const isCapturedStoriesView = platformFilter === 'instagram' && instagramContentFilter === 'captured_stories';
  const isInstagramStoryView = isStories24hView || isCapturedStoriesView;
  const isStoryViewLoading = isCapturedStoriesView
    ? capturedStoriesLoading
    : (isStories24hView ? recentStoriesLoading : false);

  const normalizePlatform = useCallback((platformValue) => {
    const value = String(platformValue || '').trim().toLowerCase();
    if (!value) return 'unknown';
    if (value === 'twitter') return 'x';
    if (value === 'fb') return 'facebook';
    if (value === 'yt') return 'youtube';
    return value;
  }, []);

  const normalizeCategory = useCallback((categoryValue) => {
    const normalized = String(categoryValue || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    if (!normalized) return 'others';
    return SOURCE_CATEGORY_OPTIONS.some((option) => option.value === normalized) ? normalized : 'others';
  }, [SOURCE_CATEGORY_OPTIONS]);

  const getPlatformLabel = useCallback((platformValue) => {
    const normalized = normalizePlatform(platformValue);
    const labels = {
      x: 'X',
      youtube: 'YouTube',
      facebook: 'Facebook',
      instagram: 'Instagram',
      whatsapp: 'WhatsApp',
      unknown: 'Unknown'
    };
    return labels[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }, [normalizePlatform]);

  const getPlatformTheme = useCallback((platformValue) => {
    const normalized = normalizePlatform(platformValue);
    const themes = {
      x: {
        iconClass: 'text-slate-950',
        rowClass: 'bg-slate-200/70 hover:bg-slate-300/70',
        stickyClass: 'bg-slate-200/80'
      },
      youtube: {
        iconClass: 'text-red-700',
        rowClass: 'bg-red-200/60 hover:bg-red-300/60',
        stickyClass: 'bg-red-200/75'
      },
      facebook: {
        iconClass: 'text-blue-700',
        rowClass: 'bg-blue-200/60 hover:bg-blue-300/60',
        stickyClass: 'bg-blue-200/75'
      },
      instagram: {
        iconClass: 'text-pink-700',
        rowClass: 'bg-pink-200/60 hover:bg-pink-300/60',
        stickyClass: 'bg-pink-200/75'
      },
      whatsapp: {
        iconClass: 'text-emerald-700',
        rowClass: 'bg-emerald-200/60 hover:bg-emerald-300/60',
        stickyClass: 'bg-emerald-200/75'
      },
      unknown: {
        iconClass: 'text-amber-700',
        rowClass: 'bg-amber-200/60 hover:bg-amber-300/60',
        stickyClass: 'bg-amber-200/75'
      }
    };

    return themes[normalized] || themes.unknown;
  }, [normalizePlatform]);

  const renderPlatformIcon = useCallback((platformValue) => {
    const normalized = normalizePlatform(platformValue);
    const theme = getPlatformTheme(normalized);
    const iconClass = `h-4 w-4 shrink-0 ${theme.iconClass}`;

    switch (normalized) {
      case 'x':
        return <Twitter className={iconClass} />;
      case 'youtube':
        return <Youtube className={iconClass} />;
      case 'facebook':
        return <Facebook className={iconClass} />;
      case 'instagram':
        return <Instagram className={iconClass} />;
      case 'whatsapp':
        return <MessageSquare className={iconClass} />;
      default:
        return <AlertTriangle className={iconClass} />;
    }
  }, [getPlatformTheme, normalizePlatform]);

  const monitoredProfilesMatrix = useMemo(() => {
    const categoryKeys = SOURCE_CATEGORY_OPTIONS.map((option) => option.value);
    const categorySet = new Set(categoryKeys);
    const platformCounts = {};

    monitoredSources.forEach((source) => {
      const platform = normalizePlatform(source?.platform);
      const category = normalizeCategory(source?.category);

      if (!platformCounts[platform]) {
        platformCounts[platform] = { total: 0 };
        categoryKeys.forEach((key) => {
          platformCounts[platform][key] = 0;
        });
      }

      if (!categorySet.has(category)) return;
      platformCounts[platform][category] += 1;
      platformCounts[platform].total += 1;
    });

    const discoveredPlatforms = Object.keys(platformCounts)
      .filter((platform) => !PLATFORM_DISPLAY_ORDER.includes(platform))
      .sort((a, b) => a.localeCompare(b));

    const orderedPlatforms = [
      ...PLATFORM_DISPLAY_ORDER,
      ...discoveredPlatforms
    ];

    const rows = orderedPlatforms
      .filter((platform) => platformCounts[platform])
      .map((platform) => ({
        platform,
        counts: platformCounts[platform]
      }));

    const totalsByCategory = categoryKeys.reduce((acc, key) => {
      acc[key] = rows.reduce((sum, row) => sum + (row.counts[key] || 0), 0);
      return acc;
    }, {});

    const grandTotal = rows.reduce((sum, row) => sum + (row.counts.total || 0), 0);

    return {
      categoryKeys,
      rows,
      totalsByCategory,
      grandTotal
    };
  }, [monitoredSources, normalizePlatform, normalizeCategory, SOURCE_CATEGORY_OPTIONS]);

  const normalizeDateInputValue = useCallback((value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  const toStartOfSelectedDay = useCallback((value) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setHours(0, 0, 0, 0);
    return parsed.getTime();
  }, []);

  const toEndOfSelectedDay = useCallback((value) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setHours(23, 59, 59, 999);
    return parsed.getTime();
  }, []);

  const handleDateRangeChange = useCallback((field, value) => {
    setDateRange((prev) => {
      const next = {
        ...prev,
        [field]: value || ''
      };

      if (next.start && next.end) {
        const startTime = new Date(next.start).getTime();
        const endTime = new Date(next.end).getTime();
        if (!Number.isNaN(startTime) && !Number.isNaN(endTime) && startTime > endTime) {
          if (field === 'start') {
            next.end = next.start;
          } else {
            next.start = next.end;
          }
        }
      }

      return next;
    });
  }, []);

  const openDatePicker = useCallback((inputRef) => {
    const el = inputRef?.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // Fallback below
      }
    }
    el.focus();
    el.click();
  }, []);

  const buildCacheKey = useCallback(() => {
    return [
      'tab', activeTab,
      'cat', alertCategory,
      'q', debouncedSearchQuery || '',
      'platform', platformFilter,
      'keyword', keywordFilter,
      // Must be part of the key: without it a cached unfiltered page would be
      // served for an intent drill-down.
      'intent', intentFilter || '',
      'sourceCat', sourceCategoryFilter,
      'start', dateRange.start || '',
      'end', dateRange.end || '',
      'igContent', instagramContentFilter,
      'igStories', instagramStoriesStatusFilter
    ].join('|');
  }, [activeTab, alertCategory, debouncedSearchQuery, platformFilter, keywordFilter, intentFilter, sourceCategoryFilter, dateRange.start, dateRange.end, instagramContentFilter, instagramStoriesStatusFilter]);

  const readCache = useCallback((key) => {
    try {
      const raw = localStorage.getItem(ALERTS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const entry = parsed?.[key];
      if (!entry?.ts || !entry?.data) return null;
      if (Date.now() - entry.ts > ALERTS_CACHE_TTL) return null;
      return entry.data;
    } catch (error) {
      console.error('Failed to read alerts cache:', error);
      return null;
    }
  }, []);

  const writeCache = useCallback((key, data) => {
    try {
      const raw = localStorage.getItem(ALERTS_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      parsed[key] = { ts: Date.now(), data };
      localStorage.setItem(ALERTS_CACHE_KEY, JSON.stringify(parsed));
    } catch (error) {
      console.error('Failed to write alerts cache:', error);
    }
  }, []);

  // Read status from URL query params (e.g., /alerts?status=acknowledged)
  useEffect(() => {
    const statusParam = searchParams.get('status');
    const searchParam = searchParams.get('search');
    const platformParam = searchParams.get('platform');
    const categoryParam = searchParams.get('category');
    // Drill-down targets used by the Command Centre: open this page already
    // narrowed to one watch-list keyword, or to one detected intent.
    const keywordParam = searchParams.get('keyword');
    const intentParam = searchParams.get('intent');

    if (statusParam && ALERT_STATUS_TABS.some((tab) => tab.value === statusParam)) {
      setActiveTab(statusParam);
    }

    if (platformParam) {
      setPlatformFilter(platformParam);
    }

    if (categoryParam) {
      setAlertCategory(categoryParam);
    }

    if (keywordParam) {
      setKeywordFilter(keywordParam);
    }

    setIntentFilter(intentParam || null);

    // Only populate search query if EXPLICITLY provided via 'search' param
    if (searchParam) {
      setSearchQuery(searchParam);
      setDebouncedSearchQuery(searchParam);
    }
    // Note: 'handle' param is handled separately within ReportsContent
  }, [searchParams]);

  useEffect(() => {
    if (!hasAnyAlertFeature) return;
    const allowedValues = visibleStatusTabs.map((tab) => tab.value);
    if (!allowedValues.includes(activeTab)) {
      setActiveTab(allowedValues[0]);
    }
  }, [activeTab, hasAnyAlertFeature, visibleStatusTabs]);

  // Sync activeTab to URL so back-navigation restores the correct tab
  useEffect(() => {
    const currentStatus = searchParams.get('status');
    if (activeTab !== currentStatus) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('status', activeTab);
        return next;
      }, { replace: true });
    }
  }, [activeTab]);

  // Helper to clear handle param from URL
  const clearHandleParam = () => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.delete('handle');
      return newParams;
    });
  };

  const updateDownloadState = (id, updates) => {
    setDownloadStates((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        ...updates
      }
    }));
  };

  // Map to store reports by alert_id for quick lookup
  const [reportsMap, setReportsMap] = useState({});

  // Add Source Modal States
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [initialSourceData, setInitialSourceData] = useState(null);

  // Fetch reports for escalated alerts to show report status
  const fetchReportsForAlerts = useCallback(async (alertsList) => {
    const escalatedAlertIds = alertsList
      .filter(a => a.status === 'escalated')
      .map(a => a.id);

    if (escalatedAlertIds.length === 0) return;

    try {
      const response = await api.get('/reports');
      const reports = response.data.data || response.data || [];

      // Create a map of alert_id -> report, but ONLY for alerts currently on screen
      const newReportsMap = {};
      reports.forEach(report => {
        // Only include reports that match current escalated alerts
        if (report.alert_id && escalatedAlertIds.includes(report.alert_id)) {
          newReportsMap[report.alert_id] = report;
        }
      });
      setReportsMap(newReportsMap); // Replace, don't merge, to avoid stale data
    } catch (error) {
      console.error('Failed to fetch reports for alerts:', error);
    }
  }, []);

  const handleDownloadMedia = async (alert, contentData) => {
    const mediaUrl = alert?.content_url || contentData?.url || contentData?.link;
    if (!mediaUrl) {
      updateDownloadState(alert.id, { error: 'No media URL available' });
      setTimeout(() => updateDownloadState(alert.id, { error: null }), 3000);
      return;
    }

    updateDownloadState(alert.id, {
      downloading: true,
      progress: 0,
      status: 'Initializing...',
      error: null
    });

    try {
      updateDownloadState(alert.id, { progress: 10, status: 'Fetching media info...' });

      const downloadPromise = api.post('/media/download', {
        media_url: mediaUrl,
        content_id: contentData?.id || alert.content_id
      });

      let progress = 10;
      const progressInterval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress < 85) {
          updateDownloadState(alert.id, { progress: Math.min(progress, 85) });
          if (progress < 30) updateDownloadState(alert.id, { status: 'Fetching media info...' });
          else if (progress < 50) updateDownloadState(alert.id, { status: 'Downloading media...' });
          else if (progress < 70) updateDownloadState(alert.id, { status: 'Processing...' });
          else updateDownloadState(alert.id, { status: 'Almost done...' });
        }
      }, 500);

      const response = await downloadPromise;
      clearInterval(progressInterval);

      updateDownloadState(alert.id, { progress: 100, status: 'Complete!' });

      if (response.data.download_url) {
        setTimeout(() => {
          window.open(response.data.download_url, '_blank');
          updateDownloadState(alert.id, { downloading: false, progress: 0, status: '' });
        }, 500);
      } else {
        updateDownloadState(alert.id, { downloading: false, progress: 0, status: '' });
      }
    } catch (error) {
      updateDownloadState(alert.id, {
        downloading: false,
        progress: 0,
        status: '',
        error: error.response?.data?.error || 'Download failed'
      });
      setTimeout(() => updateDownloadState(alert.id, { error: null }), 3000);
    }
  };

  // Reset pagination when filters change
  useEffect(() => {
    setPage(1);
    setNextCursor(null);
    setHasMore(true);
    if (!hasAnyAlertFeature) return;
    if (activeTab === 'reports') return;
    const cacheKey = buildCacheKey();
    const cached = readCache(cacheKey);
    if (cached?.alerts?.length) {
      setAlerts(cached.alerts);
      setTotalResults(cached.totalResults || 0);
      setHasMore(cached.hasMore ?? true);
      setPage(cached.nextPage || 2);
      setNextCursor(cached.nextCursor || null);
      if (cached.alertStats) setAlertStats(cached.alertStats);
    }
  }, [activeTab, alertCategory, debouncedSearchQuery, platformFilter, keywordFilter, intentFilter, sourceCategoryFilter, dateRange, buildCacheKey, readCache, hasAnyAlertFeature]);

  useEffect(() => {
    if (platformFilter !== 'instagram') {
      setInstagramContentFilter('all_posts_reels');
      setInstagramStoriesStatusFilter('all');
    }
  }, [platformFilter]);

  useEffect(() => {
    if (instagramContentFilter !== 'stories_24h') {
      setInstagramStoriesStatusFilter('all');
    }
  }, [instagramContentFilter]);

  useEffect(() => {
    const fetchKeywords = async () => {
      try {
        const response = await api.get('/keywords');
        const kws = (response.data || [])
          .map(k => k.keyword)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        setAvailableKeywords(kws);
      } catch (error) {
        console.error(error);
      }
    };

    fetchKeywords();

    // Prefetch lightweight summary for instant tab counts
    api.get('/alerts/summary').then(res => {
      if (res.data && !alertStats) {
        setAlertStats(prev => prev || res.data);
      }
    }).catch(() => { });
  }, []);

  // Removed mapContentToAlert as it was only for content/feed fallback which is now unified
  // Removed fetchContentFeed as we now use /api/alerts for everything

  const fetchAlerts = useCallback(async (isLoadMore = false, cursorOverride = null) => {
    if (!hasAnyAlertFeature) {
      setAlerts([]);
      setHasMore(false);
      setLoading(false);
      setIsRefreshing(false);
      setIsFetchingMore(false);
      return;
    }
    if (isInstagramStoryView) {
      setLoading(false);
      setIsRefreshing(false);
      setIsFetchingMore(false);
      return;
    }
    const isCurrentTabAllowed = visibleStatusTabs.some((tab) => tab.value === activeTab);
    if (!isCurrentTabAllowed) {
      setLoading(false);
      setIsRefreshing(false);
      setIsFetchingMore(false);
      return;
    }
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setError(null);
    if (isFirstLoadRef.current && !isLoadMore) {
      setLoading(true);
    } else if (isLoadMore) {
      setIsFetchingMore(true);
    } else {
      setIsRefreshing(true);
    }

    try {
      const requestSeq = ++fetchRequestSeqRef.current;
      if (!isLoadMore && fetchAbortRef.current) {
        fetchAbortRef.current.abort();
      }
      const controller = new AbortController();
      if (!isLoadMore) fetchAbortRef.current = controller;

      const params = {
        page: 1,
        limit: 20,
        includeStats: !isLoadMore,
        status: activeTab !== 'reports' ? activeTab : 'active',
        search: debouncedSearchQuery || undefined,
        platform: platformFilter !== 'all' ? platformFilter : undefined,
        category: sourceCategoryFilter !== 'all' ? sourceCategoryFilter : undefined,
        startDate: dateRange.start || undefined,
        endDate: dateRange.end || undefined,
        keyword: keywordFilter !== 'all' ? keywordFilter : undefined,
        intent: intentFilter || undefined
      };

      if (isLoadMore && (cursorOverride || nextCursor)) {
        params.cursor = cursorOverride || nextCursor;
      }

      if (alertCategory === 'viral') {
        params.alert_type = 'velocity';
      } else if (alertCategory === 'risk') {
        params.alert_type = 'risk';
      } else if (['high', 'medium', 'low', 'critical'].includes(alertCategory)) {
        params.risk_level = alertCategory;
      }

      const response = await api.get('/alerts', { params, signal: controller.signal });
      if (requestSeq !== fetchRequestSeqRef.current) return;

      const newAlerts = response.data.alerts || [];
      const pagination = response.data.pagination;
      setTotalResults((prev) => (typeof pagination.total === 'number' ? pagination.total : prev));
      if (response.data.stats) setAlertStats(response.data.stats);

      const uniqueNewAlerts = [];
      const seenIds = new Set();
      newAlerts.forEach(alert => {
        if (!seenIds.has(alert.id)) {
          seenIds.add(alert.id);
          uniqueNewAlerts.push(alert);
        }
      });

      if (isLoadMore) {
        setAlerts(prev => {
          const existingIds = new Set(prev.map(a => a.id));
          const trulyUnique = uniqueNewAlerts.filter(a => !existingIds.has(a.id));
          // If no new unique items, return same reference to avoid re-render loop
          if (trulyUnique.length === 0) return prev;
          return [...prev, ...trulyUnique];
        });
      } else {
        setAlerts(uniqueNewAlerts);
      }

      // Safety: if server returned fewer items than requested, no more data
      if (isLoadMore && uniqueNewAlerts.length === 0) {
        setHasMore(false);
        setNextCursor(null);
        return;
      }

      setHasMore(pagination.hasMore);
      setNextCursor(pagination.nextCursor || null);
      setPage((prev) => (isLoadMore ? prev + 1 : 1));

      // Cache the result (use functional approach to get latest alerts)
      const cacheKey = buildCacheKey();
      if (!isLoadMore) {
        writeCache(cacheKey, {
          alerts: uniqueNewAlerts,
          totalResults: pagination.total || 0,
          hasMore: pagination.hasMore,
          nextPage: 2,
          nextCursor: pagination.nextCursor || null,
          alertStats: response.data.stats || null
        });
      }

    } catch (error) {
      if (error.name === 'CanceledError' || error.code === 'ERR_CANCELED') return;
      console.error(error);
      setError('Failed to load alerts');
      toast.error('Failed to load alerts');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
      setIsFetchingMore(false);
      isFirstLoadRef.current = false;
      isFetchingRef.current = false;
    }
  }, [activeTab, debouncedSearchQuery, platformFilter, keywordFilter, alertCategory, dateRange, sourceCategoryFilter, buildCacheKey, writeCache, nextCursor, hasAnyAlertFeature, visibleStatusTabs, isInstagramStoryView]);

  const fetchCapturedStories = useCallback(async () => {
    const requestId = ++capturedStoriesReqIdRef.current;
    if (!isCapturedStoriesView) {
      setCapturedStories([]);
      setCapturedStoriesLoading(false);
      return;
    }

    setCapturedStoriesLoading(true);
    try {
      const allStories = [];
      let currentPage = 1;
      let hasMoreStories = true;
      const maxPages = 2;
      const maxStories = 250;
      const seenPageSignatures = new Set();

      while (hasMoreStories && currentPage <= maxPages) {
        const response = await api.get('/instagram-stories', {
          params: {
            page: currentPage,
            limit: 60,
            include_expired: true,
            include_unavailable: true,
            s3_only: true
          },
          timeout: 12000
        });

        if (requestId !== capturedStoriesReqIdRef.current) {
          return;
        }

        const storiesChunk = Array.isArray(response.data?.stories) ? response.data.stories : [];
        const firstId = storiesChunk[0]?.id || storiesChunk[0]?.story_pk || '';
        const lastId = storiesChunk[storiesChunk.length - 1]?.id || storiesChunk[storiesChunk.length - 1]?.story_pk || '';
        const signature = `${storiesChunk.length}:${firstId}:${lastId}`;
        if (seenPageSignatures.has(signature)) {
          break;
        }
        seenPageSignatures.add(signature);

        allStories.push(...storiesChunk);

        if (allStories.length >= maxStories) {
          break;
        }

        hasMoreStories = Boolean(response.data?.pagination?.hasMore) && storiesChunk.length > 0;
        currentPage += 1;
      }

      if (requestId === capturedStoriesReqIdRef.current) {
        setCapturedStories(mergeInstagramStoriesByIdentity(allStories));
      }
    } catch (error) {
      console.error('Failed to fetch captured stories:', error);
      if (requestId === capturedStoriesReqIdRef.current) {
        setCapturedStories([]);
        toast.error('Failed to load captured Instagram stories');
      }
    } finally {
      if (requestId === capturedStoriesReqIdRef.current) {
        setCapturedStoriesLoading(false);
      }
    }
  }, [isCapturedStoriesView]);

  useEffect(() => {
    fetchCapturedStories();
  }, [fetchCapturedStories]);

  const fetchRecentStories = useCallback(async () => {
    const requestId = ++recentStoriesReqIdRef.current;
    if (!isStories24hView) {
      setRecentStories([]);
      setRecentStoriesLoading(false);
      return;
    }

    setRecentStoriesLoading(true);
    try {
      const parseTimestamp = (value) => {
        if (!value) return Number.NaN;
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') {
          return value < 1e12 ? value * 1000 : value;
        }
        const text = String(value).trim();
        if (!text) return Number.NaN;
        if (/^\d+$/.test(text)) {
          const num = Number(text);
          return num < 1e12 ? num * 1000 : num;
        }
        const parsed = new Date(text).getTime();
        return Number.isNaN(parsed) ? Number.NaN : parsed;
      };

      const readStoryPublishedTime = (story) => parseTimestamp(
        story?.published_at
        || story?.created_at
        || story?.updated_at
        || story?.taken_at
        || story?.raw_data?.taken_at
        || story?.raw_data?.published_at
        || story?.raw_data?.created_at
      );

      const toStoryLikeFromContent = (item, index) => {
        const mediaList = Array.isArray(item?.media) ? item.media : [];
        const firstVideo = mediaList.find((m) => {
          const type = String(m?.type || m?.media_type || '').toLowerCase();
          const candidate = String(m?.video_url || m?.url || m?.s3_url || '');
          return type.includes('video') || /\.(mp4|webm|mov|mkv|m3u8)(\?|$)/i.test(candidate);
        });
        const firstMedia = firstVideo || mediaList[0] || {};

        const videoUrl = firstVideo?.s3_url || firstVideo?.video_url || firstVideo?.url || '';
        const imageUrl = firstMedia?.s3_preview || firstMedia?.preview || firstMedia?.preview_url || firstMedia?.thumbnail_url || firstMedia?.s3_url || firstMedia?.url || '';
        const resolvedMediaType = firstVideo ? 'video' : 'image';
        const rawStoryUrl = item?.content_url || item?.url || '';

        // Preserve original CDN URLs separately from S3 URLs
        const originalVideoUrl = firstVideo?.original_video_url || firstVideo?.video_url || firstVideo?.url || '';
        const originalImageUrl = firstMedia?.original_url || firstMedia?.original_preview || firstMedia?.url || '';

        return {
          id: item?.id || item?.content_id || `content-story-${index}`,
          story_pk: item?.content_id || item?.id || `content-story-${index}`,
          author: item?.author || item?.source_meta?.name || item?.author_handle || 'Instagram User',
          author_handle: item?.author_handle || item?.source_meta?.handle || '',
          author_avatar: item?.source_meta?.profile_image_url || '',
          media_type: resolvedMediaType,
          story_url: rawStoryUrl,
          permalink: rawStoryUrl,
          content_url: rawStoryUrl,
          s3_url: firstMedia?.s3_url || '',
          s3_thumbnail_url: firstMedia?.s3_preview || '',
          original_url: originalVideoUrl || originalImageUrl || videoUrl || firstMedia?.video_url || firstMedia?.url || item?.content_url || imageUrl,
          thumbnail_url: imageUrl || item?.content_url || '',
          video_versions: firstVideo?.video_versions || firstMedia?.video_versions || [],
          caption: item?.text || '',
          published_at: item?.published_at || item?.created_at || item?.updated_at,
          created_at: item?.created_at,
          updated_at: item?.updated_at,
          expires_at: item?.expired_at || null,
          is_available: item?.is_deleted === true ? false : true,
          deleted_at: item?.deleted_at || null,
          is_archived: mediaList.some((m) => Boolean(m?.s3_url || m?.s3_preview)),
          media: mediaList,
          raw_data: item
        };
      };

      const fetchStoriesFromInstagramStoriesApi = async () => {
        const allStories = [];
        let currentPage = 1;
        let hasMoreStories = true;
        const maxPages = 2;
        const maxStories = 240;
        const seenPageSignatures = new Set();

        while (hasMoreStories && currentPage <= maxPages) {
          const response = await api.get('/instagram-stories', {
            params: {
              page: currentPage,
              limit: 60,
              include_expired: true,
              include_unavailable: true
            },
            timeout: 12000
          });

          if (requestId !== recentStoriesReqIdRef.current) {
            return allStories;
          }

          const storiesChunk = Array.isArray(response.data?.stories) ? response.data.stories : [];
          const firstId = storiesChunk[0]?.id || storiesChunk[0]?.story_pk || '';
          const lastId = storiesChunk[storiesChunk.length - 1]?.id || storiesChunk[storiesChunk.length - 1]?.story_pk || '';
          const signature = `${storiesChunk.length}:${firstId}:${lastId}`;
          if (seenPageSignatures.has(signature)) {
            break;
          }
          seenPageSignatures.add(signature);

          allStories.push(...storiesChunk);

          if (allStories.length >= maxStories) {
            break;
          }

          hasMoreStories = Boolean(response.data?.pagination?.hasMore) && storiesChunk.length > 0;
          currentPage += 1;
        }

        return allStories;
      };

      const fetchStoriesFromContentApi = async () => {
        const allStories = [];
        let currentPage = 1;
        let hasMoreStories = true;
        const maxPages = 1;
        const maxStories = 160;
        const seenPageSignatures = new Set();

        while (hasMoreStories && currentPage <= maxPages) {
          const response = await api.get('/content', {
            params: {
              platform: 'instagram',
              content_type: 'story',
              page: currentPage,
              limit: 80
            },
            timeout: 12000
          });

          if (requestId !== recentStoriesReqIdRef.current) {
            return allStories;
          }

          const storiesChunk = Array.isArray(response.data?.items)
            ? response.data.items
            : (Array.isArray(response.data) ? response.data : []);

          const firstId = storiesChunk[0]?.id || storiesChunk[0]?.content_id || '';
          const lastId = storiesChunk[storiesChunk.length - 1]?.id || storiesChunk[storiesChunk.length - 1]?.content_id || '';
          const signature = `${storiesChunk.length}:${firstId}:${lastId}`;
          if (seenPageSignatures.has(signature)) {
            break;
          }
          seenPageSignatures.add(signature);

          allStories.push(...storiesChunk.map(toStoryLikeFromContent));

          if (allStories.length >= maxStories) {
            break;
          }

          hasMoreStories = Boolean(response.data?.pagination?.hasMore) && storiesChunk.length > 0;
          currentPage += 1;
        }

        return allStories;
      };

      const toStoryLikeFromAlert = (alert, index) => {
        const content =
          alert?.content_details ||
          ((alert?.content_id && typeof alert.content_id === 'object') ? alert.content_id : null) ||
          {};

        const mediaList = Array.isArray(content?.media) ? content.media : [];
        const firstVideo = mediaList.find((m) => {
          const type = String(m?.type || m?.media_type || '').toLowerCase();
          const candidate = String(m?.video_url || m?.url || m?.s3_url || '');
          return type.includes('video') || /\.(mp4|webm|mov|mkv|m3u8)(\?|$)/i.test(candidate);
        });
        const firstMedia = firstVideo || mediaList[0] || {};

        const storyId = content?.id || alert?.id || `alert-story-${index}`;
        const publishedAt = content?.published_at || alert?.created_at || alert?.timestamp || null;
        const rawStoryUrl = content?.content_url || alert?.content_url || content?.url || '';

        // Preserve original CDN URLs for fallback
        const originalVideoUrl = firstVideo?.original_video_url || firstVideo?.video_url || firstVideo?.url || '';
        const originalImageUrl = firstMedia?.original_url || firstMedia?.original_preview || firstMedia?.url || '';

        return {
          id: storyId,
          story_pk: content?.content_id || content?.id || alert?.content_id || storyId,
          author: alert?.author || content?.author || content?.author_handle || alert?.author_handle || 'Instagram User',
          author_handle: content?.author_handle || alert?.author_handle || alert?.source_meta?.handle || '',
          author_avatar: alert?.source_meta?.profile_image_url || '',
          media_type: firstVideo ? 'video' : (String(firstMedia?.type || firstMedia?.media_type || '').toLowerCase().includes('video') ? 'video' : 'image'),
          story_url: rawStoryUrl,
          permalink: rawStoryUrl,
          content_url: rawStoryUrl,
          s3_url: firstMedia?.s3_url || '',
          s3_thumbnail_url: firstMedia?.s3_preview || firstMedia?.preview || '',
          original_url: originalVideoUrl || originalImageUrl || content?.content_url || alert?.content_url || firstMedia?.url || '',
          thumbnail_url: firstMedia?.preview || firstMedia?.preview_url || firstMedia?.thumbnail_url || firstMedia?.url || content?.content_url || alert?.content_url || '',
          video_versions: firstVideo?.video_versions || firstMedia?.video_versions || [],
          caption: content?.text || '',
          published_at: publishedAt,
          created_at: alert?.created_at,
          updated_at: alert?.updated_at,
          expires_at: content?.expired_at || null,
          is_available: content?.is_deleted === true ? false : true,
          deleted_at: content?.deleted_at || null,
          is_archived: mediaList.some((m) => Boolean(m?.s3_url || m?.s3_preview)),
          media: mediaList,
          raw_data: content
        };
      };

      const fetchStoriesFromAlertsApi = async () => {
        const allStories = [];
        let currentPage = 1;
        let hasMoreStories = true;
        const maxPages = 1;
        const maxStories = 160;
        const seenPageSignatures = new Set();

        while (hasMoreStories && currentPage <= maxPages) {
          const response = await api.get('/alerts', {
            params: {
              platform: 'instagram',
              status: 'all',
              page: currentPage,
              limit: 80
            },
            timeout: 12000
          });

          if (requestId !== recentStoriesReqIdRef.current) {
            return allStories;
          }

          const alertsChunk = Array.isArray(response.data?.alerts) ? response.data.alerts : [];
          const firstId = alertsChunk[0]?.id || '';
          const lastId = alertsChunk[alertsChunk.length - 1]?.id || '';
          const signature = `${alertsChunk.length}:${firstId}:${lastId}`;
          if (seenPageSignatures.has(signature)) {
            break;
          }
          seenPageSignatures.add(signature);

          const storyAlerts = alertsChunk.filter((entry) => {
            const content =
              entry?.content_details ||
              ((entry?.content_id && typeof entry.content_id === 'object') ? entry.content_id : null) ||
              {};

            const contentType = String(content?.content_type || '').toLowerCase();
            const url = content?.content_url || entry?.content_url || '';
            return contentType === 'story' || /instagram\.com\/stories\//i.test(url);
          });

          allStories.push(...storyAlerts.map(toStoryLikeFromAlert));

          if (allStories.length >= maxStories) {
            break;
          }

          hasMoreStories = Boolean(response.data?.pagination?.hasMore) && alertsChunk.length > 0;
          currentPage += 1;
        }

        return allStories;
      };

      const dbStories = await fetchStoriesFromInstagramStoriesApi();
      if (requestId !== recentStoriesReqIdRef.current) {
        return;
      }

      const dbMergedStories = mergeInstagramStoriesByIdentity(dbStories);

      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const dbStoriesInLast24h = dbMergedStories.filter((story) => {
        const publishedTime = readStoryPublishedTime(story);
        if (Number.isNaN(publishedTime)) return false;
        const ageMs = now - publishedTime;
        return ageMs >= 0 && ageMs <= oneDayMs;
      });

      if (dbStoriesInLast24h.length > 0) {
        if (requestId === recentStoriesReqIdRef.current) {
          setRecentStories(dbStoriesInLast24h);
        }
        return;
      }

      const [contentStoriesResult, alertStoriesResult] = await Promise.allSettled([
        fetchStoriesFromContentApi(),
        fetchStoriesFromAlertsApi()
      ]);

      const contentStories = contentStoriesResult.status === 'fulfilled' ? contentStoriesResult.value : [];
      const alertStories = alertStoriesResult.status === 'fulfilled' ? alertStoriesResult.value : [];

      const mergedStories = [...dbMergedStories, ...contentStories, ...alertStories];
      const dedupedStories = mergeInstagramStoriesByIdentity(mergedStories);

      const storiesInLast24h = dedupedStories.filter((story) => {
        const publishedTime = readStoryPublishedTime(story);
        if (Number.isNaN(publishedTime)) return false;
        const ageMs = now - publishedTime;
        return ageMs >= 0 && ageMs <= oneDayMs;
      });

      if (requestId === recentStoriesReqIdRef.current) {
        setRecentStories(storiesInLast24h);
      }
    } catch (error) {
      console.error('Failed to fetch stories from last 24h:', error);
      if (requestId === recentStoriesReqIdRef.current) {
        setRecentStories([]);
        toast.error('Failed to load Instagram stories from last 24 hours');
      }
    } finally {
      if (requestId === recentStoriesReqIdRef.current) {
        setRecentStoriesLoading(false);
      }
    }
  }, [isStories24hView]);

  useEffect(() => {
    fetchRecentStories();
  }, [fetchRecentStories]);

  const fetchAlertStats = useCallback(async () => {
    // We now fetch stats always (for the Escalated pending count), 
    // relying on the JSX to hide regular status counts if no search is active.
    try {
      // Don't include URL queries in stats search - they're for investigation only
      const searchParam = isUrlQuery(debouncedSearchQuery) ? '' : debouncedSearchQuery;

      const params = {
        search: searchParam,
        platform: platformFilter !== 'all' ? platformFilter : undefined,
        category: sourceCategoryFilter !== 'all' ? sourceCategoryFilter : undefined,
        startDate: dateRange.start || undefined,
        endDate: dateRange.end || undefined,
        alert_type: alertCategory === 'viral' ? 'velocity' : undefined,
        keyword: keywordFilter !== 'all' ? keywordFilter : undefined,
        intent: intentFilter || undefined
      };

      if (alertCategory === 'viral') {
        params.alert_type = 'velocity';
      } else if (alertCategory === 'risk') {
        params.alert_type = 'risk';
      } else if (['high', 'medium', 'low', 'critical'].includes(alertCategory)) {
        params.risk_level = alertCategory;
      }

      const response = await api.get('/alerts/stats', { params });
      setAlertStats(response.data);
    } catch (error) {
      console.error('Failed to fetch alert stats:', error);
    }
  }, [debouncedSearchQuery, platformFilter, keywordFilter, alertCategory, dateRange, sourceCategoryFilter]);

  // Initial load or Filter change
  // Debounce Search Query - but skip if it's a URL (for investigation)
  // Search is now triggered manually via Search button or Enter key
  // This effect only handles clearing the search when input is emptied
  useEffect(() => {
    if (searchQuery === '' && debouncedSearchQuery !== '') {
      setDebouncedSearchQuery('');
    }
  }, [searchQuery]);

  // Fetch Logic Triggered by Filters (Debounced Search, Tab Switch, etc.)
  useEffect(() => {
    if (!hasAnyAlertFeature) return;
    // intentFilter MUST be part of this key. It gates whether a refetch happens
    // at all, so leaving it out means clearing the intent drill-down updates the
    // state and the URL but never re-requests — the filtered list just stays on
    // screen with no visible filter.
    const key = `${activeTab}|${alertCategory}|${debouncedSearchQuery}|${platformFilter}|${keywordFilter}|${intentFilter || ''}|${sourceCategoryFilter}|${dateRange.start}|${dateRange.end}`;
    const keyChanged = lastFetchKeyRef.current !== key;

    // Always update the key ref so transitions are detected correctly
    lastFetchKeyRef.current = key;

    // If on reports tab, let ReportsContent handle its own data fetching
    if (activeTab === 'reports' || isInstagramStoryView) return;

    // Only reset and fetch if the filters or tab actually changed
    if (keyChanged) {
      setPage(1);
      setNextCursor(null);
      setHasMore(true);
      fetchAlerts(false);
    }
  }, [activeTab, alertCategory, debouncedSearchQuery, platformFilter, keywordFilter, intentFilter, dateRange, sourceCategoryFilter, fetchAlerts, hasAnyAlertFeature, isInstagramStoryView]);

  // Initial data load when component mounts or when cache is empty
  useEffect(() => {
    if (!hasAnyAlertFeature) return;
    if (activeTab === 'reports' || isInstagramStoryView) return;

    // Only fetch if we don't have alerts loaded yet (not from cache)
    if (alerts.length === 0 && !loading) {
      fetchAlerts(false);
    }
  }, [hasAnyAlertFeature, activeTab, isInstagramStoryView, alerts.length, loading, fetchAlerts]);

  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  // Resolve the <main overflow-auto> scroll container from Layout.js
  useEffect(() => {
    scrollContainerRef.current = document.querySelector('main');
  }, []);

  // Infinite Scroll Observer
  useEffect(() => {
    if (!hasAnyAlertFeature) return;
    const root = scrollContainerRef.current || null;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loading && !isFetchingRef.current) {
          fetchAlerts(true, nextCursor);
        }
      },
      { root, threshold: 0.1, rootMargin: '300px' }
    );

    const target = observerTarget.current;
    if (target) {
      observer.observe(target);
    }

    return () => {
      if (target) {
        observer.unobserve(target);
      }
    };
  }, [activeTab, hasMore, loading, nextCursor, fetchAlerts, hasAnyAlertFeature]);

  // Fetch reports for escalated alerts when viewing escalated tab
  useEffect(() => {
    if (activeTab === 'escalated' && alerts.length > 0) {
      fetchReportsForAlerts(alerts);
    } else {
      // Clear reports map when not on escalated tab
      setReportsMap({});
    }
  }, [activeTab, alerts, fetchReportsForAlerts]);

  // --- POLLING LOGIC ---
  const checkForNewAlerts = useCallback(async () => {
    if (!hasAnyAlertFeature) return;
    // Only poll on 'active' tab for now to avoid complexity in history tabs
    if (isInstagramStoryView || activeTab !== 'active' || isFetchingRef.current) return;

    try {
      const params = {
        page: 1,
        limit: 20,
        status: 'active',
        platform: platformFilter !== 'all' ? platformFilter : undefined,
        category: sourceCategoryFilter !== 'all' ? sourceCategoryFilter : undefined,
        search: debouncedSearchQuery || undefined,
        keyword: keywordFilter !== 'all' ? keywordFilter : undefined,
        intent: intentFilter || undefined
      };

      if (alertCategory === 'viral') params.alert_type = 'velocity';
      else if (alertCategory === 'risk') params.alert_type = 'risk';
      else if (['high', 'medium', 'low', 'critical'].includes(alertCategory)) params.risk_level = alertCategory;

      const response = await api.get('/alerts', { params: { ...params, includeStats: true } });
      const mappedNew = response.data.alerts || [];

      // Identify truly new items — ALWAYS buffer them, never prepend directly.
      // This prevents reorder chaos while user is reading.
      setAlerts(currentAlerts => {
        const currentIds = new Set([
          ...currentAlerts.map(a => a.id),
          ...pendingNewAlerts.map(a => a.id)
        ]);
        const trulyNew = mappedNew.filter(a => !currentIds.has(a.id));

        if (trulyNew.length > 0) {
          // Always buffer — never auto-prepend regardless of scroll position
          setPendingNewAlerts((prev) => {
            const seen = new Set(prev.map((a) => a.id));
            const merged = [...prev];
            trulyNew.forEach((item) => {
              if (!seen.has(item.id)) {
                seen.add(item.id);
                merged.push(item);
              }
            });
            return merged;
          });
          setNewAlertCount((prev) => prev + trulyNew.length);
        }
        return currentAlerts;
      });
      if (response.data?.stats) setAlertStats(response.data.stats);

    } catch (e) {
      console.error("Polling error:", e); // Silent fail
    }
  }, [activeTab, loading, platformFilter, debouncedSearchQuery, alertCategory, keywordFilter, intentFilter, sourceCategoryFilter, hasAnyAlertFeature, pendingNewAlerts, isInstagramStoryView]);

  // Scroll Anchoring Effect
  React.useLayoutEffect(() => {
    if (scrollAnchorRef.current.shouldRestore) {
      const container = scrollContainerRef.current || document.documentElement;
      const newHeight = container.scrollHeight;
      const diff = newHeight - scrollAnchorRef.current.prevHeight;
      if (diff > 0) {
        (scrollContainerRef.current || window).scrollTo(0, scrollAnchorRef.current.prevScroll + diff);
      }
      scrollAnchorRef.current.shouldRestore = false;
    }
  }, [alerts]);

  const mergePendingAlerts = useCallback(() => {
    // Full re-fetch to load new alerts in proper order
    setPendingNewAlerts([]);
    setNewAlertCount(0);
    setPage(1);
    setNextCursor(null);
    setHasMore(true);
    fetchAlerts(false);
  }, [fetchAlerts]);

  // Reset new count when at top (but don't auto-merge — user must click the button)
  useEffect(() => {
    const container = scrollContainerRef.current || window;
    const handleScroll = () => {
      const scrollTop = scrollContainerRef.current ? scrollContainerRef.current.scrollTop : window.scrollY;
      if (scrollTop < 50 && newAlertCount > 0 && pendingNewAlerts.length === 0) {
        setNewAlertCount(0);
      }
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [newAlertCount, pendingNewAlerts.length]);

  const fetchSourcesMetadata = useCallback(async () => {
    setSourcesMetaLoading(true);
    try {
      const response = await api.get('/sources');
      // Handle both { data: [...] } and directly [...]
      const data = Array.isArray(response.data) ? response.data : (response.data?.data || []);
      setMonitoredSources(data);
      const handles = data.map(s => s.identifier).filter(Boolean);
      setMonitoredHandles(handles);
      setSourcesMetaLoaded(true);
      console.log(`[Alerts] Fetched ${handles.length} monitored handles:`, handles);
    } catch (err) {
      console.error('Error fetching source metadata:', err);
    } finally {
      setSourcesMetaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profilesMatrixOpen && !sourcesMetaLoaded && !sourcesMetaLoading) {
      fetchSourcesMetadata();
    }
  }, [profilesMatrixOpen, sourcesMetaLoaded, sourcesMetaLoading, fetchSourcesMetadata]);

  useEffect(() => {
    // fetchSourcesMetadata is called initially and periodically
    fetchSourcesMetadata();

    // Auto-refresh every 2 minutes
    const interval = setInterval(() => {
      checkForNewAlerts(); // Use checkForNewAlerts for silent refresh
      fetchSourcesMetadata();
      if (isCapturedStoriesView) {
        fetchCapturedStories();
      }
    }, 120000);

    return () => clearInterval(interval);
  }, [checkForNewAlerts, fetchAlerts, fetchAlertStats, fetchSourcesMetadata, fetchCapturedStories, isCapturedStoriesView]);

  // Poll pending engager analysis count
  useEffect(() => {
    const fetchPending = () => {
      api.get('/x/engager-analysis-pending').then(res => {
        setPendingAnalysisCount(res.data?.count || 0);
      }).catch(() => {});
    };
    fetchPending();
    const iv = setInterval(fetchPending, 10000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!hasAnyAlertFeature) return;
    if (!hasAnyAlertFeature) return undefined;
    const interval = setInterval(checkForNewAlerts, 10000); // Poll every 10s
    return () => clearInterval(interval);
  }, [checkForNewAlerts, hasAnyAlertFeature]);

  useEffect(() => {
    return () => {
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
    };
  }, []);

  const scrollToTop = () => {
    (scrollContainerRef.current || window).scrollTo({ top: 0, behavior: 'smooth' });
    mergePendingAlerts();
  };



  const handleAlertResolve = (resolvedAlert) => {
    const newStatus = resolvedAlert.status;
    const oldAlert = alerts.find(a => a.id === resolvedAlert.id) || investigatedAlerts.find(a => a.id === resolvedAlert.id);
    const statusChanged = oldAlert && oldAlert.status !== resolvedAlert.status;
    const riskLevelChanged = oldAlert && oldAlert.risk_level !== resolvedAlert.risk_level;
    const categoryChanged = oldAlert && oldAlert.source_category !== resolvedAlert.source_category;

    if (categoryChanged && !statusChanged && !riskLevelChanged) {
      // Category changed — update the alert in-place
      setAlerts(prev => prev.map(a => a.id === resolvedAlert.id ? { ...a, source_category: resolvedAlert.source_category } : a));
      setInvestigatedAlerts(prev => prev.map(a => a.id === resolvedAlert.id ? { ...a, source_category: resolvedAlert.source_category } : a));
    } else if (riskLevelChanged && !statusChanged) {
      // Risk level changed — update the alert in-place so filters reflect the new level
      setAlerts(prev => prev.map(a => a.id === resolvedAlert.id ? { ...a, risk_level: resolvedAlert.risk_level } : a));
      setInvestigatedAlerts(prev => prev.map(a => a.id === resolvedAlert.id ? { ...a, risk_level: resolvedAlert.risk_level } : a));
      toast.success(`Risk level changed to ${resolvedAlert.risk_level?.toUpperCase()}`);
    } else {
      // Status changed — remove from current tab if it no longer belongs
      setAlerts(prev => prev.filter(a => a.id !== resolvedAlert.id || (newStatus === activeTab)));
      setInvestigatedAlerts(prev => prev.filter(a => a.id !== resolvedAlert.id || (newStatus === activeTab)));
      toast.success(`Alert moved to ${newStatus?.replace('_', ' ') || 'updated'}`);
    }

    fetchAlertStats();
  };

  const fetchTopAlerts = useCallback(async (hours = topAlertsHours, forceRefresh = false) => {
    setTopAlertsLoading(true);
    setTopAlertsError(null);
    try {
      let alertIds = [];
      let meta = {};

      // Step 1: Get ranked alert IDs from per-category RAG cache (unless forced)
      if (!forceRefresh) {
        const cached = await api.get('/rag/top-alerts/cached', {
          params: { hours, mode: 'by_category' },
        }).then(r => r.data).catch(() => null);
        if (cached?.found && Array.isArray(cached.alert_ids) && cached.alert_ids.length > 0
            && cached.alert_ids[0].includes('-')) {
          alertIds = cached.alert_ids;
          meta = cached;
        }
      }

      if (!alertIds.length) {
        const ragData = await api.post('/rag/top-alerts/by-category', {
          hours,
          top_n_per_category: 50,
        }).then(r => r.data);
        alertIds = (ragData.alerts || []).map(a => a.id).filter(id => id && id.includes('-'));
        meta = ragData;
      }

      if (!alertIds.length) {
        setTopAlertsData({ alerts: [], ...meta, hours });
        return;
      }

      // Step 2: Fetch FULL alerts (with content_details, media, engagement) from node backend
      // Process in batches of 25 to avoid timeout on large requests
      const BATCH = 25;
      const fullAlerts = [];
      for (let i = 0; i < alertIds.length; i += BATCH) {
        const batch = alertIds.slice(i, i + BATCH);
        const res = await api.post('/alerts/bulk', { ids: batch });
        fullAlerts.push(...(res.data?.alerts || []));
      }

      // Preserve AI-ranked order (already grouped by category server-side)
      const byId = Object.fromEntries(fullAlerts.map(a => [a.id, a]));
      const ordered = alertIds.map(id => byId[id]).filter(Boolean);

      setTopAlertsData({
        alerts: ordered,
        total_scanned: meta.total_scanned,
        total_unique: meta.total_unique,
        top_n: ordered.length,
        top_n_per_category: meta.top_n_per_category || 50,
        categories: meta.categories || {},
        hours,
        date: meta.date,
      });
    } catch (e) {
      setTopAlertsError(e.message);
    } finally {
      setTopAlertsLoading(false);
    }
  }, [topAlertsHours]);

  const handleOpenTopAlerts = () => {
    // Always clear and refetch so we never show stale / empty cards
    setTopAlertsData(null);
    setTopAlertsCatFilter('all');
    setTopAlertsError(null);
    setTopAlertsOpen(true);
    fetchTopAlerts(topAlertsHours, false);
  };

  const handleTopAlertResolve = (resolvedAlert) => {
    setTopAlertsData(prev => prev ? {
      ...prev,
      alerts: prev.alerts.map(a => a.id === resolvedAlert.id ? { ...a, status: resolvedAlert.status } : a),
    } : prev);
    handleAlertResolve(resolvedAlert);
  };

  const handleInvestigate = async (url) => {
    if (!url.trim()) return;

    console.log('[Alerts] Investigating URL:', url);
    setIsInvestigating(true);
    try {
      console.log('[Alerts] POSTing to /alerts/investigate...');
      const response = await api.post('/alerts/investigate', { url });
      console.log('[Alerts] Investigation response:', response.data);
      const newAlert = response.data;

      setInvestigatedAlerts(prev => [newAlert, ...prev]);
      setSearchQuery(''); // Clear search after investigation
      toast.success('Investigation complete. Result added to the list.');

      // Clear frontend localStorage cache so refresh gets fresh data from DB
      try {
        localStorage.removeItem(ALERTS_CACHE_KEY);
      } catch (e) { /* ignore */ }

      // Re-fetch the main alerts list so the new alert appears in the regular list
      // This ensures it persists after page refresh (no longer depends on client state)
      setPage(1);
      setNextCursor(null);
      setHasMore(true);
      isFetchingRef.current = false; // Reset so fetchAlerts can run
      fetchAlerts(false);

      // Also refresh stats to update counts
      fetchAlertStats();

      // Auto-switch to active tab if not already there to see the result
      const fallbackTab = visibleStatusTabs.some((tab) => tab.value === 'active')
        ? 'active'
        : visibleStatusTabs[0]?.value;
      if (fallbackTab && activeTab !== fallbackTab) {
        setActiveTab(fallbackTab);
      }

      // Scroll to top to see the new result
      (scrollContainerRef.current || window).scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error('Investigation failed:', error);
      const serverMessage = error.response?.data?.message;
      const debugDetails = error.response?.data?.debug;

      const displayMessage = serverMessage
        ? `${serverMessage}${debugDetails ? ` (Debug: ${JSON.stringify(debugDetails)})` : ''}`
        : 'Failed to investigate link';

      toast.error(displayMessage);
    } finally {
      setIsInvestigating(false);
    }
  };

  // Filter investigated alerts based on current filters
  const filterInvestigatedAlerts = useCallback((alerts) => {
    return alerts.filter(alert => {
      // Platform filter
      if (platformFilter !== 'all' && alert.platform !== platformFilter) {
        return false;
      }

      // Search query filter (search in text, author, author_handle)
      if (debouncedSearchQuery) {
        const searchLower = debouncedSearchQuery.toLowerCase();
        const textMatch =
          String(alert?.content_id?.text || '').toLowerCase().includes(searchLower) ||
          String(alert?.content_details?.text || '').toLowerCase().includes(searchLower);
        const authorMatch =
          String(alert?.author || '').toLowerCase().includes(searchLower) ||
          String(alert?.author_handle || '').toLowerCase().includes(searchLower);
        if (!textMatch && !authorMatch) {
          return false;
        }
      }

      // Alert category filter (risk level or viral)
      if (alertCategory !== 'all') {
        if (alertCategory === 'viral') {
          // Viral = the backend's velocity alert type (same signal as the Viral badge).
          // viral_score / engagement_velocity were never populated, so every alert failed this.
          const isViral = alert.alert_type === 'velocity';
          if (!isViral) return false;
        } else {
          // For risk levels (high, medium, low)
          const riskLevel = alert.risk_level?.toLowerCase() || alert.severity?.toLowerCase();
          if (riskLevel !== alertCategory) {
            return false;
          }
        }
      }

      // Keyword filter
      if (keywordFilter !== 'all' && alert.matched_keywords) {
        const hasKeyword = alert.matched_keywords.some(k =>
          k.keyword_id === keywordFilter || k.keyword === keywordFilter
        );
        if (!hasKeyword) {
          return false;
        }
      }

      // Date range filter
      if (dateRange.start || dateRange.end) {
        const alertDate = new Date(alert.created_at || alert.timestamp);
        const alertTime = alertDate.getTime();
        if (Number.isNaN(alertTime)) return false;
        const startTime = toStartOfSelectedDay(dateRange.start);
        const endTime = toEndOfSelectedDay(dateRange.end);

        if (startTime && alertTime < startTime) {
          return false;
        }
        if (endTime && alertTime > endTime) {
          return false;
        }
      }

      // Status filter (activeTab)
      // Investigated alerts are always is_investigation=true and initially active
      if (activeTab === 'reports') {
        return false; // Investigated alerts don't appear in reports tab
      }

      // Match status
      const alertStatus = alert.status || 'active';
      if (activeTab !== alertStatus) {
        return false;
      }

      return true;
    });
  }, [platformFilter, debouncedSearchQuery, alertCategory, keywordFilter, dateRange, activeTab, toStartOfSelectedDay, toEndOfSelectedDay]);

  const allFilteredAlerts = useMemo(() => {
    const filteredInvestigated = filterInvestigatedAlerts(investigatedAlerts);
    const filteredRegular = alerts.filter(a => !investigatedAlerts.some(inv => inv.id === a.id));

    const applyInstagramContentFilter = (items) => {
      if (platformFilter !== 'instagram') return items;
      return items.filter((item) => {
        const content =
          item?.content_details ||
          ((item?.content_id && typeof item.content_id === 'object') ? item.content_id : null) ||
          {};
        const contentType = String(content?.content_type || '').toLowerCase();
        const contentUrl = item?.content_url || content?.content_url || content?.url || '';
        const publishedAt =
          content?.published_at
          || content?.created_at
          || content?.updated_at
          || content?.taken_at
          || item?.created_at
          || item?.updated_at
          || item?.timestamp
          || content?.raw_data?.taken_at
          || item?.raw_data?.taken_at;
        const isStory = contentType === 'story' || /instagram\.com\/stories\//i.test(contentUrl);
        const isReel = contentType === 'reel' || /instagram\.com\/(reel|reels)\//i.test(contentUrl);
        const isPost = contentType === 'post' || /instagram\.com\/p\//i.test(contentUrl);
        const isArchivedStory = isStory && /(amazonaws|s3|bhaskar-media-storage)/i.test(contentUrl);

        if (instagramContentFilter === 'stories_24h') {
          if (!isStory) return false;
          if (publishedAt) {
            const publishedTime = new Date(publishedAt).getTime();
            if (!Number.isNaN(publishedTime) && Date.now() - publishedTime > 24 * 60 * 60 * 1000) {
              return false;
            }
          }
          const isDeleted = content?.is_available === false || item?.is_available === false || content?.is_deleted === true;
          if (instagramStoriesStatusFilter === 'live') return !isDeleted;
          if (instagramStoriesStatusFilter === 'deleted') return isDeleted;
          return true;
        }

        if (instagramContentFilter === 'captured_stories') {
          if (!isArchivedStory) return false;
          if (!dateRange.start && !dateRange.end) return true;
          const publishedTime = publishedAt ? new Date(publishedAt).getTime() : null;
          if (!publishedTime || Number.isNaN(publishedTime)) return false;
          const startTime = toStartOfSelectedDay(dateRange.start);
          const endTime = toEndOfSelectedDay(dateRange.end);
          if (startTime && publishedTime < startTime) return false;
          if (endTime && publishedTime > endTime) return false;
          return true;
        }

        // all_posts_reels
        return isPost || isReel || (!isStory && !isArchivedStory);
      });
    };

    const parseDateTime = (value) => {
      if (!value) return 0;
      if (value instanceof Date) {
        const t = value.getTime();
        return Number.isNaN(t) ? 0 : t;
      }
      if (typeof value === 'number') return value;
      const str = String(value).trim();
      if (!str) return 0;
      const direct = new Date(str).getTime();
      if (!Number.isNaN(direct)) return direct;

      const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
      if (match) {
        let day = Number(match[1]);
        let month = Number(match[2]);
        let year = Number(match[3]);
        let hour = Number(match[4] || 0);
        const minute = Number(match[5] || 0);
        const second = Number(match[6] || 0);
        const meridiem = (match[7] || '').toUpperCase();
        if (year < 100) year += 2000;
        if (meridiem) {
          if (meridiem === 'PM' && hour < 12) hour += 12;
          if (meridiem === 'AM' && hour === 12) hour = 0;
        }
        const parsed = new Date(year, month - 1, day, hour, minute, second).getTime();
        return Number.isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    const getAlertTime = (item) => {
      const content = item?.content_details || item?.content_id || {};
      const published =
        content?.published_at ||
        content?.dateTime ||
        content?.created_at ||
        content?.timestamp;
      const fallback =
        item?.created_at ||
        item?.timestamp ||
        item?.updated_at;
      return parseDateTime(published || fallback);
    };

    const mapStoryToAlert = (story, index) => mapInstagramStoryToAlert(story, index);

    if (isStories24hView) {
      const now = Date.now();

      return recentStories
        .filter((story) => {
          const publishedTime = parseDateTime(
            story?.published_at
            || story?.created_at
            || story?.updated_at
            || story?.taken_at
            || story?.raw_data?.taken_at
            || story?.raw_data?.published_at
          );
          if (!publishedTime) return false;
          if (now - publishedTime > 24 * 60 * 60 * 1000) return false;

          const expiresAtTime = parseDateTime(story?.expires_at);
          const isDeleted = story?.is_available === false || Boolean(story?.deleted_at);
          const isExpired = expiresAtTime ? expiresAtTime <= now : false;

          if (instagramStoriesStatusFilter === 'live') return !isDeleted && !isExpired;
          if (instagramStoriesStatusFilter === 'deleted') return isDeleted;
          return true;
        })
        .map(mapStoryToAlert)
        .sort((a, b) => getAlertTime(b) - getAlertTime(a));
    }

    if (isCapturedStoriesView) {
      const startTime = toStartOfSelectedDay(dateRange.start);
      const endTime = toEndOfSelectedDay(dateRange.end);

      return capturedStories
        .filter((story) => {
          const hasS3Media = Boolean(story?.s3_url || story?.s3_thumbnail_url);
          if (!hasS3Media) return false;

          const storyTime = parseDateTime(
            story?.published_at
            || story?.created_at
            || story?.updated_at
            || story?.taken_at
            || story?.raw_data?.taken_at
            || story?.raw_data?.published_at
          );
          if ((startTime || endTime) && !storyTime) return false;
          if (startTime && storyTime < startTime) return false;
          if (endTime && storyTime > endTime) return false;
          return true;
        })
        .map(mapStoryToAlert)
        .sort((a, b) => getAlertTime(b) - getAlertTime(a));
    }

    return applyInstagramContentFilter([
      ...filteredInvestigated,
      ...filteredRegular
    ]);
  }, [alerts, investigatedAlerts, filterInvestigatedAlerts, platformFilter, instagramContentFilter, instagramStoriesStatusFilter, dateRange.start, dateRange.end, capturedStories, recentStories, isStories24hView, isCapturedStoriesView, toStartOfSelectedDay, toEndOfSelectedDay]);

  // Detect if search query is a URL
  const isUrlQuery = (query) => {
    const urlPattern = /^(https?:\/\/)?([\w-]+\.)?(twitter\.com|x\.com|t\.co|youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|whatsapp\.com|bit\.ly|tinyurl\.com)/i;
    return urlPattern.test(query.trim());
  };

  // Handle search input change with URL detection
  const handleSearchChange = (value) => {
    setSearchQuery(value);

    // If it looks like a URL and user presses Enter, we'll investigate
    // Otherwise, it's normal filtering
  };

  // Handle search submit (Enter key or button click)
  const handleSearchSubmit = (e) => {
    if (e) e.preventDefault();

    const query = searchQuery.trim();
    if (!query) return;

    // Check if it's a URL
    if (isUrlQuery(query)) {
      handleInvestigate(query);
    } else {
      // Trigger search — update debouncedSearchQuery to fire the fetch
      setDebouncedSearchQuery(query);
    }
  };

  const handleOpenAddSource = (data = null) => {
    setInitialSourceData(data);
    setSourceModalOpen(true);
  };

  const getRiskBadge = (level) => {
    const styles = {
      HIGH: 'bg-red-100 text-red-700 border-red-200',
      MEDIUM: 'bg-amber-100 text-amber-700 border-amber-200',
      high: 'bg-red-100 text-red-700 border-red-200',
      medium: 'bg-amber-100 text-amber-700 border-amber-200',
      critical: 'bg-red-100 text-red-700 border-red-200'
    };
    return styles[level] || 'bg-slate-100 text-slate-700 border-slate-200';
  };

  const getAlertTypeIcon = (type) => {
    switch (type) {
      case 'velocity':
        return <Zap className="h-4 w-4" />;
      case 'new_post':
        return <MessageSquare className="h-4 w-4" />;
      case 'ai_risk':
        return <Activity className="h-4 w-4" />;
      case 'content':
        return <LayoutList className="h-4 w-4" />;
      default:
        return <AlertTriangle className="h-4 w-4" />;
    }
  };

  const getAlertTypeLabel = (type) => {
    switch (type) {
      case 'velocity':
        return 'Velocity';
      case 'new_post':
        return 'New Post';
      case 'ai_risk':
        return 'AI Risk';
      case 'content':
        return 'Post';
      default:
        return 'Risk';
    }
  };

  return (
    <>
      <div className="space-y-6 max-w-[1600px] mx-auto" data-testid="alerts-page">
        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="flex flex-col">
            <h1 className="text-3xl font-heading font-bold tracking-tight">Alerts</h1>
            <p className="text-sm text-muted-foreground mt-1">Monitor profiles in our database and Report harmful content</p>
          </div>
          <div className="flex items-center gap-2">
            {hasFeatureAccess('/alerts', 'top_50_category') && (   
            <Button
              onClick={handleOpenTopAlerts}
              className="gap-2 shadow-sm h-9 px-3 text-xs bg-gradient-to-r from-red-600 to-orange-500 hover:from-red-700 hover:to-orange-600 text-white border-0"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Top 50 / Category · {topAlertsHours}h
            </Button>)}
             {hasFeatureAccess('/alerts', 'frequent_engagers') && (   
            <Button variant="outline" className="gap-2 shadow-sm h-9 px-3 text-xs relative" onClick={() => setFrequentEngagersOpen(true)}>
              <Users className="h-4 w-4" />
              Frequent Engagers
              {pendingAnalysisCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-yellow-500 text-white text-[9px] font-bold rounded-full h-4 min-w-[16px] flex items-center justify-center px-1 animate-pulse">{pendingAnalysisCount}</span>
              )}
            </Button>)}
            <Dialog open={profilesMatrixOpen} onOpenChange={setProfilesMatrixOpen}>
              <DialogTrigger asChild>
                  {hasFeatureAccess('/alerts', 'total_profiles') && (   
                <Button variant="outline" className="gap-2 shadow-sm h-9 px-3 text-xs" disabled={sourcesMetaLoading && !sourcesMetaLoaded}>
                  <LayoutGrid className="h-4 w-4" />
                  Total Profiles
                </Button>)}

              </DialogTrigger>
              <DialogContent className="w-[92vw] max-w-5xl max-h-[92vh] overflow-hidden p-0">
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <DialogHeader>
                    <DialogTitle>Profiles Being Monitored</DialogTitle>
                  </DialogHeader>
                  <p className="text-xs text-muted-foreground mt-1">
                    Total monitored profiles: <span className="font-semibold text-foreground">{monitoredProfilesMatrix.grandTotal.toLocaleString()}</span>
                  </p>
                </div>

                <div className="p-4 overflow-auto">
                  {sourcesMetaLoading && monitoredProfilesMatrix.rows.length === 0 ? (
                    <div className="text-xs text-muted-foreground">Loading monitored profiles...</div>
                  ) : monitoredProfilesMatrix.rows.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No monitored profiles found.</div>
                  ) : (
                    <div className="border border-border rounded-lg overflow-hidden bg-background">
                      <table className="w-full text-xs border-collapse">
                        <thead className="bg-slate-300/85 text-slate-900">
                          <tr>
                            <th className="text-left px-2.5 py-2 font-semibold sticky left-0 bg-slate-300/95 z-10 min-w-[150px] border-r border-b border-slate-500/60">Platform</th>
                            {SOURCE_CATEGORY_OPTIONS.map((option) => (
                              <th key={option.value} className="text-center px-2 py-2 font-semibold whitespace-nowrap border-r border-b border-slate-500/60">
                                {option.label}
                              </th>
                            ))}
                            <th className="text-center px-2 py-2 font-semibold bg-primary/20 border-b border-slate-500/60">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {monitoredProfilesMatrix.rows.map((row) => {
                            const theme = getPlatformTheme(row.platform);
                            return (
                            <tr key={row.platform} className={`border-b border-slate-500/50 ${theme.rowClass}`}>
                              <td className={`px-2.5 py-1.5 sticky left-0 z-10 border-r border-slate-500/55 ${theme.stickyClass}`}>
                                <div className="flex items-center gap-1.5 font-medium">
                                  {renderPlatformIcon(row.platform)}
                                  <span>{getPlatformLabel(row.platform)}</span>
                                </div>
                              </td>
                              {SOURCE_CATEGORY_OPTIONS.map((option) => (
                                <td key={`${row.platform}-${option.value}`} className="text-center px-2 py-1.5 tabular-nums border-r border-slate-500/45 text-slate-900 font-medium">
                                  {(row.counts[option.value] || 0).toLocaleString()}
                                </td>
                              ))}
                              <td className="text-center px-2 py-1.5 tabular-nums font-semibold bg-primary/20 text-slate-950">
                                {(row.counts.total || 0).toLocaleString()}
                              </td>
                            </tr>
                          )})}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-slate-600 bg-slate-300/90 font-semibold text-slate-900">
                            <td className="px-2.5 py-2 sticky left-0 z-10 bg-slate-300/95 border-r border-slate-500/60">All Platforms</td>
                            {SOURCE_CATEGORY_OPTIONS.map((option) => (
                              <td key={`total-${option.value}`} className="text-center px-2 py-2 tabular-nums border-r border-slate-500/60">
                                {(monitoredProfilesMatrix.totalsByCategory[option.value] || 0).toLocaleString()}
                              </td>
                            ))}
                            <td className="text-center px-2 py-2 tabular-nums bg-primary/30 text-slate-950">
                              {monitoredProfilesMatrix.grandTotal.toLocaleString()}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>
             {hasFeatureAccess('/alerts', 'add_profile') && (      
            <Button
              onClick={() => {
                setInitialSourceData(null);
                setSourceModalOpen(true);
              }}
              className="gap-2 shadow-sm"
            >
              <Plus className="h-4 w-4" />
              Add Profile
            </Button>)}
          </div>
        </div>

        {activeTab !== 'reports' && (
          <>
            {/* Search & Filters Row */}
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              {/* Unified Search Input */}
              <form onSubmit={handleSearchSubmit} className="relative w-full md:flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search alerts or paste URL to Escalate..."
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pl-9 pr-28"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  disabled={isInvestigating}
                />
                {isInvestigating && (
                  <div className="absolute right-2 top-1.5 flex items-center gap-2 px-3 py-1 bg-muted rounded-md text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Escalating...</span>
                  </div>
                )}
                {searchQuery && !isInvestigating && isUrlQuery(searchQuery) && (
                  <button
                    type="submit"
                    className="absolute right-2 top-1 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 shadow-sm flex items-center gap-1 transition-colors"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Escalate
                  </button>
                )}
                {searchQuery.trim() && !isInvestigating && !isUrlQuery(searchQuery) && (
                  <div className="absolute right-2 top-1 flex items-center gap-1">
                    {debouncedSearchQuery && (
                      <button
                        type="button"
                        onClick={() => { setSearchQuery(''); setDebouncedSearchQuery(''); }}
                        className="px-1.5 py-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"
                        title="Clear search"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={searchQuery.trim() === debouncedSearchQuery}
                      className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 shadow-sm flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-default"
                    >
                      <Search className="h-3 w-3" />
                      Search
                    </button>
                  </div>
                )}
              </form>

              {/* Compact Filter Controls */}
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={platformFilter} onValueChange={setPlatformFilter}>
                  <SelectTrigger className="w-[130px] h-9 text-xs">
                    <SelectValue placeholder="Platform" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Platforms</SelectItem>
                    <SelectItem value="x">Twitter (X)</SelectItem>
                    <SelectItem value="youtube">YouTube</SelectItem>
                    <SelectItem value="facebook">Facebook</SelectItem>
                    <SelectItem value="instagram">Instagram</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={sourceCategoryFilter} onValueChange={setSourceCategoryFilter}>
                  <SelectTrigger className="w-[140px] h-9 text-xs">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {SOURCE_CATEGORY_OPTIONS.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value} className="capitalize">
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={keywordFilter} onValueChange={setKeywordFilter}>
                  <SelectTrigger className="w-[130px] h-9 text-xs">
                    <SelectValue placeholder="Keyword" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Keywords</SelectItem>
                    {availableKeywords.map((kw) => (
                      <SelectItem key={kw} value={kw}>{kw}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="h-8 px-1.5 border border-input rounded-md bg-background flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openDatePicker(mainStartDateInputRef)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openDatePicker(mainStartDateInputRef);
                      }
                    }}
                    className="h-7 px-1.5 rounded-sm border border-transparent hover:border-input/70 focus-visible:border-input/70 flex items-center gap-1 cursor-pointer"
                  >
                    <span className="text-[10px] text-muted-foreground">From</span>
                    <input
                      ref={mainStartDateInputRef}
                      type="date"
                      value={normalizeDateInputValue(dateRange.start)}
                      onChange={(e) => handleDateRangeChange('start', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 w-[102px] bg-transparent text-[11px] outline-none cursor-pointer"
                    />
                  </div>
                  <span className="text-muted-foreground text-[11px]">→</span>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openDatePicker(mainEndDateInputRef)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openDatePicker(mainEndDateInputRef);
                      }
                    }}
                    className="h-7 px-1.5 rounded-sm border border-transparent hover:border-input/70 focus-visible:border-input/70 flex items-center gap-1 cursor-pointer"
                  >
                    <span className="text-[10px] text-muted-foreground">To</span>
                    <input
                      ref={mainEndDateInputRef}
                      type="date"
                      value={normalizeDateInputValue(dateRange.end)}
                      onChange={(e) => handleDateRangeChange('end', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 w-[102px] bg-transparent text-[11px] outline-none cursor-pointer"
                    />
                  </div>
                  {(dateRange.start || dateRange.end) && (
                    <button
                      type="button"
                      onClick={() => setDateRange({ start: '', end: '' })}
                      className="text-[10px] text-primary hover:text-primary/80 font-medium ml-1"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {/* Refreshing indicator moved to content overlay */}
            </div>
          </>
        )}

        {/* Drill-down banner.
            A keyword or intent arriving by URL narrows the list with no visible
            control — the intent filter has no dropdown at all — so an officer
            could otherwise read these as ALL the alerts. Say what is filtered
            and give one click back to the full list. */}
        {(intentFilter || keywordFilter !== 'all') && (
          <div className="flex items-center justify-between gap-3 flex-wrap rounded-md border border-primary/25 bg-primary/5 px-3 py-2">
            <span className="text-[12px] text-foreground min-w-0">
              Showing only alerts
              {intentFilter && <> classified <span className="font-semibold">“{intentFilter}”</span></>}
              {intentFilter && keywordFilter !== 'all' && ' and'}
              {keywordFilter !== 'all' && <> matching keyword <span className="font-semibold">“{keywordFilter}”</span></>}
            </span>
            <button
              type="button"
              onClick={() => {
                setIntentFilter(null);
                setKeywordFilter('all');
                // Drop the params too, or a refresh / back-button silently
                // reapplies the filter that was just dismissed.
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete('intent');
                  next.delete('keyword');
                  return next;
                }, { replace: true });
              }}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium hover:bg-accent transition"
            >
              <X className="h-3 w-3" />
              Clear filter · view all alerts
            </button>
          </div>
        )}

        {/* Status & Category Filter Bar */}
        <div className="border border-border bg-card rounded-md p-3 space-y-2.5">
          {/* Status Tabs */}
          <div className="w-full overflow-x-auto no-scrollbar">
            <div className="flex items-center gap-1 min-w-max">
              {visibleStatusTabs.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  data-testid={`tab-${tab.value}`}
                  className={`relative px-3 py-1.5 text-sm font-medium transition-all rounded-md ${activeTab === tab.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                >
                  <span className="flex items-center gap-1.5">
                    {tab.label}
                    {tab.value === 'escalated' && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${activeTab === tab.value ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-destructive/10 text-destructive'}`}>
                        {alertStats?.escalated_pending_report || 0}
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {!hasAnyAlertFeature && (
                <span className="px-3 py-1.5 text-sm text-muted-foreground">
                  No alert features are assigned to your account.
                </span>
              )}
            </div>
          </div>

          {activeTab !== 'reports' && (
            <>
              {/* Divider */}
              <div className="border-t border-border/50" />

              {/* Category Quick Filters */}
              <div className="flex items-center gap-1.5 text-sm overflow-x-auto no-scrollbar">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'high', label: 'High Risk' },
                  { value: 'medium', label: 'Medium Risk' },
                  { value: 'low', label: 'Low Risk' },
                  { value: 'viral', label: 'Viral' }
                ].map((cat) => (
                  <button
                    key={cat.value}
                    onClick={() => setAlertCategory(cat.value)}
                    className={`px-3 py-1 font-medium transition-all rounded-full text-xs ${alertCategory === cat.value
                      ? 'bg-secondary text-secondary-foreground shadow-sm border border-border'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {platformFilter === 'instagram' && (
            <div className="flex items-center gap-1.5 text-sm overflow-x-auto no-scrollbar pt-1">
              {[
                { value: 'all_posts_reels', label: 'All Posts & Reels' },
                { value: 'stories_24h', label: 'Stories (Last 24 hrs)' },
                { value: 'captured_stories', label: 'Captured Stories' }
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setInstagramContentFilter(opt.value)}
                  className={`px-3 py-1 font-medium transition-all rounded-full text-xs ${instagramContentFilter === opt.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                >
                  {opt.label}
                </button>
              ))}
              {instagramContentFilter === 'stories_24h' && (
                <div className="ml-2">
                  <Select value={instagramStoriesStatusFilter} onValueChange={setInstagramStoriesStatusFilter}>
                    <SelectTrigger className="h-8 w-[150px] text-xs">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="live">Live</SelectItem>
                      <SelectItem value="deleted">Deleted</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {instagramContentFilter === 'captured_stories' && (
                <div className="ml-2">
                  <div className="h-8 px-1.5 border border-input rounded-md bg-background flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => openDatePicker(igStartDateInputRef)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openDatePicker(igStartDateInputRef);
                        }
                      }}
                      className="h-7 px-1 rounded-sm border border-transparent hover:border-input/70 focus-visible:border-input/70 flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[10px] text-muted-foreground">From</span>
                      <input
                        ref={igStartDateInputRef}
                        type="date"
                        value={normalizeDateInputValue(dateRange.start)}
                        onChange={(e) => handleDateRangeChange('start', e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-6 w-[96px] bg-transparent text-[11px] outline-none cursor-pointer"
                      />
                    </div>
                    <span className="text-muted-foreground text-[11px]">→</span>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => openDatePicker(igEndDateInputRef)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openDatePicker(igEndDateInputRef);
                        }
                      }}
                      className="h-7 px-1 rounded-sm border border-transparent hover:border-input/70 focus-visible:border-input/70 flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[10px] text-muted-foreground">To</span>
                      <input
                        ref={igEndDateInputRef}
                        type="date"
                        value={normalizeDateInputValue(dateRange.end)}
                        onChange={(e) => handleDateRangeChange('end', e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-6 w-[96px] bg-transparent text-[11px] outline-none cursor-pointer"
                      />
                    </div>
                    {(dateRange.start || dateRange.end) && (
                      <button
                        type="button"
                        onClick={() => setDateRange({ start: '', end: '' })}
                        className="text-[11px] text-primary hover:text-primary/80 font-medium ml-1"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
              )}
            </>
          )}
        </div>

        {activeTab !== 'reports' && (
          <div className="px-1 text-xs text-muted-foreground">
            {(() => {
              const activeTabLabel = visibleStatusTabs.find((t) => t.value === activeTab)?.label || activeTab;
              const contextLabel = isCapturedStoriesView
                ? 'Captured Stories'
                : (isStories24hView ? 'Stories (Last 24 hrs)' : `${activeTabLabel} tab`);
              const activeKeyword = (debouncedSearchQuery && !isUrlQuery(debouncedSearchQuery))
                ? String(debouncedSearchQuery).trim()
                : '';
              const searchScopedCount = debouncedSearchQuery && !isUrlQuery(debouncedSearchQuery) && typeof totalResults === 'number'
                ? totalResults
                : null;

              // Story views are sourced from dedicated story APIs, so use the filtered set length directly.
              const totalCount = isInstagramStoryView
                ? allFilteredAlerts.length
                : (Number(typeof searchScopedCount === 'number' ? searchScopedCount : (alertStats?.[activeTab] || 0)) || 0);
              const visibleCount = isInstagramStoryView
                ? allFilteredAlerts.length
                : Math.min(allFilteredAlerts.length, totalCount);

              return (
                <>
                  Showing <strong className="text-foreground">{visibleCount.toLocaleString()}</strong> of <strong className="text-foreground">{totalCount.toLocaleString()}</strong> alerts in <strong className="text-foreground">{contextLabel}</strong>{activeKeyword ? <> matching <strong className="text-foreground">"{activeKeyword}"</strong></> : null}
                </>
              );
            })()}
          </div>
        )}

        {/* Main Content Area */}
        <div>
          {activeTab === 'reports' ? (
            <ReportsContent
              platformFilter={platformFilter}
              dateRange={dateRange}
              searchQuery={debouncedSearchQuery}
              keywordFilter={keywordFilter}
              viewHandle={searchParams.get('handle')}
              onClearHandle={clearHandleParam}
            />
          ) : (
            <>
              {/* New Alerts Floating Bubble */}
              {newAlertCount > 0 && (
                <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  <button
                    onClick={scrollToTop}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-full shadow-xl shadow-primary/25 hover:shadow-primary/40 hover:scale-105 active:scale-95 transition-all duration-200 flex items-center gap-2 pl-4 pr-5 py-3"
                  >
                    <ArrowUpCircle className="h-5 w-5" />
                    <span className="text-sm font-semibold whitespace-nowrap">
                      {newAlertCount} New Alert{newAlertCount !== 1 ? 's' : ''}
                    </span>
                  </button>
                </div>
              )}

              {/* View Toggle Commented Out
              <div className="flex justify-end mb-4">
                <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-md transition-all ${viewMode === 'grid'
                      ? 'bg-white dark:bg-slate-600 shadow-sm text-blue-600 dark:text-blue-400'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    title="Grid View"
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded-md transition-all ${viewMode === 'list'
                      ? 'bg-white dark:bg-slate-600 shadow-sm text-blue-600 dark:text-blue-400'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                    title="List View"
                  >
                    <LayoutList className="h-4 w-4" />
                  </button>
                </div>
              </div>
              */}

              {error && (
                <div className="mb-4 text-xs text-destructive">{error}</div>
              )}

              {(() => {

                if (isInstagramStoryView && isStoryViewLoading) {
                  return (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>{isCapturedStoriesView ? 'Loading captured stories...' : 'Loading stories from last 24 hours...'}</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
                        {[...Array(6)].map((_, i) => (
                          <div key={i}>
                            <Card className="p-4 space-y-3 border border-border rounded-md animate-pulse">
                              <div className="flex items-center justify-between">
                                <Skeleton className="h-5 w-16 rounded-full" />
                                <Skeleton className="h-5 w-20 rounded-md" />
                              </div>
                              <div className="flex items-center gap-2.5">
                                <Skeleton className="h-9 w-9 rounded-full" />
                                <div className="space-y-1.5 flex-1">
                                  <Skeleton className="h-4 w-24" />
                                  <Skeleton className="h-3 w-16" />
                                </div>
                              </div>
                              <Skeleton className="h-16 w-full rounded-md" />
                              <Skeleton className="h-32 w-full rounded-md" />
                            </Card>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }

                if (isFirstLoadRef.current && allFilteredAlerts.length === 0 && (loading || capturedStoriesLoading || recentStoriesLoading)) {
                  return (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full">
                      {[...Array(6)].map((_, i) => (
                        <div key={i} className="">
                          <Card className="p-4 space-y-3 border border-border rounded-md animate-pulse">
                            <div className="flex items-center justify-between">
                              <Skeleton className="h-5 w-16 rounded-full" />
                              <Skeleton className="h-5 w-20 rounded-md" />
                            </div>
                            <div className="flex items-center gap-2.5">
                              <Skeleton className="h-9 w-9 rounded-full" />
                              <div className="space-y-1.5 flex-1">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-3 w-16" />
                              </div>
                            </div>
                            <Skeleton className="h-16 w-full rounded-md" />
                            <Skeleton className="h-32 w-full rounded-md" />
                            <div className="flex justify-between">
                              <Skeleton className="h-3 w-24" />
                              <Skeleton className="h-3 w-16" />
                            </div>
                          </Card>
                        </div>
                      ))}
                    </div>
                  );
                }

                if (!loading && !capturedStoriesLoading && !recentStoriesLoading && !isFetchingRef.current && allFilteredAlerts.length === 0) {
                  return (
                    <Card className="p-12 text-center border border-border rounded-md" data-testid="no-alerts">
                      <AlertTriangle className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
                      <p className="text-sm text-muted-foreground mb-2">No alerts found matching your criteria.</p>
                      <Button
                        variant="link"
                        className="text-xs"
                        onClick={() => {
                          setSearchQuery('');
                          setPlatformFilter('all');
                          setKeywordFilter('all');
                          setAlertCategory('all');
                          setSourceCategoryFilter('all');
                        }}
                      >
                        Clear All Filters
                      </Button>
                    </Card>
                  );
                }

                return (
                  <div className="relative">
                    {isRefreshing && !isFirstLoadRef.current && (
                      <div className="absolute inset-0 z-20 flex items-start justify-center pt-32 bg-background/60 backdrop-blur-[1px] rounded-md">
                        <div className="flex flex-col items-center gap-2">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          <span className="text-xs font-medium text-muted-foreground">Loading alerts…</span>
                        </div>
                      </div>
                    )}
                  <div className="flex flex-col lg:flex-row gap-8 items-start">
                    <div className="flex-1 min-w-0">
                      {/* 3-column layout with left-to-right distribution for correct date order */}
                      <div className="flex gap-6 w-full items-start">
                        {(() => {
                          const colCount = typeof window !== 'undefined' && window.innerWidth < 768 ? 1 : window.innerWidth < 1024 ? 2 : 3;
                          const cols = Array.from({ length: colCount }, () => []);
                          allFilteredAlerts.forEach((alert, i) => {
                            cols[i % colCount].push({ alert, index: i });
                          });

                          return cols.map((colItems, colIndex) => (
                            <div key={colIndex} className="flex-1 min-w-0 flex flex-col gap-6" style={{ contain: 'layout style' }}>
                              {colItems.map(({ alert, index }) => {
                                const isYoutube = alert?.platform === 'youtube';
                                const isStoryArchiveCard = Boolean(alert?.is_story_archive);

                                const contentData =
                                  alert?.content_details ||
                                  ((alert?.content_id && typeof alert.content_id === 'object') ? alert.content_id : null) ||
                                  {};

                                const sourceData =
                                  alert?.source_meta ||
                                  alert?.source_details ||
                                  alert?.source ||
                                  (alert?.author ? { name: alert.author } : null);

                                return (
                                  <div
                                    key={alert?.id || index}
                                    className="group relative flex flex-col will-change-transform"
                                    style={{ contentVisibility: 'auto', containIntrinsicSize: '0 400px' }}
                                    data-testid={`alert-item-${index}`}
                                  >
                                    {isYoutube ? (
                                      <YoutubeAlertCard
                                        alert={alert}
                                        content={contentData}
                                        source={sourceData}
                                        onResolve={handleAlertResolve}
                                        viewMode="grid"
                                        hideActions={isStoryArchiveCard}
                                        searchQuery={debouncedSearchQuery}
                                        report={reportsMap[alert?.id]}
                                        onAddSource={handleOpenAddSource}
                                        isInvestigatedResult={alert?.is_investigation}
                                      />
                                    ) : (
                                      <TwitterAlertCard
                                        alert={alert}
                                        content={contentData}
                                        source={sourceData}
                                        onResolve={handleAlertResolve}
                                        viewMode="grid"
                                        hideActions={isStoryArchiveCard}
                                        searchQuery={debouncedSearchQuery}
                                        monitoredHandles={monitoredHandles}
                                        report={reportsMap[alert?.id]}
                                        onAddSource={handleOpenAddSource}
                                        isInvestigatedResult={alert?.is_investigation}
                                        onTriggerEngagerAnalysis={() => setPendingAnalysisCount(c => c + 1)}
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ));
                        })()}
                      </div>

                      {/* Load More Sentinel */}
                      {!isCapturedStoriesView && !isStories24hView && hasMore && (
                        <div ref={observerTarget} className="py-6 flex justify-center w-full">
                          {!loading && !isFetchingMore && <span className="text-muted-foreground text-xs">Scroll to load more...</span>}
                          {isFetchingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        </div>
                      )}
                      {!isCapturedStoriesView && !isStories24hView && !hasMore && allFilteredAlerts.length > 0 && (
                        <div className="py-6 text-center text-muted-foreground text-xs w-full">
                          All alerts loaded.
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>

      <AddSourceModal
        open={sourceModalOpen}
        onClose={() => setSourceModalOpen(false)}
        initialData={initialSourceData}
        onSuccess={async (createdSource) => {
          toast.success('Monitoring started for this profile');

          const newHandle = createdSource?.identifier || initialSourceData?.identifier;
          if (newHandle) {
            setMonitoredHandles(prev => [...prev, newHandle]);
          }

          if (createdSource?.platform && createdSource?.identifier) {
            setMonitoredSources((prev) => {
              const alreadyExists = prev.some((source) => {
                if (createdSource.id && source.id) {
                  return source.id === createdSource.id;
                }
                return source.platform === createdSource.platform && source.identifier === createdSource.identifier;
              });
              if (alreadyExists) return prev;
              return [...prev, createdSource];
            });
          }

          // Update all alerts from this profile to mark as monitored (both investigated and regular)
          if (initialSourceData || createdSource) {
            const platform = createdSource?.platform || initialSourceData?.platform;
            const identifier = createdSource?.identifier || initialSourceData?.identifier;
            const displayName = createdSource?.display_name || initialSourceData?.display_name;

            const updateMonitoredStatus = (alert) => {
              const matchesPlatform = alert.platform === platform;
              const matchesIdentifier = alert.author_handle === identifier;
              const matchesDisplayName = alert.author === displayName;

              return (matchesPlatform && matchesIdentifier) || (matchesPlatform && matchesDisplayName)
                ? { ...alert, is_monitored: true, source_id: createdSource?.id || null }
                : alert;
            };

            setInvestigatedAlerts(prev => prev.map(updateMonitoredStatus));
            setAlerts(prev => prev.map(updateMonitoredStatus));

            // Update backend alerts to link them to the source
            try {
              const alertsToUpdate = [...investigatedAlerts, ...alerts].filter(alert => {
                const matchesPlatform = alert.platform === platform;
                const matchesIdentifier = alert.author_handle === identifier;
                const matchesDisplayName = alert.author === displayName;
                return (matchesPlatform && matchesIdentifier) || (matchesPlatform && matchesDisplayName);
              });

              // Update each alert with source_id
              for (const alert of alertsToUpdate) {
                try {
                  api.put(`/alerts/${alert.id}`, { source_id: createdSource?.id || null }).catch(err => {
                    console.error(`Failed to link alert ${alert.id} to source:`, err);
                  });
                } catch (error) {
                  console.error(`Failed to link alert ${alert.id} to source:`, error);
                }
              }
            } catch (error) {
              console.error('Failed to update alerts with source_id:', error);
            }
          }

          await fetchSourcesMetadata();
        }}

      />

      <FrequentEngagersDialog
        open={frequentEngagersOpen}
        onOpenChange={setFrequentEngagersOpen}
        onAddSource={handleOpenAddSource}
        monitoredHandles={monitoredHandles}
      />

      {/* ── AI Top Alerts — Full Screen Page ────────────────────────────── */}
      {topAlertsOpen && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col overflow-hidden">

          {/* ── Top bar ── */}
          <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-border bg-gradient-to-r from-red-600 to-orange-500 text-white shadow-md">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <div>
                <h1 className="font-bold text-base leading-tight">AI-Ranked Top Alerts · Per Category</h1>
                <p className="text-[11px] text-red-100">
                  {topAlertsLoading
                    ? 'Ollama is scanning & ranking each category…'
                    : topAlertsData
                      ? `${topAlertsData.top_n} alerts · up to ${topAlertsData.top_n_per_category || 50}/category · from ${topAlertsData.total_unique} unique · last ${topAlertsData.hours}h · ${topAlertsData.date || ''}`
                      : 'Ready'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Time window */}
              <div className="flex gap-1">
                {[24, 48, 72].map(h => (
                  <button key={h}
                    onClick={() => { setTopAlertsHours(h); setTopAlertsData(null); setTopAlertsCatFilter('all'); fetchTopAlerts(h, true); }}
                    className={`px-3 py-1 rounded text-xs font-medium border ${topAlertsHours === h
                      ? 'bg-white text-red-600 border-white'
                      : 'border-white/40 text-white hover:bg-white/20'}`}
                  >{h}h</button>
                ))}
              </div>
              <button
                onClick={() => { setTopAlertsData(null); setTopAlertsCatFilter('all'); fetchTopAlerts(topAlertsHours, true); }}
                disabled={topAlertsLoading}
                className="px-3 py-1 rounded text-xs border border-white/40 text-white hover:bg-white/20 disabled:opacity-50 flex items-center gap-1"
              >
                {topAlertsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻'} Refresh
              </button>
              <button onClick={() => { setTopAlertsOpen(false); setTopAlertsCatFilter('all'); }}
                className="p-1.5 rounded hover:bg-white/20">
                <X className="w-5 h-5 text-white" />
              </button>
            </div>
          </div>

          {/* ── Loading ── */}
          {topAlertsLoading && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <Loader2 className="w-10 h-10 animate-spin text-red-500" />
              <div className="text-center">
                <p className="font-semibold text-slate-700 dark:text-slate-200 text-lg">Analysing alerts with AI…</p>
                <p className="text-sm text-slate-500 mt-1">Scanning last {topAlertsHours}h · ranking top 50 in each category (this can take a few minutes)</p>
              </div>
            </div>
          )}

          {/* ── Error ── */}
          {!topAlertsLoading && topAlertsError && (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-6 max-w-lg text-center">
                <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                <p className="font-medium text-red-700 dark:text-red-300">{topAlertsError}</p>
                <p className="text-xs text-red-500 mt-1">Is the RAG server running on port 8100?</p>
              </div>
            </div>
          )}

          {/* ── Content ── */}
          {!topAlertsLoading && !topAlertsError && topAlertsData && (() => {
            // Build category counts + per-category rank map from full list
            const catCounts = {};
            const rankInCategory = new Map();
            topAlertsData.alerts.forEach((a) => {
              const c = a.source_category || 'unknown';
              catCounts[c] = (catCounts[c] || 0) + 1;
              rankInCategory.set(a.id, catCounts[c]);
            });
            const filtered = topAlertsCatFilter === 'all'
              ? topAlertsData.alerts
              : topAlertsData.alerts.filter(a => (a.source_category || 'unknown') === topAlertsCatFilter);

            return (
              <div className="flex flex-col flex-1 overflow-hidden">
                {/* Category filter bar */}
                <div className="flex-shrink-0 flex items-center gap-2 px-6 py-2.5 border-b border-border bg-muted/30 overflow-x-auto">
                  <span className="text-xs text-muted-foreground font-medium flex-shrink-0">Filter:</span>
                  <button
                    onClick={() => setTopAlertsCatFilter('all')}
                    className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      topAlertsCatFilter === 'all'
                        ? 'bg-slate-800 text-white border-slate-800 dark:bg-white dark:text-slate-900 dark:border-white'
                        : 'border-border hover:bg-muted'}`}
                  >
                    All ({topAlertsData.alerts.length})
                  </button>
                  {Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([cat, cnt]) => {
                    const active = topAlertsCatFilter === cat;
                    const colorMap = {
                      communal: 'bg-red-600 border-red-600 text-white',
                      political: 'bg-blue-600 border-blue-600 text-white',
                      defamation: 'bg-amber-600 border-amber-600 text-white',
                      narcotics: 'bg-purple-600 border-purple-600 text-white',
                      history_sheeters: 'bg-rose-600 border-rose-600 text-white',
                      trouble_makers: 'bg-orange-600 border-orange-600 text-white',
                    };
                    return (
                      <button key={cat}
                        onClick={() => setTopAlertsCatFilter(active ? 'all' : cat)}
                        className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                          active ? (colorMap[cat] || 'bg-slate-600 border-slate-600 text-white')
                                 : 'border-border hover:bg-muted'}`}
                      >
                        {cat.replace(/_/g, ' ')} ({cnt})
                      </button>
                    );
                  })}
                </div>

                {/* Alert grid */}
                <div className="flex-1 overflow-y-auto p-6">
                  {filtered.length === 0 ? (
                    <div className="text-center py-20 text-muted-foreground">
                      <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p>No alerts in this category.</p>
                    </div>
                  ) : (
                    <div className="flex gap-5 w-full items-start">
                      {(() => {
                        const colCount = window.innerWidth < 768 ? 1 : window.innerWidth < 1200 ? 2 : 3;
                        const cols = Array.from({ length: colCount }, () => []);
                        filtered.forEach((alert, i) => {
                          const rank = rankInCategory.get(alert.id) || (i + 1);
                          cols[i % colCount].push({ alert, rank });
                        });
                        return cols.map((colItems, ci) => (
                          <div key={ci} className="flex-1 min-w-0 flex flex-col gap-5">
                            {colItems.map(({ alert, rank }) => {
                              const isYoutube = alert?.platform === 'youtube';
                              const contentData = alert?.content_details || (alert?.content_id && typeof alert.content_id === 'object' ? alert.content_id : null) || {};
                              const sourceData = alert?.source_meta || alert?.source_details || alert?.source || (alert?.author ? { name: alert.author } : null);
                              return (
                                <div key={alert.id} className="relative">
                                  <span className="absolute -top-2.5 -left-2.5 z-10 w-7 h-7 rounded-full bg-gradient-to-br from-red-600 to-orange-500 text-white text-[11px] font-bold flex items-center justify-center shadow-md ring-2 ring-background">
                                    #{rank}
                                  </span>
                                  {isYoutube ? (
                                    <YoutubeAlertCard alert={alert} content={contentData} source={sourceData}
                                      onResolve={handleTopAlertResolve} viewMode="grid"
                                      monitoredHandles={monitoredHandles} onAddSource={handleOpenAddSource} />
                                  ) : (
                                    <TwitterAlertCard alert={alert} content={contentData} source={sourceData}
                                      onResolve={handleTopAlertResolve} viewMode="grid"
                                      monitoredHandles={monitoredHandles} onAddSource={handleOpenAddSource}
                                      onTriggerEngagerAnalysis={() => setPendingAnalysisCount(c => c + 1)} />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {!topAlertsLoading && !topAlertsError && topAlertsData?.alerts?.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No alerts found in the last {topAlertsData?.hours}h.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
