/**
 * The empty state: what this is, and four ways to start.
 *
 * An officer opening a blank box has to invent a question and guess what the
 * assistant can answer. These tiles do both jobs — they are the capability
 * list as much as they are shortcuts — and every question on them comes from
 * the validated set, so picking one never demonstrates a failure.
 *
 * On a wide screen the suggestions live in the rail beside the conversation,
 * where they stay reachable after the first question. So the tiles here are
 * for narrow windows only, and the greeting stands alone on desktop rather
 * than offering the same four questions twice.
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PROMPT_CATEGORIES, TONE } from './prompts';
import { Eyebrow, Panel, EASE } from './ui';
import AssistantMark from './AssistantMark';

export default function PromptGallery({ onPick, disabled }) {
    const still = useReducedMotion();
    const container = still ? {} : {
        hidden: { opacity: 0 },
        show: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
    };
    const item = still ? {} : {
        hidden: { opacity: 0, y: 12 },
        show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } },
    };

    return (
        <motion.div
            variants={container}
            initial={still ? false : 'hidden'}
            animate={still ? false : 'show'}
            className="flex min-h-full flex-col justify-center py-8 sm:py-10"
        >
            <motion.div variants={item} className="mb-8 text-center">
                {/* Mark and name as one lockup, so the hero states what is
                    speaking before it asks what you want. */}
                <div className="mb-5 flex flex-col items-center gap-2.5">
                    <AssistantMark size="lg" />
                    <Eyebrow>AI Assistant</Eyebrow>
                </div>
                <h1 className="text-balance text-[26px] font-semibold leading-[1.15] tracking-[-0.025em] text-slate-900 sm:text-[32px] dark:text-white">
                    How can I help you investigate?
                </h1>
                <p className="mx-auto mt-3 max-w-lg text-pretty text-[14px] leading-relaxed text-slate-500 dark:text-slate-400">
                    Investigate your monitored environment in plain language — activity,
                    trends, locations, topics and emerging situations.
                </p>
            </motion.div>

            <motion.div variants={item}
                className="mb-3 flex items-baseline justify-between gap-3 px-1 lg:hidden">
                <Eyebrow>Suggested investigations</Eyebrow>
                <span className="text-[12px] text-slate-400 dark:text-slate-500">
                    or type your own question below
                </span>
            </motion.div>

            <div className="grid gap-2.5 sm:grid-cols-2 lg:hidden">
                {PROMPT_CATEGORIES.map(({ title, tone, icon: Icon, blurb, lead, prompts }) => (
                    <motion.div key={title} variants={item} className="min-w-0">
                        <Panel interactive className="flex h-full flex-col p-3.5">
                            <div className="mb-3 flex items-center gap-2.5">
                                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]',
                                    TONE[tone] || TONE.slate)}>
                                    <Icon className="h-4 w-4" aria-hidden />
                                </span>
                                <div className="min-w-0">
                                    <p className="truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em] text-slate-900 dark:text-slate-100">
                                        {title}
                                    </p>
                                    <p className="truncate text-[11.5px] leading-tight text-slate-400 dark:text-slate-500">
                                        {blurb}
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-0.5">
                                {[lead, ...prompts.filter((p) => p !== lead)].map((p, i) => (
                                    <button
                                        key={p}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => onPick(p)}
                                        className={cn(
                                            'group/q flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left leading-snug',
                                            'transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2',
                                            'focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50',
                                            'dark:hover:bg-slate-800',
                                            // The first question is the one most officers want;
                                            // the others are there without competing with it.
                                            i === 0
                                                ? 'text-[13px] font-medium text-slate-800 dark:text-slate-100'
                                                : 'text-[12.5px] text-slate-500 dark:text-slate-400',
                                        )}
                                    >
                                        <span className="min-w-0 flex-1">{p}</span>
                                        <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 opacity-0 transition-opacity group-hover/q:opacity-100 dark:text-slate-600" />
                                    </button>
                                ))}
                            </div>
                        </Panel>
                    </motion.div>
                ))}
            </div>
        </motion.div>
    );
}
