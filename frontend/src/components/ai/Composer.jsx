/**
 * The command bar: the question, and the two controls that change what an
 * answer MEANS.
 *
 * Whether the answer is grounded in the monitored database, and how far back
 * it looks, are not preferences — an answer read without knowing them is
 * misleading. So they sit inside the input surface itself rather than in a
 * settings panel, where they are visible every time a question is sent.
 *
 * It floats over the end of the conversation rather than sitting in a bar
 * bolted to the bottom of the window: the conversation runs underneath and
 * fades out behind it, so the page reads as one surface instead of two
 * stacked panels.
 */

import React, { forwardRef, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Square, Database, MessageCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TIME_WINDOW_OPTIONS } from './prompts';
import { Segmented } from './ui';

const Composer = forwardRef(function Composer({
    value, onChange, onSend, onStop, loading,
    useDb, onUseDbChange, windowDays, onWindowChange,
}, ref) {
    const inner = useRef(null);
    const area = ref || inner;

    // Grow with the question to about six lines, then scroll inside the box.
    useEffect(() => {
        const el = area.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    }, [value, area]);

    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (value.trim() && !loading) onSend();
        }
    };

    return (
        // The wrapper carries only the fade; clicks pass through it to the
        // conversation, and only the bar itself is interactive.
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 pt-12 sm:px-6 sm:pb-5">
            <div className="absolute inset-0 bg-gradient-to-t from-white via-white/95 to-transparent dark:from-slate-950 dark:via-slate-950/95" />
            <div className="pointer-events-auto relative mx-auto w-full max-w-3xl">
                <div className={cn(
                    'rounded-[22px] border bg-white transition-shadow',
                    'shadow-[0_4px_24px_-4px_rgba(15,23,42,0.12),0_1px_3px_rgba(15,23,42,0.06)]',
                    'focus-within:shadow-[0_8px_32px_-4px_rgba(15,23,42,0.16),0_1px_3px_rgba(15,23,42,0.08)]',
                    'border-slate-200/90 dark:border-slate-700/80 dark:bg-slate-900',
                )}>
                    <label htmlFor="assistant-question" className="sr-only">
                        Ask about activity, alerts, people, locations, or trends
                    </label>
                    <textarea
                        id="assistant-question"
                        ref={area}
                        rows={1}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={useDb
                            ? 'Ask about activity, alerts, people, locations, or trends…'
                            : 'Ask anything — this answer will not use your data'}
                        className="max-h-44 w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
                    />

                    <div className="flex items-end justify-between gap-2 px-2.5 pb-2.5 pt-1.5">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => onUseDbChange(!useDb)}
                                title={useDb
                                    ? 'Answers are grounded in the monitored database and cite the records they came from'
                                    : 'General AI knowledge only. Nothing here comes from your data.'}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                                    useDb
                                        ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300'
                                        : 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300',
                                )}
                            >
                                {useDb ? <Database className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
                                <span className="hidden sm:inline">
                                    {useDb ? 'Live database' : 'General chat'}
                                </span>
                            </button>

                            <AnimatePresence initial={false}>
                                {useDb && (
                                    <motion.div
                                        initial={{ opacity: 0, width: 0 }}
                                        animate={{ opacity: 1, width: 'auto' }}
                                        exit={{ opacity: 0, width: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="overflow-hidden"
                                    >
                                        <Segmented
                                            size="sm"
                                            idPrefix="window"
                                            options={TIME_WINDOW_OPTIONS}
                                            value={windowDays}
                                            onChange={onWindowChange}
                                        />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        <AnimatePresence mode="wait" initial={false}>
                            {loading ? (
                                <motion.button
                                    key="stop"
                                    type="button"
                                    onClick={onStop}
                                    initial={{ scale: 0.9, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0.9, opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                    aria-label="Stop generating"
                                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-slate-100 dark:text-slate-900"
                                >
                                    <Square className="h-3.5 w-3.5" fill="currentColor" />
                                </motion.button>
                            ) : (
                                <motion.button
                                    key="send"
                                    type="button"
                                    onClick={onSend}
                                    disabled={!value.trim()}
                                    initial={{ scale: 0.9, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0.9, opacity: 0 }}
                                    whileTap={{ scale: 0.94 }}
                                    transition={{ duration: 0.15 }}
                                    aria-label="Send question"
                                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800 dark:disabled:text-slate-600"
                                >
                                    <ArrowUp className="h-4 w-4" />
                                </motion.button>
                            )}
                        </AnimatePresence>
                    </div>
                </div>

                <p className="mt-2 text-center text-[11px] text-slate-400 dark:text-slate-500">
                    {useDb
                        ? 'Answers are drawn from monitored posts and cite the records they came from.'
                        : 'General chat: this answer will not use your data and cites nothing.'}
                </p>
            </div>
        </div>
    );
});

export default Composer;
