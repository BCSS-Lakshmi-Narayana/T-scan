/**
 * What the assistant is doing while a question is in flight.
 *
 * A grounded answer can take half a minute. Showing roughly where it is turns
 * waiting into watching, which is the difference between an officer waiting
 * and an officer reloading the page.
 *
 * The stages are the officer's view of the work, not the pipeline's: they say
 * what is being done to their question, never which component is doing it.
 * The progression only moves forward and holds on the last stage — stepping
 * back to "Understanding" would read as though the request had restarted.
 */

import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { Eyebrow, EASE } from './ui';
import AssistantMark from './AssistantMark';

const STAGES = [
    'Understanding the question',
    'Searching monitored activity',
    'Verifying against the records',
    'Preparing the briefing',
];

export default function ThinkingIndicator({ grounded = true, className }) {
    const [stage, setStage] = useState(0);
    const still = useReducedMotion();

    useEffect(() => {
        if (!grounded) return undefined;
        const id = setInterval(
            () => setStage((s) => Math.min(s + 1, STAGES.length - 1)),
            3200,
        );
        return () => clearInterval(id);
    }, [grounded]);

    const label = grounded ? STAGES[stage] : 'Thinking';

    return (
        <motion.div
            initial={still ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={still ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className={cn('min-w-0', className)}
            aria-live="polite"
        >
            <div className="mb-3 flex items-center gap-2">
                <AssistantMark size="sm" state="thinking" />
                <Eyebrow>Answer</Eyebrow>
            </div>

            <div className="flex items-center gap-2.5">
                <motion.p
                    key={label}
                    initial={still ? false : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: EASE }}
                    className="text-[14px] text-slate-500 dark:text-slate-400"
                >
                    {label}
                </motion.p>
            </div>

            {grounded && (
                <div className="mt-2.5 flex max-w-xs gap-1" aria-hidden>
                    {STAGES.map((s, i) => (
                        <span key={s} className="h-[3px] flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <motion.span
                                className={cn('block h-full rounded-full',
                                    i <= stage ? 'bg-blue-500' : 'bg-transparent')}
                                initial={still ? false : { scaleX: 0 }}
                                animate={{ scaleX: i <= stage ? 1 : 0 }}
                                style={{ transformOrigin: 'left' }}
                                transition={{ duration: 0.4, ease: EASE }}
                            />
                        </span>
                    ))}
                </div>
            )}
        </motion.div>
    );
}
