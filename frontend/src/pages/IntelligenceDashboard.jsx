import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronRight,
  Circle,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Globe,
  Hash,
  KeyRound,
  Layers,
  MessageSquare,
  Minus,
  Monitor,
  Search,
  PieChart as PieChartIcon,
  RefreshCw,
  Shield,
  Tag,
  TrendingDown,
  TrendingUp,
  User,
  UserSearch,
  Users,
  Zap
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { exportAsPNG } from '../lib/chartExportUtils';
import { useTenant } from '../context/TenantContext';
import { useRbac } from '../contexts/RbacContext';
import { useScopedLocation } from '../hooks/useScopedLocation';

const EventsReportEmbed = lazy(() => import('./EventsReport'));
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS & UTILITIES
   ═══════════════════════════════════════════════════════════════════ */
const TABS = [
  { key: 'alerts', featureId: 'alerts_reports', label: 'Alerts Reports', icon: AlertTriangle, color: '#3b82f6', bg: 'bg-blue-50', border: 'border-blue-100', text: 'text-blue-700' },
  { key: 'grievances', featureId: 'grievances_reports', label: 'Grievances Reports', icon: MessageSquare, color: '#f59e0b', bg: 'bg-amber-50', border: 'border-amber-100', text: 'text-amber-700' },
  { key: 'profiles', featureId: 'profiles_reports', label: 'Profiles Reports', icon: UserSearch, color: '#8b5cf6', bg: 'bg-violet-50', border: 'border-violet-100', text: 'text-violet-700' },
  { key: 'events', featureId: 'events_report', label: 'Events Report', icon: CalendarDays, color: '#10b981', bg: 'bg-emerald-50', border: 'border-emerald-100', text: 'text-emerald-700' }
];

const PLATFORM_COLORS = { x: '#000000', youtube: '#FF0000', facebook: '#1877F2', instagram: '#E4405F', whatsapp: '#25D366', unknown: '#94a3b8' };
const PLATFORM_LABELS = { x: 'X (Twitter)', youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp', unknown: 'Other' };
const PLATFORM_BAR_ICONS = {
  x: <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>,
  youtube: <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></svg>,
  facebook: <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>,
  instagram: <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.757-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z" /></svg>,
  whatsapp: <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.008-.57-.008-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" /></svg>,
};
const RISK_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
const STATUS_COLORS = {
  generated: '#3b82f6', printed: '#8b5cf6', sent: '#10b981', sent_to_intermediary: '#f59e0b',
  awaiting_reply: '#ec4899', closed: '#64748b', active: '#3b82f6', acknowledged: '#8b5cf6',
  resolved: '#10b981', false_positive: '#94a3b8', escalated: '#ef4444',
  PENDING: '#f59e0b', ESCALATED: '#ef4444', CLOSED: '#64748b',
  received: '#3b82f6', reviewed: '#8b5cf6', action_taken: '#10b981', converted_to_fir: '#ef4444'
};
const CHART_PALETTE = ['#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#10b981', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1'];

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const numFmt = new Intl.NumberFormat('en-US');
const fmt = (v, compact = false) => {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '0';
  return compact ? compactFmt.format(n) : numFmt.format(n);
};
const prettify = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { delay: i * 0.05, duration: 0.35, ease: 'easeOut' } })
};
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.05 } } };

/* ═══════════════════════════════════════════════════════════════════
   SHARED SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════════ */
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-2xl backdrop-blur-sm">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <div className="space-y-1">
        {payload.map((e) => (
          <div key={e.name} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: e.color }} />
            <span className="text-xs text-slate-600">{e.name}:</span>
            <span className="text-xs font-bold text-slate-900">{fmt(e.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const GrowthBadge = ({ value }) => {
  const n = Number(value || 0);
  const pos = n > 0;
  const neutral = n === 0;
  const Icon = neutral ? Minus : pos ? TrendingUp : TrendingDown;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      neutral && 'bg-slate-100 text-slate-500',
      pos && 'bg-emerald-50 text-emerald-700',
      !pos && !neutral && 'bg-rose-50 text-rose-700'
    )}>
      <Icon className="h-3 w-3" />
      {`${n > 0 ? '+' : ''}${n.toFixed(1)}%`}
    </span>
  );
};

const ExportButton = ({ chartRef, title }) => {
  const handleExport = useCallback(async () => {
    const el = chartRef?.current;
    if (!el) return;
    const safeName = (title || 'chart').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    await exportAsPNG(el, safeName);
  }, [chartRef, title]);
  return (
    <button type="button" onClick={handleExport} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50">
      <Camera className="h-3.5 w-3.5" /> Export
    </button>
  );
};

const KpiCard = ({ label, value, icon: Icon, color, subtitle, growth, onClick, onDownload }) => {
  const SafeIcon = Icon || Activity;

  return (
    <motion.div
      variants={fadeUp}
      onClick={onClick}
      className={cn(
        'group relative overflow-hidden rounded-2xl border p-5 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg',
        onClick ? 'cursor-pointer' : 'cursor-default'
      )}
      style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}
    >
      <div className="absolute -right-3 -top-3 h-16 w-16 rounded-full opacity-20 blur-2xl" style={{ backgroundColor: color }} />
      <div className="flex items-start justify-between">
        <div className="rounded-xl border p-2" style={{ borderColor: `${color}30`, backgroundColor: `${color}15` }}>
          <SafeIcon className="h-4 w-4" style={{ color }} />
        </div>
        <div className="flex gap-1 items-center">
          {growth !== undefined && <GrowthBadge value={growth} />}
          {onDownload && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDownload(); }}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-blue-300 hover:bg-blue-50"
              title={`Download ${label}`}
            >
              <Download className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-3 text-3xl font-black tracking-tight text-slate-900">{fmt(value, true)}</p>
      <p className="mt-1 text-sm font-semibold" style={{ color }}>{label}</p>
      {subtitle && <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>}
    </motion.div>
  );
};

const ChartCard = React.forwardRef(({ title, subtitle, icon: Icon, iconColor, children, className, action = null }, ref) => (
  <div ref={ref} className={cn('rounded-2xl border border-slate-200 bg-white p-5 shadow-sm', className)}>
    <div className="mb-4 flex items-center justify-between">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
          {Icon && <Icon className="h-4 w-4" style={{ color: iconColor || '#3b82f6' }} />}
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {action}
        {ref && <ExportButton chartRef={ref} title={title} />}
      </div>
    </div>
    {children}
  </div>
));
ChartCard.displayName = 'ChartCard';

const EmptyState = ({ message }) => (
  <div className="flex h-[200px] items-center justify-center">
    <p className="text-sm text-slate-400">{message || 'No data available'}</p>
  </div>
);

/* ═══════════════════════════════════════════════════════════════════
   ALERTS INTELLIGENCE TAB
   ═══════════════════════════════════════════════════════════════════ */
const AlertsIntelligence = ({ data, dateFrom, dateTo, districtFilter, setDistrictFilter, districtOptions }) => {
  const refs = {
    riskTrend: useRef(null),
    riskDist: useRef(null),
    platformDist: useRef(null),
    escalations: useRef(null),
    escalationPlatform: useRef(null),
    actions: useRef(null),
    topAccounts: useRef(null),
    keywords: useRef(null),
    keywordMatches: useRef(null),
    reportStatus: useRef(null),
    accountsTrend: useRef(null),
    alertTypes: useRef(null),
    riskPlatform: useRef(null),
    alertStatus: useRef(null)
  };

  const [formalReports, setFormalReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportSearch, setReportSearch] = useState('');
  const [reportStatusFilter, setReportStatusFilter] = useState('all');
  const [reportPlatformFilter, setReportPlatformFilter] = useState('all');
  const [reportCategoryFilter, setReportCategoryFilter] = useState('all');
  const [reportRiskFilter, setReportRiskFilter] = useState('all');
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const [profilesModalOpen, setProfilesModalOpen] = useState(false);
  const [monitoredSources, setMonitoredSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [modalSearch, setModalSearch] = useState('');
  const [modalPlatformFilter, setModalPlatformFilter] = useState('all');
  const [modalCategoryFilter, setModalCategoryFilter] = useState('all');
  const [modalStatusFilter, setModalStatusFilter] = useState('all');
  const [escalationCounts, setEscalationCounts] = useState({});
  const [modalView, setModalView] = useState('overview'); // 'overview' | 'list'
  const [newProfilesModalOpen, setNewProfilesModalOpen] = useState(false);
  const [topAccountsModalOpen, setTopAccountsModalOpen] = useState(false);
  const [topKeywordsModalOpen, setTopKeywordsModalOpen] = useState(false);
  const navigate = useNavigate();

  const PROFILE_CATEGORIES = [
    { value: 'political', label: 'Political' },
    { value: 'communal', label: 'Communal' },
    { value: 'trouble_makers', label: 'Trouble Makers' },
    { value: 'defamation', label: 'Defamation' },
    { value: 'narcotics', label: 'Narcotics' },
    { value: 'history_sheeters', label: 'History Sheeters' },
    { value: 'others', label: 'Others' }
  ];

  const PROFILE_PLATFORM_ORDER = ['x', 'youtube', 'facebook', 'instagram', 'whatsapp'];

  const PROFILE_PLATFORM_THEMES = {
    x: { label: 'X', rowClass: 'bg-slate-200/70 hover:bg-slate-300/70', stickyClass: 'bg-slate-200/80', color: '#000000', dotClass: 'bg-black' },
    youtube: { label: 'YouTube', rowClass: 'bg-red-200/60 hover:bg-red-300/60', stickyClass: 'bg-red-200/75', color: '#FF0000', dotClass: 'bg-red-500' },
    facebook: { label: 'Facebook', rowClass: 'bg-blue-200/60 hover:bg-blue-300/60', stickyClass: 'bg-blue-200/75', color: '#1877F2', dotClass: 'bg-blue-500' },
    instagram: { label: 'Instagram', rowClass: 'bg-pink-200/60 hover:bg-pink-300/60', stickyClass: 'bg-pink-200/75', color: '#E4405F', dotClass: 'bg-pink-500' },
    whatsapp: { label: 'WhatsApp', rowClass: 'bg-emerald-200/60 hover:bg-emerald-300/60', stickyClass: 'bg-emerald-200/75', color: '#25D366', dotClass: 'bg-emerald-500' },
  };

  const PRIORITY_COLORS = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
  const RISK_BADGE_COLORS = { critical: '#7c2d12', high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };

  // Normalize a source's platform & category
  const normalizeSource = useCallback((source) => {
    let p = String(source?.platform || '').trim().toLowerCase();
    if (p === 'twitter') p = 'x';
    if (p === 'fb') p = 'facebook';
    if (p === 'yt') p = 'youtube';
    if (!p) p = 'unknown';
    const catSet = new Set(PROFILE_CATEGORIES.map(c => c.value));
    let c = String(source?.category || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!c || !catSet.has(c)) c = 'others';
    return { ...source, _normPlatform: p, _normCategory: c };
  }, []);

  const normalizedSources = useMemo(() => monitoredSources.map(normalizeSource), [monitoredSources, normalizeSource]);

  const profilesMatrix = useMemo(() => {
    const catKeys = PROFILE_CATEGORIES.map(c => c.value);
    const platformCounts = {};

    const mkCell = () => ({ total: 0, active: 0, inactive: 0 });

    normalizedSources.forEach(source => {
      const p = source._normPlatform;
      const c = source._normCategory;
      const active = source.is_active !== false;

      if (!platformCounts[p]) {
        platformCounts[p] = { _total: mkCell() };
        catKeys.forEach(k => { platformCounts[p][k] = mkCell(); });
      }
      platformCounts[p][c].total += 1;
      platformCounts[p][c][active ? 'active' : 'inactive'] += 1;
      platformCounts[p]._total.total += 1;
      platformCounts[p]._total[active ? 'active' : 'inactive'] += 1;
    });

    const extra = Object.keys(platformCounts).filter(p => !PROFILE_PLATFORM_ORDER.includes(p)).sort();
    const ordered = [...PROFILE_PLATFORM_ORDER, ...extra];
    const rows = ordered.filter(p => platformCounts[p]).map(p => ({ platform: p, counts: platformCounts[p] }));
    const totalsByCategory = catKeys.reduce((acc, k) => {
      const cell = mkCell();
      rows.forEach(r => {
        cell.total += r.counts[k].total;
        cell.active += r.counts[k].active;
        cell.inactive += r.counts[k].inactive;
      });
      acc[k] = cell;
      return acc;
    }, {});
    const grandTotal = mkCell();
    rows.forEach(r => {
      grandTotal.total += r.counts._total.total;
      grandTotal.active += r.counts._total.active;
      grandTotal.inactive += r.counts._total.inactive;
    });
    return { rows, totalsByCategory, grandTotal };
  }, [normalizedSources]);

  // Filtered sources for the profiles list view
  const filteredSources = useMemo(() => {
    let list = normalizedSources;
    if (modalPlatformFilter !== 'all') list = list.filter(s => s._normPlatform === modalPlatformFilter);
    if (modalCategoryFilter !== 'all') list = list.filter(s => s._normCategory === modalCategoryFilter);
    if (modalStatusFilter === 'active') list = list.filter(s => s.is_active !== false);
    if (modalStatusFilter === 'inactive') list = list.filter(s => s.is_active === false);
    if (modalSearch.trim()) {
      const q = modalSearch.trim().toLowerCase();
      list = list.filter(s =>
        (s.display_name || '').toLowerCase().includes(q) ||
        (s.identifier || '').toLowerCase().includes(q) ||
        (s.category || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [normalizedSources, modalPlatformFilter, modalCategoryFilter, modalStatusFilter, modalSearch]);

  // ─── Export Helpers ───
  const exportMatrixPDF = useCallback(() => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 24, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Profiles Being Monitored \u2014 Overview Matrix', 14, 12);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`Total: ${profilesMatrix.grandTotal.total} | Active: ${profilesMatrix.grandTotal.active} | Inactive: ${profilesMatrix.grandTotal.inactive} | Generated: ${new Date().toLocaleString('en-IN')}`, 14, 20);

    const head = [['Platform', ...PROFILE_CATEGORIES.map(c => c.label), 'Total']];
    const body = profilesMatrix.rows.map(row => {
      const theme = PROFILE_PLATFORM_THEMES[row.platform] || { label: row.platform };
      return [
        theme.label,
        ...PROFILE_CATEGORIES.map(cat => {
          const c = row.counts[cat.value] || { total: 0, active: 0, inactive: 0 };
          return `${c.total}\nActive: ${c.active}  |  Inactive: ${c.inactive}`;
        }),
        `${row.counts._total.total}\nActive: ${row.counts._total.active}  |  Inactive: ${row.counts._total.inactive}`
      ];
    });
    body.push([
      'ALL PLATFORMS',
      ...PROFILE_CATEGORIES.map(cat => {
        const c = profilesMatrix.totalsByCategory[cat.value] || { total: 0, active: 0, inactive: 0 };
        return `${c.total}\nActive: ${c.active}  |  Inactive: ${c.inactive}`;
      }),
      `${profilesMatrix.grandTotal.total}\nActive: ${profilesMatrix.grandTotal.active}  |  Inactive: ${profilesMatrix.grandTotal.inactive}`
    ]);

    autoTable(doc, {
      head, body, startY: 30,
      styles: { fontSize: 7, cellPadding: 2.5, halign: 'center', lineWidth: 0.1, lineColor: [200, 200, 200] },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: { 0: { halign: 'left', fontStyle: 'bold' } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [226, 232, 240];
        }
      }
    });
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) { doc.setPage(p); doc.setFontSize(7); doc.setTextColor(148, 163, 184); doc.text(`Page ${p}/${pageCount}`, 148, 205, { align: 'center' }); }
    doc.save(`profiles_matrix_${new Date().toISOString().split('T')[0]}.pdf`);
  }, [profilesMatrix]);

  const exportMatrixExcel = useCallback(() => {
    const rows = profilesMatrix.rows.map(row => {
      const theme = PROFILE_PLATFORM_THEMES[row.platform] || { label: row.platform };
      const obj = { 'Platform': theme.label };
      PROFILE_CATEGORIES.forEach(cat => {
        const c = row.counts[cat.value] || { total: 0, active: 0, inactive: 0 };
        obj[`${cat.label} - Total`] = c.total;
        obj[`${cat.label} - Active`] = c.active;
        obj[`${cat.label} - Inactive`] = c.inactive;
      });
      obj['Grand Total'] = row.counts._total.total;
      obj['Total Active'] = row.counts._total.active;
      obj['Total Inactive'] = row.counts._total.inactive;
      return obj;
    });
    const totalsRow = { 'Platform': 'ALL PLATFORMS' };
    PROFILE_CATEGORIES.forEach(cat => {
      const c = profilesMatrix.totalsByCategory[cat.value] || { total: 0, active: 0, inactive: 0 };
      totalsRow[`${cat.label} - Total`] = c.total;
      totalsRow[`${cat.label} - Active`] = c.active;
      totalsRow[`${cat.label} - Inactive`] = c.inactive;
    });
    totalsRow['Grand Total'] = profilesMatrix.grandTotal.total;
    totalsRow['Total Active'] = profilesMatrix.grandTotal.active;
    totalsRow['Total Inactive'] = profilesMatrix.grandTotal.inactive;
    rows.push(totalsRow);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Matrix');
    const meta = [{ Field: 'Report', Value: 'Profiles Being Monitored - Matrix' }, { Field: 'Total Profiles', Value: profilesMatrix.grandTotal.total }, { Field: 'Active', Value: profilesMatrix.grandTotal.active }, { Field: 'Inactive', Value: profilesMatrix.grandTotal.inactive }, { Field: 'Generated', Value: new Date().toLocaleString('en-IN') }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Info');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `profiles_matrix_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [profilesMatrix]);

  const exportProfilesPDF = useCallback(() => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 24, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Monitored Profiles \u2014 Detailed List', 14, 12);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`Total: ${filteredSources.length} profiles | Generated: ${new Date().toLocaleString('en-IN')}`, 14, 20);
    const head = [['#', 'Name', 'Handle', 'Platform', 'Category', 'Status', 'Escalations', 'Added']];
    const body = filteredSources.map((s, i) => {
      const theme = PROFILE_PLATFORM_THEMES[s._normPlatform] || { label: s._normPlatform };
      return [i + 1, s.display_name || s.identifier || '', s.identifier || '', theme.label, prettify(s._normCategory), s.is_active !== false ? 'Active' : 'Inactive', escalationCounts[s.id] || 0, s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : ''];
    });
    autoTable(doc, {
      head, body, startY: 30,
      styles: { fontSize: 6.5, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 10 } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 5) {
          data.cell.styles.textColor = data.cell.raw === 'Active' ? [22, 163, 74] : [220, 38, 38];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    });
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) { doc.setPage(p); doc.setFontSize(7); doc.setTextColor(148, 163, 184); doc.text(`Page ${p}/${pageCount}`, 148, 205, { align: 'center' }); }
    doc.save(`monitored_profiles_${new Date().toISOString().split('T')[0]}.pdf`);
  }, [filteredSources, escalationCounts]);

  const exportProfilesExcel = useCallback(() => {
    const rows = filteredSources.map((s, i) => {
      const theme = PROFILE_PLATFORM_THEMES[s._normPlatform] || { label: s._normPlatform };
      return { '#': i + 1, 'Name': s.display_name || s.identifier || '', 'Handle': s.identifier || '', 'Platform': theme.label, 'Category': prettify(s._normCategory), 'Status': s.is_active !== false ? 'Active' : 'Inactive', 'Escalations': escalationCounts[s.id] || 0, 'Date Added': s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '' };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Profiles');
    const meta = [{ Field: 'Report', Value: 'Monitored Profiles - Detailed List' }, { Field: 'Total', Value: filteredSources.length }, { Field: 'Active', Value: filteredSources.filter(s => s.is_active !== false).length }, { Field: 'Inactive', Value: filteredSources.filter(s => s.is_active === false).length }, { Field: 'Generated', Value: new Date().toLocaleString('en-IN') }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Info');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `monitored_profiles_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [filteredSources, escalationCounts]);

  // Profiles added in the selected date range
  const newProfilesInRange = useMemo(() => {
    if (!normalizedSources.length) return [];
    return normalizedSources.filter(s => {
      if (!s.created_at) return false;
      const d = new Date(s.created_at);
      if (dateFrom && d < new Date(dateFrom)) return false;
      if (dateTo) { const to = new Date(dateTo); to.setHours(23, 59, 59, 999); if (d > to) return false; }
      return true;
    });
  }, [normalizedSources, dateFrom, dateTo]);

  const exportNewProfilesPDF = useCallback(() => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFillColor(16, 185, 129);
    doc.rect(0, 0, 297, 24, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('New Profiles Added', 14, 12);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const rangeLabel = dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB')} – ${new Date(dateTo).toLocaleDateString('en-GB')}` : 'All time';
    doc.text(`${rangeLabel} | Total: ${newProfilesInRange.length} profiles | Generated: ${new Date().toLocaleString('en-IN')}`, 14, 20);
    const head = [['#', 'Name', 'Handle', 'Platform', 'Category', 'Status', 'Escalations', 'Added']];
    const body = newProfilesInRange.map((s, i) => {
      const theme = PROFILE_PLATFORM_THEMES[s._normPlatform] || { label: s._normPlatform };
      return [i + 1, s.display_name || s.identifier || '', s.identifier || '', theme.label, prettify(s._normCategory), s.is_active !== false ? 'Active' : 'Inactive', escalationCounts[s.id] || 0, s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : ''];
    });
    autoTable(doc, {
      head, body, startY: 30,
      styles: { fontSize: 6.5, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 10 } },
      alternateRowStyles: { fillColor: [236, 253, 245] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 5) {
          data.cell.styles.textColor = data.cell.raw === 'Active' ? [22, 163, 74] : [220, 38, 38];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    });
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) { doc.setPage(p); doc.setFontSize(7); doc.setTextColor(148, 163, 184); doc.text(`Page ${p}/${pageCount}`, 148, 205, { align: 'center' }); }
    doc.save(`new_profiles_${new Date().toISOString().split('T')[0]}.pdf`);
  }, [newProfilesInRange, dateFrom, dateTo, escalationCounts]);

  const exportNewProfilesExcel = useCallback(() => {
    const rows = newProfilesInRange.map((s, i) => {
      const theme = PROFILE_PLATFORM_THEMES[s._normPlatform] || { label: s._normPlatform };
      return { '#': i + 1, 'Name': s.display_name || s.identifier || '', 'Handle': s.identifier || '', 'Platform': theme.label, 'Category': prettify(s._normCategory), 'Status': s.is_active !== false ? 'Active' : 'Inactive', 'Escalations': escalationCounts[s.id] || 0, 'Date Added': s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '' };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'New Profiles');
    const rangeLabel = dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB')} – ${new Date(dateTo).toLocaleDateString('en-GB')}` : 'All time';
    const meta = [{ Field: 'Report', Value: 'New Profiles Added' }, { Field: 'Period', Value: rangeLabel }, { Field: 'Total', Value: newProfilesInRange.length }, { Field: 'Generated', Value: new Date().toLocaleString('en-IN') }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Info');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `new_profiles_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [newProfilesInRange, dateFrom, dateTo, escalationCounts]);

  const topAccounts = data?.topActiveAccounts || [];

  const exportTopAccountsPDF = useCallback(() => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFillColor(239, 68, 68);
    doc.rect(0, 0, 297, 24, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Top Active Accounts', 14, 12);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const rangeLabel = dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB')} \u2013 ${new Date(dateTo).toLocaleDateString('en-GB')}` : 'All time';
    doc.text(`${rangeLabel} | Total: ${topAccounts.length} accounts | Generated: ${new Date().toLocaleString('en-IN')}`, 14, 20);
    const head = [['#', 'Author', 'Handle', 'Platform', 'Total Alerts', 'High', 'Medium', 'Low']];
    const body = topAccounts.map((acc, i) => [i + 1, acc.author || '', acc.handle || '', PLATFORM_LABELS[acc.platform] || acc.platform, acc.alertCount, acc.highRisk, acc.mediumRisk, acc.lowRisk]);
    autoTable(doc, {
      head, body, startY: 30,
      styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [239, 68, 68], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 10 } },
      alternateRowStyles: { fillColor: [254, 242, 242] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 5) { data.cell.styles.textColor = [220, 38, 38]; data.cell.styles.fontStyle = 'bold'; }
        if (data.section === 'body' && data.column.index === 6) { data.cell.styles.textColor = [217, 119, 6]; data.cell.styles.fontStyle = 'bold'; }
        if (data.section === 'body' && data.column.index === 7) { data.cell.styles.textColor = [22, 163, 74]; data.cell.styles.fontStyle = 'bold'; }
      }
    });
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) { doc.setPage(p); doc.setFontSize(7); doc.setTextColor(148, 163, 184); doc.text(`Page ${p}/${pageCount}`, 148, 205, { align: 'center' }); }
    doc.save(`top_active_accounts_${new Date().toISOString().split('T')[0]}.pdf`);
  }, [topAccounts, dateFrom, dateTo]);

  const exportTopAccountsExcel = useCallback(() => {
    const rows = topAccounts.map((acc, i) => ({
      '#': i + 1, 'Author': acc.author || '', 'Handle': acc.handle || '', 'Platform': PLATFORM_LABELS[acc.platform] || acc.platform, 'Total Alerts': acc.alertCount, 'High Risk': acc.highRisk, 'Medium Risk': acc.mediumRisk, 'Low Risk': acc.lowRisk
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Top Accounts');
    const rangeLabel = dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB')} \u2013 ${new Date(dateTo).toLocaleDateString('en-GB')}` : 'All time';
    const meta = [{ Field: 'Report', Value: 'Top Active Accounts' }, { Field: 'Period', Value: rangeLabel }, { Field: 'Total Accounts', Value: topAccounts.length }, { Field: 'Total Alerts', Value: topAccounts.reduce((s, a) => s + a.alertCount, 0) }, { Field: 'Generated', Value: new Date().toLocaleString('en-IN') }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Info');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `top_active_accounts_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [topAccounts, dateFrom, dateTo]);

  useEffect(() => {
    if (profilesModalOpen && !sourcesLoaded && !sourcesLoading) {
      setSourcesLoading(true);
      Promise.all([
        api.get('/sources'),
        api.get('/sources/escalation-counts').catch(() => ({ data: {} }))
      ]).then(([srcRes, escRes]) => {
        const d = Array.isArray(srcRes.data) ? srcRes.data : (srcRes.data?.data || []);
        setMonitoredSources(d);
        setEscalationCounts(escRes.data || {});
        setSourcesLoaded(true);
      }).catch(() => {}).finally(() => setSourcesLoading(false));
    }
  }, [profilesModalOpen, sourcesLoaded, sourcesLoading]);

  // Also load sources when new profiles modal opens
  useEffect(() => {
    if (newProfilesModalOpen && !sourcesLoaded && !sourcesLoading) {
      setSourcesLoading(true);
      Promise.all([
        api.get('/sources'),
        api.get('/sources/escalation-counts').catch(() => ({ data: {} }))
      ]).then(([srcRes, escRes]) => {
        const d = Array.isArray(srcRes.data) ? srcRes.data : (srcRes.data?.data || []);
        setMonitoredSources(d);
        setEscalationCounts(escRes.data || {});
        setSourcesLoaded(true);
      }).catch(() => {}).finally(() => setSourcesLoading(false));
    }
  }, [newProfilesModalOpen, sourcesLoaded, sourcesLoading]);

  const fetchReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const params = { limit: 100 };
      if (reportSearch.trim()) params.search = reportSearch.trim();
      if (reportStatusFilter !== 'all') params.status = reportStatusFilter;
      if (reportPlatformFilter !== 'all') params.platform = reportPlatformFilter;
      if (reportCategoryFilter !== 'all') params.category = reportCategoryFilter;
      if (reportRiskFilter !== 'all') params.risk_level = reportRiskFilter;
      if (districtFilter !== 'all') params.district = districtFilter;
      if (reportDateFrom) params.startDate = reportDateFrom;
      if (reportDateTo) params.endDate = reportDateTo;
      const res = await api.get('/reports', { params });
      const data = res.data;
      setFormalReports(Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []);
    } catch { setFormalReports([]); }
    finally { setReportsLoading(false); }
  }, [reportSearch, reportStatusFilter, reportPlatformFilter, reportCategoryFilter, reportRiskFilter, districtFilter, reportDateFrom, reportDateTo]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const exportAlertsPDF = useCallback(() => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text('Alerts Reports', 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()}${reportDateFrom || reportDateTo ? ` | Date: ${reportDateFrom || '…'} → ${reportDateTo || '…'}` : ''}`, 14, 25);
    autoTable(doc, {
      startY: 30,
      head: [['Report ID', 'Target User', 'Handle', 'Category', 'Generated At', 'Status']],
      body: formalReports.map((r) => [
        r.serial_number || '',
        r.target_user_details?.name || '',
        r.target_user_details?.handle ? `@${r.target_user_details.handle.replace('@', '')}` : '',
        prettify(r.alert_data?.source_category || 'N/A'),
        r.generated_at ? new Date(r.generated_at).toLocaleDateString('en-GB') : '',
        prettify(r.status || '')
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [59, 130, 246], textColor: [255, 255, 255], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [239, 246, 255] },
    });
    doc.save('alerts_reports.pdf');
  }, [formalReports, reportDateFrom, reportDateTo]);

  const exportAlertsExcel = useCallback(() => {
    const rows = formalReports.map((r) => ({
      'Report ID': r.serial_number || '',
      'Target User': r.target_user_details?.name || '',
      'Handle': r.target_user_details?.handle ? `@${r.target_user_details.handle.replace('@', '')}` : '',
      'Category': prettify(r.alert_data?.source_category || 'N/A'),
      'Post Link': r.edited_content?.contentUrl || r.joined_content_url || '',
      'Generated At': r.generated_at ? new Date(r.generated_at).toLocaleDateString('en-GB') : '',
      'Status': prettify(r.status || '')
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Alerts Reports');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), 'alerts_reports.xlsx');
  }, [formalReports]);

  if (!data) return <EmptyState message="Loading alerts intelligence..." />;

  const riskDist = (data.riskAnalysis?.distribution || []).map(r => ({
    name: prettify(r.level), value: r.count, color: RISK_COLORS[r.level] || '#94a3b8', _raw: r.level
  }));

  const platformDist = (data.platformDistribution || []).map(r => ({
    name: PLATFORM_LABELS[r.platform] || r.platform, value: r.count, color: PLATFORM_COLORS[r.platform] || PLATFORM_COLORS.unknown
  }));

  const alertTypesData = (data.alertTypes || []).map((r, i) => ({
    name: prettify(r.type), value: r.count, color: CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const escalationStatusData = (data.escalations?.statusDistribution || []).map((r, i) => ({
    name: prettify(r.status), value: r.count, color: STATUS_COLORS[r.status] || CHART_PALETTE[i % CHART_PALETTE.length], _raw: r.status
  }));

  // Build platform-escalation cross tab
  const escByPlatformMap = {};
  (data.escalations?.byPlatform || []).forEach(({ platform, status, count }) => {
    if (!escByPlatformMap[platform]) escByPlatformMap[platform] = { platform: PLATFORM_LABELS[platform] || platform };
    escByPlatformMap[platform][prettify(status)] = count;
  });
  const escByPlatformData = Object.values(escByPlatformMap);
  const escStatuses = [...new Set((data.escalations?.byPlatform || []).map(r => prettify(r.status)))];

  const actionsData = (() => {
    const allPlatforms = ['x', 'youtube', 'facebook', 'instagram'];
    const raw = data.actions?.allTimeByPlatform || [];
    const map = {};
    raw.forEach(r => { map[r.platform] = r.count; });
    return allPlatforms.map(p => ({
      name: PLATFORM_LABELS[p] || p,
      value: map[p] || 0,
      color: PLATFORM_COLORS[p] || PLATFORM_COLORS.unknown,
      _raw: p
    }));
  })();

  const keywordCatData = (data.keywords?.byCategory || []).map((r, i) => ({
    name: prettify(r.category), total: r.total, active: r.active, color: CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const topKeywords = (data.keywords?.topMatched || []).slice(0, 12);

  const reportStatusData = (data.reportsFormatShare?.statusDistribution || []).map((r, i) => ({
    name: prettify(r.status), value: r.count, color: STATUS_COLORS[r.status] || CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const alertTrend = data.alertsTrend || [];

  const alertStatusData = (data.alertStatusSummary || []).map((r, i) => ({
    name: prettify(r.status), value: r.count, color: STATUS_COLORS[r.status] || CHART_PALETTE[i % CHART_PALETTE.length], _raw: r.status
  }));

  // Risk by platform cross-tab
  const riskPlatformMap = {};
  (data.riskAnalysis?.byPlatform || []).forEach(({ platform, riskLevel, count }) => {
    if (!riskPlatformMap[platform]) riskPlatformMap[platform] = { platform: PLATFORM_LABELS[platform] || platform };
    riskPlatformMap[platform][prettify(riskLevel)] = count;
  });
  const riskPlatformData = Object.values(riskPlatformMap);

  return (
    <motion.div initial="hidden" animate="visible" variants={stagger} className="space-y-5">
      {/* Top: KPI sidebar (right) + first chart row */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Left: charts */}
        <div className="space-y-5 xl:col-span-9">

      {/* Formal Reports Table */}
      <motion.div variants={fadeUp}>
        <ChartCard title="Alerts Reports" subtitle="Manage and export generated formal investigation notices" icon={FileText} iconColor="#3b82f6">
          {/* Filters Row */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 min-w-[180px] max-w-[280px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search name, handle, ID..."
                value={reportSearch}
                onChange={(e) => setReportSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchReports()}
                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-700 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
            {/* Status */}
            <select value={reportStatusFilter} onChange={(e) => setReportStatusFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
              <option value="all">All Status</option>
              <option value="sent_to_intermediary">Sent to Intermediary</option>
              <option value="closed">Closed</option>
            </select>
            {/* Platform */}
            <select value={reportPlatformFilter} onChange={(e) => setReportPlatformFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
              <option value="all">All Platforms</option>
              <option value="twitter">X (Twitter)</option>
              <option value="youtube">YouTube</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
            {/* Category */}
            <select value={reportCategoryFilter} onChange={(e) => setReportCategoryFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
              <option value="all">All Categories</option>
              <option value="political">Political</option>
              <option value="communal">Communal</option>
              <option value="trouble_makers">Trouble Makers</option>
              <option value="defamation">Defamation</option>
              <option value="narcotics">Narcotics</option>
              <option value="history_sheeters">History Sheeters</option>
              <option value="others">Others</option>
            </select>
            {/* Risk Level */}
            <select value={reportRiskFilter} onChange={(e) => setReportRiskFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
              <option value="all">All Risk</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            {/* Date From */}
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              <input type="date" value={reportDateFrom} onChange={(e) => setReportDateFrom(e.target.value)} className="border-0 bg-transparent text-xs text-slate-700 outline-none w-[105px]" />
            </div>
            <span className="text-[10px] text-slate-400">to</span>
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              <input type="date" value={reportDateTo} onChange={(e) => setReportDateTo(e.target.value)} className="border-0 bg-transparent text-xs text-slate-700 outline-none w-[105px]" />
            </div>
            {/* Clear */}
            {(reportSearch || reportStatusFilter !== 'all' || reportPlatformFilter !== 'all' || reportCategoryFilter !== 'all' || reportRiskFilter !== 'all' || reportDateFrom || reportDateTo) && (
              <button type="button" onClick={() => { setReportSearch(''); setReportStatusFilter('all'); setReportPlatformFilter('all'); setReportCategoryFilter('all'); setReportRiskFilter('all'); setReportDateFrom(''); setReportDateTo(''); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 transition-colors">
                <RefreshCw className="h-3 w-3" /> Clear
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={exportAlertsPDF} disabled={formalReports.length === 0} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-all hover:bg-blue-100 disabled:opacity-40">
                <Download className="h-3.5 w-3.5" /> PDF
              </button>
              <button type="button" onClick={exportAlertsExcel} disabled={formalReports.length === 0} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-all hover:bg-emerald-100 disabled:opacity-40">
                <Download className="h-3.5 w-3.5" /> Excel
              </button>
              <span className="text-[11px] font-medium text-slate-400">{formalReports.length} report{formalReports.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {reportsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />)}
            </div>
          ) : formalReports.length === 0 ? (
            <EmptyState message="No formal reports found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Report ID</th>
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Target User</th>
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Category</th>
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Post Link</th>
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Generated At</th>
                    <th className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Status</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {formalReports.slice(0, 10).map((report) => (
                    <tr key={report._id || report.id} className="border-b border-slate-50 transition-colors hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <Hash className="h-3 w-3 text-blue-500 shrink-0" />
                          <span className="font-mono text-xs font-bold text-slate-900">{report.serial_number}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center">
                            {report.target_user_details?.avatar_url ? (
                              <img src={report.target_user_details.avatar_url} className="h-full w-full object-cover" alt="" />
                            ) : (
                              <User className="h-4 w-4 text-slate-400" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-800 truncate">{report.target_user_details?.name}</p>
                            <p className="text-[10px] text-slate-400 truncate">@{report.target_user_details?.handle?.replace('@', '')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize" style={{ backgroundColor: '#8b5cf615', color: '#8b5cf6' }}>
                          {report.alert_data?.source_category || 'N/A'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {(report.edited_content?.contentUrl || report.joined_content_url) ? (
                          <a href={report.edited_content?.contentUrl || report.joined_content_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-medium">
                            <ExternalLink className="h-3 w-3" /> View Post
                          </a>
                        ) : <span className="text-slate-400 text-xs italic">N/A</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1 text-xs text-slate-600">
                          <CalendarDays className="h-3 w-3 shrink-0" />
                          {report.generated_at ? new Date(report.generated_at).toLocaleDateString('en-GB') : 'N/A'}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ backgroundColor: `${STATUS_COLORS[report.status] || '#94a3b8'}15`, color: STATUS_COLORS[report.status] || '#94a3b8' }}>
                          {prettify(report.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link to={`/reports/generate/${report.alert_id}`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                            <Eye className="h-3.5 w-3.5" />
                          </Link>
                          <Link to={`/reports/generate/${report.alert_id}?print=true`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                            <Download className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </motion.div>

      {/* Row 2: Merged Escalations Overview — status donut (left) + platform bars (right) */}
      <motion.div variants={fadeUp}>
        <ChartCard ref={refs.escalations} title="Escalations Overview" subtitle="Status distribution and total escalations per platform" icon={FileText} iconColor="#f59e0b">
          {(escalationStatusData.length || actionsData.length) ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* LEFT: Status donut */}
              <div className="flex flex-col items-center lg:border-r lg:border-slate-100 lg:pr-6">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                  Status Distribution
                </div>
                <div className="relative h-[200px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={escalationStatusData} dataKey="value" nameKey="name" innerRadius={48} outerRadius={76} paddingAngle={3} cornerRadius={4} className="cursor-pointer" onClick={() => navigate(`/alerts?status=reports`)}>
                        {escalationStatusData.map(e => <Cell key={e.name} fill={e.color} stroke="white" strokeWidth={2} />)}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <p className="text-xl font-black text-slate-900">{escalationStatusData.reduce((s, r) => s + r.value, 0)}</p>
                    <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">Total</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 w-full mt-1 px-1">
                  {escalationStatusData.map(e => (
                    <div key={e.name} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-1.5 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => navigate(`/alerts?status=reports`)}>
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: e.color }} />
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold text-slate-600 truncate">{e.name}</p>
                        <p className="text-xs font-black text-slate-900">{e.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* RIGHT: Total escalations per platform — horizontal bars */}
              <div className="flex flex-col min-h-[260px]">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 text-center lg:text-left">
                  Total Escalations per Platform
                </div>
                <div className="flex-1 flex flex-col justify-center gap-4 py-2">
                  {(() => {
                    const maxValue = Math.max(1, ...actionsData.map(d => d.value || 0));
                    return actionsData.map((item) => {
                      const value = item.value || 0;
                      // Width scales with value; 0-count rows still show an 8% colored pill.
                      const pct = Math.max(8, Math.round((value / maxValue) * 100));
                      const display = value >= 1000
                        ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`
                        : value;
                      const icon = PLATFORM_BAR_ICONS[item._raw];
                      return (
                        <button
                          key={item.name}
                          type="button"
                          onClick={() => { if (item._raw) navigate(`/alerts?status=reports&platform=${encodeURIComponent(item._raw)}`); }}
                          className="flex items-center gap-3 group cursor-pointer"
                        >
                          <span
                            className="flex items-center justify-center shrink-0 h-7 w-7 rounded-md"
                            style={{ backgroundColor: `${item.color}15`, color: item.color }}
                          >
                            {icon || <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />}
                          </span>
                          <span className="text-xs font-semibold text-slate-700 w-20 text-left truncate" title={item.name}>
                            {item.name}
                          </span>
                          <div className="flex-1 h-5 rounded-full bg-slate-100 overflow-hidden shadow-inner">
                            <div
                              className="h-full rounded-full transition-all duration-500 group-hover:brightness-110"
                              style={{ width: `${pct}%`, backgroundColor: item.color }}
                            />
                          </div>
                          <span className="text-sm font-extrabold text-slate-900 w-10 text-right tabular-nums">
                            {display}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          ) : <EmptyState />}
        </ChartCard>
      </motion.div>


        </div>

        {/* Right: KPI tiles stacked vertically */}
        <motion.div variants={stagger} className="flex flex-col gap-4 xl:col-span-3">
          <KpiCard label="Total Profiles" value={data.accounts?.total} icon={Users} color="#3b82f6" subtitle={`${data.accounts?.active || 0} active`} onClick={() => setProfilesModalOpen(true)} />

          {/* Combined Risk Distribution + Alert Status Summary */}
          <motion.div variants={fadeUp} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h4 className="flex items-center gap-2 text-xs font-bold text-slate-800 mb-3">
              <PieChartIcon className="h-3.5 w-3.5 text-violet-500" />
              Alert Summary
            </h4>

            {/* Risk Distribution Donut */}
            {riskDist.length > 0 && (
              <div className="relative h-[140px] mb-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={riskDist} dataKey="value" nameKey="name" innerRadius={38} outerRadius={60} paddingAngle={3} cornerRadius={3} className="cursor-pointer" onClick={(entry) => { if (entry?._raw) navigate(`/alerts?category=${encodeURIComponent(entry._raw)}`); }}>
                      {riskDist.map(e => <Cell key={e.name} fill={e.color} stroke="white" strokeWidth={2} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <p className="text-lg font-black text-slate-900">{fmt(riskDist.reduce((s, r) => s + r.value, 0), true)}</p>
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">Alerts</p>
                </div>
              </div>
            )}

            {/* Risk legend */}
            <div className="space-y-1 mb-3">
              {riskDist.map(r => (
                <button key={r.name} type="button" onClick={() => navigate(`/alerts?category=${encodeURIComponent(r._raw)}`)} className="flex w-full items-center justify-between px-1.5 py-1 rounded-md transition-colors hover:bg-slate-50 group cursor-pointer">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: r.color }} />
                    <span className="text-[11px] font-medium text-slate-600 group-hover:text-slate-900">{r.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-bold text-slate-800">{fmt(r.value)}</span>
                    <ExternalLink className="h-2.5 w-2.5 text-slate-300 group-hover:text-slate-500 transition-colors" />
                  </div>
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="border-t border-slate-100 my-2" />

            {/* Alert Status Donut */}
            <h5 className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 mb-2">
              <Activity className="h-3 w-3 text-indigo-500" />
              Alert Status
            </h5>
            {alertStatusData.length > 0 && (
              <div className="relative h-[130px] mb-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={alertStatusData} dataKey="value" nameKey="name" innerRadius={34} outerRadius={55} paddingAngle={2} cornerRadius={3} className="cursor-pointer" onClick={(entry) => { if (entry?._raw) navigate(`/alerts?status=${encodeURIComponent(entry._raw)}`); }}>
                      {alertStatusData.map(e => <Cell key={e.name} fill={e.color} stroke="white" strokeWidth={2} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <p className="text-base font-black text-slate-900">{fmt(alertStatusData.reduce((s, r) => s + r.value, 0), true)}</p>
                  <p className="text-[8px] font-semibold uppercase tracking-widest text-slate-400">Total</p>
                </div>
              </div>
            )}
            <div className="space-y-1">
              {alertStatusData.map(s => (
                <button key={s.name} type="button" onClick={() => navigate(`/alerts?status=${encodeURIComponent(s._raw)}`)} className="flex w-full items-center justify-between px-1.5 py-1 rounded-md transition-colors hover:bg-slate-50 group cursor-pointer">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-[11px] font-medium text-slate-600 group-hover:text-slate-900">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-bold text-slate-800">{fmt(s.value)}</span>
                    <ExternalLink className="h-2.5 w-2.5 text-slate-300 group-hover:text-slate-500 transition-colors" />
                  </div>
                </button>
              ))}
            </div>
          </motion.div>

          <KpiCard label="Reports Generated" value={data.actions?.total} icon={FileText} color="#8b5cf6" growth={data.actions?.changePct} />
          <KpiCard label="New Profiles Added" value={data.accounts?.addedInRange || 0} icon={TrendingUp} color="#10b981" subtitle={dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})} – ${new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})}` : 'In selected range'} onClick={() => setNewProfilesModalOpen(true)} />
          <KpiCard label="Top Active Accounts" value={topAccounts.length} icon={Activity} color="#ef4444" subtitle={dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})} \u2013 ${new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})}` : 'Most flagged accounts'} onClick={() => setTopAccountsModalOpen(true)} />
          <KpiCard label="Top Keywords" value={topKeywords.length} icon={KeyRound} color="#f59e0b" subtitle="Matched keywords" onClick={() => setTopKeywordsModalOpen(true)} />
        </motion.div>
      </div>

      {/* Profiles Being Monitored Modal */}
      <Dialog open={profilesModalOpen} onOpenChange={(open) => { setProfilesModalOpen(open); if (!open) { setModalSearch(''); setModalPlatformFilter('all'); setModalCategoryFilter('all'); setModalStatusFilter('all'); setModalView('overview'); } }}>
        <DialogContent className="w-[96vw] max-w-7xl max-h-[94vh] overflow-hidden p-0">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-blue-50/30">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-900">Profiles Being Monitored</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-slate-500 mt-1">Complete overview of all monitored social media profiles across platforms and categories</p>
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: 'calc(94vh - 72px)' }}>
            {sourcesLoading && normalizedSources.length === 0 ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />)}
              </div>
            ) : normalizedSources.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-16">No monitored profiles found.</p>
            ) : (
              <div className="p-5 space-y-5">
                {/* Summary KPI Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 text-center">
                    <p className="text-2xl font-black text-blue-700">{profilesMatrix.grandTotal.total.toLocaleString()}</p>
                    <p className="text-[11px] font-semibold text-blue-600 mt-0.5">Total Profiles</p>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 text-center">
                    <p className="text-2xl font-black text-emerald-700">{profilesMatrix.grandTotal.active.toLocaleString()}</p>
                    <p className="text-[11px] font-semibold text-emerald-600 mt-0.5">Active</p>
                  </div>
                  <div className="rounded-xl border border-red-200 bg-red-50/60 p-3.5 text-center">
                    <p className="text-2xl font-black text-red-700">{profilesMatrix.grandTotal.inactive.toLocaleString()}</p>
                    <p className="text-[11px] font-semibold text-red-600 mt-0.5">Inactive</p>
                  </div>
                  {/* Platform breakdown mini cards */}
                  {profilesMatrix.rows.slice(0, 3).map(row => {
                    const theme = PROFILE_PLATFORM_THEMES[row.platform] || { label: row.platform, dotClass: 'bg-slate-400' };
                    return (
                      <div key={row.platform} className="rounded-xl border border-slate-200 bg-white p-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5 mb-1">
                          <span className={`h-2 w-2 rounded-full ${theme.dotClass}`} />
                          <p className="text-[11px] font-semibold text-slate-500">{theme.label}</p>
                        </div>
                        <p className="text-xl font-black text-slate-800">{row.counts._total.total.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-400">{row.counts._total.active} active &middot; {row.counts._total.inactive} inactive</p>
                      </div>
                    );
                  })}
                </div>

                {/* Toolbar: View Toggle + Export */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setModalView('overview')} className={cn('px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all', modalView === 'overview' ? 'bg-slate-900 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
                      Overview Matrix
                    </button>
                    <button type="button" onClick={() => setModalView('list')} className={cn('px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all', modalView === 'list' ? 'bg-slate-900 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
                      All Profiles ({normalizedSources.length.toLocaleString()})
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={modalView === 'overview' ? exportMatrixPDF : exportProfilesPDF} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-red-300 hover:bg-red-50 hover:text-red-700">
                      <Download className="h-3.5 w-3.5" /> PDF
                    </button>
                    <button type="button" onClick={modalView === 'overview' ? exportMatrixExcel : exportProfilesExcel} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700">
                      <Download className="h-3.5 w-3.5" /> Excel
                    </button>
                  </div>
                </div>

                {/* Overview Matrix View */}
                {modalView === 'overview' && (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse min-w-[700px]">
                        <thead>
                          <tr className="bg-slate-800 text-white">
                            <th className="text-left px-3 py-2.5 font-semibold sticky left-0 bg-slate-800 z-10 min-w-[130px] border-r border-slate-600">Platform</th>
                            {PROFILE_CATEGORIES.map(cat => (
                              <th key={cat.value} className="text-center px-2.5 py-2.5 font-semibold whitespace-nowrap border-r border-slate-600">{cat.label}</th>
                            ))}
                            <th className="text-center px-2.5 py-2.5 font-bold bg-blue-900/50 whitespace-nowrap">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {profilesMatrix.rows.map(row => {
                            const theme = PROFILE_PLATFORM_THEMES[row.platform] || { label: row.platform, rowClass: 'bg-amber-50 hover:bg-amber-100', stickyClass: 'bg-amber-50', dotClass: 'bg-slate-400' };
                            return (
                              <tr key={row.platform} className={`border-b border-slate-200 ${theme.rowClass}`}>
                                <td className={`px-3 py-2.5 sticky left-0 z-10 border-r border-slate-200 font-semibold ${theme.stickyClass}`}>
                                  <div className="flex items-center gap-2">
                                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${theme.dotClass}`} />
                                    {theme.label}
                                  </div>
                                </td>
                                {PROFILE_CATEGORIES.map(cat => {
                                  const cell = row.counts[cat.value] || { total: 0 };
                                  return (
                                    <td key={`${row.platform}-${cat.value}`} className="text-center px-2.5 py-2.5 tabular-nums border-r border-slate-100 font-bold text-slate-900">{cell.total || <span className="text-slate-300">&mdash;</span>}</td>
                                  );
                                })}
                                <td className="text-center px-2.5 py-2.5 tabular-nums font-black text-slate-900 bg-blue-50/50">{row.counts._total.total}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-slate-400 bg-slate-800 text-white font-semibold">
                            <td className="px-3 py-2.5 sticky left-0 z-10 bg-slate-800 border-r border-slate-600 font-bold">All Platforms</td>
                            {PROFILE_CATEGORIES.map(cat => {
                              const cell = profilesMatrix.totalsByCategory[cat.value] || { total: 0 };
                              return (
                                <td key={`ft-${cat.value}`} className="text-center px-2.5 py-2.5 tabular-nums border-r border-slate-600/50 font-bold">{cell.total}</td>
                              );
                            })}
                            <td className="text-center px-2.5 py-2.5 tabular-nums font-black bg-blue-900/40">{profilesMatrix.grandTotal.total}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Detailed List View */}
                {modalView === 'list' && (
                  <div className="space-y-3">
                    {/* Filters Row */}
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative flex-1 min-w-[200px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                        <input
                          type="text"
                          placeholder="Search by name or handle..."
                          value={modalSearch}
                          onChange={(e) => setModalSearch(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs text-slate-700 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
                        />
                      </div>
                      <select value={modalPlatformFilter} onChange={(e) => setModalPlatformFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
                        <option value="all">All Platforms</option>
                        {PROFILE_PLATFORM_ORDER.filter(p => normalizedSources.some(s => s._normPlatform === p)).map(p => (
                          <option key={p} value={p}>{(PROFILE_PLATFORM_THEMES[p]?.label || p)}</option>
                        ))}
                      </select>
                      <select value={modalCategoryFilter} onChange={(e) => setModalCategoryFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
                        <option value="all">All Categories</option>
                        {PROFILE_CATEGORIES.map(cat => (
                          <option key={cat.value} value={cat.value}>{cat.label}</option>
                        ))}
                      </select>
                      <select value={modalStatusFilter} onChange={(e) => setModalStatusFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 focus:border-blue-300 focus:outline-none">
                        <option value="all">All Status</option>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>

                      <span className="text-[11px] text-slate-400 font-medium ml-auto">
                        Showing {filteredSources.length.toLocaleString()} of {normalizedSources.length.toLocaleString()}
                      </span>
                    </div>

                    {/* Profiles Table */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="overflow-x-auto" style={{ maxHeight: '52vh' }}>
                        <table className="w-full text-xs border-collapse">
                          <thead className="bg-slate-100 sticky top-0 z-10">
                            <tr>
                              <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">#</th>
                              <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Profile</th>
                              <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Platform</th>
                              <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Category</th>
                              <th className="text-center px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Status</th>
                              <th className="text-center px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Escalations</th>
                              <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Added</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredSources.length === 0 ? (
                              <tr><td colSpan={7} className="text-center py-10 text-sm text-slate-400">No profiles match the current filters.</td></tr>
                            ) : filteredSources.map((source, idx) => {
                              const theme = PROFILE_PLATFORM_THEMES[source._normPlatform] || { label: source._normPlatform, dotClass: 'bg-slate-400', color: '#94a3b8' };
                              const isActive = source.is_active !== false;
                              return (
                                <tr key={source._id || source.id || idx} className="border-b border-slate-100 transition-colors hover:bg-slate-50 cursor-pointer" onClick={() => {
                                    const handle = source.identifier;
                                    const platform = source._normPlatform;
                                    if (platform === 'x') navigate(`/x-monitor?handle=${encodeURIComponent(handle)}`);
                                    else if (platform === 'instagram') navigate(source.id ? `/instagram-monitor/${source.id}` : '/instagram-monitor');
                                    else if (platform === 'youtube') navigate('/youtube-monitor');
                                    else if (platform === 'facebook') navigate('/facebook-monitor');
                                    else navigate(`/alerts?search=${encodeURIComponent(handle)}`);
                                    setProfilesModalOpen(false);
                                  }}>
                                  <td className="px-3 py-2.5 text-[11px] font-medium text-slate-400 tabular-nums">{idx + 1}</td>
                                  <td className="px-3 py-2.5">
                                    <div className="flex items-center gap-2.5">
                                      <div className="h-8 w-8 rounded-full bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center">
                                        {source.profile_image_url ? (
                                          <img src={source.profile_image_url} className="h-full w-full object-cover" alt="" />
                                        ) : (
                                          <User className="h-4 w-4 text-slate-400" />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <p className="text-xs font-semibold text-slate-800 truncate max-w-[180px] group-hover:text-blue-600">{source.display_name || source.identifier}</p>
                                        <p className="text-[10px] text-slate-400 truncate max-w-[180px]">@{source.identifier}</p>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: `${theme.color}12`, color: theme.color }}>
                                      <span className={`h-1.5 w-1.5 rounded-full ${theme.dotClass}`} />
                                      {theme.label}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize bg-violet-50 text-violet-700">
                                      {prettify(source._normCategory)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600')}>
                                      <Circle className={cn('h-1.5 w-1.5 fill-current', isActive ? 'text-emerald-500' : 'text-red-400')} />
                                      {isActive ? 'Active' : 'Inactive'}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className={`inline-flex items-center justify-center min-w-[28px] rounded-full px-2 py-0.5 text-[10px] font-bold ${(escalationCounts[source.id] || 0) > 0 ? 'bg-purple-50 text-purple-700' : 'bg-slate-50 text-slate-400'}`}>
                                      {escalationCounts[source.id] || 0}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className="text-[11px] text-slate-500">
                                      {source.created_at ? new Date(source.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* New Profiles Added Modal */}
      <Dialog open={newProfilesModalOpen} onOpenChange={setNewProfilesModalOpen}>
        <DialogContent className="w-[96vw] max-w-5xl max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-emerald-50/50 to-slate-50">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-900">New Profiles Added</DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-slate-500">
                {dateFrom && dateTo
                  ? <>{new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} – {new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} &middot; <span className="font-semibold text-emerald-700">{newProfilesInRange.length} profiles</span></>
                  : <><span className="font-semibold text-emerald-700">{newProfilesInRange.length} profiles</span> added (no date range selected — showing all)</>}
              </p>
              {newProfilesInRange.length > 0 && (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={exportNewProfilesPDF} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-red-300 hover:bg-red-50 hover:text-red-700">
                    <Download className="h-3 w-3" /> PDF
                  </button>
                  <button type="button" onClick={exportNewProfilesExcel} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700">
                    <Download className="h-3 w-3" /> Excel
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(90vh - 80px)' }}>
            {sourcesLoading && newProfilesInRange.length === 0 ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4].map(i => <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />)}
              </div>
            ) : newProfilesInRange.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-16">No profiles added in this period.</p>
            ) : (
              <div className="p-4">
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto" style={{ maxHeight: '62vh' }}>
                    <table className="w-full text-xs border-collapse">
                      <thead className="bg-slate-100 sticky top-0 z-10">
                        <tr>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">#</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Profile</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Platform</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Category</th>
                          <th className="text-center px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Status</th>
                          <th className="text-center px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Priority</th>
                          <th className="text-center px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Risk</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Added On</th>
                        </tr>
                      </thead>
                      <tbody>
                        {newProfilesInRange.map((source, idx) => {
                          const theme = PROFILE_PLATFORM_THEMES[source._normPlatform] || { label: source._normPlatform, dotClass: 'bg-slate-400', color: '#94a3b8' };
                          const isActive = source.is_active !== false;
                          return (
                            <tr key={source._id || source.id || idx} className="border-b border-slate-100 transition-colors hover:bg-slate-50">
                              <td className="px-3 py-2.5 text-[11px] font-medium text-slate-400 tabular-nums">{idx + 1}</td>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  <div className="h-8 w-8 rounded-full bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center">
                                    {source.profile_image_url ? (
                                      <img src={source.profile_image_url} className="h-full w-full object-cover" alt="" />
                                    ) : (
                                      <User className="h-4 w-4 text-slate-400" />
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold text-slate-800 truncate max-w-[180px]">{source.display_name || source.identifier}</p>
                                    <p className="text-[10px] text-slate-400 truncate max-w-[180px]">@{source.identifier}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: `${theme.color}12`, color: theme.color }}>
                                  <span className={`h-1.5 w-1.5 rounded-full ${theme.dotClass}`} />
                                  {theme.label}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize bg-violet-50 text-violet-700">
                                  {prettify(source._normCategory)}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600')}>
                                  <Circle className={cn('h-1.5 w-1.5 fill-current', isActive ? 'text-emerald-500' : 'text-red-400')} />
                                  {isActive ? 'Active' : 'Inactive'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold capitalize" style={{ backgroundColor: `${PRIORITY_COLORS[source.priority] || '#94a3b8'}15`, color: PRIORITY_COLORS[source.priority] || '#94a3b8' }}>
                                  {source.priority || 'medium'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold capitalize" style={{ backgroundColor: `${RISK_BADGE_COLORS[source.risk_level] || '#94a3b8'}15`, color: RISK_BADGE_COLORS[source.risk_level] || '#94a3b8' }}>
                                  {source.risk_level || 'low'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="text-[11px] text-slate-500">
                                  {source.created_at ? new Date(source.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '\u2014'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Top Active Accounts Modal */}
      <Dialog open={topAccountsModalOpen} onOpenChange={setTopAccountsModalOpen}>
        <DialogContent className="w-[96vw] max-w-5xl max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-red-50/50 to-slate-50">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-900">Top Active Accounts</DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-slate-500">
                {dateFrom && dateTo
                  ? <>{new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} \u2013 {new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} &middot; <span className="font-semibold text-red-700">{topAccounts.length} accounts</span></>
                  : <>Most flagged accounts &middot; <span className="font-semibold text-red-700">{topAccounts.length} accounts</span></>}
              </p>
              {topAccounts.length > 0 && (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={exportTopAccountsPDF} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-red-300 hover:bg-red-50 hover:text-red-700">
                    <Download className="h-3 w-3" /> PDF
                  </button>
                  <button type="button" onClick={exportTopAccountsExcel} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-all hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700">
                    <Download className="h-3 w-3" /> Excel
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(90vh - 80px)' }}>
            {topAccounts.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-16">No account data available.</p>
            ) : (
              <div className="p-4">
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto" style={{ maxHeight: '62vh' }}>
                    <table className="w-full text-xs border-collapse">
                      <thead className="bg-slate-100 sticky top-0 z-10">
                        <tr>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">#</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Account</th>
                          <th className="text-left px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Platform</th>
                          <th className="text-right px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Total Alerts</th>
                          <th className="text-right px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">High</th>
                          <th className="text-right px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Medium</th>
                          <th className="text-right px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Low</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topAccounts.map((acc, idx) => (
                          <tr key={idx} className="border-b border-slate-100 transition-colors hover:bg-slate-50">
                            <td className="px-3 py-2.5 text-[11px] font-medium text-slate-400 tabular-nums">{idx + 1}</td>
                            <td className="px-3 py-2.5">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-800 truncate max-w-[200px]">{acc.author}</p>
                                <p className="text-[10px] text-slate-400 truncate max-w-[200px]">@{acc.handle}</p>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: `${PLATFORM_COLORS[acc.platform] || '#94a3b8'}15`, color: PLATFORM_COLORS[acc.platform] || '#94a3b8' }}>
                                {PLATFORM_LABELS[acc.platform] || acc.platform}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right text-sm font-black text-slate-900">{acc.alertCount}</td>
                            <td className="px-3 py-2.5 text-right"><span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">{acc.highRisk}</span></td>
                            <td className="px-3 py-2.5 text-right"><span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-700">{acc.mediumRisk}</span></td>
                            <td className="px-3 py-2.5 text-right"><span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-700">{acc.lowRisk}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Top Keywords Modal */}
      <Dialog open={topKeywordsModalOpen} onOpenChange={setTopKeywordsModalOpen}>
        <DialogContent className="w-[96vw] max-w-2xl max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-amber-50/50 to-slate-50">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-900">Top Matched Keywords</DialogTitle>
            </DialogHeader>
            <p className="text-xs text-slate-500 mt-1">
              {dateFrom && dateTo
                ? <>{new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} \u2013 {new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})} &middot; <span className="font-semibold text-amber-700">{topKeywords.length} keywords</span></>
                : <>Most triggered keywords &middot; <span className="font-semibold text-amber-700">{topKeywords.length} keywords</span></>}
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">Click any keyword to view all matching posts</p>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(90vh - 100px)' }}>
            {topKeywords.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-16">No keyword data available.</p>
            ) : (
              <div className="p-4 space-y-2">
                {topKeywords.slice(0, 10).map((kw, idx) => {
                  const maxCount = topKeywords[0]?.count || 1;
                  const pct = Math.round((kw.count / maxCount) * 100);
                  const color = CHART_PALETTE[idx % CHART_PALETTE.length];
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => { setTopKeywordsModalOpen(false); navigate(`/alerts?search=${encodeURIComponent(kw.keyword)}`); }}
                      className="w-full text-left group rounded-xl border border-slate-200 bg-white px-4 py-3 transition-all hover:border-amber-300 hover:shadow-md hover:bg-amber-50/30 cursor-pointer"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2.5">
                          <span className="flex items-center justify-center h-6 w-6 rounded-full text-[10px] font-black text-white" style={{ backgroundColor: color }}>{idx + 1}</span>
                          <span className="text-sm font-semibold text-slate-800 group-hover:text-amber-800 transition-colors">{kw.keyword}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-slate-900 tabular-nums">{kw.count}</span>
                          <span className="text-[10px] text-slate-400">matches</span>
                          <ExternalLink className="h-3.5 w-3.5 text-slate-300 group-hover:text-amber-500 transition-colors" />
                        </div>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </motion.div>
  );
};

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   GRIEVANCES INTELLIGENCE TAB
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
const GrievancesIntelligence = ({ data, dateFrom, dateTo, districtFilter, setDistrictFilter, districtOptions }) => {
  const refs = {
    trend: useRef(null),
    classification: useRef(null),
    priority: useRef(null),
    gwrCategory: useRef(null),
    suggCategory: useRef(null),
    critCategory: useRef(null),
    sentiment: useRef(null),
  };

  const [allReports, setAllReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const [reportTypeFilter, setReportTypeFilter] = useState('all');
  const [reportsModalOpen, setReportsModalOpen] = useState(false);
  const [reportsModalType, setReportsModalType] = useState('all');
  const [profilePlatform, setProfilePlatform] = useState('all');
  const [posterPlatform, setPosterPlatform] = useState('all');
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAllReports = async () => {
      setReportsLoading(true);
      try {
        const params = {
          limit: 500,
          ...(reportDateFrom ? { from: reportDateFrom } : {}),
          ...(reportDateTo ? { to: reportDateTo } : {}),
          ...(districtFilter !== 'all' ? { district: districtFilter } : {})
        };
        const [gwRes, critRes, suggRes] = await Promise.all([
          api.get('/grievance-workflow/reports', { params }).catch(() => ({ data: { reports: [] } })),
          api.get('/criticism/reports', { params }).catch(() => ({ data: { reports: [] } })),
          api.get('/suggestion/reports', { params }).catch(() => ({ data: { reports: [] } }))
        ]);
        const gw = (gwRes.data?.reports || []).map(r => ({ ...r, _type: 'grievance' }));
        const cr = (critRes.data?.reports || []).map(r => ({ ...r, _type: 'criticism' }));
        const sg = (suggRes.data?.reports || []).map(r => ({ ...r, _type: 'suggestion' }));
        const merged = [...gw, ...cr, ...sg].sort((a, b) => new Date(b.post_date || b.created_at) - new Date(a.post_date || a.created_at));
        setAllReports(merged);
      } catch {
        setAllReports([]);
      } finally {
        setReportsLoading(false);
      }
    };
    fetchAllReports();
  }, [reportDateFrom, reportDateTo, districtFilter]);

  const grievanceWorkflowReports = allReports.filter(r => r._type === 'grievance');
  const filteredReports = reportTypeFilter === 'all' ? allReports : allReports.filter(r => r._type === reportTypeFilter);
  const openReportsModal = (type = 'all') => {
    setReportsModalType(type);
    setReportsModalOpen(true);
  };

  const TYPE_BADGE = {
    grievance: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'Grievance' },
    criticism: { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', label: 'Criticism' },
    suggestion: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Suggestion' },
  };

  const REPORT_MODAL_THEME = {
    all: { title: 'Reports in Date Range', subtitle: 'All reports', tone: 'blue', header: 'from-blue-50/60 to-cyan-50/40', row: 'hover:bg-blue-50/20', button: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100', th: 'text-blue-700', thead: 'bg-blue-50/70' },
    grievance: { title: 'Grievance Reports', subtitle: 'Showing grievance workflow reports only', tone: 'amber', header: 'from-amber-50/60 to-orange-50/40', row: 'hover:bg-amber-50/20', button: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100', th: 'text-amber-700', thead: 'bg-amber-50/70' },
    suggestion: { title: 'Suggestion Reports', subtitle: 'Showing suggestion reports only', tone: 'emerald', header: 'from-emerald-50/60 to-green-50/40', row: 'hover:bg-emerald-50/20', button: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100', th: 'text-emerald-700', thead: 'bg-emerald-50/70' },
    criticism: { title: 'Criticism Reports', subtitle: 'Showing criticism reports only', tone: 'pink', header: 'from-pink-50/60 to-rose-50/40', row: 'hover:bg-pink-50/20', button: 'border-pink-200 bg-pink-50 text-pink-700 hover:bg-pink-100', th: 'text-pink-700', thead: 'bg-pink-50/70' },
  };
  const activeModalTheme = REPORT_MODAL_THEME[reportsModalType] || REPORT_MODAL_THEME.all;
  const modalReports = reportsModalType === 'all' ? allReports : allReports.filter(r => r._type === reportsModalType);
  const exportModalPDF = () => {
    exportReportsPDF(modalReports, `kpi_${reportsModalType}_reports`, reportsModalType, activeModalTheme.title);
  };
  const exportModalExcel = () => {
    exportReportsExcel(modalReports, `kpi_${reportsModalType}_reports`);
  };

  if (!data) return <EmptyState message="Loading grievances intelligence..." />;

  const platformData = (data.byPlatform || []).map(r => ({
    name: PLATFORM_LABELS[r.platform] || r.platform,
    value: r.count,
    color: PLATFORM_COLORS[r.platform] || PLATFORM_COLORS.unknown,
    _raw: r.platform
  }));

  const workflowData = (data.workflowStatus || []).map((r, i) => ({
    name: prettify(r.status),
    value: r.count,
    color: STATUS_COLORS[r.status] || CHART_PALETTE[i % CHART_PALETTE.length],
    _raw: r.status
  }));

  const gwrCategoryData = (data.grievanceReports?.categoryDistribution || []).map((r, i) => ({
    name: r.category,
    value: r.count,
    color: CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const suggCategoryData = (data.suggestions?.categoryDistribution || []).map((r, i) => ({
    name: r.category,
    value: r.count,
    color: CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const critCategoryData = (data.criticism?.categoryDistribution || []).map((r, i) => ({
    name: r.category,
    value: r.count,
    color: CHART_PALETTE[i % CHART_PALETTE.length]
  }));

  const trendData = data.dailyTrend || [];

  const sentimentData = (data.sentiment || []).map(r => ({
    name: prettify(r.sentiment),
    value: r.count,
    color: r.sentiment === 'positive' ? '#22c55e' : r.sentiment === 'negative' ? '#ef4444' : '#94a3b8'
  }));

  // Sentiment comes from the sentiment service (services/sentiment grievance target).
  const sentimentTotals = (data.sentiment || []).reduce((acc, r) => ({
    ...acc,
    [r.sentiment]: r.count,
    total: (acc.total || 0) + r.count,
  }), { positive: 0, neutral: 0, negative: 0, total: 0 });

  const sentimentByProfile = data.sentimentByProfile || [];
  const postersBySentiment = data.postersBySentiment || [];
  const profilePlatforms = [...new Set(sentimentByProfile.map(r => r.platform).filter(Boolean))].sort();
  const posterPlatforms = [...new Set(postersBySentiment.map(r => r.platform).filter(Boolean))].sort();
  const visibleProfiles = sentimentByProfile.filter(r => profilePlatform === 'all' || r.platform === profilePlatform).slice(0, 25);
  const visiblePosters = postersBySentiment.filter(r => posterPlatform === 'all' || r.platform === posterPlatform).slice(0, 25);

  // Every count is a link into the grievances list, filtered the same way.
  const openGrievances = ({ handle, poster, platform, sentiment }) => {
    const params = new URLSearchParams();
    if (handle) params.set('handle', handle);
    if (poster) params.set('poster', poster);
    if (platform) params.set('platform', platform);
    if (sentiment) params.set('sentiment', sentiment);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    navigate(`/grievances?${params.toString()}`);
  };

  const SentimentCount = ({ value, tone, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!value}
      className={cn(
        'w-12 rounded-md py-0.5 text-xs font-semibold tabular-nums transition-colors',
        value ? 'hover:underline cursor-pointer' : 'cursor-default opacity-40',
        tone === 'positive' ? 'text-emerald-700' : tone === 'negative' ? 'text-red-700' : 'text-slate-600'
      )}
    >
      {value || 0}
    </button>
  );



  // ── Export helpers ──
  const exportReportsPDF = (reports, fileName = 'intelligence_reports', selectedType = 'all', title = 'Intelligence Reports') => {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text(title, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()}${reportDateFrom || reportDateTo ? ` | Date: ${reportDateFrom || '…'} → ${reportDateTo || '…'}` : ''}${selectedType !== 'all' ? ` | Type: ${TYPE_BADGE[selectedType]?.label}` : ''}`, 14, 25);
    autoTable(doc, {
      startY: 30,
      head: [['#', 'Type', 'Unique Code', 'Posted By', 'Platform', 'Category', 'Status', 'Post Date', 'Informed To']],
      body: reports.map((r, i) => [
        i + 1,
        TYPE_BADGE[r._type]?.label || r._type,
        r.unique_code || '',
        r.posted_by?.display_name || r.posted_by?.handle || '',
        prettify(r.platform || ''),
        r.category || '',
        r.status || r.shared_via || '',
        r.post_date ? new Date(r.post_date).toLocaleDateString('en-GB') : '',
        r.informed_to?.name || ''
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [245, 158, 11], textColor: [255, 255, 255], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [254, 252, 232] },
    });
    doc.save(`${fileName}.pdf`);
  };

  const exportReportsExcel = (reports, fileName = 'intelligence_reports') => {
    const rows = reports.map((r, i) => ({
      '#': i + 1,
      'Type': TYPE_BADGE[r._type]?.label || r._type,
      'Unique Code': r.unique_code || '',
      'Posted By': r.posted_by?.display_name || r.posted_by?.handle || '',
      'Handle': r.posted_by?.handle || '',
      'Platform': prettify(r.platform || ''),
      'Category': r.category || '',
      'Status': r.status || r.shared_via || '',
      'Post Date': r.post_date ? new Date(r.post_date).toLocaleDateString('en-GB') : '',
      'Post Description': r.post_description || '',
      'Informed To': r.informed_to?.name || '',
      'Department': r.informed_to?.department || '',
      'Remarks': r.remarks || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Intelligence Reports');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([buf], { type: 'application/octet-stream' }), `${fileName}.xlsx`);
  };

  const exportGrievancesPDF = () => {
    exportReportsPDF(filteredReports, 'intelligence_reports', reportTypeFilter, 'Intelligence Reports');
  };

  const exportGrievancesExcel = () => {
    exportReportsExcel(filteredReports, 'intelligence_reports');
  };

  const STATUS_BADGE = {
    PENDING: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
    ESCALATED: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
    CLOSED: { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' },
  };

  return (
    <motion.div initial="hidden" animate="visible" variants={stagger} className="space-y-5">
      {/* MAIN GRID: LEFT (reports+charts) + RIGHT (KPIs) */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* LEFT SIDE (col-span-9): Reports Table + Charts */}
        <div className="space-y-5 xl:col-span-9">

      {/* Reports Table */}
      <motion.div variants={fadeUp}>
        <ChartCard title="Reports" subtitle="Grievance, Criticism & Suggestion reports – filter by date and type" icon={FileText} iconColor="#f59e0b">
          {/* Filters + Export bar */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {/* Date From */}
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              <input type="date" value={reportDateFrom} onChange={e => setReportDateFrom(e.target.value)} className="border-0 bg-transparent text-xs text-slate-700 outline-none w-[110px]" placeholder="From" />
            </div>
            <span className="text-[10px] text-slate-400 font-medium">to</span>
            {/* Date To */}
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              <input type="date" value={reportDateTo} onChange={e => setReportDateTo(e.target.value)} className="border-0 bg-transparent text-xs text-slate-700 outline-none w-[110px]" placeholder="To" />
            </div>
            {/* Type Filter */}
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <Filter className="h-3.5 w-3.5 text-slate-400" />
              <select value={reportTypeFilter} onChange={e => setReportTypeFilter(e.target.value)} className="border-0 bg-transparent text-xs text-slate-700 outline-none cursor-pointer">
                <option value="all">All Types</option>
                <option value="grievance">Grievance</option>
                <option value="criticism">Criticism</option>
                <option value="suggestion">Suggestion</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => openReportsModal('grievance')}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 transition-colors"
            >
              G Workflow
            </button>
            {/* Clear filters */}
            {(reportDateFrom || reportDateTo || reportTypeFilter !== 'all') && (
              <button type="button" onClick={() => { setReportDateFrom(''); setReportDateTo(''); setReportTypeFilter('all'); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 transition-colors">
                <RefreshCw className="h-3 w-3" /> Clear
              </button>
            )}
            {/* Spacer */}
            <div className="flex-1" />
            {/* Exports */}
            <button type="button" onClick={exportGrievancesPDF} disabled={filteredReports.length === 0} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-all hover:bg-amber-100 disabled:opacity-40">
              <Download className="h-3.5 w-3.5" /> PDF
            </button>
            <button type="button" onClick={exportGrievancesExcel} disabled={filteredReports.length === 0} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-all hover:bg-emerald-100 disabled:opacity-40">
              <Download className="h-3.5 w-3.5" /> Excel
            </button>
            <span className="text-[11px] font-medium text-slate-400">{filteredReports.length} report{filteredReports.length !== 1 ? 's' : ''}</span>
          </div>

          {reportsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />)}
            </div>
          ) : filteredReports.length === 0 ? (
            <EmptyState message="No reports found for the selected filters" />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gradient-to-r from-amber-50 to-orange-50/50">
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Type</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Code</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Posted By</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Platform</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Category</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Status</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Post Date</th>
                    <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-amber-700">Informed To</th>
                    <th className="px-3 py-3 text-right text-[11px] font-bold uppercase tracking-wider text-amber-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReports.slice(0, 20).map((report, idx) => {
                    const statusBadge = STATUS_BADGE[report.status] || STATUS_BADGE.PENDING;
                    const typeBadge = TYPE_BADGE[report._type] || TYPE_BADGE.grievance;
                    const viewLink = report._type === 'grievance' ? `/grievances?tab=reports&id=${report.id}` : report._type === 'criticism' ? `/grievances?tab=criticism&id=${report.id}` : `/grievances?tab=suggestions&id=${report.id}`;
                    return (
                      <tr key={report.id || idx} className="border-b border-slate-50 transition-colors hover:bg-amber-50/30">
                        <td className="px-3 py-2.5">
                          <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold', typeBadge.bg, typeBadge.text, typeBadge.border)}>
                            {typeBadge.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <Hash className="h-3 w-3 text-amber-500 shrink-0" />
                            <span className="font-mono text-xs font-bold text-slate-900">{report.unique_code || '—'}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-7 w-7 rounded-full bg-amber-100 overflow-hidden shrink-0 flex items-center justify-center">
                              {report.posted_by?.profile_image_url ? (
                                <img src={report.posted_by.profile_image_url} className="h-full w-full object-cover" alt="" />
                              ) : (
                                <User className="h-4 w-4 text-amber-400" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-800 truncate">{report.posted_by?.display_name || '—'}</p>
                              <p className="text-[10px] text-slate-400 truncate">@{(report.posted_by?.handle || '').replace('@', '')}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize" style={{ backgroundColor: `${PLATFORM_COLORS[report.platform] || '#94a3b8'}15`, color: PLATFORM_COLORS[report.platform] || '#94a3b8' }}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PLATFORM_COLORS[report.platform] || '#94a3b8' }} />
                            {PLATFORM_LABELS[report.platform] || prettify(report.platform || 'unknown')}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: '#8b5cf615', color: '#8b5cf6' }}>
                            {report.category || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase', statusBadge.bg, statusBadge.text, statusBadge.border)}>
                            {report.status || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 text-xs text-slate-600">
                            <CalendarDays className="h-3 w-3 shrink-0" />
                            {report.post_date ? new Date(report.post_date).toLocaleDateString('en-GB') : '—'}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {report.informed_to?.name ? (
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-700 truncate">{report.informed_to.name}</p>
                              {report.informed_to.department && <p className="text-[10px] text-slate-400 truncate">{report.informed_to.department}</p>}
                            </div>
                          ) : <span className="text-xs text-slate-400 italic">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Link to={viewLink} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-amber-100 hover:text-amber-700 transition-colors">
                              <Eye className="h-3.5 w-3.5" />
                            </Link>
                            {report.post_link && (
                              <a href={report.post_link} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-blue-100 hover:text-blue-700 transition-colors">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredReports.length > 20 && (
                <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50/50 text-center">
                  <Link to="/grievances?tab=reports" className="text-xs font-semibold text-amber-600 hover:text-amber-800 transition-colors">
                    View all {filteredReports.length} reports →
                  </Link>
                </div>
              )}
            </div>
          )}
        </ChartCard>
      </motion.div>

      {/* Grievance Categories */}
      <motion.div variants={fadeUp}>
        <ChartCard ref={refs.gwrCategory} title="Grievance Categories" subtitle="Report classification categories" icon={BarChart3} iconColor="#8b5cf6">
          {gwrCategoryData.length ? (
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={gwrCategoryData.slice(0, 7)} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b', fontWeight: 500 }} width={85} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="value" name="Reports" radius={[0, 6, 6, 0]} maxBarSize={20}>
                    {gwrCategoryData.slice(0, 7).map(e => <Cell key={e.name} fill={e.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState />}
        </ChartCard>
      </motion.div>

      {/* Daily Trend */}
      <motion.div variants={fadeUp}>
        <ChartCard ref={refs.trend} title="Daily Tags Trend" subtitle="Volume of grievances over time" icon={Activity} iconColor="#f59e0b">
          {trendData.length ? (
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
                  <defs>
                    <linearGradient id="grievance-trend-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tickFormatter={v => String(v).slice(5)} minTickGap={18} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="count" name="Grievances" stroke="#f59e0b" strokeWidth={2} fill="url(#grievance-trend-grad)" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState />}
        </ChartCard>
      </motion.div>

        </div>

        {/* RIGHT SIDE (col-span-3): KPI tiles stacked vertically */}
        <motion.div variants={stagger} className="flex flex-col gap-4 xl:col-span-3">
          <KpiCard label="In Date Range" value={data.summary?.inRange} icon={CalendarDays} color="#3b82f6" growth={data.summary?.changePct} subtitle={dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})} – ${new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})}` : 'In selected range'} onClick={() => openReportsModal('all')} />

          <KpiCard label="Grievance Reports" value={data.grievanceReports?.total} icon={FileText} color="#8b5cf6" subtitle={`${data.grievanceReports?.shared || 0} shared`} onClick={() => openReportsModal('grievance')} />
          <KpiCard label="Suggestions" value={data.suggestions?.total} icon={Building2} color="#10b981" subtitle={`${data.suggestions?.shared || 0} shared`} onClick={() => openReportsModal('suggestion')} />
          <KpiCard label="Criticism" value={data.criticism?.total} icon={Zap} color="#ec4899" subtitle={`${data.criticism?.shared || 0} shared`} onClick={() => openReportsModal('criticism')} />
        </motion.div>
      </div>

      {/* ─── Grievance sentiment (sentiment service) ─── */}
      <motion.div variants={stagger} className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard ref={refs.sentiment} title="Sentiment of Grievances" subtitle="From the sentiment service" icon={PieChartIcon} iconColor="#8b5cf6">
          {sentimentTotals.total > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'negative', label: 'Negative', value: sentimentTotals.negative, cls: 'border-red-200 bg-red-50 text-red-800' },
                  { key: 'neutral', label: 'Neutral', value: sentimentTotals.neutral, cls: 'border-slate-200 bg-slate-50 text-slate-700' },
                  { key: 'positive', label: 'Positive', value: sentimentTotals.positive, cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
                ].map(tile => (
                  <button
                    key={tile.key}
                    type="button"
                    onClick={() => openGrievances({ sentiment: tile.key })}
                    className={cn('rounded-lg border px-3 py-2 text-left transition-transform hover:scale-[1.02]', tile.cls)}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{tile.label}</p>
                    <p className="mt-0.5 text-2xl font-black">{(tile.value || 0).toLocaleString()}</p>
                  </button>
                ))}
              </div>
              <div className="h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={sentimentData} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={3} cornerRadius={4}>
                      {sentimentData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : <EmptyState message="No grievance has been analysed yet" />}
        </ChartCard>

        <ChartCard
          title="Sentiment by Tagged Account"
          subtitle="Which monitored accounts attract complaints"
          icon={Users}
          iconColor="#f59e0b"
          action={profilePlatforms.length > 1 ? (
            <select
              value={profilePlatform}
              onChange={(e) => setProfilePlatform(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
            >
              <option value="all">All platforms</option>
              {profilePlatforms.map(pf => <option key={pf} value={pf}>{prettify(pf)}</option>)}
            </select>
          ) : null}
        >
          {visibleProfiles.length ? (
            <div className="max-h-[320px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1.5 text-left font-semibold">Account</th>
                    <th className="py-1.5 text-center font-semibold text-red-600">Neg</th>
                    <th className="py-1.5 text-center font-semibold">Neu</th>
                    <th className="py-1.5 text-center font-semibold text-emerald-600">Pos</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProfiles.map(row => (
                    <tr key={`${row.platform}-${row.account}`} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2">
                        <button
                          type="button"
                          onClick={() => openGrievances({ handle: row.account, platform: row.platform })}
                          className="block max-w-[220px] truncate text-left font-semibold text-slate-700 hover:text-amber-700 hover:underline"
                          title={`All grievances tagging ${row.account}`}
                        >
                          {row.display_name || row.account}
                        </button>
                        <span className="text-[10px] text-slate-400">{prettify(row.platform)}{row.department ? ` · ${row.department}` : ''}</span>
                      </td>
                      <td className="text-center"><SentimentCount value={row.negative} tone="negative" onClick={() => openGrievances({ handle: row.account, platform: row.platform, sentiment: 'negative' })} /></td>
                      <td className="text-center"><SentimentCount value={row.neutral} tone="neutral" onClick={() => openGrievances({ handle: row.account, platform: row.platform, sentiment: 'neutral' })} /></td>
                      <td className="text-center"><SentimentCount value={row.positive} tone="positive" onClick={() => openGrievances({ handle: row.account, platform: row.platform, sentiment: 'positive' })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState message="No analysed grievances for these accounts yet" />}
        </ChartCard>
      </motion.div>

      {/* ─── Who is complaining ─── */}
      <motion.div variants={stagger} className="mt-4">
        <ChartCard
          title="Complainants by Sentiment"
          subtitle="Accounts raising the most negative grievances"
          icon={Users}
          iconColor="#ef4444"
          action={posterPlatforms.length > 1 ? (
            <select
              value={posterPlatform}
              onChange={(e) => setPosterPlatform(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
            >
              <option value="all">All platforms</option>
              {posterPlatforms.map(pf => <option key={pf} value={pf}>{prettify(pf)}</option>)}
            </select>
          ) : null}
        >
          {visiblePosters.length ? (
            <div className="max-h-[320px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1.5 text-left font-semibold">Complainant</th>
                    <th className="py-1.5 text-center font-semibold text-red-600">Neg</th>
                    <th className="py-1.5 text-center font-semibold">Neu</th>
                    <th className="py-1.5 text-center font-semibold text-emerald-600">Pos</th>
                    <th className="py-1.5 text-center font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePosters.map(row => (
                    <tr key={`${row.platform}-${row.poster}`} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2">
                        <button
                          type="button"
                          onClick={() => openGrievances({ poster: row.poster, platform: row.platform })}
                          className="block max-w-[220px] truncate text-left font-semibold text-slate-700 hover:text-amber-700 hover:underline"
                          title={`All grievances from ${row.poster}`}
                        >
                          @{row.poster}
                        </button>
                        <span className="text-[10px] text-slate-400">{prettify(row.platform)}</span>
                      </td>
                      <td className="text-center"><SentimentCount value={row.negative} tone="negative" onClick={() => openGrievances({ poster: row.poster, platform: row.platform, sentiment: 'negative' })} /></td>
                      <td className="text-center"><SentimentCount value={row.neutral} tone="neutral" onClick={() => openGrievances({ poster: row.poster, platform: row.platform, sentiment: 'neutral' })} /></td>
                      <td className="text-center"><SentimentCount value={row.positive} tone="positive" onClick={() => openGrievances({ poster: row.poster, platform: row.platform, sentiment: 'positive' })} /></td>
                      <td className="text-center text-xs font-semibold tabular-nums text-slate-500">{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState message="No analysed grievances yet" />}
        </ChartCard>
      </motion.div>

      <Dialog open={reportsModalOpen} onOpenChange={setReportsModalOpen}>
        <DialogContent className="w-[96vw] max-w-5xl max-h-[90vh] overflow-hidden p-0">
          <div className={cn('px-6 py-4 border-b border-slate-200 bg-gradient-to-r', activeModalTheme.header)}>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <DialogHeader>
                  <DialogTitle className="text-lg font-bold text-slate-900">{activeModalTheme.title}</DialogTitle>
                </DialogHeader>
                <p className="text-xs text-slate-500 mt-1">
                  {activeModalTheme.subtitle}
                  {reportDateFrom || reportDateTo
                    ? ` | Date: ${reportDateFrom || '...'} to ${reportDateTo || '...'}`
                    : ''}
                  {` | ${modalReports.length} records`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportModalPDF}
                  disabled={modalReports.length === 0}
                  className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all disabled:opacity-40', activeModalTheme.button)}
                >
                  <Download className="h-3.5 w-3.5" /> PDF
                </button>
                <button
                  type="button"
                  onClick={exportModalExcel}
                  disabled={modalReports.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-all hover:bg-slate-50 disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" /> Excel
                </button>
              </div>
            </div>
          </div>
          <div className="overflow-y-auto p-4" style={{ maxHeight: 'calc(90vh - 96px)' }}>
            {reportsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4].map(i => <div key={i} className="h-11 w-full animate-pulse rounded-lg bg-slate-100" />)}
              </div>
            ) : modalReports.length === 0 ? (
              <EmptyState message="No reports found for this KPI" />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className={activeModalTheme.thead}>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Type</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Code</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Posted By</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Platform</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Category</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Status</th>
                      <th className={cn('px-3 py-2.5 text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Post Date</th>
                      <th className={cn('px-3 py-2.5 text-right text-[11px] font-bold uppercase tracking-wider', activeModalTheme.th)}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modalReports.map((report, idx) => {
                      const badge = STATUS_BADGE[report.status] || STATUS_BADGE.PENDING;
                      const typeBadge = TYPE_BADGE[report._type] || TYPE_BADGE.grievance;
                      return (
                        <tr key={report.id || idx} className={cn('border-b border-slate-50 transition-colors', activeModalTheme.row)}>
                          <td className="px-3 py-2">
                            <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase', typeBadge.bg, typeBadge.text, typeBadge.border)}>
                              {typeBadge.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs font-mono font-bold text-slate-900">{report.unique_code || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-700">{report.posted_by?.display_name || report.posted_by?.handle || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-700">{PLATFORM_LABELS[report.platform] || prettify(report.platform || 'unknown')}</td>
                          <td className="px-3 py-2 text-xs text-slate-700">{report.category || '—'}</td>
                          <td className="px-3 py-2">
                            <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase', badge.bg, badge.text, badge.border)}>
                              {report.status || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">{report.post_date ? new Date(report.post_date).toLocaleDateString('en-GB') : '—'}</td>
                          <td className="px-3 py-2 text-right">
                            <Link
                              to={`/grievances?tab=reports&id=${report.id}`}
                              className={cn('inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors', activeModalTheme.button)}
                              onClick={() => setReportsModalOpen(false)}
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   PROFILES INTELLIGENCE TAB
   ═══════════════════════════════════════════════════════════════════ */
const ProfilesIntelligence = ({ data, dateFrom, dateTo, districtFilter, setDistrictFilter, districtOptions }) => {
  const refs = {
    platform: useRef(null),
  };

  const districtParams = districtFilter !== 'all' ? { district: districtFilter } : {};

  // Drill-down modal state
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillTitle, setDrillTitle] = useState('');
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillProfiles, setDrillProfiles] = useState([]);
  const [drillSearch, setDrillSearch] = useState('');
  const lastDrillRef = useRef(null);

  const handlePieClick = async (sliceData, chartType) => {
    // chartType: 'platform' | 'coverage'
    lastDrillRef.current = { kind: 'pie', sliceData, chartType };
    setDrillTitle(sliceData.name);
    setDrillOpen(true);
    setDrillLoading(true);
    setDrillSearch('');
    setDrillProfiles([]);

    try {
      const params = { limit: 500, status: 'active', ...districtParams };
      if (chartType === 'platform') {
        params.platform = sliceData._rawPlatform || sliceData.name;
      } else if (chartType === 'coverage') {
        params.minLinkedPlatforms = sliceData._rawCount;
      }
      const res = await api.get('/poi', { params });
      setDrillProfiles(res.data?.pois || []);
    } catch {
      setDrillProfiles([]);
    } finally {
      setDrillLoading(false);
    }
  };

  const handleKpiClick = async (type) => {
    const labels = {
      total: 'Total Profiles',
      addedInRange: 'Added in Range',
      active: 'Active Profiles',
      deleted: 'Profiles with Deleted Accounts'
    };
    lastDrillRef.current = { kind: 'kpi', type };
    setDrillTitle(labels[type] || type);
    setDrillOpen(true);
    setDrillLoading(true);
    setDrillSearch('');
    setDrillProfiles([]);

    try {
      const params = { limit: 500, ...districtParams };
      if (type === 'active') {
        params.status = 'active';
      }
      const res = await api.get('/poi', { params });
      let profiles = res.data?.pois || [];

      if (type === 'addedInRange' && dateFrom && dateTo) {
        const from = new Date(dateFrom);
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        profiles = profiles.filter(p => {
          const created = new Date(p.createdAt);
          return created >= from && created <= to;
        });
      } else if (type === 'deleted') {
        profiles = profiles.filter(p => {
          const dp = p.previouslyDeletedProfiles;
          if (!dp) return false;
          return Object.values(dp).some(v => Array.isArray(v) ? v.length > 0 : !!v);
        });
      }

      setDrillProfiles(profiles);
    } catch {
      setDrillProfiles([]);
    } finally {
      setDrillLoading(false);
    }
  };

  // Re-run the last drill-down fetch when the district filter changes.
  useEffect(() => {
    if (!drillOpen || !lastDrillRef.current) return;
    const last = lastDrillRef.current;
    if (last.kind === 'pie') handlePieClick(last.sliceData, last.chartType);
    else handleKpiClick(last.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districtFilter]);

  const filteredDrillProfiles = useMemo(() => {
    if (!drillSearch.trim()) return drillProfiles;
    const q = drillSearch.toLowerCase();
    return drillProfiles.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.realName || '').toLowerCase().includes(q) ||
      (p.socialMedia || []).some(s =>
        (s.handle || '').toLowerCase().includes(q) ||
        (s.displayName || '').toLowerCase().includes(q) ||
        (s.category || '').toLowerCase().includes(q)
      )
    );
  }, [drillProfiles, drillSearch]);

  const handleKpiDownload = useCallback(async (type) => {
    const labels = {
      total: 'Total Profiles',
      addedInRange: 'Added in Range',
      active: 'Active Profiles',
      deleted: 'Profiles with Deleted Accounts'
    };
    try {
      const params = { limit: 500, ...districtParams };
      if (type === 'active') params.status = 'active';
      const res = await api.get('/poi', { params });
      let profiles = res.data?.pois || [];

      if (type === 'addedInRange' && dateFrom && dateTo) {
        const from = new Date(dateFrom);
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        profiles = profiles.filter(p => {
          const created = new Date(p.createdAt);
          return created >= from && created <= to;
        });
      } else if (type === 'deleted') {
        profiles = profiles.filter(p => {
          const dp = p.previouslyDeletedProfiles;
          if (!dp) return false;
          return Object.values(dp).some(v => Array.isArray(v) ? v.length > 0 : !!v);
        });
      }

      const rows = profiles.map((p, i) => ({
        '#': i + 1,
        'Name': p.name || 'Unknown',
        'Real Name': p.realName || '',
        'Categories': Array.from(new Set((p.socialMedia || []).map(s => (s.category || '').trim()).filter(Boolean))).join(', '),
        'Status': (p.status || 'active').toUpperCase(),
        'Linked Platforms': (p.socialMedia || []).length,
        'Handles': (p.socialMedia || []).map(s => `${s.platform || ''}:@${(s.handle || '').replace('@', '')}`).join(', '),
        'Created': p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-GB') : '',
      }));

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Profiles');
      const rangeLabel = dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB')} – ${new Date(dateTo).toLocaleDateString('en-GB')}` : 'All time';
      const meta = [
        { Field: 'Report', Value: labels[type] || type },
        { Field: 'Period', Value: rangeLabel },
        { Field: 'Total', Value: profiles.length },
        { Field: 'Generated', Value: new Date().toLocaleString('en-IN') },
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), 'Info');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const safeName = (labels[type] || type).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeName}_${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch {
      // silent fail
    }
  }, [dateFrom, dateTo, districtFilter]);

  if (!data) return <EmptyState message="Loading profiles intelligence..." />;

  const platformData = (data.platformDistribution || []).map(r => ({
    name: PLATFORM_LABELS[r.platform] || r.platform, value: r.count, color: PLATFORM_COLORS[r.platform] || PLATFORM_COLORS.unknown, _rawPlatform: r.platform
  }));

  const coverageData = (data.socialCoverage || []).map((r, i) => ({
    name: `${r.linkedPlatforms} Platform${r.linkedPlatforms !== 1 ? 's' : ''}`,
    value: r.count,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
    _rawCount: r.linkedPlatforms
  }));

  // ── Build the Profile Summary matrix (platform × category) from the
  //    flat platformCategoryMatrix the backend now returns. Only the 7
  //    canonical categories are shown — anything else (legacy "media",
  //    "news", "unknown", etc.) gets folded into "others".
  const CANONICAL_CATEGORIES = [
    { value: 'political', label: 'Political' },
    { value: 'communal', label: 'Communal' },
    { value: 'trouble_makers', label: 'Trouble Makers' },
    { value: 'defamation', label: 'Defamation' },
    { value: 'narcotics', label: 'Narcotics' },
    { value: 'history_sheeters', label: 'History Sheeters' },
    { value: 'others', label: 'Others' },
  ];
  const platformCategoryRaw = data.platformCategoryMatrix || [];
  const profileMatrix = (() => {
    const canonical = new Set(CANONICAL_CATEGORIES.map(c => c.value));
    const platformMap = {}; // { platform: { category: count, _total: n } }
    platformCategoryRaw.forEach(({ platform, category, count }) => {
      // Drop entries whose category isn't one of the 7 canonical ones —
      // legacy values like "media", "news", "unknown", "", null are
      // ignored entirely so the Others row only counts genuine "others".
      if (!canonical.has(category)) return;
      if (!platformMap[platform]) platformMap[platform] = { _total: 0 };
      platformMap[platform][category] = (platformMap[platform][category] || 0) + count;
      platformMap[platform]._total += count;
    });
    const rows = Object.entries(platformMap)
      .map(([platform, counts]) => ({
        platform,
        label: PLATFORM_LABELS[platform] || platform,
        color: PLATFORM_COLORS[platform] || PLATFORM_COLORS.unknown,
        total: counts._total,
        counts,
      }))
      .sort((a, b) => b.total - a.total);
    const categoryTotals = CANONICAL_CATEGORIES.reduce((acc, c) => {
      acc[c.value] = rows.reduce((s, r) => s + (r.counts[c.value] || 0), 0);
      return acc;
    }, {});
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    return { categories: CANONICAL_CATEGORIES, rows, categoryTotals, grandTotal };
  })();

  const summary = data.summary || {};

  return (
    <motion.div initial="hidden" animate="visible" variants={stagger} className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="space-y-5 xl:col-span-9">
          <motion.div variants={fadeUp}>
            <ChartCard ref={refs.platform} title="Platform Coverage" subtitle="Platform-wise profile counts and category breakdown" icon={Globe} iconColor="#1877F2">
              {platformData.length ? (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {/* LEFT: pie chart + platform-wise counts */}
                  <div className="flex flex-col lg:border-r lg:border-slate-100 lg:pr-6">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 text-center lg:text-left">
                      Platform Distribution
                    </div>
                    <div className="relative h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={platformData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={92} paddingAngle={3} cornerRadius={4} className="cursor-pointer" onClick={(_, idx) => handlePieClick(platformData[idx], 'platform')}>
                            {platformData.map(e => <Cell key={e.name} fill={e.color} stroke="white" strokeWidth={2} />)}
                          </Pie>
                          <Tooltip content={<ChartTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <p className="text-2xl font-black text-slate-900">{fmt(platformData.reduce((s, r) => s + r.value, 0), true)}</p>
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Links</p>
                      </div>
                    </div>
                    <div className="mt-2 space-y-1">
                      {platformData.map(r => {
                        const icon = PLATFORM_BAR_ICONS[r._rawPlatform];
                        return (
                          <div
                            key={r.name}
                            className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-slate-50 transition-colors"
                            onClick={() => handlePieClick(r, 'platform')}
                          >
                            {icon ? (
                              <span
                                className="flex items-center justify-center h-6 w-6 rounded"
                                style={{ backgroundColor: `${r.color}15`, color: r.color }}
                              >
                                {icon}
                              </span>
                            ) : (
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color }} />
                            )}
                            <span className="text-xs font-medium text-slate-600 truncate">{r.name}</span>
                            <span className="text-sm font-bold text-slate-900 tabular-nums">{fmt(r.value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* RIGHT: profile-summary matrix table (platform × category) */}
                  <div className="flex flex-col min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 text-center lg:text-left">
                      Profile Summary by Category
                    </div>
                    {profileMatrix.rows.length && profileMatrix.categories.length ? (
                      <div className="overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50 text-slate-500">
                              <th className="text-left px-2.5 py-2 font-semibold sticky left-0 bg-slate-50 z-10">Category</th>
                              {profileMatrix.rows.map(row => {
                                const icon = PLATFORM_BAR_ICONS[row.platform];
                                return (
                                  <th key={row.platform} className="px-2 py-2 font-semibold whitespace-nowrap" title={row.label}>
                                    <div className="flex flex-col items-center gap-1">
                                      {icon ? (
                                        <span
                                          className="flex items-center justify-center h-5 w-5 rounded"
                                          style={{ backgroundColor: `${row.color}15`, color: row.color }}
                                        >
                                          {icon}
                                        </span>
                                      ) : (
                                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                                      )}
                                      <span className="text-[10px]">{row.label}</span>
                                    </div>
                                  </th>
                                );
                              })}
                              <th className="text-center px-2.5 py-2 font-bold text-slate-700 bg-slate-100 whitespace-nowrap">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {profileMatrix.categories.map((cat) => {
                              const rowTotal = profileMatrix.categoryTotals[cat.value] || 0;
                              return (
                                <tr key={cat.value} className="border-t border-slate-100 hover:bg-slate-50/60 transition-colors">
                                  <td className="px-2.5 py-2 sticky left-0 bg-white z-10 font-semibold text-slate-700 whitespace-nowrap">
                                    {cat.label}
                                  </td>
                                  {profileMatrix.rows.map(row => {
                                    const v = row.counts[cat.value] || 0;
                                    return (
                                      <td
                                        key={row.platform}
                                        className={`text-center px-2 py-2 tabular-nums ${v ? 'text-slate-800 font-medium cursor-pointer hover:underline' : 'text-slate-300'}`}
                                        onClick={() => v && handlePieClick({ _rawPlatform: row.platform, name: row.label }, 'platform')}
                                      >
                                        {v || '—'}
                                      </td>
                                    );
                                  })}
                                  <td className="text-center px-2.5 py-2 font-black tabular-nums text-slate-900 bg-slate-50">
                                    {fmt(rowTotal)}
                                  </td>
                                </tr>
                              );
                            })}
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-700">
                              <td className="px-2.5 py-2 sticky left-0 bg-slate-50 z-10">Total</td>
                              {profileMatrix.rows.map(row => (
                                <td
                                  key={row.platform}
                                  className="text-center px-2 py-2 tabular-nums cursor-pointer hover:underline"
                                  onClick={() => handlePieClick({ _rawPlatform: row.platform, name: row.label }, 'platform')}
                                >
                                  {fmt(row.total)}
                                </td>
                              ))}
                              <td className="text-center px-2.5 py-2 font-black tabular-nums text-slate-900 bg-slate-100">
                                {fmt(profileMatrix.grandTotal)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center py-12 text-xs text-slate-400">
                        No category breakdown available.
                      </div>
                    )}
                  </div>
                </div>
              ) : <EmptyState />}
            </ChartCard>
          </motion.div>
        </div>

        <motion.div variants={stagger} className="flex flex-col gap-4 xl:col-span-3">
          <KpiCard label="Total Profiles" value={summary.total} icon={Users} color="#8b5cf6" onClick={() => handleKpiClick('total')} onDownload={() => handleKpiDownload('total')} />
          <KpiCard label="Added in Range" value={summary.addedInRange} icon={TrendingUp} color="#3b82f6" subtitle={dateFrom && dateTo ? `${new Date(dateFrom).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})} – ${new Date(dateTo).toLocaleDateString('en-GB', {day:'2-digit',month:'short'})}` : undefined} onClick={() => handleKpiClick('addedInRange')} onDownload={() => handleKpiDownload('addedInRange')} />
          <KpiCard label="Active" value={summary.active} icon={UserSearch} color="#10b981" onClick={() => handleKpiClick('active')} onDownload={() => handleKpiDownload('active')} />
          <KpiCard label="Deleted Profiles" value={summary.withDeletedProfiles} icon={AlertTriangle} color="#ec4899" subtitle="Tracked deletions" onClick={() => handleKpiClick('deleted')} onDownload={() => handleKpiDownload('deleted')} />
        </motion.div>
      </div>

      {/* Drill-Down Modal */}
      <Dialog open={drillOpen} onOpenChange={(open) => { setDrillOpen(open); if (!open) { setDrillSearch(''); setDrillProfiles([]); } }}>
        <DialogContent className="w-[96vw] max-w-5xl max-h-[90vh] overflow-hidden p-0">
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-violet-50 to-slate-50">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Users className="h-5 w-5 text-violet-600" />
                {drillTitle} — Profiles ({filteredDrillProfiles.length})
              </DialogTitle>
            </DialogHeader>
            <div className="relative mt-3 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                placeholder="Search name, handle, category..."
                value={drillSearch}
                onChange={(e) => setDrillSearch(e.target.value)}
                className="w-full pl-9 pr-3 h-8 text-xs rounded-lg border border-slate-200 bg-white focus:border-violet-400 focus:ring-1 focus:ring-violet-200 outline-none transition-colors"
              />
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: 'calc(90vh - 120px)' }}>
            {drillLoading ? (
              <div className="flex items-center justify-center py-20">
                <RefreshCw className="h-5 w-5 animate-spin text-violet-500" />
                <span className="ml-2 text-sm text-slate-500">Loading profiles...</span>
              </div>
            ) : filteredDrillProfiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                <Users className="h-8 w-8 mb-2" />
                <p className="text-sm font-medium">No profiles found</p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0 z-10">
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">#</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">Name</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">Category</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">Linked Handles</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">Status</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-600">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDrillProfiles.map((poi, idx) => (
                    <tr key={poi._id || idx} className="border-b border-slate-100 hover:bg-violet-50/30 transition-colors cursor-pointer" onClick={() => window.open(`/person-of-interest/${poi._id}`, '_blank')}>
                      <td className="px-4 py-2.5 text-slate-400 font-mono">{idx + 1}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-900">{poi.name || 'Unknown'}</div>
                        {poi.realName && poi.realName !== poi.name && <div className="text-[10px] text-slate-400">aka {poi.realName}</div>}
                      </td>
                      <td className="px-4 py-2.5">
                        {(() => {
                          const cats = Array.from(new Set(
                            (poi.socialMedia || [])
                              .map(s => (s.category || '').trim())
                              .filter(Boolean)
                          ));
                          if (!cats.length) return <span className="text-slate-300">—</span>;
                          return (
                            <div className="flex flex-wrap gap-1">
                              {cats.map(c => (
                                <span key={c} className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-50 text-violet-700 capitalize">
                                  {c.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {(poi.socialMedia || []).slice(0, 4).map((s, si) => (
                            <span key={si} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PLATFORM_COLORS[s.platform] || '#94a3b8' }} />
                              @{(s.handle || '').replace('@', '')}
                            </span>
                          ))}
                          {(poi.socialMedia || []).length > 4 && (
                            <span className="text-[10px] text-slate-400">+{poi.socialMedia.length - 4} more</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn('inline-block px-2 py-0.5 rounded-full text-[10px] font-bold', poi.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                          {(poi.status || 'active').toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{poi.createdAt ? new Date(poi.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════════ */
const IntelligenceDashboard = () => {
  const { tenant } = useTenant();
  const { hasFeatureAccess } = useRbac();
  const visibleTabs = useMemo(
    () => TABS.filter((tab) => hasFeatureAccess('/intelligence-dashboard', tab.featureId)),
    [hasFeatureAccess]
  );
  const [activeTab, setActiveTab] = useState('alerts');

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab(visibleTabs[0].key);
    }
  }, [visibleTabs, activeTab]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [districtFilter, setDistrictFilter] = useState('all');
  const { districtOptions } = useScopedLocation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [alertsData, setAlertsData] = useState(null);
  const [grievancesData, setGrievancesData] = useState(null);
  const [profilesData, setProfilesData] = useState(null);

  const activeTabMeta = useMemo(() => TABS.find(t => t.key === activeTab) || TABS[0], [activeTab]);

  const fetchData = useCallback(async (tab) => {
    if (tab === 'events') { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;
      if (districtFilter !== 'all') params.district = districtFilter;

      const targetTab = tab || activeTab;
      const response = await api.get(`/intelligence/${targetTab}`, { params });

      switch (targetTab) {
        case 'alerts': setAlertsData(response.data); break;
        case 'grievances': setGrievancesData(response.data); break;
        case 'profiles': setProfilesData(response.data); break;
      }
    } catch (err) {
      setError(`Failed to load ${tab || activeTab} intelligence. Please try again.`);
    } finally {
      setLoading(false);
    }
  }, [activeTab, dateFrom, dateTo, districtFilter]);

  useEffect(() => {
    fetchData(activeTab);
  }, [activeTab, tenant, districtFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApplyDateRange = () => {
    if (!dateFrom || !dateTo) return;
    fetchData(activeTab);
  };

  const handleClearDateRange = () => {
    setDateFrom('');
    setDateTo('');
    // Re-fetch with no custom range
    setTimeout(() => fetchData(activeTab), 0);
  };

  const handleTabChange = (key) => {
    setActiveTab(key);
  };

  const currentData = activeTab === 'alerts' ? alertsData : activeTab === 'grievances' ? grievancesData : profilesData;
  const generatedAt = currentData?.generatedAt ? new Date(currentData.generatedAt).toLocaleString() : '--';

  return (
    <div className="p-4 md:p-6">
      <div className="mx-auto max-w-[1600px] space-y-5">

        {/* ══════════ HEADER ══════════ */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between"
        >
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900 sm:text-2xl">
              Reports
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* District Filter — drives the KPIs/charts for every tab */}
            <select
              value={districtFilter}
              onChange={(e) => setDistrictFilter(e.target.value)}
              className="h-9 rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-700 outline-none focus:border-slate-400"
            >
              <option value="all">All Districts</option>
              {districtOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            {/* Date Range */}
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-slate-400"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-slate-400"
              />
              <Button size="sm" variant="outline" onClick={handleApplyDateRange} className="h-7 px-2 text-xs">Apply</Button>
              <Button size="sm" variant="ghost" onClick={handleClearDateRange} className="h-7 px-2 text-xs">Clear</Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs bg-slate-900 text-white hover:bg-slate-800 hover:text-white"
                onClick={() => {
                  const today = new Date().toISOString().split('T')[0];
                  setDateFrom(today);
                  setDateTo(today);
                  setTimeout(() => fetchData(activeTab), 0);
                }}
              >
                Today
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => fetchData(activeTab)} disabled={loading} className="gap-2 rounded-xl border-slate-200">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-[11px] text-slate-500">{generatedAt}</span>
            </div>
          </div>
        </motion.div>

        {/* ══════════ TAB NAVIGATION ══════════ */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"
        >
          <div className="flex gap-2">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleTabChange(tab.key)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all',
                    isActive
                      ? 'bg-slate-900 text-white shadow-md'
                      : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                  <span className="sm:hidden">{tab.key === 'alerts' ? 'Alerts' : tab.key === 'grievances' ? 'Grievances' : tab.key === 'events' ? 'Events' : 'Profiles'}</span>
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* ══════════ ERROR BANNER ══════════ */}
        {error && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => fetchData(activeTab)}>Retry</Button>
            </div>
          </div>
        )}

        {/* ══════════ LOADING SKELETON ══════════ */}
        {loading && !currentData && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="animate-pulse space-y-5">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-32 rounded-2xl bg-slate-100" />
                ))}
              </div>
              <div className="grid grid-cols-12 gap-4">
                <div className="col-span-8 h-80 rounded-2xl bg-slate-100" />
                <div className="col-span-4 h-80 rounded-2xl bg-slate-100" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-64 rounded-2xl bg-slate-100" />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ══════════ TAB CONTENT ══════════ */}
        {activeTab === 'alerts' && <AlertsIntelligence data={alertsData} dateFrom={dateFrom} dateTo={dateTo} districtFilter={districtFilter} setDistrictFilter={setDistrictFilter} districtOptions={districtOptions} />}
        {activeTab === 'grievances' && <GrievancesIntelligence data={grievancesData} dateFrom={dateFrom} dateTo={dateTo} districtFilter={districtFilter} setDistrictFilter={setDistrictFilter} districtOptions={districtOptions} />}
        {activeTab === 'profiles' && <ProfilesIntelligence data={profilesData} dateFrom={dateFrom} dateTo={dateTo} districtFilter={districtFilter} setDistrictFilter={setDistrictFilter} districtOptions={districtOptions} />}
        {activeTab === 'events' && (
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
            </div>
          }>
            <EventsReportEmbed />
          </Suspense>
        )}

      </div>
    </div>
  );
};

export default IntelligenceDashboard;
