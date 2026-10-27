/**
 * An on-demand concept scan, rendered as it runs.
 *
 * The backend filters the window, ranks candidates, and has the LLM judge each
 * one. Confirmed records arrive while the rest are still being judged, so this
 * renders the partial result on every poll rather than waiting for the end.
 *
 * Each card carries the judge's reason. An officer acting on a match should be
 * able to see why it matched, and a wrong call is visible rather than hidden.
 */

import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    ScanSearch, ExternalLink, Loader2, Square, Telescope, CheckCircle2,
    AlertTriangle, Sparkles, Filter, ChevronDown,
} from 'lucide-react';
import { cn } from '../../lib/utils';

const PAGE = 15;

const STAGE_LABEL = {
    planning: 'Understanding the question',
    filtering: 'Selecting records in range',
    recalling: 'Finding likely matches',
    reranking: 'Ranking the candidates',
    judging: 'AI is checking each record',
    summarising: 'Writing the summary',
    done: 'Done',
};

const RISK_STYLE = {
    high: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
    medium: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
    low: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
};

const SENTIMENT_DOT = {
    negative: 'bg-rose-500',
    positive: 'bg-emerald-500',
    neutral: 'bg-slate-400',
};

// Distinct, readable hues for group labels, cycled in label order.
const LABEL_HUES = [
    'from-blue-500 to-indigo-600',
    'from-fuchsia-500 to-purple-600',
    'from-amber-500 to-orange-600',
    'from-emerald-500 to-teal-600',
    'from-rose-500 to-pink-600',
    'from-cyan-500 to-sky-600',
    'from-lime-500 to-green-600',
    'from-slate-500 to-slate-700',
];

const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());

/** Plain-text export of the result, for the copy button. */
export const scanToText = (scan) => {
    if (!scan) return '';
    const head = `${scan.question}\n${scan.found} match(es) · ${scan.filters}`;
    const rows = (scan.matches || []).map((c, i) => [
        `${i + 1}. ${c.handle ? `@${c.handle}` : c.kind}${c.platform ? ` · ${c.platform}` : ''} · ${fmtDate(c.published_at)}`,
        c.labels?.length ? `   Labels: ${c.labels.join(', ')}` : null,
        c.why ? `   Why: ${c.why}` : null,
        c.url ? `   ${c.url}` : null,
    ].filter(Boolean).join('\n'));
    return [head, scan.summary, ...rows].filter(Boolean).join('\n\n');
};

function Progress({ scan }) {
    const running = scan.status === 'running';
    const pct = scan.pool ? Math.min(100, Math.round((scan.checked / scan.pool) * 100)) : 0;

    return (
        <div className="mt-2">
            <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
                    {running
                        ? <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                        : <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                    {running ? STAGE_LABEL[scan.stage] || 'Working' : 'Scan complete'}
                </span>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">
                    {scan.window_total > 0 && <>{scan.window_total.toLocaleString()} in range · </>}
                    {scan.pool > 0 && <>{scan.checked.toLocaleString()}/{scan.pool.toLocaleString()} checked · </>}
                    <span className="font-semibold text-slate-700 dark:text-slate-200">{scan.found}</span> found
                </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60">
                <motion.div
                    className={cn('h-full rounded-full bg-gradient-to-r',
                        running ? 'from-blue-500 via-indigo-500 to-blue-500' : 'from-emerald-500 to-teal-500')}
                    initial={{ width: 0 }}
                    animate={{ width: running && !scan.pool ? '18%' : `${running ? pct : 100}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                />
            </div>
        </div>
    );
}

function GroupTiles({ scan, active, onPick }) {
    if (scan.mode !== 'group') return null;
    return (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {scan.labels.map((label, i) => {
                const n = scan.counts?.[label] || 0;
                const on = active === label;
                return (
                    <motion.button
                        key={label}
                        type="button"
                        layout
                        onClick={() => onPick(on ? null : label)}
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                        className={cn(
                            'relative overflow-hidden rounded-xl px-3 py-2 text-left ring-1 transition-shadow',
                            on
                                ? 'text-white shadow-md ring-transparent'
                                : 'bg-slate-50 text-slate-700 ring-slate-200 hover:shadow-sm dark:bg-slate-900/50 dark:text-slate-200 dark:ring-slate-700'
                        )}
                    >
                        {on && (
                            <motion.span
                                layoutId={`tile-bg-${scan.job_id}`}
                                className={cn('absolute inset-0 bg-gradient-to-br', LABEL_HUES[i % LABEL_HUES.length])}
                            />
                        )}
                        <span className="relative block truncate text-[11px] font-medium opacity-80">{titleCase(label)}</span>
                        <motion.span
                            key={n}
                            initial={{ opacity: 0.4, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="relative block text-xl font-bold tabular-nums"
                        >
                            {n}
                        </motion.span>
                    </motion.button>
                );
            })}
        </div>
    );
}

function Card({ card, index, labels }) {
    const risk = String(card.risk_level || '').toLowerCase();
    return (
        <motion.li
            layout
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, delay: Math.min(index, 6) * 0.03, ease: [0.22, 1, 0.36, 1] }}
            className="group/card rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md dark:border-slate-700/70 dark:bg-slate-900/60 dark:hover:border-blue-800"
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-slate-100 px-1 font-semibold tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {index + 1}
                </span>
                {card.handle && (
                    <span className="font-semibold text-slate-800 dark:text-slate-100">@{card.handle}</span>
                )}
                {card.platform && (
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-medium capitalize text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {card.platform}
                    </span>
                )}
                <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium capitalize text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                    {card.kind}
                </span>
                {card.published_at && <span className="text-slate-500 dark:text-slate-400">{fmtDate(card.published_at)}</span>}
                {card.sentiment && (
                    <span className="inline-flex items-center gap-1 capitalize text-slate-500 dark:text-slate-400">
                        <span className={cn('h-1.5 w-1.5 rounded-full', SENTIMENT_DOT[card.sentiment] || 'bg-slate-400')} />
                        {card.sentiment}
                    </span>
                )}
                {risk && (
                    <span className={cn('rounded-md px-1.5 py-0.5 font-semibold capitalize ring-1', RISK_STYLE[risk] || RISK_STYLE.low)}>
                        {risk} risk{card.risk_score != null ? ` · ${card.risk_score}` : ''}
                    </span>
                )}
                {card.url && (
                    <a
                        href={card.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/50"
                    >
                        View post <ExternalLink className="h-3 w-3" />
                    </a>
                )}
            </div>

            {labels.length > 1 && card.labels?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {card.labels.map((l) => (
                        <span
                            key={l}
                            className={cn('rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-semibold text-white',
                                LABEL_HUES[Math.max(0, labels.indexOf(l)) % LABEL_HUES.length])}
                        >
                            {titleCase(l)}
                        </span>
                    ))}
                </div>
            )}

            {card.why && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium text-indigo-700 dark:text-indigo-300">
                    <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{card.why}</span>
                </p>
            )}

            {card.text && (
                <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
                    {card.text}
                </p>
            )}
        </motion.li>
    );
}

export default function ScanResult({ scan, onDeepScan, onCancel }) {
    const [active, setActive] = useState(null);
    const [shown, setShown] = useState(PAGE);

    const cards = useMemo(() => {
        const all = scan?.matches || [];
        return active ? all.filter((c) => c.labels?.includes(active)) : all;
    }, [scan, active]);

    if (!scan) return null;
    const running = scan.status === 'running';
    const canDeepen = !running && !scan.deep && scan.status === 'done' && scan.window_total > scan.pool;
    const concept = scan.mode === 'group' ? scan.labels.map(titleCase).join(' · ') : scan.labels[0];

    return (
        <div className="min-w-0">
            {/* ─── headline ─── */}
            <div className="flex items-start gap-2">
                <motion.span
                    animate={running ? { rotate: [0, 12, -12, 0] } : { rotate: 0 }}
                    transition={running ? { repeat: Infinity, duration: 1.6 } : {}}
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-blue-600 text-white shadow-sm"
                >
                    <ScanSearch className="h-3.5 w-3.5" />
                </motion.span>
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                        {scan.status === 'error'
                            ? 'The scan failed'
                            : running
                                ? <>Scanning for <span className="text-indigo-600 dark:text-indigo-300">{concept}</span></>
                                : <><span className="tabular-nums">{scan.found}</span> record{scan.found === 1 ? '' : 's'} match <span className="text-indigo-600 dark:text-indigo-300">{concept}</span></>}
                    </p>
                    {scan.filters && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                            <Filter className="h-3 w-3" /> {scan.filters}
                        </p>
                    )}
                </div>
                {running && (
                    <button
                        type="button"
                        onClick={() => onCancel?.(scan.job_id)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                    >
                        <Square className="h-3 w-3" /> Stop
                    </button>
                )}
            </div>

            {scan.status !== 'error' && <Progress scan={scan} />}
            {scan.error && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{scan.error}</p>}

            <GroupTiles scan={scan} active={active} onPick={(l) => { setActive(l); setShown(PAGE); }} />

            {/* ─── summary ─── */}
            <AnimatePresence>
                {scan.summary && (
                    <motion.p
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-3 rounded-xl bg-gradient-to-br from-indigo-50 to-blue-50 px-3 py-2 text-[12.5px] leading-relaxed text-slate-700 ring-1 ring-indigo-100 dark:from-indigo-950/40 dark:to-blue-950/30 dark:text-slate-200 dark:ring-indigo-900/50"
                    >
                        {scan.summary}
                    </motion.p>
                )}
            </AnimatePresence>

            {(scan.note || scan.verified === false) && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    {scan.note}
                </p>
            )}

            {/* ─── cards ─── */}
            {cards.length > 0 && (
                <ul className="mt-3 space-y-2">
                    <AnimatePresence initial={false}>
                        {cards.slice(0, shown).map((c, i) => (
                            <Card key={c.key} card={c} index={i} labels={scan.labels} />
                        ))}
                    </AnimatePresence>
                </ul>
            )}

            {!running && scan.status === 'done' && scan.found === 0 && scan.verified !== false && (
                <p className="mt-3 text-[12px] text-slate-500 dark:text-slate-400">
                    No record in range matched{scan.window_total ? ` (${scan.window_total.toLocaleString()} in range)` : ''}.
                </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {cards.length > shown && (
                    <button
                        type="button"
                        onClick={() => setShown((n) => n + PAGE)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-all hover:border-blue-300 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    >
                        <ChevronDown className="h-3 w-3" /> Show {Math.min(PAGE, cards.length - shown)} more
                    </button>
                )}
                {canDeepen && (
                    <motion.button
                        type="button"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileHover={{ y: -1 }}
                        onClick={() => onDeepScan?.(scan.question)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-indigo-500/20 transition-shadow hover:shadow-md"
                    >
                        <Telescope className="h-3.5 w-3.5" />
                        Deep scan all {scan.window_total.toLocaleString()}
                    </motion.button>
                )}
                {!running && scan.took_ms > 0 && (
                    <span className="ml-auto text-[10px] tabular-nums text-slate-400 dark:text-slate-500">
                        {(scan.took_ms / 1000).toFixed(1)}s{scan.reranked ? ' · reranked' : ''}{scan.deep ? ' · deep' : ''}
                    </span>
                )}
            </div>
        </div>
    );
}
