import React, { useState, useEffect } from 'react';
import api from '../lib/api';

// Shared fetch for the officer's monitoring allocation + current usage.
// Returns null for admins (enforced === false) or on any error, so every caller
// can simply render nothing and never disrupt the page.
// `enabled=false` skips the request entirely (used when a parent already has the
// data and passes it down, so we don't fire the same GET twice).
// `refreshKey` re-fetches whenever it changes — callers bump it after any action
// that changes usage (activating/pausing a profile or event, create, delete) so
// the meter stays live instead of needing a manual page refresh.
export const useMonitoringUsage = (enabled = true, refreshKey = 0) => {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    api.get('/sources/monitoring-usage')
      .then((res) => { if (alive) setUsage(res.data); })
      .catch(() => { /* silent — the meter is optional */ });
    return () => { alive = false; };
  }, [enabled, refreshKey]);

  return usage && usage.enforced ? usage : null;
};

const shellCls = 'rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-4 py-3';
const titleCls = 'text-xs font-semibold text-amber-800 dark:text-amber-300 uppercase tracking-wide';
const noteCls = 'text-[11px] text-amber-700 dark:text-amber-400/80 mt-1';

// Read-only strip showing a District Officer their allocated monitoring limits
// vs. what they are currently using. Renders NOTHING for admins or on error.
//   mode="profiles" (default) → active profiles per platform
//   mode="events"             → active manual events + keywords-per-event allowance
// Pass `usage` when the parent already called useMonitoringUsage() (avoids a
// duplicate request); otherwise the component fetches its own.
const MonitoringUsageBar = ({ mode = 'profiles', usage: usageProp, className = '', refreshKey = 0 }) => {
  // Only self-fetch when the parent didn't already supply the data.
  const fetched = useMonitoringUsage(usageProp === undefined, refreshKey);
  const usage = usageProp !== undefined ? usageProp : fetched;
  if (!usage) return null;

  if (mode === 'events') {
    const ev = usage.events;
    if (!ev || ev.limit == null) return null;
    const full = ev.active >= ev.limit;
    const none = ev.limit === 0;
    return (
      <div className={`${shellCls} ${className}`}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className={titleCls}>Your monitoring allocation</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span
              className={`text-sm ${full ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-slate-700 dark:text-slate-300'}`}
              title={`${ev.active} active of ${ev.limit} allowed (${ev.total} total created)`}
            >
              Active events: {ev.active}/{ev.limit}{full ? ' · full' : ''}
            </span>
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Keywords per event: {usage.max_keywords_per_event}
            </span>
          </div>
        </div>
        <p className={noteCls}>
          {none
            ? 'You have no active event allocation. Events you create stay paused.'
            : 'You can create any number of events — extra ones stay paused. Pause or archive an active event to free a slot.'}
        </p>
      </div>
    );
  }

  const labels = { x: 'X', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };
  const entries = Object.entries(usage.per_platform || {});
  if (entries.length === 0) return null;

  return (
    <div className={`${shellCls} ${className}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className={titleCls}>Your monitoring allocation</span>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {entries.map(([platform, v]) => {
            const full = v.limit != null && v.active >= v.limit;
            return (
              <span
                key={platform}
                className={`text-sm ${full ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-slate-700 dark:text-slate-300'}`}
                title={`${v.active} active of ${v.limit} allowed (${v.total} total staged)`}
              >
                {labels[platform] || platform}: {v.active}/{v.limit}{full ? ' · full' : ''}
              </span>
            );
          })}
        </div>
      </div>
      <p className={noteCls}>
        You can add any number of profiles — extra ones are staged paused. Pause an active profile to free a slot.
      </p>
    </div>
  );
};

export default MonitoringUsageBar;
