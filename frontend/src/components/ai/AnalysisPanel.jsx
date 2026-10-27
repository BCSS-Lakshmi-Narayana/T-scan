/**
 * The deep reading behind an answer: how far it has got, and what it found.
 *
 * The officer gets a usable answer immediately and this fills in behind it, so
 * the panel's first job is to be honest about which of those they are looking
 * at. While it runs, the evidence on screen is what retrieval found and is
 * labelled "initial"; only when the reading finishes does it become the
 * evidence chosen BECAUSE of what was read.
 *
 * The three populations are always shown apart. "4,669 matching · 192
 * analysed · 20 key evidence" are three different facts, and the single word
 * "examined" that used to stand for all of them let twenty records be
 * reported as though thousands had been looked at.
 *
 * Nothing here names the machinery. An officer is told what is being done to
 * their question, never which component is doing it.
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { Chip, Eyebrow, Note, Section, useEnter } from './ui';
import { populationsText, reuseText } from '../../lib/answerText';

/** A quiet determinate bar. Determinate because we know the population. */
function Progress({ percent }) {
    const still = useReducedMotion();
    return (
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <motion.div
                className="h-full rounded-full bg-blue-500"
                initial={still ? false : { width: 0 }}
                animate={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            />
        </div>
    );
}

function Rows({ label, rows, prefix = '' }) {
    if (!rows?.length) return null;
    return (
        <div className="min-w-0">
            <p className="mb-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400">
                {label}
            </p>
            <div className="flex flex-wrap gap-1.5">
                {rows.slice(0, 8).map((r) => (
                    <Chip key={`${r.value}`} count={Number(r.count || 0).toLocaleString()}>
                        {prefix}{String(r.value)}
                    </Chip>
                ))}
            </div>
        </div>
    );
}

export default function AnalysisPanel({ analysis, counts }) {
    const enter = useEnter();
    const running = analysis?.status === 'running';
    const failed = analysis?.status === 'error';
    const progress = analysis?.progress || {};
    const stage = analysis?.evidence_stage === 'final' ? 'final' : 'initial';
    const line = populationsText(counts, stage);

    // Nothing to say: no deep reading was warranted for this question.
    if (!analysis?.job_id && !counts?.analysed) {
        return line ? (
            <p className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">{line}</p>
        ) : null;
    }

    return (
        <motion.div {...enter()} className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Eyebrow>Analysis</Eyebrow>
                <p className="text-[12px] tabular-nums text-slate-500 dark:text-slate-400">{line}</p>
            </div>

            {/* A comparison reads each scope on its own, so progress is
                reported per scope: one pooled "300 analysed" describes
                neither place. */}
            {running && analysis.sides?.length > 0 && (
                <div className="space-y-2.5">
                    <p className="text-[13px] text-slate-600 dark:text-slate-300">
                        {analysis.stage_text || 'Analysing relevant monitored posts…'}
                    </p>
                    {analysis.sides.map((s) => (
                        <div key={s.label} className="space-y-1">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <p className="text-[12.5px] font-medium text-slate-700 dark:text-slate-200">
                                    {s.label}
                                </p>
                                <p className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                                    {Number(s.analysed || 0).toLocaleString()} / {Number(s.population || 0).toLocaleString()} analysed
                                </p>
                            </div>
                            <Progress percent={s.percent || 0} />
                        </div>
                    ))}
                </div>
            )}

            {running && !analysis.sides?.length && (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <p className="text-[13px] text-slate-600 dark:text-slate-300">
                            {analysis.stage_text || 'Analysing relevant monitored posts…'}
                        </p>
                        <p className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                            {progress.population
                                ? `${Number(progress.analysed || 0).toLocaleString()} / ${Number(progress.population).toLocaleString()} analysed`
                                : ''}
                        </p>
                    </div>
                    <Progress percent={progress.percent || 0} />
                    <p className="text-[11.5px] text-slate-400 dark:text-slate-500">
                        The evidence below is the initial retrieval. It is replaced once
                        the analysis finishes.
                    </p>
                </div>
            )}

            {failed && (
                <Note>
                    The deeper analysis could not be completed. The figures and evidence
                    above come from the database directly and are unaffected.
                </Note>
            )}

            {!running && !failed && reuseText(progress) && (
                <p className="text-[11.5px] text-slate-400 dark:text-slate-500">
                    {reuseText(progress)}
                </p>
            )}

            {/* Every part of the findings is checked, not just the first:
                gating on themes alone would have dropped the clusters — and
                the caveats attached to them — whenever themes came back empty. */}
            {!running && analysis.comparison?.sides?.length > 0 && (
                <div className="space-y-3.5">
                    {analysis.comparison.sides.map((s) => (
                        <div key={s.label} className="min-w-0">
                            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                                <p className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
                                    {s.label}
                                </p>
                                <p className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                                    {typeof s.matching === 'number'
                                        ? `${s.matching.toLocaleString()} matching · ` : ''}
                                    {Number(s.analysed || 0).toLocaleString()} analysed
                                </p>
                            </div>
                            <Rows label="Recurring themes" rows={s.themes} />
                        </div>
                    ))}
                    <Note>
                        Each figure counts posts captured for that location. Places are
                        monitored to different depths, so a larger number does not by
                        itself mean more is happening there.
                    </Note>
                </div>
            )}

            {!running && !analysis.comparison && (analysis.themes?.length || analysis.locations?.length
                || analysis.accounts?.length || analysis.clusters?.length
                || analysis.repeated_claims?.length) ? (
                <div className="space-y-3.5">
                    <Rows label="Recurring themes" rows={analysis.themes} />
                    <Rows label="Places named in posts" rows={analysis.locations} />
                    <Rows label="Accounts posting repeatedly" rows={analysis.accounts} prefix="@" />

                    {analysis.clusters?.length > 0 && (
                        <div className="min-w-0">
                            <p className="mb-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400">
                                Groups of posts sharing a theme and a place
                            </p>
                            <ul className="space-y-1">
                                {analysis.clusters.slice(0, 5).map((c, i) => (
                                    <li key={`${c.theme}-${i}`}
                                        className="text-[12.5px] text-slate-600 dark:text-slate-300">
                                        <span className="font-medium capitalize">{c.theme}</span>
                                        {c.where ? ` in ${c.where}` : ''} — {c.size} posts
                                    </li>
                                ))}
                            </ul>
                            <Note className="mt-2">
                                These are separate posts that share a theme and a place. That
                                is not evidence they describe the same incident.
                            </Note>
                        </div>
                    )}

                    {analysis.repeated_claims?.length > 0 && (
                        <div className="min-w-0">
                            <p className="mb-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400">
                                Claims made by more than one account
                            </p>
                            <ul className="space-y-1">
                                {analysis.repeated_claims.slice(0, 4).map((c, i) => (
                                    <li key={i} className="text-[12.5px] text-slate-600 dark:text-slate-300">
                                        “{c.claim}” — {c.accounts} accounts
                                    </li>
                                ))}
                            </ul>
                            <Note className="mt-2">
                                Repetition across accounts shows what is being said, not that
                                any of it is established.
                            </Note>
                        </div>
                    )}
                </div>
            ) : null}
        </motion.div>
    );
}

export { Progress };
