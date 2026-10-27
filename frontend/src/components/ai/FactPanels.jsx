/**
 * The measured parts of an answer: a comparison, a movement over time, or a
 * situation the assistant assembled.
 *
 * Every number here came from the database and is already in the response;
 * none is computed in the browser.
 *
 * The wording is deliberately flat. These panels count POSTS — what was said
 * online and captured — which is not the same as what happened. So the unit is
 * written next to every figure, the semantic label comes before the number
 * rather than after it, and no panel ranks its sides. An officer reading
 * "Hyderabad 4,241 / Mulugu 26" must not be nudged toward "Hyderabad is worse";
 * they are being shown how much was captured in each place.
 */

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Eyebrow, Note, Section, Chip, useEnter } from './ui';

/** Grouping figures read better with separators; "1293" is a year, "1,293" is a count. */
const num = (v) => (typeof v === 'number' ? v.toLocaleString() : v ?? '—');

/**
 * One measured figure: what it is, then how much of it, then its unit.
 *
 * Label first on purpose. A column that opens with "4,560" makes the officer
 * read the number before knowing what was counted, which is exactly how a post
 * count gets remembered as an incident count.
 */
function Figure({ label, value, unit, tone = 'default', delay = 0, children }) {
    const enter = useEnter();
    return (
        <motion.div {...enter(delay)} className="min-w-0">
            <p className="truncate text-[12px] font-medium text-slate-500 dark:text-slate-400">
                {label}
            </p>
            {children || (
                <p className={cn(
                    'mt-0.5 truncate text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]',
                    tone === 'muted' ? 'text-slate-400 dark:text-slate-500'
                        : 'text-slate-900 dark:text-white',
                )}>
                    {num(value)}
                </p>
            )}
            {unit && (
                <p className="mt-1 truncate text-[11.5px] text-slate-400 dark:text-slate-500">{unit}</p>
            )}
        </motion.div>
    );
}

/**
 * Two or more measured scopes, side by side.
 *
 * No winner, no ranking, no "higher/lower" language: the officer is shown what
 * was counted for each scope and draws their own conclusion.
 */
export function ComparisonPanel({ fact, scope }) {
    const sides = fact?.sides || [];
    if (sides.length < 2) return null;
    return (
        <Section label="Monitored post volume by location" aria-label="Comparison">
            <div className={cn('grid gap-x-6 gap-y-4',
                sides.length > 2 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2')}>
                {sides.map((s, i) => (
                    <Figure key={s.label ?? i} label={s.label} value={s.count}
                        unit="monitored posts" delay={i} />
                ))}
            </div>
            {scope && (
                <p className="mt-3 text-[12px] text-slate-500 dark:text-slate-400">{scope}</p>
            )}
            <Note className="mt-3">
                Each figure counts posts captured for that location in the same window.
                Different places are monitored to different depths, so a larger number
                does not by itself mean more is happening there.
            </Note>
        </Section>
    );
}

/**
 * Movement between two windows.
 *
 * Labelled "monitored post volume" on purpose. A rise here means more posts
 * were captured, which is not the same as more happening.
 */
export function TrendPanel({ fact }) {
    // Every hook runs before any early return: React matches hooks by call
    // order, so bailing out above this line would change that order between
    // a render with a trend and one without.
    const enter = useEnter();
    if (!fact) return null;
    const { current, previous, change_pct: pct, direction, days } = fact;
    const up = direction === 'up' || (typeof pct === 'number' && pct > 0);
    const flat = pct === 0 || direction === 'flat';
    const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;

    return (
        <Section label="Monitored post volume" aria-label="Trend">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Figure label={days ? `Current ${days} days` : 'Current period'}
                    value={current} unit="monitored posts" />
                <Figure label={days ? `Previous ${days} days` : 'Previous period'}
                    value={previous} unit="monitored posts" tone="muted" delay={1} />
                <Figure label="Change" delay={2}
                    unit={flat ? 'no material change' : up ? 'more posts captured' : 'fewer posts captured'}>
                    <p className={cn(
                        'mt-0.5 inline-flex items-center gap-1 text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]',
                        flat ? 'text-slate-500 dark:text-slate-400'
                            : up ? 'text-amber-600 dark:text-amber-400'
                                : 'text-emerald-600 dark:text-emerald-400',
                    )}>
                        <Icon className="h-5 w-5 shrink-0" aria-hidden />
                        {typeof pct === 'number' ? `${pct > 0 ? '+' : ''}${pct}%` : '—'}
                    </p>
                </Figure>
            </div>
            {typeof pct !== 'number' ? (
                <Note className="mt-3">
                    No percentage change can be stated — nothing was recorded in the
                    earlier window.
                </Note>
            ) : (
                <Note className="mt-3">
                    This is the change in how many posts were captured, not a change in
                    how much is happening on the ground.
                </Note>
            )}
        </Section>
    );
}

/** "murder" -> "Murder", "women_safety" -> "Women safety". */
const pretty = (s) => {
    const t = String(s ?? '').replace(/_/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/**
 * A row of counted values: theme, place or account.
 *
 * `verbatim` keeps handles exactly as stored. A handle is an identifier an
 * officer may search for or type, so capitalising it the way a theme is
 * capitalised would be wrong.
 */
function Chips({ items, keyName = 'value', prefix = '', verbatim = false }) {
    const enter = useEnter();
    const rows = (items || []).filter((r) => r && (r[keyName] ?? r.text));
    if (!rows.length) return null;
    return (
        <div className="flex flex-wrap gap-1.5">
            {rows.slice(0, 8).map((r, i) => {
                const raw = r[keyName] ?? r.text;
                return (
                    <motion.span key={`${raw}-${i}`} {...enter(i)}>
                        <Chip count={num(r.count)}>
                            {prefix}{verbatim ? String(raw) : pretty(raw)}
                        </Chip>
                    </motion.span>
                );
            })}
        </div>
    );
}

/** A sub-heading inside the situation block. Quieter than the section label. */
function Row({ label, children }) {
    return (
        <div className="min-w-0">
            <p className="mb-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400">{label}</p>
            {children}
        </div>
    );
}

/**
 * What the assistant observed, arranged so the themes are read first.
 *
 * Sections are omitted entirely when the backend did not establish them —
 * an empty "Connections" heading would suggest the question was asked and
 * answered with nothing, when it was never answerable.
 */
export function SituationPanel({ situation }) {
    if (!situation) return null;
    const { topics, where, who, connections, window_days: win, volume } = situation;
    const hasAny = (topics?.length || where?.length || who?.length || connections?.length);
    if (!hasAny) return null;

    const scope = [
        typeof volume === 'number' ? `${num(volume)} posts` : null,
        win ? `last ${win} days` : null,
    ].filter(Boolean).join(' · ');

    return (
        <Section label="Monitored online activity" aside={scope} aria-label="Observed activity">
            <div className="space-y-3.5">
                {topics?.length > 0 && (
                    <Row label="Key themes"><Chips items={topics} /></Row>
                )}
                {where?.length > 0 && (
                    <Row label="Where"><Chips items={where} /></Row>
                )}
                {who?.length > 0 && (
                    <Row label="Accounts appearing repeatedly">
                        <Chips items={who} prefix="@" verbatim />
                    </Row>
                )}
                {connections?.length > 0 && (
                    <Row label="Connected records">
                        <p className="text-[12.5px] text-slate-500 dark:text-slate-400">
                            {connections.length} record{connections.length === 1 ? '' : 's'} share an
                            account, target or place with the matches.
                        </p>
                    </Row>
                )}
            </div>

            <Note className="mt-4">
                These are themes counted across monitored posts — what was said online,
                not a record of events. They do not by themselves establish that any
                specific incident occurred.
            </Note>
        </Section>
    );
}

export default { ComparisonPanel, TrendPanel, SituationPanel };
