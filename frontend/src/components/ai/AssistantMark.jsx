/**
 * The assistant's avatar.
 *
 * One face used everywhere it speaks — the header, the empty state, each
 * answer, and the waiting state — so the officer always knows which voice they
 * are reading. It is the only ornamental object on the page, which is what
 * lets it carry the product's character without the rest of the interface
 * having to shout.
 *
 * `state` drives the motion rather than a pile of booleans: idle breathes very
 * slowly, thinking glows and sweeps, and every bit of it stops dead under the
 * OS "reduce motion" setting.
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Bot } from 'lucide-react';
import { cn } from '../../lib/utils';

const SIZES = {
    sm: { box: 'h-7 w-7 rounded-[10px]', glyph: 'h-4 w-4', ring: '-inset-[3px] rounded-[13px]' },
    md: { box: 'h-9 w-9 rounded-xl', glyph: 'h-5 w-5', ring: '-inset-1 rounded-[16px]' },
    lg: { box: 'h-14 w-14 rounded-[18px]', glyph: 'h-7 w-7', ring: '-inset-1.5 rounded-[24px]' },
};

export default function AssistantMark({ size = 'md', state = 'idle', className }) {
    const still = useReducedMotion();
    const s = SIZES[size] || SIZES.md;
    const thinking = state === 'thinking';

    return (
        <span className={cn('relative inline-flex shrink-0', className)}>
            {/* A soft halo, only while the assistant is working. */}
            {thinking && !still && (
                <motion.span
                    className={cn('absolute bg-blue-500/25 blur-md', s.ring)}
                    animate={{ opacity: [0.3, 0.85, 0.3], scale: [0.95, 1.05, 0.95] }}
                    transition={{ duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}
                />
            )}

            <motion.span
                className={cn(
                    'relative flex items-center justify-center overflow-hidden text-white',
                    'bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-700',
                    'shadow-lg shadow-blue-500/20 ring-1 ring-inset ring-white/15',
                    s.box,
                )}
                animate={still ? {} : thinking ? { scale: [1, 1.05, 1] } : { y: [0, -1.5, 0] }}
                transition={{ duration: thinking ? 1.9 : 4.5, repeat: Infinity, ease: 'easeInOut' }}
            >
                {/* A highlight sweeping across reads as the assistant being busy,
                    without a spinner's "something is stuck". */}
                {thinking && !still && (
                    <motion.span
                        className="absolute inset-0 bg-[linear-gradient(110deg,transparent_35%,rgba(255,255,255,0.5)_50%,transparent_65%)]"
                        animate={{ x: ['-130%', '130%'] }}
                        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                    />
                )}
                <Bot className={cn('relative', s.glyph)} aria-hidden />
            </motion.span>
        </span>
    );
}
