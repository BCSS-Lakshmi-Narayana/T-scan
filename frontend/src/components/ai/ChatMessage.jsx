/**
 * One turn of the conversation.
 *
 * The officer's question is a short line they can scan back to. The answer is
 * not a chat bubble at all — it is a document laid on the page, because an
 * answer here carries measured figures, caveats and twenty pieces of evidence,
 * and none of that belongs inside a speech balloon. Only the evidence cards
 * are raised off the page, so the one elevated thing on screen is always the
 * thing an officer can open and follow to its source.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ExternalLink, Database, CornerDownRight, Copy, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import MessageContent from './MessageContent';
import ScanResult, { scanToText } from './ScanResult';
import V2Details from './V2Details';
import { FailureNotice } from './ResponseStates';
import { Eyebrow, useEnter } from './ui';
import AssistantMark from './AssistantMark';

function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    if (!text) return null;
    return (
        <button
            type="button"
            title="Copy answer"
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                } catch { /* clipboard blocked — the answer is still selectable */ }
            }}
            className="rounded-md p-1.5 text-slate-400 opacity-0 transition-all hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
    );
}

/** The v1 path still answers with a plain list of sources. */
function Sources({ sources }) {
    const [open, setOpen] = useState(false);
    if (!sources?.length) return null;

    return (
        <div className="mt-3">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:text-slate-200"
            >
                <Database className="h-3.5 w-3.5" />
                {sources.length} source{sources.length === 1 ? '' : 's'}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-180')} />
            </button>

            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="overflow-hidden"
                    >
                        <ul className="mt-2 space-y-1.5">
                            {sources.slice(0, 8).map((src, i) => {
                                const url = src.url || src.link || src.content_url;
                                const label = src.title || src.collection || src.source_collection || `Record ${i + 1}`;
                                const preview = src.preview || src.text || '';
                                return (
                                    <li key={i}
                                        className="rounded-lg border border-slate-200/80 px-2.5 py-1.5 text-[12px] dark:border-slate-800">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate font-medium text-slate-700 dark:text-slate-300">{label}</span>
                                            {url && (
                                                <a href={url} target="_blank" rel="noreferrer"
                                                    className="inline-flex shrink-0 items-center gap-0.5 text-blue-600 hover:underline dark:text-blue-400">
                                                    open <ExternalLink className="h-2.5 w-2.5" />
                                                </a>
                                            )}
                                        </div>
                                        {preview && (
                                            <p className="mt-0.5 line-clamp-2 text-slate-500 dark:text-slate-400">{preview}</p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/**
 * What the officer asked.
 *
 * Right-aligned and quiet. It exists so they can scan back and see which
 * question an answer belongs to, not to be read again in full, so it takes as
 * little room as it can while staying unmistakably theirs.
 */
function UserTurn({ content }) {
    const enter = useEnter();
    return (
        <motion.div {...enter(0, { opacity: 0, y: 6 })} className="flex justify-end">
            <div className="max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-slate-900 px-3.5 py-2 text-[14px] leading-relaxed text-white dark:bg-slate-100 dark:text-slate-900">
                <p className="whitespace-pre-line break-words">{content}</p>
            </div>
        </motion.div>
    );
}

export default function ChatMessage({
    message, onFollowup, isLast, onDeepScan, onCancelScan, onRetry, onCompose,
}) {
    const enter = useEnter();
    const isUser = message.role === 'user';
    if (isUser) return <UserTurn content={message.content} />;

    const scan = message.scan;

    return (
        <motion.div {...enter(0, { opacity: 0, y: 8 })} className="group min-w-0">
            <div className="mb-3 flex items-center gap-2">
                <AssistantMark size="sm" />
                <Eyebrow>Answer</Eyebrow>
            </div>

            {scan ? (
                <ScanResult scan={scan} onDeepScan={onDeepScan} onCancel={onCancelScan} />
            ) : message.failure ? (
                <FailureNotice question={message.failure.question} onRetry={onRetry} />
            ) : message.v2 ? (
                // The v2 answer owns its whole layout: the records inside its
                // text are rendered as cards, so the text copy is never shown.
                <V2Details response={message.v2} onFollowup={onFollowup} onCompose={onCompose} />
            ) : (
                <>
                    <MessageContent content={message.content} />
                    <Sources sources={message.sources} />
                </>
            )}

            <div className="mt-2 flex items-center gap-2">
                {typeof message.window === 'number' && (
                    <span className="text-[11.5px] text-slate-400 dark:text-slate-500">
                        {message.window.toLocaleString()} records in window
                    </span>
                )}
                <CopyButton text={scan ? scanToText(scan) : message.content} />
            </div>

            {/* Follow-ups only under the newest answer: older ones are history. */}
            {isLast && message.followups?.length > 0 && (
                <motion.div
                    {...enter(1)}
                    className="mt-3 flex flex-wrap gap-1.5"
                >
                    {message.followups.map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => onFollowup?.(f)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                        >
                            <CornerDownRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                            {f}
                        </button>
                    ))}
                </motion.div>
            )}
        </motion.div>
    );
}
