import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { DISTRICT_FILTER_KEY } from '../lib/api';
import { DISTRICT_FILTER_EVENT, useDistrictFilter } from '../hooks/useDistrictFilter';
import { useAuth } from '../contexts/AuthContext';
import { useRbac } from '../contexts/RbacContext';
import { useMonitoringUsage } from '../components/MonitoringUsageBar';
import DistrictMap, { MapLegend } from '../components/DistrictMap';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  LandPlot, Siren, ShieldAlert, CalendarClock, Megaphone,
  Cpu, TrendingUp, TrendingDown, Hash, RefreshCw, Radio, FileText,
  Activity, Clock, MapPin, Map as MapIcon, Info, ArrowUpRight, ChevronRight
} from 'lucide-react';

/* ══════════════════════════════════════════════════════════════════════════
 * DESIGN TOKENS
 *
 * One scale for everything on the board, so nothing is sized or coloured
 * ad hoc. Rows declare a fixed height from ROW; panels never grow to fit
 * their content — content scrolls inside instead. That keeps every row's
 * baseline aligned no matter how much data a tenant happens to have.
 * ══════════════════════════════════════════════════════════════════════════ */

// Fixed row heights (px). The whole layout is built from these four.
const ROW = { kpi: 108, sm: 272, md: 344, lg: 452 };

// Categorical — platform identity only. Validated for colour-vision
// separation against both the light and dark chart surfaces.
const SERIES = {
  light: { x: '#2a78d6', instagram: '#eb6834', facebook: '#1baf7a', youtube: '#eda100' },
  dark: { x: '#3987e5', instagram: '#d95926', facebook: '#199e70', youtube: '#c98500' }
};

// Status — reserved for severity. Never reused as a series colour, and always
// shipped alongside a label so meaning is never carried by hue alone.
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const RISK_COLOR = { low: STATUS.good, medium: STATUS.warning, high: STATUS.critical };

const PLATFORM_LABEL = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };

// Official brand marks as inline paths. lucide ships Twitter/Instagram/
// Facebook/Youtube glyphs but they are deprecated (and its "Twitter" is still
// the retired bird, not the X mark), so the paths live here instead — accurate
// today and safe across a lucide upgrade.
const BRAND = {
  x: {
    label: 'X (Twitter)',
    chip: 'bg-slate-900 dark:bg-white',
    ink: 'text-white dark:text-slate-900',
    path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'
  },
  instagram: {
    label: 'Instagram',
    chip: 'bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600',
    ink: 'text-white',
    path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z'
  },
  facebook: {
    label: 'Facebook',
    chip: 'bg-[#1877F2]',
    ink: 'text-white',
    path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z'
  },
  youtube: {
    label: 'YouTube',
    chip: 'bg-[#FF0000]',
    ink: 'text-white',
    path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z'
  }
};

const PlatformIcon = ({ platform, size = 28 }) => {
  const b = BRAND[platform];
  if (!b) return <span className="rounded-lg bg-slate-300 dark:bg-slate-700 shrink-0" style={{ width: size, height: size }} />;
  return (
    <span
      className={`grid place-items-center rounded-lg shrink-0 ${b.chip}`}
      style={{ width: size, height: size }}
      title={b.label}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.54)} height={Math.round(size * 0.54)}
        fill="currentColor" aria-hidden="true" className={b.ink}>
        <path d={b.path} />
      </svg>
    </span>
  );
};

/* ── Utilities ─────────────────────────────────────────────────────────── */

const useIsDark = () => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => o.disconnect();
  }, []);
  return dark;
};

// Show the real number. Operational counts here are small enough to read
// exactly (a thousands separator is plenty), so abbreviation only kicks in past
// 100k where it would otherwise break column widths.
const nf = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
};

const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const titleCase = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const timeAgo = (iso) => {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/* ── Primitives ────────────────────────────────────────────────────────── */

const CARD = 'rounded-2xl bg-white dark:bg-slate-900 ring-1 ring-slate-900/[0.07] dark:ring-white/[0.08] shadow-[0_1px_2px_rgba(16,24,40,.04),0_12px_28px_-20px_rgba(16,24,40,.22)]';

/**
 * Fixed-height panel. `h` sets the outer height; the body flexes and scrolls,
 * so panels in a row always line up regardless of content volume.
 */
const Panel = ({ title, icon: Icon, action, children, h, className = '', scroll = false, pad = true }) => (
  <section className={`${CARD} flex flex-col overflow-hidden ${className}`} style={h ? { height: h } : undefined}>
    {(title || action) && (
      <header className="flex items-center justify-between gap-3 px-5 h-[46px] shrink-0 border-b border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-[15px] w-[15px] text-slate-400 dark:text-slate-500 shrink-0" strokeWidth={2} />}
          <h2 className="text-[12.5px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100 truncate">{title}</h2>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
    )}
    <div className={`flex-1 min-h-0 ${pad ? 'px-5 py-4' : ''} ${scroll ? 'overflow-y-auto' : 'overflow-hidden'}`}>
      {children}
    </div>
  </section>
);

const SectionLabel = ({ children, hint }) => (
  <div className="flex items-baseline gap-2.5 px-1 pt-1">
    <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-slate-400 dark:text-slate-500">{children}</h2>
    {hint && <span className="text-[10.5px] text-slate-300 dark:text-slate-600">{hint}</span>}
    <span className="flex-1 h-px bg-slate-200/70 dark:bg-slate-800" />
  </div>
);

const Delta = ({ value }) => {
  if (value === null || value === undefined) return null;
  if (value === 0) return <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tabular-nums">0%</span>;
  const up = value > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
      <Icon className="h-3 w-3" strokeWidth={2.5} />{Math.abs(value)}%
    </span>
  );
};

const TONE = {
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  rose: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400'
};

// Uniform KPI tile. Proportional figures on the value (tabular-nums makes a
// large standalone number look loose); the sub-line is reserved for context.
// When `onClick` is supplied the whole tile becomes a button and grows an
// affordance (arrow + hover lift) so it reads as interactive rather than static.
const Tile = ({ icon: Icon, label, value, sub, delta, tone = 'slate', accent, onClick }) => {
  const Root = onClick ? 'button' : 'div';
  return (
    <Root
      onClick={onClick}
      type={onClick ? 'button' : undefined}
      className={`${CARD} group relative text-left px-4 py-3 flex flex-col justify-between w-full overflow-hidden ${
        onClick
          ? 'cursor-pointer hover:ring-slate-900/[0.16] dark:hover:ring-white/20 hover:shadow-[0_1px_2px_rgba(16,24,40,.05),0_16px_32px_-20px_rgba(16,24,40,.32)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition'
          : ''
      }`}
      style={{ height: ROW.kpi }}
    >
      {/* Severity tiles carry a top band in their own band colour, so the row
          reads as an ordered scale instead of four identical cards. */}
      {accent && <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: accent }} />}
      <div className="flex items-start justify-between gap-2">
        <span className="h-7 w-7 rounded-lg grid place-items-center shrink-0"
          style={accent ? { background: `${accent}1f`, color: accent } : undefined}>
          <Icon className={`h-[15px] w-[15px] ${accent ? '' : TONE[tone]} ${accent ? '' : 'rounded-lg'}`} strokeWidth={2} />
        </span>
        <span className="flex items-center gap-1.5">
          <Delta value={delta} />
          {onClick && (
            <ArrowUpRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 group-hover:text-slate-500 dark:group-hover:text-slate-400 transition" strokeWidth={2.2} />
          )}
        </span>
      </div>
      <div className="min-w-0">
        <div className="text-[25px] leading-none font-semibold tracking-[-0.025em] truncate"
          style={accent ? { color: accent } : undefined}>
          <span className={accent ? '' : 'text-slate-900 dark:text-white'}>{value}</span>
        </div>
        <div className="mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">{label}</div>
        <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate h-[13px]">{sub || ''}</div>
      </div>
    </Root>
  );
};

// Shared affordance for clickable rows inside panels.
const ROW_LINK = 'w-full text-left rounded-lg transition hover:bg-slate-50 dark:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

const Empty = ({ icon: Icon = Info, children }) => (
  <div className="h-full grid place-items-center text-center px-4">
    <div>
      <Icon className="h-5 w-5 mx-auto text-slate-300 dark:text-slate-700" strokeWidth={1.8} />
      <p className="mt-1.5 text-[11.5px] text-slate-400 dark:text-slate-500">{children}</p>
    </div>
  </div>
);

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/15 shadow-lg px-2.5 py-1.5">
      {label && <div className="text-[10.5px] font-medium text-slate-500 dark:text-slate-400 mb-0.5">{label}</div>}
      {payload.map((p) => (
        <div key={p.dataKey || p.name} className="flex items-center gap-1.5 text-[12px]">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color || p.payload?.fill }} />
          <span className="text-slate-600 dark:text-slate-300">{p.name}</span>
          <span className="font-semibold tabular-nums text-slate-900 dark:text-white ml-1">{nf(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// Labelled meter row — used wherever a value sits against a maximum.
const Meter = ({ label, value, max, color, right, sub }) => (
  <div>
    <div className="flex items-center justify-between gap-2 text-[11.5px] mb-1">
      <span className="text-slate-600 dark:text-slate-300 truncate">{label}</span>
      <span className="tabular-nums shrink-0 font-semibold text-slate-900 dark:text-white">
        {right ?? nf(value)}
      </span>
    </div>
    <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(value > 0 ? 2 : 0, (value / (max || 1)) * 100))}%`, background: color }} />
    </div>
    {sub && <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{sub}</div>}
  </div>
);

/* ══════════════════════════════════════════════════════════════════════════
 * PAGE
 * ══════════════════════════════════════════════════════════════════════════ */

const CommandCenter = () => {
  const { user } = useAuth();               // eslint-disable-line no-unused-vars
  const { hasAccess } = useRbac();
  const navigate = useNavigate();
  const isDark = useIsDark();
  const series = isDark ? SERIES.dark : SERIES.light;
  const grid = isDark ? '#2c2c2a' : '#e8eaed';
  const axisInk = '#8a8a86';

  const [data, setData] = useState(null);
  const [geo, setGeo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [clock, setClock] = useState(() => new Date());
  const [pinned, setPinned] = useState(null);

  const usage = useMonitoringUsage();

  // Drill-down. Returns undefined when the destination page is not permitted for
  // this user, so the tile stays inert rather than routing them into an
  // Access Denied screen.
  const go = useCallback((path, params) => {
    const base = path.split('?')[0];
    if (!hasAccess(base)) return undefined;
    return () => {
      const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
      navigate(`${base}${qs}`);
    };
  }, [hasAccess, navigate]);

  /**
   * Select a district. Highlights it here AND applies the app-wide filter, so
   * any page opened next is already scoped to it.
   *
   * This page is listed in Layout's DISTRICT_SELF_SCOPED set, so writing the
   * filter does not remount it — the effect below refetches in place and the
   * previous render is held at reduced opacity while it lands. Without that
   * opt-out every click would replay the full loading skeleton.
   */
  const selectDistrict = useCallback((district) => {
    setPinned(district);
    if (district) localStorage.setItem(DISTRICT_FILTER_KEY, district);
    else localStorage.removeItem(DISTRICT_FILTER_KEY);
    window.dispatchEvent(new Event(DISTRICT_FILTER_EVENT));
  }, []);

  /**
   * Open a district's alerts at one severity: applies the district globally
   * (so the destination page is already scoped) and filters by risk level.
   * `?category=high|medium|low` is what Alerts maps onto `risk_level`.
   */
  const openDistrictRisk = useCallback((district, level) => {
    if (!hasAccess('/alerts')) return undefined;
    return (e) => {
      e?.stopPropagation?.();       // don't also trigger the row's own select
      if (district) {
        localStorage.setItem(DISTRICT_FILTER_KEY, district);
        window.dispatchEvent(new Event(DISTRICT_FILTER_EVENT));
      }
      navigate(`/alerts?${new URLSearchParams({ status: 'active', category: level }).toString()}`);
    };
  }, [hasAccess, navigate]);

  // Open the alerts behind a watch-list keyword, or behind a detected intent.
  // Both resolve server-side to the posts that actually carry them.
  const openAlertsFiltered = useCallback((params) => {
    if (!hasAccess('/alerts')) return undefined;
    return () => navigate(`/alerts?${new URLSearchParams({ status: 'active', ...params }).toString()}`);
  }, [hasAccess, navigate]);

  // Permission probes, so rows can style themselves as interactive only when
  // the destination is actually reachable.
  const goEvents = !!go('/events');
  const goAlerts = go('/alerts', { status: 'active' });
  const goKeywords = go('/settings', { tab: 'keywords' });

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true); else setLoading(true);
    try {
      const res = await api.get('/command-center/overview');
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.message || 'Unable to load the command centre');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refetch in place whenever the district filter changes — from a click here,
  // or from the navbar selector. `load(true)` is the soft path: it holds the
  // current render at reduced opacity rather than flashing the skeleton.
  const districtFilter = useDistrictFilter();
  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) { firstScope.current = false; return; }  // initial load already ran
    setPinned(districtFilter === 'all' ? null : districtFilter);
    load(true);
  }, [districtFilter, load]);

  useEffect(() => {
    let alive = true;
    api.get('/command-center/geo')
      .then((r) => { if (alive) setGeo(r.data); })
      .catch(() => { if (alive) setGeo({ available: false, reason: 'error' }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => load(true), 120000);
    return () => clearInterval(t);
  }, [load]);

  const k = data?.kpis;
  const scope = data?.scope;
  const isAdmin = scope?.isStateAdmin;

  const byDistrict = useMemo(
    () => Object.fromEntries((data?.districts || []).map((d) => [d.district, d])),
    [data]
  );

  const alertDonut = useMemo(() => {
    const r = data?.alerts?.byRisk || {};
    return [
      { name: 'High', value: r.high || 0, fill: STATUS.critical },
      { name: 'Medium', value: r.medium || 0, fill: STATUS.warning },
      { name: 'Low', value: r.low || 0, fill: STATUS.good }
    ].filter((d) => d.value > 0);
  }, [data]);
  const alertTotal = alertDonut.reduce((s, d) => s + d.value, 0);

  const trendData = useMemo(
    () => (data?.trend || []).map((t) => ({
      ...t,
      label: new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    })),
    [data]
  );

  // Days that actually recorded something. With a sparse window, saying so
  // beats leaving the reader to wonder whether the chart is broken.
  const activeDays = useMemo(
    () => (data?.trend || []).filter((t) => t.posts > 0 || t.alerts > 0).length,
    [data]
  );

  // When a district is pinned, show the keywords that APPLY to it (a keyword
  // with no district scope is tenant-wide) and use that district's own count —
  // otherwise the list would credit a keyword for hits somewhere else. Silent
  // keywords stay visible: "configured but never matched" is the actionable case.
  const topicsInScope = useMemo(() => {
    const all = data?.topics || [];
    if (!pinned) return all;
    return all
      .filter((t) => !t.scope?.length || t.scope.includes(pinned))
      .map((t) => ({
        ...t,
        count: (t.districts || []).find((d) => d.district === pinned)?.count || 0
      }))
      .sort((a, b) => b.count - a.count || String(a.keyword).localeCompare(String(b.keyword)));
  }, [data, pinned]);

  const maxIntent = useMemo(
    () => Math.max(1, ...(data?.intents || []).map((i) => i.count || 0)),
    [data]
  );

  const alertRanked = useMemo(
    () => (data?.districts || [])
      .filter((d) => d.alerts > 0)
      .sort((a, b) => (b.alertRisk?.high || 0) - (a.alertRisk?.high || 0) || b.alerts - a.alerts),
    [data]
  );

  const activeDistricts = useMemo(
    () => (data?.districts || []).filter((d) => d.posts > 0 || d.alerts > 0 || d.grievances > 0),
    [data]
  );

  // The worst district anchors the top of the scale, so shading always compares
  // districts against the heaviest negative volume actually present.
  const maxNegative = useMemo(
    () => Math.max(1, ...(data?.districts || []).map((d) => d.sentiment?.negative || 0)),
    [data]
  );

  /**
   * Districts are shaded green → yellow → orange → red by their VOLUME of
   * negative posts, relative to the worst district. Volume rather than
   * proportion: a district with 25 negative posts is a bigger problem than one
   * with 2, even if both are 60% negative.
   */
  const mapValues = useMemo(() => {
    const out = {};
    (data?.districts || []).forEach((d) => {
      const common = [['Posts', nf(d.posts)], ['Alerts', nf(d.alerts)], ['Events', nf(d.events)], ['Grievances', nf(d.grievances)]];
      const s = d.sentiment || { positive: 0, neutral: 0, negative: 0 };
      out[d.district] = {
        intensity: d.sentimentTotal ? (s.negative || 0) / maxNegative : undefined,
        label: d.sentimentTotal
          ? `${nf(s.negative)} negative of ${nf(d.sentimentTotal)} analysed`
          : 'No posts analysed',
        rows: d.sentimentTotal
          ? [['Negative', nf(s.negative)], ['Neutral', nf(s.neutral)], ['Positive', nf(s.positive)], ...common]
          : common
      };
    });
    return out;
  }, [data, maxNegative]);

  /* ── Loading / error ─────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-full bg-slate-100/70 dark:bg-slate-950 p-4 sm:p-5 space-y-3">
        <div className="h-10 w-72 rounded-xl bg-white/70 dark:bg-slate-900/70 animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={`${CARD} animate-pulse`} style={{ height: ROW.kpi }} />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className={`${CARD} lg:col-span-2 animate-pulse`} style={{ height: ROW.lg }} />
          <div className={`${CARD} animate-pulse`} style={{ height: ROW.lg }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-full bg-slate-100/70 dark:bg-slate-950 p-5">
        <Panel title="Command Centre" icon={Radio} h={220}>
          <div className="h-full grid place-items-center text-center">
            <div>
              <p className="text-[13px] text-slate-600 dark:text-slate-300">{error}</p>
              <button onClick={() => load()} className="mt-3 text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:underline">
                Try again
              </button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }


  return (
    <div className={`min-h-full bg-slate-100/70 dark:bg-slate-950 p-4 sm:p-5 space-y-3 transition-opacity ${refreshing ? 'opacity-70' : ''}`}>

      {/* ══ Masthead ══ */}
      <header className={`${CARD} px-5 py-3.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-white">Command Centre</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />Live
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
            <span>{isAdmin ? 'State overview' : 'District view'}</span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {scope?.activeDistrict ? titleCase(scope.activeDistrict) : `${scope?.districtCount || 0} districts`}
            </span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>District-tagged data only</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[15px] font-semibold tabular-nums leading-none text-slate-900 dark:text-white">
              {clock.toLocaleTimeString(undefined, { hour12: false })}
            </div>
            <div className="text-[10.5px] text-slate-400 dark:text-slate-500 mt-1">
              {clock.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-[12px] font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </header>

      {/* ══ 1 · Situation ══
          Six tiles, one per domain. Each number appears here exactly once —
          severity, platform and district breakdowns live in their own panels
          below rather than being echoed up here. */}
      <SectionLabel hint="current standing">Situation</SectionLabel>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile icon={LandPlot} tone="slate" label={isAdmin ? 'Districts' : 'My districts'}
          value={k?.districts?.total ?? 0}
          sub={`${activeDistricts.length} with activity`}
          onClick={go('/sources')} />
        <Tile icon={Siren} tone="rose" label="Total alerts" value={nf(k?.alerts?.total)}
          delta={k?.alerts?.delta} sub={`${nf(k?.escalated?.total)} escalated`}
          onClick={go('/alerts', { status: 'active' })} />
        {/* The severity split, carrying its own band colour so the row reads as
            a scale at a glance rather than four identical grey tiles. */}
        <Tile icon={ShieldAlert} accent={STATUS.critical} label="High risk"
          value={nf(data.alerts.byRisk.high)}
          sub={`${pctOf(data.alerts.byRisk.high, alertTotal)}% of alerts`}
          onClick={go('/alerts', { status: 'active' })} />
        <Tile icon={ShieldAlert} accent={STATUS.warning} label="Medium risk"
          value={nf(data.alerts.byRisk.medium)}
          sub={`${pctOf(data.alerts.byRisk.medium, alertTotal)}% of alerts`}
          onClick={go('/alerts', { status: 'active' })} />
        <Tile icon={ShieldAlert} accent={STATUS.good} label="Low risk"
          value={nf(data.alerts.byRisk.low)}
          sub={`${pctOf(data.alerts.byRisk.low, alertTotal)}% of alerts`}
          onClick={go('/alerts', { status: 'active' })} />
        <Tile icon={Megaphone} tone="amber" label="Grievances" value={nf(k?.grievances?.pending)}
          delta={k?.grievances?.delta} sub={`${nf(k?.grievances?.today)} today`}
          onClick={go('/grievances', { tab: 'all' })} />
      </div>

      {/* ══ 2 · Geography ══ */}
      <SectionLabel hint="drag to pan · scroll to zoom · click a district">Geography</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          h={ROW.lg}
          className="lg:col-span-2"
          pad={false}
          title={geo?.state ? `${geo.state} — district map` : 'District map'}
          icon={MapIcon}
          action={
            <span className="text-[10.5px] text-slate-400 dark:text-slate-500">
              Negative posts by district
            </span>
          }
        >
          <div className="h-full flex flex-col">
            <div className="flex-1 min-h-0 px-2 pt-2">
              {geo === null ? (
                <div className="h-full grid place-items-center">
                  <div className="h-6 w-6 rounded-full border-2 border-slate-200 dark:border-slate-700 border-t-blue-500 animate-spin" />
                </div>
              ) : geo.available ? (
                <DistrictMap
                  features={geo.features} bbox={geo.bbox} values={mapValues}
                  measure="sentiment" isDark={isDark} height={ROW.lg - 46 - 44}
                  selected={pinned} onSelect={selectDistrict}
                />
              ) : (
                <Empty icon={MapIcon}>
                  {geo.reason === 'no_state_configured'
                    ? 'Set the state in tenant configuration to enable the map.'
                    : geo.message || 'No boundary file bundled for this state.'}
                </Empty>
              )}
            </div>
            {geo?.available && (
              <div className="h-[44px] shrink-0 px-5 flex items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800/80">
                <MapLegend isDark={isDark} scale />
                {!geo.coverage?.complete && (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-700 dark:text-amber-400 shrink-0"
                    title={`No boundary geometry for: ${geo.coverage.missing.join(', ')}`}>
                    <Info className="h-3 w-3" />{geo.coverage.drawn}/{geo.coverage.requested} mapped
                  </span>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Panel
          h={ROW.lg} scroll
          title="District focus"
          icon={LandPlot}
          action={pinned
            ? <button onClick={() => selectDistrict(null)} className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline">Clear selection</button>
            : <span className="text-[10.5px] text-slate-400 dark:text-slate-500">Top by risk</span>}
        >
          {!activeDistricts.length ? <Empty icon={LandPlot}>No district activity yet</Empty> : (
            <div className="space-y-1.5">
              {/* One list, always. Selecting a district expands it in place
                  rather than swapping the panel for a separate detail view. */}
              {activeDistricts.map((x) => {
                const r = x.alertRisk || { high: 0, medium: 0, low: 0 };
                const open = pinned === x.district;
                return (
                  <div key={x.district}
                    className={`rounded-xl transition ${open
                      ? 'bg-blue-50/60 dark:bg-slate-800/80 ring-1 ring-blue-200 dark:ring-slate-700'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}>
                    <button
                      onClick={() => selectDistrict(open ? null : x.district)}
                      className="w-full text-left px-2.5 pt-2 pb-1.5"
                      aria-expanded={open}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <ChevronRight
                            className={`h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
                            strokeWidth={2.5}
                          />
                          <span className={`text-[12.5px] truncate ${open ? 'font-semibold text-slate-900 dark:text-white' : 'font-medium text-slate-800 dark:text-slate-200'}`}>
                            {titleCase(x.district)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums">
                          <span className="text-[13px] font-semibold text-slate-900 dark:text-white">{nf(x.alerts)}</span>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-1">alerts</span>
                        </span>
                      </div>
                      <div className="flex h-1.5 rounded-full overflow-hidden gap-[2px] bg-slate-100 dark:bg-slate-800">
                        {[['high', STATUS.critical], ['medium', STATUS.warning], ['low', STATUS.good]].map(([kk, c]) => (
                          r[kk] ? <div key={kk} style={{ width: `${(r[kk] / x.alerts) * 100}%`, background: c }} /> : null
                        ))}
                      </div>
                    </button>

                    {/* Severity chips: each opens that district's alerts at that level */}
                    <div className="flex items-center gap-1.5 px-2.5 pb-2">
                      {[['High', 'high', r.high, STATUS.critical],
                        ['Medium', 'medium', r.medium, STATUS.warning],
                        ['Low', 'low', r.low, STATUS.good]].map(([label, level, v, c]) => {
                        const jump = v > 0 ? openDistrictRisk(x.district, level) : undefined;
                        const Chip = jump ? 'button' : 'span';
                        return (
                          <Chip key={level} onClick={jump} type={jump ? 'button' : undefined}
                            title={jump ? `${v} ${label.toLowerCase()}-risk alerts in ${titleCase(x.district)}` : undefined}
                            className={`inline-flex items-center gap-1 rounded-md pl-1.5 pr-2 py-0.5 text-[10px] tabular-nums transition ${
                              jump ? 'cursor-pointer hover:ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500' : 'opacity-45'
                            }`}
                            style={{ background: `${c}14`, color: c, '--tw-ring-color': c }}>
                            <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: c }} />
                            {label} <span className="font-semibold">{v}</span>
                          </Chip>
                        );
                      })}
                    </div>

                    {/* Expanded totals. Animated with grid-template-rows 0fr→1fr
                        so it slides open to its natural height — no fixed
                        max-height to guess at, and it stays keyboard/AT-safe
                        because the content is only hidden by overflow. */}
                    <div
                      className="grid px-2.5 motion-safe:transition-[grid-template-rows] motion-safe:duration-300 ease-out"
                      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
                      aria-hidden={!open}
                    >
                      <div className="overflow-hidden">
                        <div className="grid grid-cols-3 gap-2 pb-2.5 pt-2 border-t border-blue-100 dark:border-slate-700">
                          {[['Alerts', x.alerts], ['Events', x.events], ['Grievances', x.grievances]].map(([label, v]) => (
                            <div key={label} className="rounded-lg bg-white/70 dark:bg-slate-900/50 px-2 py-2">
                              <div className="text-[16px] font-semibold tracking-[-0.01em] leading-none text-slate-900 dark:text-white">{nf(v)}</div>
                              <div className="text-[9.5px] text-slate-500 dark:text-slate-400 mt-1">{label}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* ══ 3 · Alert analytics ══ */}
      <SectionLabel hint="volume, severity and distribution">Alert analytics</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel h={ROW.md} className="lg:col-span-2" title="Daily activity · last 14 days" icon={Activity}
          action={
            <div className="flex items-center gap-3.5 text-[10.5px]">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: series.x }} /><span className="text-slate-500 dark:text-slate-400">Posts collected</span></span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: series.instagram }} /><span className="text-slate-500 dark:text-slate-400">Alerts raised</span></span>
            </div>
          }>
          {/* Bars, not a smoothed area: these are discrete per-day counts, and a
              monotone curve would draw values between days that never existed
              (the old chart implied a gentle ramp across days that were zero).
              One shared y-axis is honest here — the two series are within ~1.4x
              of each other, so nothing is being visually rescaled. */}
          <div className="h-full flex flex-col">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}
                barCategoryGap="22%" barGap={2}>
                <CartesianGrid stroke={grid} strokeWidth={1} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: axisInk }} tickLine={false}
                  axisLine={{ stroke: grid }} interval="preserveStartEnd" minTickGap={18} />
                <YAxis tick={{ fontSize: 10, fill: axisInk }} tickLine={false} axisLine={false}
                  width={46} tickFormatter={nf} allowDecimals={false} />
                <Tooltip content={<ChartTip />} cursor={{ fill: isDark ? 'rgba(255,255,255,.05)' : 'rgba(16,24,40,.045)' }} />
                <Bar dataKey="posts" name="Posts collected" fill={series.x} radius={[4, 4, 0, 0]} maxBarSize={26} />
                <Bar dataKey="alerts" name="Alerts raised" fill={series.instagram} radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
            {activeDays > 0 && activeDays < trendData.length && (
              <p className="text-[10px] text-slate-400 dark:text-slate-500 pt-1.5 shrink-0">
                Activity on {activeDays} of {trendData.length} days — the rest recorded nothing.
              </p>
            )}
          </div>
        </Panel>

        <Panel h={ROW.md} title="Alert severity" icon={Siren}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500 tabular-nums">{nf(alertTotal)} total</span>}>
          {alertTotal === 0 ? <Empty icon={Siren}>No alerts in scope</Empty> : (
            <div className="h-full flex items-center gap-4">
              <div className="relative w-[132px] h-[132px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={alertDonut} dataKey="value" nameKey="name" innerRadius={44} outerRadius={62} paddingAngle={2} stroke="none">
                      {alertDonut.map((d) => <Cell key={d.name} fill={d.fill} />)}
                    </Pie>
                    <Tooltip content={<ChartTip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 grid place-items-center pointer-events-none">
                  <div className="text-center">
                    <div className="text-[21px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-white leading-none">{nf(alertTotal)}</div>
                    <div className="text-[9.5px] text-slate-400 dark:text-slate-500 mt-0.5">alerts</div>
                  </div>
                </div>
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                {alertDonut.map((d) => {
                  const open = go('/alerts', { status: 'active' });
                  const Row = open ? 'button' : 'div';
                  return (
                    <Row key={d.name} onClick={open} type={open ? 'button' : undefined}
                      className={`flex items-center gap-2 text-[12px] w-full ${open ? `${ROW_LINK} -mx-1 px-1 py-0.5` : ''}`}
                      title={open ? `Open ${d.name.toLowerCase()}-risk alerts` : undefined}>
                      <span className="h-2 w-2 rounded-[2px] shrink-0" style={{ background: d.fill }} />
                      <span className="text-slate-600 dark:text-slate-300 flex-1 truncate text-left">{d.name} risk</span>
                      <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{nf(d.value)}</span>
                      <span className="text-slate-400 dark:text-slate-500 tabular-nums w-9 text-right text-[11px]">
                        {Math.round((d.value / alertTotal) * 100)}%
                      </span>
                    </Row>
                  );
                })}
                <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-x-3 gap-y-2">
                  {[['Active', data.alerts.byStatus.active, 'active'],
                    ['Acknowledged', data.alerts.byStatus.acknowledged, 'acknowledged'],
                    ['Escalated', data.alerts.byStatus.escalated, 'escalated'],
                    ['Resolved', data.alerts.byStatus.resolved, 'false_positive']].map(([label, v, status]) => {
                    const open = go('/alerts', { status });
                    const Cell = open ? 'button' : 'div';
                    return (
                      <Cell key={label} onClick={open} type={open ? 'button' : undefined}
                        className={`text-left ${open ? `${ROW_LINK} -mx-1 px-1 py-0.5` : ''}`}>
                        <div className="text-[14px] font-semibold tabular-nums text-slate-900 dark:text-white leading-none">{nf(v || 0)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">{label}</div>
                      </Cell>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ══ 4 · Districts ══ */}
      <SectionLabel hint={`${activeDistricts.length} of ${data.districts.length} districts active`}>District breakdown</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel h={ROW.md} className="lg:col-span-2" scroll pad={false}
          title={isAdmin ? 'District comparison' : 'My districts'} icon={LandPlot}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500">Ranked by risk</span>}>
          {!data.districts?.length ? <Empty icon={LandPlot}>No districts assigned</Empty> : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                <tr className="text-[9.5px] uppercase tracking-[0.07em] text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
                  <th className="text-left font-semibold py-2 pl-5 pr-2">District</th>
                  <th className="text-right font-semibold py-2 px-3">Alerts</th>
                  <th className="text-right font-semibold py-2 px-3">Events</th>
                  <th className="text-right font-semibold py-2 px-3">Grievances</th>
                  <th className="text-right font-semibold py-2 pr-5 pl-3">Risk</th>
                </tr>
              </thead>
              <tbody>
                {data.districts.map((d) => (
                  <tr key={d.district} onClick={() => selectDistrict(d.district === pinned ? null : d.district)}
                    className={`cursor-pointer border-b border-slate-50 dark:border-slate-800/50 transition ${pinned === d.district ? 'bg-blue-50/60 dark:bg-slate-800/70' : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/40'}`}>
                    <td className="py-2 pl-5 pr-2 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">{titleCase(d.district)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{nf(d.alerts)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{nf(d.events)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{nf(d.grievances)}</td>
                    <td className="py-2 pr-5 pl-3 text-right">
                      {d.analysed ? (
                        // Worst risk level actually observed here, with the full
                        // level breakdown on hover.
                        <span className="inline-flex items-center gap-1.5 rounded-full pl-1.5 pr-2 py-0.5 text-[11px] font-semibold capitalize"
                          style={{ background: `${RISK_COLOR[d.riskBand]}1a`, color: RISK_COLOR[d.riskBand] }}
                          title={`${d.riskLevels.high} high · ${d.riskLevels.medium} medium · ${d.riskLevels.low} low`}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: RISK_COLOR[d.riskBand] }} />{d.riskBand}
                        </span>
                      ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel h={ROW.md} scroll title="Alerts by district" icon={Siren}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500">By risk level</span>}>
          {!alertRanked.length ? <Empty icon={Siren}>No alerts raised</Empty> : (
            <div className="space-y-3">
              {alertRanked.map((d) => {
                const r = d.alertRisk || { high: 0, medium: 0, low: 0 };
                return (
                  <div key={d.district}
                    className={`rounded-xl px-2.5 py-2 transition ${pinned === d.district ? 'bg-blue-50/70 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}>
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <button onClick={() => selectDistrict(d.district === pinned ? null : d.district)}
                        className="text-[12.5px] font-medium text-slate-800 dark:text-slate-200 truncate hover:text-blue-600 dark:hover:text-blue-400 transition text-left"
                        title={`Focus on ${titleCase(d.district)}`}>
                        {titleCase(d.district)}
                      </button>
                      <span className="shrink-0 tabular-nums">
                        <span className="text-[13px] font-semibold text-slate-900 dark:text-white">{nf(d.alerts)}</span>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 ml-1">alerts</span>
                      </span>
                    </div>
                    <div className="flex h-2 rounded-full overflow-hidden gap-[2px] bg-slate-100 dark:bg-slate-800">
                      {[['high', STATUS.critical], ['medium', STATUS.warning], ['low', STATUS.good]].map(([kk, c]) =>
                        r[kk] ? <div key={kk} title={`${titleCase(kk)} risk: ${r[kk]}`} style={{ width: `${(r[kk] / d.alerts) * 100}%`, background: c }} /> : null)}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      {[['High', 'high', r.high, STATUS.critical],
                        ['Medium', 'medium', r.medium, STATUS.warning],
                        ['Low', 'low', r.low, STATUS.good]].map(([label, level, v, c]) => {
                        const open = v > 0 ? openDistrictRisk(d.district, level) : undefined;
                        const Chip = open ? 'button' : 'span';
                        return (
                          <Chip key={level} onClick={open} type={open ? 'button' : undefined}
                            title={open ? `${v} ${label.toLowerCase()}-risk alerts in ${titleCase(d.district)}` : undefined}
                            className={`inline-flex items-center gap-1 rounded-md pl-1.5 pr-2 py-0.5 text-[10px] tabular-nums transition ${
                              open ? 'cursor-pointer hover:ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500' : 'opacity-45'
                            }`}
                            style={{ background: `${c}14`, color: c, '--tw-ring-color': c }}>
                            <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: c }} />
                            {label} <span className="font-semibold">{v}</span>
                          </Chip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* ══ 5 · Intelligence ══ */}
      <SectionLabel hint="what is being detected">Intelligence</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">

        {/* The tenant's own watch list and how it is performing — NOT the
            hardcoded lexicon inside mappingService. A keyword that matched
            nothing is shown too; that is the actionable half. */}
        <Panel h={ROW.sm} scroll title="My keywords" icon={Hash}
          action={
            goKeywords ? (
              <button onClick={goKeywords}
                className="inline-flex items-center gap-1 text-[10.5px] font-medium text-blue-600 dark:text-blue-400 hover:underline tabular-nums">
                {data.keywordStats?.matched ?? 0}/{data.keywordStats?.configured ?? 0} matched
                <ArrowUpRight className="h-3 w-3" strokeWidth={2.2} />
              </button>
            ) : (
              <span className="text-[10.5px] text-slate-400 dark:text-slate-500 tabular-nums">
                {data.keywordStats?.matched ?? 0}/{data.keywordStats?.configured ?? 0} matched · 14d
              </span>
            )
          }>
          {!topicsInScope.length ? (
            <Empty icon={Hash}>
              {pinned ? `No keywords configured for ${titleCase(pinned)}` : 'No keywords configured yet'}
            </Empty>
          ) : (
            <ol className="space-y-2.5">
              {topicsInScope.map((t) => {
                const max = Math.max(1, ...topicsInScope.map((z) => z.count));
                const silent = t.count === 0;
                return (
                  <li key={t.keyword} className="text-[12px]">
                    {/* Opens the alerts whose posts actually matched this keyword.
                        The district chips below are siblings, not children — a
                        button inside a button swallows the inner click. */}
                    <button
                      onClick={silent ? undefined : openAlertsFiltered({ keyword: t.keyword })}
                      disabled={silent}
                      title={silent
                        ? 'No posts matched this keyword'
                        : `Open the ${t.count} alert${t.count === 1 ? '' : 's'} matching "${t.keyword}"`}
                      className={`w-full text-left rounded-lg -mx-1 px-1 py-0.5 ${silent ? 'cursor-default' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`truncate flex-1 ${silent ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'}`}>
                          {t.keyword}
                        </span>
                        <span className="h-1.5 w-11 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden shrink-0">
                          <span className="block h-full rounded-full"
                            style={{ width: `${silent ? 0 : (t.count / max) * 100}%`, background: series.x }} />
                        </span>
                        <span className="shrink-0 tabular-nums text-right">
                          <span className={`font-semibold ${silent ? 'text-slate-300 dark:text-slate-600' : 'text-slate-900 dark:text-white'}`}>
                            {t.count}
                          </span>
                          <span className="text-[9.5px] text-slate-400 dark:text-slate-500 ml-1">posts</span>
                        </span>
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[9.5px]">
                      <span className="text-slate-400 dark:text-slate-500">
                        {t.scope?.length ? t.scope.map(titleCase).join(', ') : 'All districts'}
                      </span>
                      {!pinned && t.districts?.slice(0, 2).map((d) => (
                        <button key={d.district} onClick={() => selectDistrict(d.district)}
                          className="text-blue-600/70 dark:text-blue-400/70 hover:text-blue-600 dark:hover:text-blue-400 tabular-nums transition">
                          {titleCase(d.district)} {d.count}
                        </button>
                      ))}
                      {silent && <span className="text-slate-300 dark:text-slate-600">no hits</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <Panel h={ROW.sm} scroll title="Detected intent" icon={ShieldAlert}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500">By volume</span>}>
          {!data.intents?.length ? <Empty icon={ShieldAlert}>Nothing classified</Empty> : (
            <ul className="space-y-2.5">
              {data.intents.map((it) => (
                <li key={it.intent}>
                  {/* Resolves server-side to the posts whose latest analysis
                      carries this intent, then to their alerts. */}
                  <button
                    onClick={openAlertsFiltered({ intent: it.intent })}
                    title={`Open the alerts for posts classified "${it.intent}"`}
                    className="w-full text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[11.5px] text-slate-700 dark:text-slate-200 leading-snug line-clamp-2" title={it.intent}>{it.intent}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-[11.5px] font-semibold text-slate-900 dark:text-white">{nf(it.count)}</span>
                      <span className="text-[9.5px] text-slate-400 dark:text-slate-500 ml-1">posts</span>
                    </span>
                  </div>
                  {/* Bar tracks the same number shown above it — post count —
                      not a second metric. */}
                  <div className="h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mt-1">
                    <div className="h-full rounded-full"
                      style={{ width: `${Math.max(2, (it.count / maxIntent) * 100)}%`, background: series.x }} />
                  </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>


        <Panel h={ROW.sm} scroll title="Grievances" icon={Megaphone}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500 tabular-nums">{nf(k?.grievances?.pending)} open</span>}>
          {/* The workflow in order, using the same wording the Grievances page
              itself uses (Received → Reviewed → Action Taken → Closed), rather
              than invented shorthand. */}
          <div className="space-y-1 mb-3">
            {[['Received', data.grievances.byStatus.received, STATUS.warning, 'pending'],
              ['Reviewed', data.grievances.byStatus.reviewed, series.x, 'pending'],
              ['Action taken', data.grievances.byStatus.action_taken, series.x, 'escalated'],
              ['Closed', data.grievances.byStatus.closed, STATUS.good, 'closed']].map(([label, v, color, tab]) => {
              const open = go('/grievances', { tab });
              const Row = open ? 'button' : 'div';
              const n = v || 0;
              return (
                <Row key={label} onClick={open} type={open ? 'button' : undefined}
                  className={`w-full flex items-center gap-2 text-[12px] px-2 py-1.5 rounded-lg text-left ${open ? 'hover:bg-slate-50 dark:hover:bg-slate-800/60 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500' : ''}`}>
                  <span className="h-2 w-2 rounded-[2px] shrink-0" style={{ background: n ? color : (isDark ? '#334155' : '#dbe1e8') }} />
                  <span className={`flex-1 truncate ${n ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}`}>{label}</span>
                  <span className={`font-semibold tabular-nums ${n ? 'text-slate-900 dark:text-white' : 'text-slate-300 dark:text-slate-600'}`}>{nf(n)}</span>
                </Row>
              );
            })}
          </div>
          {data.grievances.byCategory?.length > 0 ? (
            <>
              <div className="text-[9.5px] uppercase tracking-[0.08em] text-slate-400 dark:text-slate-500 mb-1.5">Top categories</div>
              <ul className="space-y-1.5">
                {data.grievances.byCategory.slice(0, 5).map((c) => (
                  <li key={c.category} className="flex items-center justify-between text-[11.5px] gap-2">
                    <span className="text-slate-600 dark:text-slate-300 truncate">{titleCase(c.category)}</span>
                    <span className="font-semibold tabular-nums text-slate-900 dark:text-white shrink-0">{nf(c.count)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[11px] text-slate-400 dark:text-slate-500">No categories assigned yet.</p>
          )}
          {data.grievances.byStatus.converted_to_fir > 0 && (
            <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11.5px]">
              <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <FileText className="h-3.5 w-3.5 text-slate-400" />Converted to FIR
              </span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-white">{nf(data.grievances.byStatus.converted_to_fir)}</span>
            </div>
          )}
        </Panel>
      </div>

      {/* ══ 6 · Operations ══ */}
      <SectionLabel hint="live monitoring">Operations</SectionLabel>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel h={ROW.md} className="lg:col-span-2" scroll pad={false} title="Event monitoring" icon={CalendarClock}
          action={<span className="text-[10.5px] text-slate-400 dark:text-slate-500 tabular-nums">{nf(k?.events?.live)} live</span>}>
          {!data.events?.length ? <Empty icon={CalendarClock}>No active or planned events</Empty> : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                <tr className="text-[9.5px] uppercase tracking-[0.07em] text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
                  <th className="text-left font-semibold py-2 pl-5 pr-3">Event</th>
                  <th className="text-left font-semibold py-2 pr-3">District</th>
                  <th className="text-right font-semibold py-2 px-2">Keywords</th>
                  <th className="text-right font-semibold py-2 px-2">Last check</th>
                  <th className="text-right font-semibold py-2 pr-5 pl-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id}
                    // Events only understands all|active|paused — a 'planned'
                    // event would otherwise land on a filter that doesn't exist.
                    onClick={go('/events', { status: e.status === 'active' || e.status === 'paused' ? e.status : 'all' })}
                    className={`border-b border-slate-50 dark:border-slate-800/50 ${goEvents ? 'cursor-pointer hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition' : ''}`}>
                    <td className="py-2 pl-5 pr-3 font-medium text-slate-800 dark:text-slate-200 max-w-[220px] truncate" title={e.name}>{e.name}</td>
                    <td className="py-2 pr-3 text-slate-500 dark:text-slate-400 truncate max-w-[130px]">{e.districts?.length ? e.districts.map(titleCase).join(', ') : '—'}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{e.keywords}</td>
                    <td className="py-2 px-2 text-right text-slate-500 dark:text-slate-400 whitespace-nowrap">{e.last_polled_at ? timeAgo(e.last_polled_at) : '—'}</td>
                    <td className="py-2 pr-5 pl-2 text-right">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${e.status === 'active' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                        {e.status === 'active' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                        {titleCase(e.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>


        <Panel h={ROW.md} scroll title="Live feed" icon={Clock}>
          {!data.feed?.length ? <Empty icon={Clock}>Nothing recent</Empty> : (
            <ul className="space-y-3">
              {data.feed.map((f, i) => {
                // Alert entries drill into Alerts; audit entries into the log.
                const open = f.kind === 'alert' ? go('/alerts', { status: 'active' }) : go('/audit-logs');
                const Item = open ? 'button' : 'div';
                return (
                <li key={i}>
                  <Item onClick={open} type={open ? 'button' : undefined}
                    className={`flex gap-2.5 w-full text-left ${open ? `${ROW_LINK} -mx-1.5 px-1.5 py-1` : ''}`}>
                  <span className="mt-[5px] h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ background: f.severity ? RISK_COLOR[f.severity] || STATUS.warning : (isDark ? '#475569' : '#cbd5e1') }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] text-slate-800 dark:text-slate-200 leading-snug line-clamp-2" title={f.title}>{titleCase(f.title)}</div>
                    {f.detail && <div className="text-[10.5px] text-slate-500 dark:text-slate-400 truncate" title={f.detail}>{f.detail}</div>}
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 flex items-center gap-1.5">
                      <span>{timeAgo(f.at)}</span>
                      {f.districts?.length > 0 && (<><span className="text-slate-300 dark:text-slate-600">·</span><span className="truncate">{f.districts.map(titleCase).join(', ')}</span></>)}
                    </div>
                  </div>
                  </Item>
                </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* ══ 7 · Capacity ══ */}
      {(usage || k?.engine) && (
        <>
          <SectionLabel hint="monitoring capacity">System</SectionLabel>
          <div className={`${CARD} px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-4`}>
            <div className="flex items-center gap-2.5">
              <span className={`h-8 w-8 rounded-lg grid place-items-center ${TONE.emerald}`}><Cpu className="h-4 w-4" strokeWidth={2} /></span>
              <div>
                <div className="text-[15px] font-semibold tabular-nums leading-none text-slate-900 dark:text-white">
                  {k?.engine?.sourcesActive ?? 0}<span className="text-slate-400 dark:text-slate-500 font-normal">/{k?.engine?.sourcesTotal ?? 0}</span>
                </div>
                <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1">Active sources</div>
              </div>
            </div>
            {k?.engine?.queueDepth !== null && k?.engine?.queueDepth !== undefined && (
              <>
                <div>
                  <div className="text-[15px] font-semibold tabular-nums leading-none text-slate-900 dark:text-white">
                    {k.engine.queueActive}
                  </div>
                  <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1">Analysing now</div>
                </div>
                <div>
                  <div className="text-[15px] font-semibold tabular-nums leading-none text-slate-900 dark:text-white">
                    {k.engine.queueDepth}
                  </div>
                  <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1">Waiting in queue</div>
                </div>
              </>
            )}
            {usage && Object.entries(usage.per_platform || {}).map(([platform, v]) => {
              const full = v.limit != null && v.active >= v.limit;
              return (
                <div key={platform} className="flex items-center gap-2.5">
                  <PlatformIcon platform={platform} size={26} />
                  <div>
                    <div className="text-[15px] font-semibold tabular-nums leading-none" style={{ color: full ? STATUS.critical : undefined }}>
                      <span className={full ? '' : 'text-slate-900 dark:text-white'}>{v.active}</span>
                      <span className="text-slate-400 dark:text-slate-500 font-normal">/{v.limit}</span>
                    </div>
                    <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1">
                      {full ? 'Full' : 'Active profiles'}
                    </div>
                  </div>
                </div>
              );
            })}
            {usage?.events && (
              <div>
                <div className="text-[15px] font-semibold tabular-nums leading-none text-slate-900 dark:text-white">
                  {usage.events.active}<span className="text-slate-400 dark:text-slate-500 font-normal">/{usage.events.limit}</span>
                </div>
                <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-1">Active events</div>
              </div>
            )}
            <span className="ml-auto text-[10.5px] text-slate-400 dark:text-slate-500">
              Updated {timeAgo(data.generated_at)} · auto-refreshes every 2 min
            </span>
          </div>
        </>
      )}
    </div>
  );
};

export default CommandCenter;
