/**
 * The shared vocabulary of the assistant: one type scale, one radius, one set
 * of surfaces. Everything in components/ai composes from these.
 *
 * The page is read as a document, not as a chat log. An officer scans it for
 * the answer, then for what it rests on, so the hierarchy is carried by
 * typography and whitespace rather than by boxes inside boxes. Only two
 * elevations exist: the page, and a surface resting on it.
 *
 * Accent colour is reserved for what the officer can act on. Risk, trend
 * direction and status use colour semantically and nowhere else, so a red
 * thing on this page always means something.
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';

/** 150–250ms, one easing curve. Anything slower reads as lag, not polish. */
export const EASE = [0.22, 1, 0.36, 1];
export const DUR = 0.2;

/**
 * Entrance props for an element, honouring the OS "reduce motion" setting.
 * Returns `initial: false` when motion is reduced, which mounts the element
 * already in place rather than animating it to nowhere.
 */
export function useEnter() {
    const still = useReducedMotion();
    return (i = 0, from = { opacity: 0, y: 6 }) => (still
        ? { initial: false }
        : {
            initial: from,
            animate: { opacity: 1, y: 0, x: 0 },
            transition: { duration: DUR, delay: i * 0.04, ease: EASE },
        });
}

/**
 * The small caps label above a section.
 *
 * Deliberately quiet: it names the section for someone scanning, and disappears
 * for someone reading. A full heading at every level would make four competing
 * titles in one answer.
 */
export function Eyebrow({ children, className, as: As = 'p' }) {
    return (
        <As className={cn(
            'text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400 dark:text-slate-500',
            className,
        )}>
            {children}
        </As>
    );
}

/**
 * One part of an answer: a label and its content, with the vertical rhythm
 * already set. Sections are separated by space, not by rules or borders —
 * an answer divided by lines reads as a form to fill in.
 */
export function Section({ label, aside, children, className, ...rest }) {
    return (
        <section className={cn('min-w-0', className)} {...rest}>
            {(label || aside) && (
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    {label ? <Eyebrow>{label}</Eyebrow> : <span />}
                    {aside && (
                        <span className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                            {aside}
                        </span>
                    )}
                </div>
            )}
            {children}
        </section>
    );
}

/**
 * A surface resting on the page: the answer, an evidence card, a starter tile.
 *
 * A hairline border and a single-pixel shadow, never a glow. `interactive`
 * adds the hover state for surfaces that carry actions — an expandable
 * evidence card, a tile of questions — so a surface that responds to the
 * pointer is always one the officer can do something with.
 */
export function Panel({ interactive = false, className, as: As = 'div', ...rest }) {
    return (
        <As
            className={cn(
                'rounded-2xl border border-slate-200/80 bg-white',
                'shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
                'dark:border-slate-800 dark:bg-slate-900/60',
                interactive && 'transition-[border-color,box-shadow,transform] duration-200 '
                    + 'hover:border-slate-300 hover:shadow-[0_2px_10px_rgba(15,23,42,0.06)] '
                    + 'dark:hover:border-slate-700',
                className,
            )}
            {...rest}
        />
    );
}

/** A counted value: the thing, then how many of it. */
export function Chip({ children, count, className }) {
    return (
        <span className={cn(
            'inline-flex items-baseline gap-1.5 rounded-lg bg-slate-100 px-2 py-[3px]',
            'text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200',
            className,
        )}>
            {children}
            {count !== undefined && count !== null && (
                <span className="tabular-nums text-slate-400 dark:text-slate-500">{count}</span>
            )}
        </span>
    );
}

/**
 * A quiet caveat tied to the thing above it.
 *
 * Used where the interface would otherwise let an officer read more into a
 * number than it can carry. It is not styled as a warning: it is a standing
 * fact about what the data is, not an alert.
 */
export function Note({ children, className }) {
    return (
        <p className={cn(
            'border-l-2 border-slate-200 pl-3 text-[12px] leading-relaxed text-slate-500',
            'dark:border-slate-700 dark:text-slate-400',
            className,
        )}>
            {children}
        </p>
    );
}

/** The one button shape on this page. */
export function Button({ variant = 'secondary', className, as: As = 'button', ...rest }) {
    return (
        <As
            className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium',
                'transition-colors duration-150 focus:outline-none focus-visible:ring-2',
                'focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-950',
                'disabled:cursor-not-allowed disabled:opacity-40',
                variant === 'primary' && 'bg-blue-600 px-4 py-2 text-white hover:bg-blue-700',
                variant === 'secondary' && 'border border-slate-200 bg-white px-3 py-1.5 text-slate-700 '
                    + 'hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 '
                    + 'dark:hover:bg-slate-800',
                variant === 'ghost' && 'px-2 py-1 text-slate-500 hover:text-slate-900 '
                    + 'dark:text-slate-400 dark:hover:text-slate-100',
                variant === 'danger' && 'bg-rose-600 px-4 py-2 text-white hover:bg-rose-700',
                className,
            )}
            {...rest}
        />
    );
}

/** A segmented control, the way a time window or a tab should look. */
export function Segmented({ options, value, onChange, idPrefix, className, size = 'md' }) {
    return (
        <div
            role="tablist"
            className={cn('inline-flex items-center gap-0.5 rounded-xl bg-slate-100 p-0.5 dark:bg-slate-800',
                className)}
        >
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <button
                        key={String(o.value)}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        title={o.title || o.label}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            'relative rounded-[10px] font-medium transition-colors duration-150',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                            size === 'sm' ? 'px-2 py-[3px] text-[12px]' : 'px-3 py-1 text-[13px]',
                            active ? 'text-slate-900 dark:text-white'
                                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                        )}
                    >
                        {active && (
                            <motion.span
                                layoutId={`${idPrefix}-seg`}
                                className="absolute inset-0 rounded-[10px] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:bg-slate-700"
                                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                            />
                        )}
                        <span className="relative whitespace-nowrap">{o.label}</span>
                    </button>
                );
            })}
        </div>
    );
}

export default { Eyebrow, Section, Panel, Chip, Note, Button, Segmented, useEnter };
