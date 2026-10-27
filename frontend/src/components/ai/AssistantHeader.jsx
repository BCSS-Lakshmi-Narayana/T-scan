/**
 * The page header.
 *
 * It answers one question — what am I looking at, and what is it looking at —
 * and then stops. It is not a dashboard: no counts, no charts, nothing that
 * competes with the answer below it.
 *
 * What it does carry is operational context, because the same question asked
 * against the monitored database and against general knowledge gives different
 * answers, and an officer must never have to guess which one they are reading.
 *
 * It spans the window rather than sitting inside the reading column, so the
 * page reads as an application and not as a document dropped onto a blank
 * sheet.
 */

import React from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Segmented } from './ui';
import AssistantMark from './AssistantMark';

/** A live/degraded dot. Silent while everything is fine and the state is known. */
function ServiceState({ health }) {
    if (!health || health.healthy) return null;
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-[3px] text-[11.5px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Degraded
        </span>
    );
}

export default function AssistantHeader({
    tabs, activeTab, onTabChange, health, useDb, windowDays, onClear, canClear, busy,
}) {
    const scope = [
        useDb ? 'Live monitored intelligence' : 'General knowledge — not your data',
        useDb && windowDays ? `last ${windowDays} days` : useDb ? 'all time' : null,
    ].filter(Boolean).join(' · ');

    return (
        <header className={cn(
            'sticky top-0 z-20 shrink-0 border-b border-slate-200/70 bg-white/75 backdrop-blur-xl',
            'dark:border-slate-800 dark:bg-slate-950/75',
        )}>
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
                <AssistantMark size="md" state={busy ? 'thinking' : 'idle'} />

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-white">
                            AI Assistant
                        </h1>
                        <ServiceState health={health} />
                    </div>
                    <p className="truncate text-[12px] text-slate-500 dark:text-slate-400">{scope}</p>
                </div>

                {tabs.length > 1 && (
                    <Segmented
                        idPrefix="ai-tab"
                        options={tabs.map((t) => ({ value: t.id, label: t.label }))}
                        value={activeTab}
                        onChange={onTabChange}
                    />
                )}

                {canClear && (
                    <button
                        type="button"
                        onClick={onClear}
                        title="Clear this conversation"
                        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Clear</span>
                    </button>
                )}
            </div>
        </header>
    );
}
