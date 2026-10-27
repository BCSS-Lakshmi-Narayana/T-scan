/**
 * The body of an answer, in the order an officer reads it.
 *
 *   Answer      what was asked, answered in sentences
 *   Analysis    the measured panels: situation, comparison, trend
 *   Details     anything the template said that no panel covers
 *   Evidence    the posts it all rests on
 *
 * The template the backend produces opens with counts rather than an answer,
 * so on its own it buries the point under statistics. Where the model produced
 * a reading of the same evidence — and it survived the backend's claim check —
 * that leads, labelled as the model's words. Numbers shown anywhere here are
 * the database's, copied from `facts`; none is computed in the browser.
 *
 * Clarification choices are sent back as a new question: the server resolves
 * and re-checks them, and this page never decides scope.
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ThumbsDown, ThumbsUp } from 'lucide-react';
import api from '../../lib/api';
import { cn } from '../../lib/utils';
import { ComparisonPanel, SituationPanel, TrendPanel } from './FactPanels';
import EvidenceList from './EvidenceList';
import AnalysisPanel from './AnalysisPanel';
import { Eyebrow, Section, Note } from './ui';
import { ClarificationChoices, DeniedNotice, EmptyResult, StatusBadge } from './ResponseStates';
import { countHeadline, leadAnswer, resultCounts, supportingProse } from '../../lib/answerText';

/**
 * Database field names are not officer vocabulary. "By risk_level" is how the
 * column is spelled; "By risk level" is how the question was asked.
 */
const GROUP_LABEL = {
    districts: 'district', district: 'district', handle: 'account',
    risk_level: 'risk level', topics: 'theme', platform: 'platform',
    sentiment: 'sentiment', category: 'category',
};

/**
 * Row labels are stored in database spelling. "women_safety" is a column
 * value; "Women safety" is what the table is read as. Handles are left alone
 * by the caller that renders them, because an identifier is not a word.
 */
const prettyValue = (s) => {
    const t = String(s ?? '').replace(/_/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/** A counted breakdown the backend already grouped. */
function FactTable({ fact }) {
    if (!fact.rows?.length) return null;
    const key = 'value' in fact.rows[0] ? 'value' : 'bucket';
    // A handle is typed and searched for; capitalising it would make it wrong.
    const verbatim = fact.group_by === 'handle' || fact.group_by === 'platform';
    const label = GROUP_LABEL[fact.group_by] || String(fact.group_by || '').replace(/_/g, ' ');
    return (
        <Section label={`By ${label}`}>
            <table className="w-full text-[12.5px]">
                <tbody>
                    {fact.rows.map((r) => (
                        <tr key={String(r[key])} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                            <td className="py-1.5 text-slate-600 dark:text-slate-300">
                                {verbatim ? String(r[key]) : prettyValue(r[key])}
                            </td>
                            <td className="py-1.5 text-right font-medium tabular-nums text-slate-900 dark:text-slate-100">
                                {typeof r.count === 'number' ? r.count.toLocaleString() : r.count}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </Section>
    );
}

/**
 * The answer to a "how many" question: the number, large, with what it counts
 * and the period it covers. Shown only when nothing else answers — a situation
 * or a set of evidence cards states the same thing better in context.
 */
function CountAnswer({ total, measure, scope }) {
    return (
        <div className="min-w-0">
            <p className="text-[12px] font-medium text-slate-500 dark:text-slate-400">
                {measure.charAt(0).toUpperCase() + measure.slice(1)}
            </p>
            <p className="mt-0.5 text-[34px] font-semibold leading-none tabular-nums tracking-[-0.03em] text-slate-900 dark:text-white">
                {total.toLocaleString()}
            </p>
            {scope && (
                <p className="mt-1.5 text-[12px] text-slate-400 dark:text-slate-500">{scope}</p>
            )}
        </div>
    );
}

function Feedback({ requestId }) {
    const [sent, setSent] = useState(null);
    const send = async (kind) => {
        setSent(kind);
        try {
            await api.post('/rag/v2/feedback', { kind, target: { type: 'answer', request_id: requestId } });
        } catch { /* feedback is best effort */ }
    };
    if (sent) return <span className="text-[12px] text-slate-400">Thanks</span>;
    return (
        <span className="inline-flex items-center gap-0.5">
            <button type="button" title="Useful" onClick={() => send('useful')}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-emerald-600 dark:hover:bg-slate-800">
                <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" title="Not useful" onClick={() => send('not_useful')}
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800">
                <ThumbsDown className="h-3.5 w-3.5" />
            </button>
        </span>
    );
}

/** Prose, one paragraph per line, at reading size. */
function Prose({ text, className }) {
    if (!text) return null;
    return (
        <div className={cn('space-y-2', className)}>
            {text.split('\n').filter((l) => l.trim()).map((line, i) => (
                <p key={i} className="text-pretty text-[14.5px] leading-[1.65] text-slate-700 dark:text-slate-200">
                    {line}
                </p>
            ))}
        </div>
    );
}

export default function V2Details({ response, onFollowup, onCompose }) {
    const facts = response?.facts || [];
    const situation = response?.analysis?.situation || null;
    const comparison = facts.find((f) => f.type === 'comparison');
    const trend = facts.find((f) => f.type === 'trend');
    // A one-row "breakdown" breaks nothing down, and where the situation panel
    // already shows a grouping as chips, the same grouping as a table below it
    // is the same data printed twice.
    const COVERED_BY_SITUATION = new Set(['districts', 'district', 'handle', 'topics']);
    const tables = facts.filter((f) => (f.rows?.length || 0) > 1
        && !(situation && COVERED_BY_SITUATION.has(f.group_by)));
    // Measured surfaces on screen: their sentences come out of the prose so
    // the same figure is not stated twice in two different phrasings.
    const [measured, setMeasured] = useState(false);
    if (!response) return null;

    const panels = [
        situation && 'situation', trend && 'trend', comparison && 'comparison',
        // Keyed off the FACTS, not the tables actually drawn. A grouping the
        // backend restated in prose ("By risk_level: high (4241)") must come
        // out of the text even when the table itself is too thin to show, or
        // the database's column name becomes the officer's answer.
        facts.some((f) => f.rows?.length) && 'table',
    ].filter(Boolean);

    const lead = leadAnswer(response, { panels });
    const supporting = supportingProse(response, { panels });
    const records = (response.evidence || []).filter(
        (e) => e && (e.type === 'record' || e.type === 'verdict'));
    // Nothing else says what was found: no sentences, no cards. Then the count
    // IS the answer and it gets stated as one.
    const headline = (!lead && !records.length) ? countHeadline(response) : null;
    const choices = (response.clarification?.unresolved || []).flatMap((u) => u.candidates || []);
    const derived = (response.evidence || []).filter(
        (e) => e && e.type !== 'record' && e.type !== 'verdict');

    return (
        <div className="min-w-0 space-y-5">
            {response.status && response.status !== 'answered' && (
                <StatusBadge status={response.status} />
            )}

            {/* ── the answer ─────────────────────────────────────────────── */}
            {headline && <CountAnswer {...headline} />}

            {lead && (
                <div className="min-w-0">
                    <Prose text={lead.text} />
                    {lead.source === 'ai' && (
                        <p className="mt-2 text-[11.5px] text-slate-400 dark:text-slate-500">
                            AI interpretation — verify against the evidence below.
                        </p>
                    )}
                </div>
            )}

            {response.status === 'denied' && <DeniedNotice />}
            {response.status === 'empty' && <EmptyResult onCompose={onCompose} />}
            {choices.length > 0 && (
                <ClarificationChoices choices={choices} onFollowup={onFollowup} />
            )}

            {/* ── what was measured ──────────────────────────────────────── */}
            {situation && <SituationPanel situation={situation} />}
            {comparison && <ComparisonPanel fact={comparison} />}
            {trend && <TrendPanel fact={trend} />}
            {tables.map((f) => <FactTable key={f.evidence_id} fact={f} />)}

            {supporting && (
                <Section label="Details">
                    <Prose text={supporting} className="space-y-1.5" />
                </Section>
            )}

            {response.limitations?.length > 0 && (
                <Section label="Limitations">
                    <ul className="space-y-1.5">
                        {response.limitations.map((l) => (
                            <li key={l} className="flex gap-2 text-[12.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span className="min-w-0">{l}</span>
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            {/* ── what the deep reading found, and how far it has got ────── */}
            <AnalysisPanel analysis={response.analysis} counts={resultCounts(response)} />

            {/* ── the evidence ───────────────────────────────────────────── */}
            <EvidenceList response={response} />

            {/* ── provenance and feedback ────────────────────────────────── */}
            {(derived.length > 0 || response.request_id) && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    {derived.length > 0 ? (
                        <button
                            type="button"
                            onClick={() => setMeasured((v) => !v)}
                            aria-expanded={measured}
                            className="inline-flex items-center gap-1.5 rounded text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:text-slate-200"
                        >
                            How this was measured
                            <span className="text-slate-400">
                                · {derived.length} derived figure{derived.length === 1 ? '' : 's'}
                            </span>
                            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200',
                                measured && 'rotate-180')} />
                        </button>
                    ) : <span />}
                    {response.request_id && <Feedback requestId={response.request_id} />}
                </div>
            )}

            {measured && derived.length > 0 && (
                <div className="space-y-1.5">
                    <Eyebrow>Derived figures</Eyebrow>
                    {/* Aggregates, trends and the situation itself: no author and no
                        post to open, so they stay a compact line rather than
                        pretending to be a source card. */}
                    <ul className="space-y-1">
                        {derived.map((e, i) => (
                            <li key={e.id || i}
                                className="rounded-lg border border-slate-200/80 px-2.5 py-1.5 text-[12px] text-slate-600 dark:border-slate-800 dark:text-slate-300">
                                <span className="text-slate-400 dark:text-slate-500">{e.type}</span>
                                {e.content && <p className="mt-0.5 line-clamp-2">{e.content}</p>}
                            </li>
                        ))}
                    </ul>
                    <Note>
                        These are counts the assistant computed over the monitored set,
                        not individual posts.
                    </Note>
                </div>
            )}
        </div>
    );
}
