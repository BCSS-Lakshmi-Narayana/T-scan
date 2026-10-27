/**
 * One monitored post, as its own card.
 *
 * Collapsed it shows only what is needed to decide whether to open it: who
 * posted, where, when, how it was rated, and the opening of the content.
 * Expanded it shows the content in full plus the facts the record carries.
 *
 * There is no generated summary here. The response has no summary field, and
 * writing one in the browser would put words an officer might act on next to
 * evidence that does not support them. What is shown is the record's own text,
 * labelled as such.
 */

import React, { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, ExternalLink, User } from 'lucide-react';
import { cn } from '../../lib/utils';
import { evidenceDate, platformLabel, postUrl, profileUrl } from '../../lib/evidenceLinks';
import { Panel, EASE } from './ui';

/** Risk is one of the few places colour carries meaning, so it is kept subtle. */
const RISK_TONE = {
    critical: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40',
    high: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-950/40',
    medium: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40',
    low: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800',
};

/** The record's own opening lines, for the collapsed card. */
function excerpt(content, limit = 180) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    // Cut on a word so the preview does not end mid-word.
    return `${text.slice(0, text.lastIndexOf(' ', limit) || limit).trimEnd()}…`;
}

function Meta({ label, value }) {
    if (value === null || value === undefined || value === '' ||
        (Array.isArray(value) && !value.length)) return null;
    return (
        <div className="min-w-0">
            <dt className="text-[11px] text-slate-400 dark:text-slate-500">{label}</dt>
            <dd className="truncate text-[12.5px] text-slate-700 dark:text-slate-200">
                {Array.isArray(value) ? value.join(', ') : String(value)}
            </dd>
        </div>
    );
}

const ACTION = 'inline-flex items-center gap-1 rounded text-[12px] font-medium transition-colors '
    + 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

export default function EvidenceCard({ item, index }) {
    const [open, setOpen] = useState(false);
    const still = useReducedMotion();
    const panelId = useId();
    const f = item.facts || {};

    const post = postUrl(item);
    const profile = profileUrl(f.handle, f.platform);
    const handle = f.handle ? `@${String(f.handle).replace(/^@+/, '')}` : null;
    const platform = platformLabel(f.platform);
    const when = evidenceDate(f.published_at || item.timestamp);
    const content = item.content || '';
    const preview = excerpt(content);
    const truncated = preview.endsWith('…');

    return (
        <Panel interactive className="overflow-hidden">
            <div className="p-3.5">
                <div className="flex items-start gap-3">
                    <span className="mt-[3px] shrink-0 text-[11px] font-semibold tabular-nums text-slate-300 dark:text-slate-600">
                        {String(index + 1).padStart(2, '0')}
                    </span>

                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {handle && (profile ? (
                                <a href={profile} target="_blank" rel="noopener noreferrer"
                                    className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900 hover:underline dark:text-slate-100">
                                    {handle}
                                </a>
                            ) : (
                                <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
                                    {handle}
                                </span>
                            ))}
                            {platform && (
                                <span className="text-[12px] text-slate-400 dark:text-slate-500">
                                    · {platform}
                                </span>
                            )}
                            {when && (
                                <span className="text-[12px] text-slate-400 dark:text-slate-500">
                                    · {when}
                                </span>
                            )}
                            {f.risk_level && (
                                <span className={cn('rounded-md px-1.5 py-[2px] text-[11px] font-medium capitalize',
                                    RISK_TONE[f.risk_level] || RISK_TONE.low)}>
                                    {f.risk_level}
                                </span>
                            )}
                        </div>

                        {!open && preview && (
                            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
                                {preview}
                            </p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                            {(truncated || open) && content && (
                                <button
                                    type="button"
                                    onClick={() => setOpen((v) => !v)}
                                    aria-expanded={open}
                                    aria-controls={panelId}
                                    className={cn(ACTION, 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white')}
                                >
                                    {open ? 'Show less' : 'View content'}
                                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200',
                                        open && 'rotate-180')} />
                                </button>
                            )}
                            {post && (
                                <a href={post} target="_blank" rel="noopener noreferrer"
                                    className={cn(ACTION, 'text-blue-600 hover:underline dark:text-blue-400')}>
                                    Open source <ExternalLink className="h-3 w-3" />
                                </a>
                            )}
                            {profile && (
                                <a href={profile} target="_blank" rel="noopener noreferrer"
                                    className={cn(ACTION, 'font-normal text-slate-500 hover:underline dark:text-slate-400')}>
                                    <User className="h-3 w-3" /> Author
                                </a>
                            )}
                        </div>
                    </div>
                </div>

                <AnimatePresence initial={false}>
                    {open && (
                        <motion.div
                            id={panelId}
                            initial={still ? false : { height: 0, opacity: 0 }}
                            animate={still ? {} : { height: 'auto', opacity: 1 }}
                            exit={still ? {} : { height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: EASE }}
                            className="overflow-hidden"
                        >
                            <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400 dark:text-slate-500">
                                        Original content
                                    </p>
                                    <p className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-line break-words text-[13px] leading-relaxed text-slate-700 dark:text-slate-200">
                                        {content}
                                    </p>
                                </div>

                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                                    <Meta label="Platform" value={platform} />
                                    <Meta label="Author" value={handle} />
                                    <Meta label="Published" value={when} />
                                    <Meta label="Category" value={f.category} />
                                    <Meta label="Risk" value={f.risk_level} />
                                    <Meta label="Sentiment" value={f.sentiment} />
                                    <Meta label="Topics" value={f.topics} />
                                    <Meta label="Districts" value={item.districts} />
                                </dl>

                                {post && (
                                    <a href={post} target="_blank" rel="noopener noreferrer"
                                        className={cn(ACTION, 'text-blue-600 hover:underline dark:text-blue-400')}>
                                        Open original source <ExternalLink className="h-3 w-3" />
                                    </a>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </Panel>
    );
}
