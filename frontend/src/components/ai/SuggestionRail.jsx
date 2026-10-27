/**
 * Suggested investigations, kept to one side.
 *
 * On a wide screen the conversation only needs a reading column, which leaves
 * a band of empty space. Putting the suggestions there means an officer can
 * see what the assistant can answer at any point in the conversation — not
 * only on the first screen, which is the one moment they are least likely to
 * need the help.
 *
 * Plain rows rather than cards. This is a list of questions to glance down,
 * and a column of bordered boxes reads slower than a well-set list.
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { PROMPT_CATEGORIES, TONE } from './prompts';
import { Eyebrow, EASE } from './ui';

export default function SuggestionRail({ onPick, disabled, className }) {
    const still = useReducedMotion();

    return (
        <aside
            aria-label="Suggested investigations"
            className={cn(
                'flex w-72 shrink-0 flex-col overflow-y-auto border-r border-slate-200/70 bg-slate-50/40',
                'dark:border-slate-800 dark:bg-slate-900/30',
                className,
            )}
        >
            <div className="px-4 py-5">
                <Eyebrow className="mb-3 px-2">Suggested investigations</Eyebrow>

                <div className="space-y-5">
                    {PROMPT_CATEGORIES.map(({ title, tone, icon: Icon, prompts }, gi) => (
                        <motion.div
                            key={title}
                            initial={still ? false : { opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.22, delay: gi * 0.05, ease: EASE }}
                        >
                            <div className="mb-1.5 flex items-center gap-2 px-2">
                                <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                                    TONE[tone] || TONE.slate)}>
                                    <Icon className="h-3 w-3" aria-hidden />
                                </span>
                                <p className="truncate text-[12px] font-semibold tracking-[-0.01em] text-slate-700 dark:text-slate-200">
                                    {title}
                                </p>
                            </div>

                            <div className="space-y-px">
                                {prompts.map((p) => (
                                    <button
                                        key={p}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => onPick(p)}
                                        title={p}
                                        className={cn(
                                            'block w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] leading-snug',
                                            'text-slate-500 transition-colors hover:bg-white hover:text-slate-900',
                                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                                            'disabled:cursor-not-allowed disabled:opacity-50',
                                            'dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
                                        )}
                                    >
                                        {p}
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </aside>
    );
}
