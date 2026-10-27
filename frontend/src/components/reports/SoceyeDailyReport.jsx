import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Antenna,
  Cpu,
  Calendar,
  FileBarChart,
  Network,
  BellRing,
  Users,
  AlertTriangle,
  RefreshCw,
  Download,
  Image as ImageIcon,
  TrendingUp,
  TrendingDown,
  Loader2,
  Activity,
  Hash,
  History as HistoryIcon,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Send,
  Bot,
  Search,
  Pin,
  PinOff,
  Pause,
  Play,
  Target,
  ChevronRight
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import html2canvas from 'html2canvas';
import { saveAs } from 'file-saver';
import api from '../../lib/api';
import { TwitterAlertCard, YoutubeAlertCard } from '../AlertCards';
import ContentCard from '../ContentCard';

/* ───────────────────────── helpers ───────────────────────── */
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
const fmtDateTime = (d) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return '—'; }
};
// Internal-only redirection. Officers stay inside the app — no external platform links.
//   - Instagram + known sourceId → dedicated profile monitor page
//   - Everything else → /alerts filtered by author handle so they see all related alerts
const profileUrl = (platform, handle, sourceId) => {
  const k = String(platform || '').toLowerCase();
  const h = String(handle || '').replace(/^@/, '').trim();
  if (sourceId && k.includes('insta')) return `/instagram-monitor/${sourceId}`;
  if (h) return `/alerts?search=${encodeURIComponent(h)}`;
  return null;
};

const platformBadge = (p) => {
  const k = String(p || '').toLowerCase();
  if (k.includes('x') || k.includes('twitter')) return { label: 'X', cls: 'bg-[#E6F1FB] text-[#185FA5]' };
  if (k.includes('insta')) return { label: 'IG', cls: 'bg-[#FBEAF0] text-[#993556]' };
  if (k.includes('face')) return { label: 'FB', cls: 'bg-[#E6F1FB] text-[#0C447C]' };
  if (k.includes('you')) return { label: 'YT', cls: 'bg-[#FCEBEB] text-[#A32D2D]' };
  return { label: p || '—', cls: 'bg-slate-100 text-slate-700' };
};

const sentimentCls = (s) => {
  const k = String(s || '').toLowerCase();
  if (k === 'positive') return 'bg-[#EAF3DE] text-[#3B6D11]';
  if (k === 'negative') return 'bg-[#FCEBEB] text-[#A32D2D]';
  return 'bg-[#F1EFE8] text-[#5F5E5A]';
};

const AVATAR_PALETTE = [
  { bg: '#E6F1FB', fg: '#185FA5' },
  { bg: '#E1F5EE', fg: '#0F6E56' },
  { bg: '#FBEAF0', fg: '#993556' },
  { bg: '#FAECE7', fg: '#993C1D' },
  { bg: '#EAF3DE', fg: '#3B6D11' }
];

/* ───────────────────────── UI atoms ───────────────────────── */
const Metric = ({ label, value, tone = 'default' }) => {
  const tones = {
    default: 'text-slate-900',
    blue: 'text-[#185FA5]',
    green: 'text-[#3B6D11]',
    amber: 'text-[#854F0B]',
    red: 'text-[#A32D2D]',
    teal: 'text-[#0F6E56]',
    orange: 'text-[#993C1D]'
  };
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3 border border-slate-100">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      <div className={`text-[22px] font-semibold leading-none ${tones[tone] || tones.default}`}>{value}</div>
    </div>
  );
};

const RowItem = ({ label, value, valueClass = '' }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0 text-[13px]">
    <span className="text-slate-500">{label}</span>
    <span className={`font-semibold text-slate-900 ${valueClass}`}>{value}</span>
  </div>
);

const SectionShell = React.forwardRef(({ num, title, icon: Icon, accent = '#185FA5', onExportPdf, onExportPng, onExportCsv, children }, ref) => (
  <section className="mb-6" ref={ref}>
    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div className="flex items-center gap-2">
        {num != null ? (
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold"
            style={{ background: `${accent}1A`, color: accent }}
          >
            {num}
          </span>
        ) : Icon ? (
          <Icon className="h-4 w-4" style={{ color: accent }} />
        ) : null}
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="flex items-center gap-1">
        {onExportPng && (
          <button
            type="button"
            onClick={onExportPng}
            title="Export this section as PNG"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
          >
            <ImageIcon className="h-3 w-3" /> PNG
          </button>
        )}
        {onExportPdf && (
          <button
            type="button"
            onClick={onExportPdf}
            title="Export this section as PDF"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
          >
            <Download className="h-3 w-3" /> PDF
          </button>
        )}
        {onExportCsv && (
          <button
            type="button"
            onClick={onExportCsv}
            title="Export this section as CSV"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
          >
            <FileBarChart className="h-3 w-3" /> CSV
          </button>
        )}
      </div>
    </div>
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">{children}</div>
  </section>
));
SectionShell.displayName = 'SectionShell';

const EmptyHint = ({ msg = 'No data captured in this window.' }) => (
  <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/50 px-3 py-4 text-center text-xs text-slate-500">
    {msg}
  </div>
);

/* ───────────────────────── data viz atoms ───────────────────────── */

// Tiny ↑23% / ↓5% delta chip. Hidden when no prev-window data was supplied.
const TrendBadge = ({ pct, label = 'vs prev', invert = false }) => {
  if (pct == null || Number.isNaN(pct)) return null;
  const positive = pct >= 0;
  // For some metrics (response time, pending) an increase is bad — invert color.
  const good = invert ? !positive : positive;
  const Icon = positive ? TrendingUp : TrendingDown;
  const cls = good
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : 'text-rose-700 bg-rose-50 border-rose-200';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cls}`}>
      <Icon className="h-2.5 w-2.5" />
      {Math.abs(pct)}% <span className="opacity-60 ml-0.5">{label}</span>
    </span>
  );
};

// Metric card with optional trend badge.
const MetricWithTrend = ({ label, value, tone = 'default', trend, invert }) => {
  const tones = {
    default: 'text-slate-900',
    blue: 'text-[#185FA5]',
    green: 'text-[#3B6D11]',
    amber: 'text-[#854F0B]',
    red: 'text-[#A32D2D]',
    teal: 'text-[#0F6E56]',
    orange: 'text-[#993C1D]'
  };
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3 border border-slate-100">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
        <TrendBadge pct={trend} invert={invert} />
      </div>
      <div className={`text-[22px] font-semibold leading-none ${tones[tone] || tones.default}`}>{value}</div>
    </div>
  );
};

// Horizontal stacked bar — used for sentiment + status breakdowns.
const StackedBar = ({ segments }) => {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  if (total === 0) {
    return <div className="h-2 rounded-full bg-slate-100" />;
  }
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100">
      {segments.map((s, i) => {
        const pct = (s.value / total) * 100;
        if (pct <= 0) return null;
        return (
          <div
            key={s.label || i}
            style={{ width: `${pct}%`, background: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        );
      })}
    </div>
  );
};

const SentimentBar = ({ positive = 0, neutral = 0, negative = 0 }) => {
  const total = positive + neutral + negative;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Sentiment Mix</div>
        <div className="text-[10px] text-slate-400">{fmtNum(total)} posts</div>
      </div>
      <StackedBar
        segments={[
          { label: 'positive', value: positive, color: '#3B6D11' },
          { label: 'neutral',  value: neutral,  color: '#94A3B8' },
          { label: 'negative', value: negative, color: '#A32D2D' }
        ]}
      />
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#3B6D11]" /> Positive {fmtNum(positive)}</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#94A3B8]" /> Neutral {fmtNum(neutral)}</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#A32D2D]" /> Negative {fmtNum(negative)}</span>
      </div>
    </div>
  );
};

// Horizontal bar list — used for platform mix etc.
const HBarList = ({ title, items, totalLabel = 'total', accent = '#185FA5' }) => {
  const total = items.reduce((s, x) => s + (x.count || 0), 0);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{title}</div>
        <div className="text-[10px] text-slate-400">{fmtNum(total)} {totalLabel}</div>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-slate-400 italic">No data</div>
      ) : (
        <div className="space-y-1.5">
          {items.slice(0, 6).map((it, i) => {
            const pct = total > 0 ? (it.count / total) * 100 : 0;
            return (
              <div key={it.label || i} className="text-[12px]">
                <div className="flex justify-between mb-0.5">
                  <span className="text-slate-700 truncate">{it.label}</span>
                  <span className="text-slate-500 ml-2">{fmtNum(it.count)} <span className="text-slate-400">· {Math.round(pct)}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full" style={{ width: `${pct}%`, background: accent }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Sparkline / bar chart of hourly alert distribution.
const HourlyTimeline = ({ buckets = [], accent = '#A32D2D' }) => {
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => b.count || 0));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Alert Volume — Hourly</div>
        <div className="text-[10px] text-slate-400">peak {fmtNum(max)}/hr</div>
      </div>
      <div className="flex items-end gap-[2px] h-16">
        {buckets.map((b, i) => {
          const h = Math.max(2, Math.round((b.count / max) * 100));
          const highPct = b.count > 0 ? (b.high / b.count) : 0;
          // Color shifts redder as the high-priority share grows.
          const color = highPct > 0.5
            ? '#A32D2D'
            : highPct > 0.2
              ? '#D97706'
              : accent === '#A32D2D' ? '#FDA4AF' : accent;
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm"
              style={{ height: `${h}%`, background: color, minWidth: 4 }}
              title={`${new Date(b.start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${b.count} alerts (${b.high} HIGH)`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-slate-400 mt-1">
        <span>{buckets[0]?.start ? new Date(buckets[0].start).toLocaleTimeString('en-IN', { hour: '2-digit' }) : 'start'}</span>
        <span>now</span>
      </div>
    </div>
  );
};

// Hero "Threat Level" banner — top-of-body status indicator.
const ThreatBanner = ({ level = 'NORMAL', score = 0, highlights, windowHours, onJump }) => {
  const cfg = {
    CRITICAL: { bg: 'from-rose-600 to-red-700',     icon: ShieldAlert,   pulse: true,  text: 'CRITICAL — immediate triage' },
    HIGH:     { bg: 'from-orange-500 to-rose-600',  icon: ShieldAlert,   pulse: true,  text: 'HIGH — multiple signals firing' },
    ELEVATED: { bg: 'from-amber-500 to-orange-500', icon: AlertTriangle, pulse: false, text: 'ELEVATED — monitor closely' },
    NORMAL:   { bg: 'from-emerald-500 to-teal-600', icon: ShieldCheck,   pulse: false, text: 'NORMAL — situation stable' }
  };
  const c = cfg[level] || cfg.NORMAL;
  const Icon = c.icon;
  return (
    <div className={`rounded-xl bg-gradient-to-r ${c.bg} text-white px-5 py-3.5 shadow-lg mb-4`}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className={`relative w-10 h-10 rounded-lg bg-white/15 flex items-center justify-center backdrop-blur ${c.pulse ? 'ring-2 ring-white/40' : ''}`}>
          <Icon className="h-5 w-5" />
          {c.pulse && <span className="absolute inset-0 rounded-lg ring-2 ring-white/60 animate-ping" />}
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest opacity-80">Threat Level — last {windowHours}h</div>
          <div className="font-bold text-[18px] leading-tight">{c.text}</div>
          {highlights && <div className="text-[12px] opacity-90 mt-0.5">{highlights}</div>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="text-right hidden sm:block">
            <div className="text-[10px] uppercase tracking-widest opacity-80">Score</div>
            <div className="font-bold text-[20px] leading-none">{score}</div>
          </div>
          {onJump && (
            <button
              type="button"
              onClick={onJump}
              className="inline-flex items-center gap-1 bg-white/15 hover:bg-white/25 backdrop-blur px-3 py-1.5 rounded-md text-[12px] font-medium transition"
            >
              Review alerts <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Recommendations checklist — actionable items with deep-links.
const RECO_TONE = {
  red:     'border-rose-200 bg-rose-50/70 text-rose-900',
  orange:  'border-orange-200 bg-orange-50/70 text-orange-900',
  amber:   'border-amber-200 bg-amber-50/70 text-amber-900',
  blue:    'border-blue-200 bg-blue-50/70 text-blue-900',
  violet:  'border-violet-200 bg-violet-50/70 text-violet-900',
  emerald: 'border-emerald-200 bg-emerald-50/70 text-emerald-900',
  green:   'border-emerald-200 bg-emerald-50/70 text-emerald-900'
};
const RecommendationsCard = ({ recommendations = [] }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex items-center gap-2 mb-3">
      <Target className="h-4 w-4 text-[#A32D2D]" />
      <h3 className="text-sm font-semibold text-slate-900">Recommended Actions</h3>
      <span className="text-[10px] text-slate-400">{recommendations.length} item{recommendations.length === 1 ? '' : 's'}</span>
    </div>
    <div className="space-y-2">
      {recommendations.map((r, i) => {
        const cls = RECO_TONE[r.tone] || RECO_TONE.blue;
        const body = (
          <>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-white border border-current/30 flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold leading-tight">{r.title}</div>
                {r.detail && <div className="text-[11px] opacity-80 mt-0.5">{r.detail}</div>}
              </div>
              {r.action && <ChevronRight className="h-4 w-4 opacity-60 flex-shrink-0 mt-0.5" />}
            </div>
          </>
        );
        if (r.action) {
          return (
            <Link key={i} to={r.action} className={`block rounded-md border px-3 py-2 hover:brightness-95 transition ${cls}`}>
              {body}
            </Link>
          );
        }
        return (
          <div key={i} className={`rounded-md border px-3 py-2 ${cls}`}>
            {body}
          </div>
        );
      })}
    </div>
  </div>
);

// Compact executive briefing card.
const ExecutiveBriefing = ({ report }) => {
  if (!report) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-white via-blue-50/30 to-white p-4 shadow-sm mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-[#185FA5]" />
        <h3 className="text-sm font-semibold text-slate-900">Executive Briefing</h3>
      </div>
      <p className="text-[13px] leading-relaxed text-slate-700">{report.executive_summary}</p>
      {report.intelligence_observations && (
        <p className="text-[12px] leading-relaxed text-slate-600 mt-2 pt-2 border-t border-slate-100">
          <span className="font-semibold text-slate-700">Observations: </span>
          {report.intelligence_observations}
        </p>
      )}
    </div>
  );
};

// "Ask AI about this report" — scoped chat that uses /rag/query with the
// report's snapshot inlined as system context.
const AskAiAboutReport = ({ report, windowHours }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [thread, setThread] = useState([]); // { role, content }
  const [busy, setBusy] = useState(false);

  const suggestions = [
    'What should I focus on first?',
    'Summarise the top risks in 3 bullets',
    'Which profile deserves the most attention?',
    'Draft an evening briefing for the SP'
  ];

  const ask = useCallback(async (question) => {
    const text = (question || q).trim();
    if (!text || busy) return;
    setQ('');
    setThread((t) => [...t, { role: 'user', content: text }]);
    setBusy(true);
    try {
      // Inline a compact JSON snapshot of the live report so the LLM has
      // grounded numbers to reason over without hitting the DB again.
      const snapshot = {
        window_hours: windowHours,
        threat_level: report?.threat_level,
        threat_score: report?.threat_score,
        executive_summary: report?.executive_summary,
        alerts: {
          total: report?.alerts?.total_count,
          high: report?.alerts?.priority_scoring?.high,
          medium: report?.alerts?.priority_scoring?.medium,
          escalated: report?.alerts?.escalated_count,
          top_categories: report?.alerts?.by_category?.slice(0, 5)
        },
        grievances: {
          total: report?.grievances?.total_count,
          pending: report?.grievances?.pending,
          by_type: report?.grievances?.by_type
        },
        events: {
          total: report?.events?.total_count,
          top: (report?.events?.top_events || []).slice(0, 5).map((e) => ({
            name: e.event_name, posts: e.content_count, risk: e.risk_score
          }))
        },
        keywords: (report?.keywords_trends || []).slice(0, 10),
        recommendations: report?.recommendations
      };
      const prompt = `You are reasoning over this Soceye Live Report snapshot (JSON):\n${JSON.stringify(snapshot, null, 2)}\n\nQuestion: ${text}\n\nAnswer concisely, cite specific numbers from the snapshot, and recommend the next step.`;
      const res = await api.post('/rag/query', {
        question: prompt,
        collection: 'all',
        top_k: 6,
        time_window_days: Math.max(1, Math.ceil((windowHours || 24) / 24)),
        use_db: false // Pure LLM reasoning over the inlined snapshot — don't re-query DB.
      });
      setThread((t) => [...t, { role: 'assistant', content: res.data?.answer || '_(no answer)_' }]);
    } catch (e) {
      setThread((t) => [...t, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }, [q, busy, report, windowHours]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 bg-gradient-to-br from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white px-4 py-2.5 rounded-full shadow-xl shadow-blue-500/30 text-sm font-medium transition active:scale-95"
        title="Ask AI about this report"
      >
        <Bot className="h-4 w-4" /> Ask AI about this report
      </button>
    );
  }
  return (
    <div className="fixed bottom-6 right-6 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col max-h-[70vh]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-blue-600 to-indigo-700 text-white rounded-t-2xl">
        <Bot className="h-4 w-4" />
        <span className="text-sm font-semibold">Ask AI about this report</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto text-white/70 hover:text-white text-xs"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {thread.length === 0 && (
          <>
            <div className="text-[11px] text-slate-500 mb-1">Try one of these:</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-slate-50 border border-slate-200 hover:bg-blue-50 hover:border-blue-200 text-slate-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {thread.map((m, i) => (
          <div key={i} className={`text-[12px] rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-blue-600 text-white ml-6' : 'bg-slate-50 text-slate-800 mr-6 border border-slate-100'}`}>
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="text-[11px] text-slate-500 inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>
      <div className="border-t border-slate-100 p-2 flex gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
          placeholder="Ask anything about this report…"
          className="flex-1 text-[12px] border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          type="button"
          onClick={() => ask()}
          disabled={!q.trim() || busy}
          className="inline-flex items-center justify-center bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-md px-2.5"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

/* ───────────────────────── export helpers ───────────────────────── */
const captureNode = async (node) => {
  if (!node) return null;
  return html2canvas(node, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    logging: false
  });
};

const exportNodeAsPng = async (node, filename) => {
  const canvas = await captureNode(node);
  if (!canvas) return;
  canvas.toBlob((blob) => blob && saveAs(blob, filename));
};

const exportNodeAsPdf = async (node, filename, title) => {
  const canvas = await captureNode(node);
  if (!canvas) return;
  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  pdf.setFontSize(13);
  pdf.text(title || 'Soceye Report', 14, 14);
  pdf.setFontSize(9);
  pdf.setTextColor(120);
  pdf.text(`Generated ${new Date().toLocaleString('en-IN')}`, 14, 19);
  pdf.setTextColor(0);
  const imgW = pageW - 20;
  const imgH = (canvas.height * imgW) / canvas.width;
  let heightLeft = imgH;
  let position = 24;
  pdf.addImage(imgData, 'PNG', 10, position, imgW, imgH);
  heightLeft -= pageH - position;
  while (heightLeft > 0) {
    position = heightLeft - imgH;
    pdf.addPage();
    pdf.addImage(imgData, 'PNG', 10, position, imgW, imgH);
    heightLeft -= pageH;
  }
  pdf.save(filename);
};

const downloadCsv = (rows, headers, filename) => {
  if (!rows?.length) return;
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  rows.forEach((r) => lines.push(headers.map((h) => escape(r[h])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  saveAs(blob, filename);
};

/* ───────────────────────── tab views ───────────────────────── */
const OverviewTab = ({ report, fileTag }) => {
  const dial = report.dial100_calls || {};
  const griev = report.grievances || {};
  const events = report.events || {};
  const alerts = report.alerts || {};
  const summary = report.summary_statistics || {};

  const dial100Ref = useRef(null);
  const grievRef = useRef(null);
  const eventsRef = useRef(null);
  const alertsRef = useRef(null);

  const grievByType = griev.by_type || {};
  const allTimeAlertsReports = report.escalations || {};

  // Headline KPIs — at-a-glance for the SP.
  const headline = [
    { label: 'Alerts',     value: alerts.total_count,        tone: 'red',   trend: alerts.trend_percentage },
    { label: 'HIGH',       value: alerts.priority_scoring?.high, tone: 'red' },
    { label: 'Viral',      value: summary.viral_posts_count, tone: 'orange' },
    { label: 'Grievances', value: griev.total_count,         tone: 'blue',  trend: griev.trend_percentage },
    { label: 'Events',     value: events.total_count,        tone: 'teal',  trend: events.trend_percentage },
    { label: 'Dial-100',   value: dial.total_count,          tone: 'amber', trend: dial.trend_percentage }
  ];

  const sentiment = summary.sentiment_breakdown || { positive: 0, neutral: 0, negative: 0 };

  return (
    <div>
      {/* ── Executive Briefing ── */}
      <ExecutiveBriefing report={report} />

      {/* ── Headline KPI strip ── */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
        {headline.map((h) => (
          <MetricWithTrend
            key={h.label}
            label={h.label}
            value={fmtNum(h.value)}
            tone={h.tone}
            trend={h.trend}
          />
        ))}
      </div>

      {/* ── Recommendations + Sentiment + Platform Mix ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-5">
        <div className="lg:col-span-2">
          <RecommendationsCard recommendations={report.recommendations || []} />
        </div>
        <div className="space-y-3">
          <SentimentBar
            positive={sentiment.positive}
            neutral={sentiment.neutral}
            negative={sentiment.negative}
          />
          <HBarList
            title="Alerts by Platform"
            items={(alerts.by_platform || []).map((p) => ({ label: p.platform, count: p.count })).sort((a, b) => b.count - a.count)}
            totalLabel="alerts"
            accent="#A32D2D"
          />
        </div>
      </div>

      {/* ── Hourly alert timeline ── */}
      {(alerts.hourly_distribution || []).length > 0 && (
        <div className="mb-5">
          <HourlyTimeline buckets={alerts.hourly_distribution} />
        </div>
      )}

      {/* 1. Dial 100 */}
      <SectionShell
        ref={dial100Ref}
        num={1}
        title="Dial 100 Calls"
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(dial100Ref.current, `${fileTag}_dial100.png`)}
        onExportPdf={() => exportNodeAsPdf(dial100Ref.current, `${fileTag}_dial100.pdf`, 'Dial 100 Calls')}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <Metric label="Total Received" value={fmtNum(dial.total_count)} tone="blue" />
          <Metric label="Critical" value={fmtNum(dial.critical_incidents)} tone="red" />
          <Metric label="Avg Response (min)" value={fmtNum(dial.response_time_avg)} />
          <Metric label="Trend vs prev" value={`${(dial.trend_percentage ?? 0) >= 0 ? '↑' : '↓'} ${Math.abs(dial.trend_percentage ?? 0)}%`} tone={dial.trend_percentage >= 0 ? 'green' : 'red'} />
        </div>
        {dial.by_category?.length > 0 && (
          <div className="mt-3 text-xs text-slate-600">
            Top categories: {dial.by_category.slice(0, 4).map((c) => `${c.category} (${c.count})`).join(' · ')}
          </div>
        )}
      </SectionShell>

      {/* 2. Grievances */}
      <SectionShell
        ref={grievRef}
        num={2}
        title="Grievances"
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(grievRef.current, `${fileTag}_grievances.png`)}
        onExportPdf={() => exportNodeAsPdf(grievRef.current, `${fileTag}_grievances.pdf`, 'Grievances')}
      >
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-100 bg-white p-3.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-2">This Period</div>
            <RowItem label="Posts tagging us" value={fmtNum(griev.total_count)} />
            <RowItem label="Converted → Grievances" value={fmtNum(grievByType.grievance)} valueClass="text-[#185FA5]" />
            <RowItem label="Converted → Criticism" value={fmtNum(grievByType.criticism)} valueClass="text-[#A32D2D]" />
            <RowItem label="Converted → Suggestions" value={fmtNum(grievByType.suggestion)} valueClass="text-[#3B6D11]" />
            {grievByType.query > 0 && (
              <RowItem label="Converted → Queries" value={fmtNum(grievByType.query)} valueClass="text-[#0F6E56]" />
            )}
          </div>
          <div className="rounded-lg border border-slate-100 bg-white p-3.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-2">All Time</div>
            <div className="flex gap-2">
              <div className="flex-1 rounded-md bg-slate-50 px-3 py-2.5 text-center border border-slate-100">
                <div className="text-[11px] text-slate-500">Pending</div>
                <div className="text-[20px] font-semibold text-[#854F0B]">{fmtNum(griev.all_time_pending)}</div>
              </div>
              <div className="flex-1 rounded-md bg-slate-50 px-3 py-2.5 text-center border border-slate-100">
                <div className="text-[11px] text-slate-500">Closed</div>
                <div className="text-[20px] font-semibold text-[#3B6D11]">{fmtNum(griev.all_time_closed)}</div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-1">In Window</div>
              <RowItem label="Pending / In-flight" value={fmtNum(griev.pending)} valueClass="text-[#854F0B]" />
              <RowItem label="Under Review" value={fmtNum(griev.under_review)} />
              <RowItem label="Closed" value={fmtNum(griev.closed)} valueClass="text-[#3B6D11]" />
            </div>
          </div>
        </div>
        {griev.ai_summary && (
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600 italic border-l-2 border-blue-200 pl-3">
            <span className="not-italic font-semibold text-slate-700">AI summary: </span>{griev.ai_summary}
          </p>
        )}
      </SectionShell>

      {/* 3. Events */}
      <SectionShell
        ref={eventsRef}
        num={3}
        title="Events"
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(eventsRef.current, `${fileTag}_events.png`)}
        onExportPdf={() => exportNodeAsPdf(eventsRef.current, `${fileTag}_events.pdf`, 'Events')}
      >
        <div className="flex flex-wrap gap-2 mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1 text-xs border border-slate-100">
            <span className="text-slate-500">Monitoring</span>
            <span className="font-semibold text-slate-900">{fmtNum(events.total_count)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1 text-xs border border-slate-100">
            <span className="text-slate-500">Human Trafficking flags</span>
            <span className="font-semibold text-slate-900">{fmtNum(events.human_trafficking)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1 text-xs border border-slate-100">
            <span className="text-slate-500">Public Unrest</span>
            <span className="font-semibold text-slate-900">{fmtNum(events.public_unrest)}</span>
          </span>
        </div>
        {(events.top_events || []).length === 0 ? (
          <EmptyHint msg="No active events in this window." />
        ) : (
          <div className="space-y-2.5">
            {(events.top_events || []).slice(0, 6).map((ev) => (
              <div key={ev.event_id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#1D9E75] animate-pulse" />
                  <div className="font-medium text-[13px] text-slate-900 flex-1 truncate">{ev.event_name || ev.event_id}</div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1"><ImageIcon className="h-3 w-3" /> {fmtNum(ev.content_count)} posts</span>
                  {ev.platforms?.length > 0 && (
                    <span className="inline-flex items-center gap-1"><Network className="h-3 w-3" /> {ev.platforms.join(', ')}</span>
                  )}
                  {ev.risk_score != null && (
                    <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Risk {ev.risk_score}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionShell>

      {/* 4. Alerts summary */}
      <SectionShell
        ref={alertsRef}
        num={4}
        title="Alerts"
        accent="#A32D2D"
        onExportPng={() => exportNodeAsPng(alertsRef.current, `${fileTag}_alerts_summary.png`)}
        onExportPdf={() => exportNodeAsPdf(alertsRef.current, `${fileTag}_alerts_summary.pdf`, 'Alerts')}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <Metric label="Alerts Received" value={fmtNum(alerts.total_count)} tone="red" />
          <Metric label="HIGH" value={fmtNum(alerts.priority_scoring?.high)} tone="red" />
          <Metric label="MEDIUM" value={fmtNum(alerts.priority_scoring?.medium)} tone="amber" />
          <Metric label="Escalated" value={fmtNum(alerts.escalated_count)} tone="orange" />
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3 grid md:grid-cols-2 gap-2">
          <RowItem label="Reports generated (window)" value={fmtNum(allTimeAlertsReports.total_count)} />
          <RowItem label="Reports closed" value={fmtNum(allTimeAlertsReports.closed)} valueClass="text-[#3B6D11]" />
          <RowItem label="Reports pending" value={fmtNum(allTimeAlertsReports.pending)} valueClass="text-[#854F0B]" />
          <RowItem label="Viral posts detected" value={fmtNum(summary.viral_posts_count)} />
        </div>
        {alerts.ai_intelligence_summary && (
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600 italic border-l-2 border-red-200 pl-3">
            <span className="not-italic font-semibold text-slate-700">AI summary: </span>{alerts.ai_intelligence_summary}
          </p>
        )}
      </SectionShell>
    </div>
  );
};

// Per-event card with expandable list of fetched posts. Content is fetched
// lazily on first expand so we don't hammer the backend for every event when
// the tab loads.
const EventCardWithPosts = ({ ev, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [posts, setPosts] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [platform, setPlatform] = useState('all');
  const [error, setError] = useState('');
  const [loadedOnce, setLoadedOnce] = useState(false);

  const fetchPosts = useCallback(async (p = 1, plat = platform, replace = false) => {
    if (!ev?.event_id) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/events/${ev.event_id}/content`, {
        params: { page: p, limit: 24, platform: plat }
      });
      const items = res.data?.content || [];
      setPosts((prev) => replace ? items : [...prev, ...items]);
      setPage(p);
      setHasMore(res.data?.has_more !== false);
      setLoadedOnce(true);
    } catch (e) {
      setError(e?.response?.data?.message || e.message || 'Failed to load posts');
    } finally {
      setLoading(false);
    }
  }, [ev?.event_id, platform]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && !loadedOnce) fetchPosts(1, platform, true);
  }, [expanded, loadedOnce, platform, fetchPosts]);

  const onPlatformChange = useCallback((newPlat) => {
    setPlatform(newPlat);
    fetchPosts(1, newPlat, true);
  }, [fetchPosts]);

  const platformOptions = useMemo(() => {
    const set = new Set(['all', ...(ev.platforms || [])]);
    return Array.from(set);
  }, [ev.platforms]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0">
          <div className="font-medium text-[14px] text-slate-900">{ev.event_name || ev.event_id}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">Monitoring since {fmtDateTime(ev.timestamp)}</div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(ev.platforms || []).map((p) => {
            const b = platformBadge(p);
            return (
              <span key={p} className={`text-[10px] font-medium px-2 py-0.5 rounded ${b.cls}`}>
                {b.label}
              </span>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <Metric label="Posts Fetched" value={fmtNum(ev.content_count)} tone="blue" />
        <Metric label="Reach" value={fmtNum(ev.reach)} />
        <Metric label="Risk Score" value={fmtNum(ev.risk_score)} tone="red" />
        <Metric label="Engagement" value={fmtNum(ev.engagement_metrics?.likes)} tone="teal" />
      </div>

      {/* Expand / collapse posts */}
      <div className="mt-2 border-t border-slate-100 pt-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!ev.event_id || ev.content_count === 0}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[#185FA5] hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Hide' : 'View'} fetched posts
          {ev.content_count > 0 && (
            <span className="text-slate-400 font-normal">({fmtNum(ev.content_count)})</span>
          )}
        </button>

        {expanded && (
          <div className="mt-3">
            {platformOptions.length > 2 && (
              <div className="flex gap-1.5 flex-wrap mb-3">
                {platformOptions.map((p) => {
                  const isActive = p === platform;
                  const label = p === 'all' ? 'All' : platformBadge(p).label;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => onPlatformChange(p)}
                      className={`text-[11px] px-2.5 py-1 rounded-md border ${
                        isActive
                          ? 'bg-[#185FA5] text-white border-[#185FA5]'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {error && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5" /> {error}
              </div>
            )}

            {loading && posts.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-slate-500 gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-xs">Loading fetched posts…</span>
              </div>
            ) : posts.length === 0 ? (
              <EmptyHint msg="No posts fetched for this event yet." />
            ) : (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                  {[0, 1].map((col) => (
                    <div key={col} className="flex flex-col gap-3 min-w-0">
                      {posts
                        .filter((_, idx) => idx % 2 === col)
                        .map((c, idx) => (
                          <div key={c.id || `${col}-${idx}`} className="min-w-0">
                            <ContentCard item={c} index={idx} />
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
                {hasMore && (
                  <div className="flex justify-center mt-3">
                    <button
                      type="button"
                      onClick={() => fetchPosts(page + 1, platform, false)}
                      disabled={loading}
                      className="inline-flex items-center gap-1.5 text-[12px] rounded-md border border-slate-200 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {loading ? 'Loading…' : 'Load more'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const EventsTab = ({ report, fileTag }) => {
  const events = (report.events?.top_events || []);
  const containerRef = useRef(null);

  if (events.length === 0) {
    return (
      <SectionShell title="Events Dashboard" icon={Network} accent="#185FA5">
        <EmptyHint msg="No events recorded in this window." />
      </SectionShell>
    );
  }

  return (
    <div ref={containerRef}>
      <SectionShell
        title="Events Dashboard"
        icon={Network}
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(containerRef.current, `${fileTag}_events_dashboard.png`)}
        onExportPdf={() => exportNodeAsPdf(containerRef.current, `${fileTag}_events_dashboard.pdf`, 'Events Dashboard')}
        onExportCsv={() =>
          downloadCsv(
            events.map((e) => ({
              event_name: e.event_name,
              posts_fetched: e.content_count,
              platforms: (e.platforms || []).join(' | '),
              risk_score: e.risk_score,
              timestamp: e.timestamp
            })),
            ['event_name', 'posts_fetched', 'platforms', 'risk_score', 'timestamp'],
            `${fileTag}_events.csv`
          )
        }
      >
        <div className="space-y-3">
          {events.map((ev, i) => (
            <EventCardWithPosts key={ev.event_id || i} ev={ev} defaultExpanded={i === 0} />
          ))}
        </div>
      </SectionShell>
    </div>
  );
};

// Masonry grid of full alert cards (mirrors the Alerts page layout)
const AlertCardMasonry = ({ alerts, emptyMsg, showRank = true, onResolve, hideActions = false }) => {
  const [cols, setCols] = useState(() =>
    typeof window === 'undefined' ? 3 : window.innerWidth < 768 ? 1 : window.innerWidth < 1200 ? 2 : 3
  );
  useEffect(() => {
    const handler = () => {
      setCols(window.innerWidth < 768 ? 1 : window.innerWidth < 1200 ? 2 : 3);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  if (!alerts?.length) return <EmptyHint msg={emptyMsg} />;

  const buckets = Array.from({ length: cols }, () => []);
  alerts.forEach((a, i) => buckets[i % cols].push({ alert: a, rank: i + 1 }));

  return (
    <div className="flex gap-4 w-full items-start">
      {buckets.map((bucket, ci) => (
        <div key={ci} className="flex-1 min-w-0 flex flex-col gap-4">
          {bucket.map(({ alert, rank }) => {
            const isYoutube = alert?.platform === 'youtube';
            const contentData =
              alert?.content_details ||
              (alert?.content_id && typeof alert.content_id === 'object' ? alert.content_id : null) ||
              {};
            const sourceData =
              alert?.source_meta ||
              alert?.source_details ||
              alert?.source ||
              (alert?.author ? { name: alert.author } : null);
            return (
              <div key={alert.id || rank} className="relative">
                {showRank && (
                  <span className="absolute -top-2.5 -left-2.5 z-10 w-7 h-7 rounded-full bg-gradient-to-br from-red-600 to-orange-500 text-white text-[11px] font-bold flex items-center justify-center shadow-md ring-2 ring-white">
                    #{rank}
                  </span>
                )}
                {isYoutube ? (
                  <YoutubeAlertCard
                    alert={alert}
                    content={contentData}
                    source={sourceData}
                    viewMode="grid"
                    hideActions={hideActions}
                    onResolve={onResolve}
                  />
                ) : (
                  <TwitterAlertCard
                    alert={alert}
                    content={contentData}
                    source={sourceData}
                    viewMode="grid"
                    hideActions={hideActions}
                    onResolve={onResolve}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const AlertsTab = ({ report, fileTag, fullAlertsById, hydrating, onAlertResolve }) => {
  const summary = report.alerts || {};
  const topIds = report.alerts?.top_alert_ids || [];
  const viralIds = report.alerts?.viral_alert_ids || [];

  const [search, setSearch] = useState('');
  const [riskFilter, setRiskFilter] = useState('all'); // all | high | medium | low
  const [platformFilter, setPlatformFilter] = useState('all');

  const matches = useCallback((a) => {
    if (!a) return false;
    if (riskFilter !== 'all' && String(a.risk_level || a.threat_level || '').toLowerCase() !== riskFilter) return false;
    if (platformFilter !== 'all' && String(a.platform || '').toLowerCase() !== platformFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const hay = `${a.title || ''} ${a.author || ''} ${a.author_handle || ''} ${(a.matched_keywords_normalized || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  }, [search, riskFilter, platformFilter]);

  // Preserve the backend-supplied order
  const topAlerts = useMemo(
    () => topIds.map((id) => fullAlertsById[id]).filter(Boolean).filter(matches),
    [topIds, fullAlertsById, matches]
  );
  const viralAlerts = useMemo(
    () => viralIds.map((id) => fullAlertsById[id]).filter(Boolean).filter(matches),
    [viralIds, fullAlertsById, matches]
  );

  const top50Summary = report.alerts?.alert_summaries || [];
  const allPlatforms = useMemo(() => {
    const set = new Set();
    Object.values(fullAlertsById).forEach((a) => { if (a?.platform) set.add(a.platform.toLowerCase()); });
    return Array.from(set);
  }, [fullAlertsById]);
  const viralRef = useRef(null);
  const tableRef = useRef(null);
  const overviewRef = useRef(null);

  return (
    <div>
      <SectionShell
        ref={overviewRef}
        title="Alerts Overview"
        icon={BellRing}
        accent="#A32D2D"
        onExportPng={() => exportNodeAsPng(overviewRef.current, `${fileTag}_alerts_overview.png`)}
        onExportPdf={() => exportNodeAsPdf(overviewRef.current, `${fileTag}_alerts_overview.pdf`, 'Alerts Overview')}
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          <MetricWithTrend label="Total Alerts" value={fmtNum(summary.total_count)} tone="red" trend={summary.trend_percentage} />
          <Metric label="HIGH" value={fmtNum(summary.priority_scoring?.high)} tone="red" />
          <Metric label="MEDIUM" value={fmtNum(summary.priority_scoring?.medium)} tone="amber" />
          <Metric label="Escalated" value={fmtNum(summary.escalated_count)} tone="orange" />
          <Metric label="Resolution %" value={`${summary.resolution_rate ?? 0}%`} tone={summary.resolution_rate >= 50 ? 'green' : 'amber'} />
        </div>

        {/* ── Search & filter ── */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, author, handle, keyword…"
              className="w-full pl-8 pr-3 py-1.5 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <select
            value={riskFilter}
            onChange={(e) => setRiskFilter(e.target.value)}
            className="text-[12px] border border-slate-200 rounded-md px-2 py-1.5 bg-white"
          >
            <option value="all">All risks</option>
            <option value="high">HIGH</option>
            <option value="medium">MEDIUM</option>
            <option value="low">LOW</option>
          </select>
          {allPlatforms.length > 0 && (
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="text-[12px] border border-slate-200 rounded-md px-2 py-1.5 bg-white"
            >
              <option value="all">All platforms</option>
              {allPlatforms.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          {(search || riskFilter !== 'all' || platformFilter !== 'all') && (
            <button
              type="button"
              onClick={() => { setSearch(''); setRiskFilter('all'); setPlatformFilter('all'); }}
              className="text-[11px] text-slate-500 hover:text-rose-600 px-2"
            >
              Clear
            </button>
          )}
        </div>
      </SectionShell>

      <SectionShell
        ref={viralRef}
        title={`Viral Posts${viralAlerts.length ? ` · ${viralAlerts.length}` : ''}`}
        icon={Activity}
        accent="#993C1D"
        onExportPng={() => exportNodeAsPng(viralRef.current, `${fileTag}_viral.png`)}
        onExportPdf={() => exportNodeAsPdf(viralRef.current, `${fileTag}_viral.pdf`, 'Viral Posts')}
        onExportCsv={() =>
          downloadCsv(
            viralAlerts.map((a, i) => ({
              rank: i + 1,
              id: a.id,
              title: a.title,
              author: a.author,
              platform: a.platform,
              risk_level: a.risk_level,
              status: a.status,
              content_url: a.content_url,
              velocity: a.velocity_data?.velocity,
              triggered: a.velocity_data?.threshold_triggered
            })),
            ['rank', 'id', 'title', 'author', 'platform', 'risk_level', 'status', 'content_url', 'velocity', 'triggered'],
            `${fileTag}_viral.csv`
          )
        }
      >
        {hydrating && viralAlerts.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading viral post cards…
          </div>
        ) : (
          <AlertCardMasonry
            alerts={viralAlerts}
            emptyMsg="No viral posts detected in this window."
            onResolve={onAlertResolve}
          />
        )}
      </SectionShell>

      <SectionShell
        ref={tableRef}
        title={`Top ${topAlerts.length || top50Summary.length} Alerts`}
        icon={AlertTriangle}
        accent="#A32D2D"
        onExportPng={() => exportNodeAsPng(tableRef.current, `${fileTag}_top50.png`)}
        onExportPdf={() => {
          const pdf = new jsPDF('p', 'mm', 'a4');
          pdf.setFontSize(13);
          pdf.text(`Top ${topAlerts.length || top50Summary.length} Alerts`, 14, 14);
          pdf.setFontSize(9);
          pdf.setTextColor(120);
          pdf.text(`Generated ${new Date().toLocaleString('en-IN')}`, 14, 19);
          pdf.setTextColor(0);
          const rows = (topAlerts.length ? topAlerts : top50Summary).map((a, i) => [
            i + 1,
            ((a.title || '') + '').slice(0, 60),
            a.platform || a.category || '',
            a.risk_level || a.threat_level || '',
            a.status || ''
          ]);
          autoTable(pdf, {
            startY: 24,
            head: [['#', 'Title', 'Platform / Category', 'Risk', 'Status']],
            body: rows,
            styles: { fontSize: 8 }
          });
          pdf.save(`${fileTag}_top50.pdf`);
        }}
        onExportCsv={() =>
          downloadCsv(
            (topAlerts.length ? topAlerts : top50Summary).map((a, i) => ({
              rank: i + 1,
              id: a.id || a.alert_id,
              title: a.title,
              author: a.author,
              platform: a.platform,
              risk_level: a.risk_level || a.threat_level,
              status: a.status,
              content_url: a.content_url
            })),
            ['rank', 'id', 'title', 'author', 'platform', 'risk_level', 'status', 'content_url'],
            `${fileTag}_top50.csv`
          )
        }
      >
        {hydrating && topAlerts.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-500 text-xs py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading alert cards…
          </div>
        ) : (
          <AlertCardMasonry
            alerts={topAlerts}
            emptyMsg="No alerts in this window."
            onResolve={onAlertResolve}
          />
        )}
      </SectionShell>
    </div>
  );
};

const ProfilesTab = ({ report, fileTag }) => {
  const profiles = report.profiles || {};
  const topProfiles = report.alerts?.top_profiles || [];
  const keywords = report.keywords_trends || [];

  const summaryRef = useRef(null);
  const profilesRef = useRef(null);
  const kwRef = useRef(null);

  const byPlatformMap = useMemo(() => {
    const m = {};
    (profiles.by_platform || []).forEach((p) => {
      m[String(p.platform || '').toLowerCase()] = p.active;
    });
    return m;
  }, [profiles]);

  return (
    <div>
      <SectionShell
        ref={summaryRef}
        title="Profiles"
        icon={Users}
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(summaryRef.current, `${fileTag}_profiles_summary.png`)}
        onExportPdf={() => exportNodeAsPdf(summaryRef.current, `${fileTag}_profiles_summary.pdf`, 'Profiles')}
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          <Metric label="Total Monitoring" value={fmtNum(profiles.total_monitoring)} tone="blue" />
          <Metric label="X Profiles" value={fmtNum(byPlatformMap.x || byPlatformMap.twitter)} />
          <Metric label="Instagram" value={fmtNum(byPlatformMap.instagram)} tone="orange" />
          <Metric label="Facebook" value={fmtNum(byPlatformMap.facebook)} tone="blue" />
          <Metric label="YouTube" value={fmtNum(byPlatformMap.youtube)} tone="red" />
        </div>
      </SectionShell>

      <SectionShell
        ref={profilesRef}
        title="Top Active Profiles"
        icon={TrendingUp}
        accent="#185FA5"
        onExportPng={() => exportNodeAsPng(profilesRef.current, `${fileTag}_top_profiles.png`)}
        onExportPdf={() => exportNodeAsPdf(profilesRef.current, `${fileTag}_top_profiles.pdf`, 'Top Active Profiles')}
        onExportCsv={() =>
          downloadCsv(
            topProfiles.map((p) => ({
              name: p.name, handle: p.handle, platform: p.platform,
              category: p.category, influence_score: p.influence_score, threat_score: p.threat_score
            })),
            ['name', 'handle', 'platform', 'category', 'influence_score', 'threat_score'],
            `${fileTag}_top_profiles.csv`
          )
        }
      >
        {topProfiles.length === 0 ? (
          <EmptyHint msg="No active profile activity in this window." />
        ) : (
          <div className="space-y-1.5">
            {topProfiles.slice(0, 10).map((p, i) => {
              const palette = AVATAR_PALETTE[i % AVATAR_PALETTE.length];
              const initials = (p.name || p.handle || '??').replace('@', '').slice(0, 2).toUpperCase();
              const b = platformBadge(p.platform);
              const to = profileUrl(p.platform, p.handle, p.profile_id);
              const rowCls = `flex items-center gap-2.5 rounded-md bg-slate-50 px-3 py-2 border border-slate-100 ${to ? 'hover:bg-blue-50 hover:border-blue-200 cursor-pointer transition-colors' : ''}`;
              const body = (
                <>
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
                    style={{ background: palette.bg, color: palette.fg }}
                  >
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-slate-900 truncate">{p.name || '—'}</div>
                    <div className="text-[11px] text-slate-500 truncate">@{p.handle || 'unknown'}</div>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${b.cls}`}>{b.label}</span>
                  <span className="text-[11px] text-slate-500 whitespace-nowrap">
                    {p.alert_count ? `${p.alert_count} alert${p.alert_count > 1 ? 's' : ''}` : `Threat ${p.threat_score ?? '—'}`}
                  </span>
                </>
              );
              if (to) {
                return (
                  <Link key={p.profile_id || i} to={to} title={`Open ${p.handle || p.name} in app`} className={rowCls}>
                    {body}
                  </Link>
                );
              }
              return <div key={p.profile_id || i} className={rowCls}>{body}</div>;
            })}
          </div>
        )}
      </SectionShell>

      <SectionShell
        ref={kwRef}
        title="Top 10 Keywords"
        icon={Hash}
        accent="#0F6E56"
        onExportPng={() => exportNodeAsPng(kwRef.current, `${fileTag}_keywords.png`)}
        onExportPdf={() => exportNodeAsPdf(kwRef.current, `${fileTag}_keywords.pdf`, 'Top 10 Keywords')}
        onExportCsv={() =>
          downloadCsv(
            keywords.map((k, i) => ({
              rank: i + 1,
              keyword: k.keyword,
              frequency: k.frequency,
              sentiment: k.sentiment,
              trend: k.trend,
              risk_level: k.risk_level,
              platforms: (k.platforms || []).join(' | ')
            })),
            ['rank', 'keyword', 'frequency', 'sentiment', 'trend', 'risk_level', 'platforms'],
            `${fileTag}_keywords.csv`
          )
        }
      >
        {keywords.length === 0 ? (
          <EmptyHint msg="No tracked keywords surfaced in this window." />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {keywords.slice(0, 10).map((k, i) => (
              <Link
                key={k.keyword || i}
                to={`/alerts?search=${encodeURIComponent(k.keyword)}`}
                title={`Show alerts related to "${k.keyword}"`}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-blue-50 hover:border-blue-200 transition-colors"
              >
                <span className="text-[10px] text-slate-400">{i + 1}</span>
                <span className="text-slate-800 font-medium">{k.keyword}</span>
                <span className="text-[10px] text-slate-500">· {fmtNum(k.frequency)}</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sentimentCls(k.sentiment)}`}>
                  {k.sentiment || 'neutral'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </SectionShell>
    </div>
  );
};

/* ───────────────────────── main component ───────────────────────── */
const TABS = [
  { id: 'overview', label: 'Report Overview', icon: FileBarChart },
  { id: 'events',   label: 'Events Dashboard', icon: Network },
  { id: 'alerts',   label: 'Alerts Dashboard', icon: BellRing },
  { id: 'profiles', label: 'Profiles & Keywords', icon: Users }
];

const AUTO_REFRESH_OPTIONS = [
  { label: 'Off',      value: 0 },
  { label: '1 min',    value: 60_000 },
  { label: '5 min',    value: 300_000 },
  { label: '15 min',   value: 900_000 }
];

const PINNED_STORAGE_KEY = 'soceye.report.pinnedSnapshots.v1';

const SoceyeDailyReport = () => {
  const [activeTab, setActiveTab] = useState('overview');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hours, setHours] = useState(24);
  const [fullAlertsById, setFullAlertsById] = useState({});
  const [hydratingAlerts, setHydratingAlerts] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());

  // History — past saved snapshots
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingSnapshotId, setViewingSnapshotId] = useState(null); // null = live
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [pinned, setPinned] = useState(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const togglePinned = useCallback((snapId) => {
    setPinned((prev) => {
      const next = { ...prev };
      if (next[snapId]) delete next[snapId];
      else next[snapId] = Date.now();
      try { window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const fetchReport = useCallback(async (hrs, opts = {}) => {
    const { silent = false } = opts;
    if (!silent) setLoading(true);
    setError('');
    if (!silent) {
      setFullAlertsById({});
      setViewingSnapshotId(null);
      setSnapshotMeta(null);
    }
    try {
      const res = await api.get('/comprehensive-report/soceye-live', { params: { hours: hrs } });
      if (res.data?.success) {
        setReport(res.data.report);
        setLastRefreshedAt(Date.now());
      } else {
        setError(res.data?.error || 'Failed to load report');
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load report');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await api.get('/comprehensive-report/soceye-history', { params: { limit: 60 } });
      if (res.data?.success) setHistory(res.data.snapshots || []);
    } catch {
      // History is non-critical; ignore.
    }
  }, []);

  const loadSnapshot = useCallback(async (snapId) => {
    setLoading(true);
    setError('');
    setFullAlertsById({});
    setHistoryOpen(false);
    try {
      const res = await api.get(`/comprehensive-report/soceye-history/${snapId}`);
      if (res.data?.success) {
        setReport(res.data.report);
        setViewingSnapshotId(snapId);
        setSnapshotMeta(res.data.snapshot);
      } else {
        setError(res.data?.error || 'Failed to load snapshot');
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load snapshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReport(hours); }, [fetchReport, hours]);
  useEffect(() => { fetchHistory(); }, [fetchHistory, report]);

  // Auto-refresh on a configurable interval. We refresh silently (no full
  // spinner takeover) so the officer can keep reading while data updates.
  useEffect(() => {
    if (!autoRefreshMs || viewingSnapshotId) return;
    const id = setInterval(() => {
      fetchReport(hours, { silent: true });
    }, autoRefreshMs);
    return () => clearInterval(id);
  }, [autoRefreshMs, hours, viewingSnapshotId, fetchReport]);

  // Clock tick for the "Updated X ago" indicator.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Apply local update when a card's action (ack / escalate / resolve / risk change) succeeds.
  const handleAlertResolve = useCallback((resolved) => {
    if (!resolved?.id) return;
    setFullAlertsById((prev) => {
      const existing = prev[resolved.id];
      if (!existing) return prev;
      return { ...prev, [resolved.id]: { ...existing, ...resolved } };
    });
  }, []);

  // Hydrate full Alert documents (with content_details & source_meta) for cards.
  useEffect(() => {
    const topIds = report?.alerts?.top_alert_ids || [];
    const viralIds = report?.alerts?.viral_alert_ids || [];
    const uniqueIds = Array.from(new Set([...topIds, ...viralIds])).filter(Boolean);
    if (uniqueIds.length === 0) return;

    let cancelled = false;
    setHydratingAlerts(true);
    (async () => {
      try {
        const BATCH = 25;
        const map = {};
        for (let i = 0; i < uniqueIds.length; i += BATCH) {
          const slice = uniqueIds.slice(i, i + BATCH);
          const res = await api.post('/alerts/bulk', { ids: slice });
          (res.data?.alerts || []).forEach((a) => { if (a?.id) map[a.id] = a; });
          if (cancelled) return;
        }
        if (!cancelled) setFullAlertsById(map);
      } catch (e) {
        // Cards just won't show — summary still rendered.
      } finally {
        if (!cancelled) setHydratingAlerts(false);
      }
    })();

    return () => { cancelled = true; };
  }, [report]);

  const fileTag = useMemo(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    return `soceye_${hours}h_${stamp}`;
  }, [hours]);

  const rangeLabel = useMemo(() => {
    if (!report?.date_range) return '—';
    return `${fmtDateTime(report.date_range.start)}  →  ${fmtDateTime(report.date_range.end)}`;
  }, [report]);

  // Relative "updated X seconds/minutes ago" indicator. Recomputed on nowTick.
  const lastRefreshedLabel = useMemo(() => {
    if (!lastRefreshedAt) return '';
    const diff = Math.max(0, nowTick - lastRefreshedAt);
    if (diff < 30_000) return 'just now';
    if (diff < 60_000) return 'less than a minute ago';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  }, [lastRefreshedAt, nowTick]);

  // Sort history: pinned items first, then by date desc.
  const sortedHistory = useMemo(() => {
    const arr = [...history];
    arr.sort((a, b) => {
      const ap = pinned[a.id] ? 1 : 0;
      const bp = pinned[b.id] ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime();
    });
    return arr;
  }, [history, pinned]);

  const exportFullPdf = useCallback(async () => {
    if (!report) return;
    const pdf = new jsPDF('p', 'mm', 'a4');
    // Cover header
    pdf.setFontSize(16);
    pdf.text('SOCEYE — AI Generated Report', 14, 18);
    pdf.setFontSize(10);
    pdf.setTextColor(120);
    pdf.text(`Window: last ${hours} hours`, 14, 25);
    pdf.text(`Range: ${rangeLabel}`, 14, 30);
    pdf.text(`Generated: ${new Date().toLocaleString('en-IN')}`, 14, 35);

    // Threat level box
    pdf.setTextColor(0);
    pdf.setFontSize(12);
    pdf.text(`Threat Level: ${report.threat_level || 'NORMAL'}  (score ${report.threat_score || 0})`, 14, 44);
    pdf.setFontSize(9);
    pdf.setTextColor(80);
    if (report.threat_highlights) {
      pdf.text(pdf.splitTextToSize(report.threat_highlights, 180), 14, 50);
    }

    // Executive summary
    pdf.setTextColor(0);
    pdf.setFontSize(12);
    pdf.text('Executive Summary', 14, 62);
    pdf.setFontSize(9);
    pdf.text(pdf.splitTextToSize(report.executive_summary || '', 180), 14, 68);

    // Observations
    if (report.intelligence_observations) {
      pdf.setFontSize(12);
      pdf.text('Intelligence Observations', 14, 90);
      pdf.setFontSize(9);
      pdf.text(pdf.splitTextToSize(report.intelligence_observations, 180), 14, 96);
    }

    // Recommendations table
    const recs = report.recommendations || [];
    if (recs.length) {
      autoTable(pdf, {
        startY: 118,
        head: [['#', 'Recommendation', 'Detail']],
        body: recs.map((r, i) => [i + 1, r.title || '', r.detail || '']),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [24, 95, 165] }
      });
    }

    // Key metrics table
    const a = report.alerts || {};
    const g = report.grievances || {};
    const e = report.events || {};
    const d = report.dial100_calls || {};
    const ss = report.summary_statistics || {};
    autoTable(pdf, {
      head: [['Metric', 'Value', 'Trend vs prev']],
      body: [
        ['Total Alerts',  String(a.total_count ?? 0), (a.trend_percentage ?? 0) + '%'],
        ['HIGH Alerts',   String(a.priority_scoring?.high ?? 0), ''],
        ['Escalated',     String(a.escalated_count ?? 0), ''],
        ['Viral Posts',   String(ss.viral_posts_count ?? 0), ''],
        ['Grievances',    String(g.total_count ?? 0), (g.trend_percentage ?? 0) + '%'],
        ['Events',        String(e.total_count ?? 0), (e.trend_percentage ?? 0) + '%'],
        ['Dial-100 Calls', String(d.total_count ?? 0), (d.trend_percentage ?? 0) + '%'],
        ['Threat Rate %', String(ss.threat_rate_percentage ?? 0)+'%', '']
      ],
      styles: { fontSize: 8 },
      headStyles: { fillColor: [163, 45, 45] }
    });

    pdf.save(`${fileTag}_full.pdf`);
  }, [report, hours, rangeLabel, fileTag]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Top bar */}
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Antenna className="h-5 w-5 text-[#185FA5]" />
          <span className="font-semibold text-slate-900">
            <span className="font-bold">SOCEYE</span> — AI Generated Report
          </span>
          <span className="inline-flex items-center gap-1 bg-[#E6F1FB] text-[#185FA5] text-[10px] font-medium px-2 py-0.5 rounded uppercase tracking-wider">
            <Cpu className="h-2.5 w-2.5" /> AI
          </span>
          <span className="inline-flex items-center gap-1 bg-white border border-slate-200 text-[11px] text-slate-600 px-2 py-0.5 rounded">
            <Calendar className="h-3 w-3" /> {rangeLabel}
          </span>
          <div className="flex-1" />
          {lastRefreshedAt && !viewingSnapshotId && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500" title={`Last refreshed ${fmtDateTime(lastRefreshedAt)}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Updated {lastRefreshedLabel}
            </span>
          )}
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="text-[12px] rounded-md border border-slate-200 bg-white px-2 py-1"
            disabled={loading}
          >
            <option value={24}>Last 24 hours</option>
            <option value={48}>Last 48 hours</option>
            <option value={72}>Last 72 hours</option>
            <option value={168}>Last 7 days</option>
          </select>
          {/* Auto-refresh selector — disabled while viewing a historical snapshot */}
          <div className="inline-flex items-center gap-1 text-[11px] rounded-md border border-slate-200 bg-white px-2 py-1" title="Auto-refresh interval">
            {autoRefreshMs > 0 ? (
              <Play className="h-3 w-3 text-emerald-600" />
            ) : (
              <Pause className="h-3 w-3 text-slate-400" />
            )}
            <span className="text-slate-500">Auto</span>
            <select
              value={autoRefreshMs}
              onChange={(e) => setAutoRefreshMs(Number(e.target.value))}
              disabled={!!viewingSnapshotId}
              className="text-[11px] bg-transparent focus:outline-none disabled:opacity-50"
            >
              {AUTO_REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[12px] rounded-md border border-slate-200 bg-white px-2.5 py-1 hover:bg-slate-50"
            >
              <HistoryIcon className="h-3.5 w-3.5" />
              History
              {history.length > 0 && (
                <span className="text-[10px] text-slate-400 ml-0.5">({history.length})</span>
              )}
            </button>
            {historyOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setHistoryOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute right-0 top-full mt-1 w-72 max-h-80 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg z-50">
                  <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 sticky top-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Past Reports</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">One snapshot saved per day per window</div>
                  </div>
                  {history.length === 0 ? (
                    <div className="px-3 py-4 text-[12px] text-slate-500 text-center">
                      No saved snapshots yet.
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      <li>
                        <button
                          type="button"
                          onClick={() => { setHistoryOpen(false); fetchReport(hours); }}
                          className={`w-full text-left px-3 py-2 text-[12px] hover:bg-blue-50 ${!viewingSnapshotId ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-700'}`}
                        >
                          ● Live · last {hours}h
                        </button>
                      </li>
                      {sortedHistory.map((s) => {
                        const isActive = s.id === viewingSnapshotId;
                        const isPinned = !!pinned[s.id];
                        return (
                          <li key={s.id} className="flex items-stretch">
                            <button
                              type="button"
                              onClick={() => loadSnapshot(s.id)}
                              className={`flex-1 text-left px-3 py-2 text-[12px] hover:bg-blue-50 ${isActive ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-700'}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1">
                                  {isPinned && <Pin className="h-2.5 w-2.5 text-amber-500 fill-amber-500" />}
                                  {s.date_key}
                                </span>
                                <span className="text-[10px] text-slate-400">last {s.window_hours}h</span>
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                generated {fmtDateTime(s.generated_at)}
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); togglePinned(s.id); }}
                              title={isPinned ? 'Unpin snapshot' : 'Pin snapshot to top'}
                              className="px-2 text-slate-400 hover:text-amber-500"
                            >
                              {isPinned
                                ? <Pin className="h-3.5 w-3.5 fill-amber-500 text-amber-500" />
                                : <PinOff className="h-3.5 w-3.5" />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => fetchReport(hours)}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[12px] rounded-md border border-slate-200 bg-white px-2.5 py-1 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Generating…' : (viewingSnapshotId ? 'Go Live' : 'Refresh')}
          </button>
          <button
            type="button"
            onClick={exportFullPdf}
            disabled={!report || loading}
            className="inline-flex items-center gap-1 text-[12px] rounded-md bg-[#185FA5] text-white px-2.5 py-1 hover:bg-[#0F4A85] disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Export full
          </button>
        </div>
        <div className="mt-2.5 flex gap-0 border-b border-transparent -mb-3">
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-2 text-[12px] inline-flex items-center gap-1.5 border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-[#185FA5] text-[#185FA5] font-semibold'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 bg-slate-50/40">
        {viewingSnapshotId && snapshotMeta && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 flex items-center gap-2 flex-wrap">
            <HistoryIcon className="h-3.5 w-3.5" />
            <span>
              Viewing historical snapshot for <strong>{snapshotMeta.date_key}</strong>
              {' '}(last {snapshotMeta.window_hours}h, generated {fmtDateTime(snapshotMeta.generated_at)}).
            </span>
            <button
              type="button"
              onClick={() => fetchReport(hours)}
              className="ml-auto text-[11px] underline hover:text-amber-900"
            >
              Switch to live
            </button>
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {error}
            <button
              type="button"
              onClick={() => fetchReport(hours)}
              className="ml-auto text-[11px] underline"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !report && (
          <div className="flex items-center justify-center py-20 text-slate-500 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Generating Soceye Report from live data…</span>
          </div>
        )}

        {report && (
          <>
            {/* Threat-level hero — only on Overview (other tabs already focus on the topic). */}
            {activeTab === 'overview' && (
              <ThreatBanner
                level={report.threat_level || 'NORMAL'}
                score={report.threat_score || 0}
                highlights={report.threat_highlights}
                windowHours={report.window_hours || hours}
                onJump={() => setActiveTab('alerts')}
              />
            )}
            {activeTab === 'overview' && <OverviewTab report={report} fileTag={fileTag} />}
            {activeTab === 'events'   && <EventsTab   report={report} fileTag={fileTag} />}
            {activeTab === 'alerts'   && <AlertsTab   report={report} fileTag={fileTag} fullAlertsById={fullAlertsById} hydrating={hydratingAlerts} onAlertResolve={handleAlertResolve} />}
            {activeTab === 'profiles' && <ProfilesTab report={report} fileTag={fileTag} />}
          </>
        )}
      </div>

      {/* Floating AI assistant scoped to this report */}
      {report && (
        <AskAiAboutReport report={report} windowHours={report.window_hours || hours} />
      )}
    </div>
  );
};

export default SoceyeDailyReport;
