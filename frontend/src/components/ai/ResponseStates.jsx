/**
 * The states an answer can be in other than "here is your answer".
 *
 * Each one is designed rather than improvised, because these are the moments
 * an officer decides whether the tool is working. A refusal, an empty result
 * and a crash mean three different things and must not look alike: one is the
 * system working correctly, one is a real finding about the data, and one is a
 * fault. Saying "no results" when access was denied would be a lie, and saying
 * "error" when nothing matched would send an officer looking for a bug.
 *
 * None of these expose a status code or a stack. The officer cannot act on
 * either, and the detail is already in the console.
 */

import React from 'react';
import { AlertCircle, RotateCw, SearchX, ShieldAlert, HelpCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button, Eyebrow } from './ui';

/**
 * The one-word standing of an answer, shown above it.
 *
 * "Answered" gets no badge: the normal case should not be decorated, or the
 * exceptions stop standing out.
 */
const BADGE = {
    partial: ['Partial answer', 'text-amber-700 bg-amber-50 ring-amber-200/70 dark:text-amber-300 dark:bg-amber-950/40 dark:ring-amber-900/50'],
    empty: ['Nothing found', 'text-slate-600 bg-slate-100 ring-slate-200 dark:text-slate-300 dark:bg-slate-800 dark:ring-slate-700'],
    denied: ['Not permitted', 'text-rose-700 bg-rose-50 ring-rose-200/70 dark:text-rose-300 dark:bg-rose-950/40 dark:ring-rose-900/50'],
    clarification: ['Needs clarification', 'text-blue-700 bg-blue-50 ring-blue-200/70 dark:text-blue-300 dark:bg-blue-950/40 dark:ring-blue-900/50'],
    error: ['Error', 'text-rose-700 bg-rose-50 ring-rose-200/70 dark:text-rose-300 dark:bg-rose-950/40'],
};

export function StatusBadge({ status }) {
    const badge = BADGE[status];
    if (!badge) return null;
    const Icon = status === 'denied' ? ShieldAlert
        : status === 'empty' ? SearchX
            : status === 'clarification' ? HelpCircle : AlertCircle;
    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] font-medium ring-1',
            badge[1],
        )}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {badge[0]}
        </span>
    );
}

/** A state block: icon, what happened, what to do about it. */
function Notice({ icon: Icon, tone = 'neutral', title, children, className }) {
    return (
        <div className={cn(
            'flex items-start gap-3 rounded-xl border px-3.5 py-3',
            tone === 'danger'
                ? 'border-rose-200/70 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20'
                : 'border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/40',
            className,
        )}>
            <Icon className={cn('mt-[2px] h-4 w-4 shrink-0',
                tone === 'danger' ? 'text-rose-500' : 'text-slate-400')} aria-hidden />
            <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-slate-800 dark:text-slate-100">{title}</p>
                {children}
            </div>
        </div>
    );
}

/**
 * Nothing matched.
 *
 * This is a real finding, not a failure: the monitored set genuinely contains
 * nothing for that question in that window. It says so, and offers the two
 * adjustments that most often change the outcome. The suggestions fill the
 * composer rather than firing on their own, so the officer sends a question
 * they have read.
 */
export function EmptyResult({ onCompose }) {
    return (
        <Notice icon={SearchX} title="No matching monitored activity found.">
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                Nothing in the monitored set matches this question for the selected
                period. Widening the window or the location often changes that.
            </p>
            {onCompose && (
                <div className="mt-2.5">
                    <Eyebrow className="mb-1.5">Try</Eyebrow>
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" className="py-1 text-[12.5px]"
                            onClick={() => onCompose('Show me high risk activity in Hyderabad in the last 30 days.')}>
                            Expand time range
                        </Button>
                        <Button type="button" className="py-1 text-[12.5px]"
                            onClick={() => onCompose("What's happening in ")}>
                            Change location
                        </Button>
                    </div>
                </div>
            )}
        </Notice>
    );
}

/**
 * The question asked for something outside the officer's authority.
 *
 * Deliberately plain and non-accusatory. The scope decision was made and
 * enforced on the server; this only reports it.
 */
export function DeniedNotice({ reason }) {
    return (
        <Notice icon={ShieldAlert} tone="danger" title="This is outside your access.">
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                {reason || 'The question asks for data beyond the districts and permissions '
                    + 'assigned to your account. Your assigned scope was used instead.'}
            </p>
        </Notice>
    );
}

/**
 * The investigation did not complete.
 *
 * Says so plainly and hands the question back, because retrying is the only
 * useful action and the officer should not have to retype.
 */
export function FailureNotice({ question, onRetry }) {
    return (
        <Notice icon={AlertCircle} tone="danger"
            title="Something went wrong while completing the investigation.">
            {question && (
                <p className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                    {question}
                </p>
            )}
            {onRetry && question && (
                <Button type="button" onClick={() => onRetry(question)} className="mt-2.5 py-1 text-[12.5px]">
                    <RotateCw className="h-3.5 w-3.5" /> Retry
                </Button>
            )}
        </Notice>
    );
}

/**
 * The question was ambiguous and the server named the possibilities.
 *
 * Choosing sends a new question rather than resolving it in the browser: scope
 * is decided and re-checked on the server, never here.
 */
export function ClarificationChoices({ choices, onFollowup }) {
    if (!choices?.length) return null;
    return (
        <div>
            <Eyebrow className="mb-1.5">Did you mean</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
                {choices.map((c) => (
                    <button
                        key={c}
                        type="button"
                        onClick={() => onFollowup?.(`What about ${c}?`)}
                        className="rounded-full border border-blue-200 bg-blue-50/60 px-3 py-1 text-[12.5px] font-medium text-blue-700 transition-colors hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"
                    >
                        {c}
                    </button>
                ))}
            </div>
        </div>
    );
}

export default { StatusBadge, EmptyResult, DeniedNotice, FailureNotice, ClarificationChoices };
