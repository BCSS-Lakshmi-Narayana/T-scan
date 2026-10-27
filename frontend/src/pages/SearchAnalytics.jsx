import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import { toast } from 'sonner';
import { TrendingUp, RefreshCw, AlertCircle, Info } from 'lucide-react';
import { Card } from '../components/ui/card';
import SearchControls from '../components/searchAnalytics/SearchControls';
import InterestOverTimeChart from '../components/searchAnalytics/InterestOverTimeChart';
import TopRegionsCard from '../components/searchAnalytics/TopRegionsCard';
import RelatedSearchesCard from '../components/searchAnalytics/RelatedSearchesCard';
import TrendingScoreCard from '../components/searchAnalytics/TrendingScoreCard';

const RECENT_STORAGE_KEY = 'bsk:searchAnalytics:recent';
const PREFS_STORAGE_KEY = 'bsk:searchAnalytics:prefs';
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const FILTER_DEBOUNCE_MS = 800;
const MAX_RECENT = 10;
const DEFAULT_QUERY = 'Bandi Sanjay';

const loadJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const SearchAnalytics = () => {
  const initialPrefs = useMemo(() => loadJson(PREFS_STORAGE_KEY, {}), []);

  const [query, setQuery] = useState(initialPrefs.query || DEFAULT_QUERY);
  const [country, setCountry] = useState(initialPrefs.country || 'IN');
  const [range, setRange] = useState(initialPrefs.range || '7');
  const [autoRefresh, setAutoRefresh] = useState(Boolean(initialPrefs.autoRefresh));
  const [recent, setRecent] = useState(() => loadJson(RECENT_STORAGE_KEY, []));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState(null);

  const intervalRef = useRef(null);
  const filterDebounceRef = useRef(null);
  const pollRef = useRef(null);
  const silentRef = useRef(false);
  const activeQueryRef = useRef('');

  useEffect(() => {
    try {
      localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({ query, country, range, autoRefresh })
      );
    } catch {
      /* ignore quota errors */
    }
  }, [query, country, range, autoRefresh]);

  const pushRecent = useCallback((kw) => {
    setRecent((prev) => {
      const cleaned = [kw, ...prev.filter((item) => item.toLowerCase() !== kw.toLowerCase())].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(cleaned));
      } catch {
        /* ignore */
      }
      return cleaned;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    try {
      localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // Cancel any in-flight poll on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const fetchTrends = useCallback(
    async (kwOverride, { silent = false } = {}) => {
      const kw = (kwOverride ?? query).trim();
      if (!kw) return;

      stopPolling();
      activeQueryRef.current = kw;
      silentRef.current = silent;
      if (!silent) setLoading(true);
      setError(null);

      // ── inline poll helper (captures kw and silent via closure) ──────────
      const pollStatus = (jobId, attempt = 0) => {
        const MAX_ATTEMPTS = 36; // 36 × 2.5 s = 90 s max
        if (attempt >= MAX_ATTEMPTS) {
          if (activeQueryRef.current !== kw) return;
          setError('Timed out waiting for Google Trends data. Please try again.');
          setLoading(false);
          setIsPolling(false);
          return;
        }
        pollRef.current = setTimeout(async () => {
          if (activeQueryRef.current !== kw) return;
          try {
            const statusRes = await api.get(`/search-trends/status/${encodeURIComponent(jobId)}`);
            if (activeQueryRef.current !== kw) return;
            const { status, data: jobData, error: jobError } = statusRes.data || {};

            if (status === 'completed') {
              setIsPolling(false);
              if (jobData?.success === false) {
                const msg = jobData.message || 'Trends request failed';
                setError(msg);
                if (!silentRef.current) toast.error(msg);
              } else {
                setData(jobData);
                pushRecent(kw);
                if (!silentRef.current) toast.success(`Loaded trends for "${kw}"`);
              }
              setLoading(false);
              return;
            }

            if (status === 'failed') {
              setIsPolling(false);
              const msg = jobError || 'Google Trends fetch failed. Please try again in ~30 seconds.';
              setError(msg);
              if (!silentRef.current) toast.error(msg);
              setLoading(false);
              return;
            }

            // still processing — schedule next poll
            pollStatus(jobId, attempt + 1);
          } catch (pollErr) {
            if (activeQueryRef.current !== kw) return;
            const msg = pollErr?.response?.data?.message || pollErr?.message || 'Failed to check trends status';
            setError(msg);
            setLoading(false);
            setIsPolling(false);
          }
        }, 2500);
      };
      // ─────────────────────────────────────────────────────────────────────

      let handedOff = false;
      try {
        const res = await api.get('/search-trends', {
          params: { q: kw, country, range }
        });

        if (activeQueryRef.current !== kw) return;

        // Backend queued the job — switch to polling mode
        if (res.data?.status === 'queued' && res.data?.jobId) {
          handedOff = true;
          setIsPolling(true);
          pollStatus(res.data.jobId);
          return;
        }

        // Immediate result (cache HIT or sync fallback)
        if (res.data?.success === false) {
          throw new Error(res.data?.message || 'Trends request failed');
        }
        setData(res.data);
        pushRecent(kw);
        if (!silent) toast.success(`Loaded trends for "${kw}"`);
      } catch (err) {
        if (activeQueryRef.current !== kw) return;
        const message =
          err?.response?.data?.message ||
          err?.message ||
          'Failed to load search trends';
        setError(message);
        if (!silent) toast.error(message);
      } finally {
        // Only clear loading here when we did NOT hand off to the poller.
        // The poller manages setLoading(false) on its own.
        if (!handedOff && !silent) setLoading(false);
      }
    },
    [country, pushRecent, query, range, stopPolling]
  );

  const handleSubmit = useCallback(() => {
    fetchTrends();
  }, [fetchTrends]);

  const didInitialFetchRef = useRef(false);
  useEffect(() => {
    if (didInitialFetchRef.current) return;
    didInitialFetchRef.current = true;
    const initial = (initialPrefs.query || DEFAULT_QUERY).trim();
    if (initial) {
      fetchTrends(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when filters change after first successful query — debounced so
  // rapidly switching multiple filters only triggers one network call.
  useEffect(() => {
    if (!data?.query) return;
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      fetchTrends(data.query, { silent: true });
    }, FILTER_DEBOUNCE_MS);
    return () => {
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, range]);

  // Auto-refresh every 5 min
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoRefresh && data?.query) {
      intervalRef.current = setInterval(() => {
        fetchTrends(data.query, { silent: true });
      }, AUTO_REFRESH_MS);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, data?.query, fetchTrends]);

  return (
    <div className="space-y-6" data-testid="search-analytics-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-heading font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-7 w-7 text-orange-500" />
            Search Analytics
          </h1>
          <p className="text-muted-foreground mt-1">
            Explore real-time Google Trends search interest for keywords, incidents and campaigns.
          </p>
        </div>
        {data?.lastUpdated && (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5 mt-2">
            <RefreshCw className={`h-3 w-3 ${autoRefresh ? 'animate-spin-slow' : ''}`} />
            Last updated {new Date(data.lastUpdated).toLocaleString()}
            {data.stale && (
              <span className="ml-2 text-[10px] uppercase tracking-wider bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded">
                Cached (rate-limited)
              </span>
            )}
          </div>
        )}
      </div>

      <SearchControls
        query={query}
        setQuery={setQuery}
        country={country}
        setCountry={setCountry}
        range={range}
        setRange={setRange}
        autoRefresh={autoRefresh}
        setAutoRefresh={setAutoRefresh}
        onSubmit={handleSubmit}
        loading={loading}
        recent={recent}
        onClearRecent={clearRecent}
      />

      {error && (
        <Card className="p-4 border-red-500/30 bg-red-500/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-500">Couldn't load trends data</p>
              <p className="text-sm text-muted-foreground mt-0.5">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {data && data.keywordFound === false && query && (
        <Card className="p-4 border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <p className="font-semibold text-amber-500">"{query}" is not currently trending</p>
              <p className="text-muted-foreground mt-0.5">
                Showing all {data.totalTrends} trending topics in {data.country} for the selected time window instead.
              </p>
            </div>
          </div>
        </Card>
      )}

      {loading && !data && (
        <Card className="p-12 flex flex-col items-center justify-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-orange-500" />
          <p className="text-sm text-muted-foreground">
            {isPolling
              ? 'Fetching trending data (this may take a few seconds)…'
              : `Fetching trending data for "${query}"…`}
          </p>
          <p className="text-xs text-muted-foreground">Results are cached for 15 minutes.</p>
        </Card>
      )}

      {!loading && !data && !error && (
        <Card className="p-12 flex flex-col items-center justify-center text-center gap-2">
          <TrendingUp className="h-10 w-10 text-orange-500/60" />
          <p className="text-base font-semibold">Search any keyword to begin</p>
          <p className="text-sm text-muted-foreground max-w-md">
            Type a keyword like <span className="font-medium">Bandi Sanjay</span> or{' '}
            <span className="font-medium">train accident</span> above and hit Analyze.
          </p>
        </Card>
      )}

      {data && (
        <>
          <InterestOverTimeChart
            data={data.interestOverTime}
            keyword={data.displayQuery || data.query}
            summary={data.summary}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <TrendingScoreCard summary={data.summary} lastUpdated={data.lastUpdated} />
            <div className="lg:col-span-2">
              <TopRegionsCard regions={data.topRegions} />
            </div>
          </div>

          <RelatedSearchesCard data={data} />
        </>
      )}
    </div>
  );
};

export default SearchAnalytics;
