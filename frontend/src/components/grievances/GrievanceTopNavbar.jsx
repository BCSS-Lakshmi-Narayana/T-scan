import React, { useState, useMemo } from 'react';
import {
    Globe, BarChart3, Plus, Trash2, Calendar, User, BadgeCheck, ChevronDown, Check, X
} from 'lucide-react';
import { Button } from '../ui/button';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator
} from '../ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { cn } from '../../lib/utils';

/* ═══════════════════════════════════════════════════════════════ */
/*                  PLATFORM ICONS & COMPONENTS                   */
/* ═══════════════════════════════════════════════════════════════ */

// X (Twitter) Logo
const XLogo = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
);

// Facebook Logo
const FacebookLogo = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
);

const PLATFORM_FILTER_THEME = {
    all: {
        accent: '#b45309',
        activeBg: '#fde68a',
        activeText: '#78350f',
        activeBorder: '#d97706',
        inactiveText: '#a16207',
        inactiveBorder: '#fbbf24',
    },
    x: {
        accent: '#111827',
        activeBg: '#f3f4f6',
        activeText: '#111827',
        activeBorder: '#9ca3af',
        inactiveText: '#374151',
        inactiveBorder: '#d1d5db',
    },
    facebook: {
        accent: '#1877F2',
        activeBg: '#dbeafe',
        activeText: '#1e3a8a',
        activeBorder: '#1877F2',
        inactiveText: '#1d4ed8',
        inactiveBorder: '#93c5fd',
    },
};

// Sentiment of the grievance, from the sentiment service.
const SENTIMENT_FILTERS = [
    { id: 'all', label: 'All', className: 'border-slate-300 text-slate-700 dark:text-slate-300' },
    { id: 'negative', label: 'Negative', className: 'border-red-300 text-red-700 dark:text-red-400' },
    { id: 'neutral', label: 'Neutral', className: 'border-amber-300 text-amber-700 dark:text-amber-400' },
    { id: 'positive', label: 'Positive', className: 'border-emerald-300 text-emerald-700 dark:text-emerald-400' },
];

// <input type="date"> works in local YYYY-MM-DD; dateRange holds local Date
// objects (from = start of day, to = end of day).
const toDateInputValue = (d) => {
    if (!d) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fromDateInputValue = (value, endOfDay = false) => {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    if (!y || !m || !d) return null;
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
};
const DATE_PRESETS = [
    { key: 'today', label: 'Today', days: 1 },
    { key: '7d', label: '7D', days: 7 },
    { key: '30d', label: '30D', days: 30 },
];
const presetRange = (days) => {
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    return { from, to };
};

/* ═══════════════════════════════════════════════════════════════ */
/*                  MAIN NAVBAR COMPONENT                         */
/* ═══════════════════════════════════════════════════════════════ */

export const GrievanceTopNavbar = ({
    activePlatform = 'all',
    onPlatformChange,
    activeSentiment = 'all',
    onSentimentChange,
    onDiscoverFacebook,
    dateRange = null,
    onDateRangeChange,
    activeStatus = 'total',
    onStatusChange,
    selectedHandle = null,
    onHandleChange,
    stats = {},
    workflowStats = {},
    grievances = [],
    sources = [],
    allowedStatuses = null,
    onAddSource,
    onRemoveSource,
    onFetchSourceHistory
}) => {
    const [isHandleDropdownOpen, setIsHandleDropdownOpen] = useState(false);

    // Platform tabs
    const PLATFORMS = [
        { id: 'all', label: 'All', icon: null, color: 'text-slate-600' },
        { id: 'x', label: 'X', icon: XLogo, color: 'text-black dark:text-white' },
        { id: 'facebook', label: 'Facebook', icon: FacebookLogo, color: 'text-[#1877F2]' },
    ];

    // Status filters
    const STATUS_FILTERS = [
        { id: 'total', label: 'Total', key: 'total' },
        { id: 'pending', label: 'Pending', key: 'pending' },
        { id: 'escalated', label: 'Escalated', key: 'escalated' },
        { id: 'closed', label: 'Closed', key: 'closed' },
        { id: 'fir', label: 'FIR', key: 'converted_to_fir' },
    ];

    const visibleStatusFilters = Array.isArray(allowedStatuses)
        ? STATUS_FILTERS.filter((status) => allowedStatuses.includes(status.id))
        : STATUS_FILTERS;

    const canViewReports = !Array.isArray(allowedStatuses) || allowedStatuses.includes('reports');
    const canViewStampedPostFilters = !Array.isArray(allowedStatuses)
        || allowedStatuses.includes('total')
        || allowedStatuses.includes('criticism')
        || allowedStatuses.includes('suggestion');

    // Filter sources based on active platform
    const platformSources = useMemo(() => {
        if (activePlatform === 'all') return sources; // Or maybe empty if we only want to show when platform selected
        // Actually, if 'all', we probably shouldn't show the detailed cards list or maybe show all?
        // Let's filter by the specific platform if selected 
        return sources.filter(s => s.platform === activePlatform);
    }, [activePlatform, sources]);

    // Use workflow report stats for filter counts (G-flow only)
    const statusCounts = useMemo(() => {
        return {
            total: workflowStats.total || 0,
            pending: workflowStats.pending || 0,
            escalated: workflowStats.escalated || 0,
            closed: workflowStats.closed || 0,
            converted_to_fir: workflowStats.fir || 0,
            reopened: 0,
        };
    }, [workflowStats]);

    const selectedHandleData = sources.find(h => h.handle === selectedHandle || h.id === selectedHandle);
    const isReportsMode = activeStatus === 'reports';

    const fromValue = toDateInputValue(dateRange?.from);
    const toValue = toDateInputValue(dateRange?.to);
    const hasDateRange = Boolean(dateRange?.from || dateRange?.to);
    const activeDatePreset = DATE_PRESETS.find((preset) => {
        const range = presetRange(preset.days);
        return fromValue === toDateInputValue(range.from) && toValue === toDateInputValue(range.to);
    })?.key || null;
    const filterTheme = PLATFORM_FILTER_THEME[activePlatform] || PLATFORM_FILTER_THEME.all;

    return (
        <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex flex-col">
            <div className="px-6 py-0">
                {/* ─────────────────────────────────────────────────── */
                /*              SECTION 1: PLATFORM TABS                */
                /* ─────────────────────────────────────────────────── */}
                <div className="flex items-center gap-3 border-b border-slate-100 dark:border-slate-700 overflow-x-auto scrollbar-hide py-1">
                    {PLATFORMS.map((platform) => {
                        const isActive = !isReportsMode && activePlatform === platform.id;
                        const Icon = platform.icon;
                        const platformTheme = PLATFORM_FILTER_THEME[platform.id] || PLATFORM_FILTER_THEME.all;

                        return (
                            <button
                                key={platform.id}
                                onClick={() => {
                                    onPlatformChange?.(platform.id);
                                    if (activeStatus === 'reports') {
                                        onStatusChange?.('total');
                                    }
                                }}
                                className={cn(
                                    'flex items-center gap-3 px-6 py-4 text-base font-semibold transition-all duration-200 relative whitespace-nowrap rounded-lg active:scale-95 active:translate-y-[1px]',
                                    // Base styling
                                    'hover:bg-slate-50 dark:hover:bg-slate-800',
                                    // Active state
                                    isActive
                                        ? 'text-slate-900 dark:text-slate-100 font-semibold'
                                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200',
                                    // Bottom indicator for active
                                    isActive && 'border-b-2'
                                )}
                                style={isActive ? { borderBottomColor: platformTheme.accent } : undefined}
                            >
                                {Icon ? (
                                    <Icon className={cn('h-5 w-5', platform.color)} />
                                ) : (
                                    <Globe className="h-5 w-5 text-slate-600" />
                                )}
                                <span>{platform.label}</span>
                            </button>
                        );
                    })}

                    {canViewReports && (
                        <button
                            type="button"
                            onClick={() => onStatusChange?.('reports')}
                            className={cn(
                                'ml-auto flex items-center gap-3 px-6 py-4 text-base font-semibold transition-all duration-200 relative whitespace-nowrap rounded-lg active:scale-95 active:translate-y-[1px] hover:bg-slate-50 dark:hover:bg-slate-800',
                                activeStatus === 'reports'
                                    ? 'text-slate-900 dark:text-slate-100 font-semibold border-b-2 border-blue-500'
                                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            )}
                        >
                            <BarChart3 className="h-5 w-5 text-blue-600" />
                            <span>Reports</span>
                        </button>
                    )}
                </div>

                {/* ─────────────────────────────────────────────────── */
                /*     SECTION 2: STATUS FILTERS + RIGHT DROPDOWN        */
                /* ─────────────────────────────────────────────────── */}
                {!isReportsMode && <div className="flex items-center justify-between gap-4 py-3">
                    {/* Status Filter Buttons */}
                    <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide flex-1">
                        {visibleStatusFilters.map((status) => {
                            const isActive = activeStatus === status.id;
                            const count = statusCounts[status.key] || 0;

                            return (
                                <button
                                    key={status.id}
                                    onClick={() => onStatusChange?.(status.id)}
                                    className={cn(
                                        'px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap border active:scale-95 active:translate-y-[1px]',
                                        isActive ? 'shadow-sm' : 'hover:bg-slate-50 dark:hover:bg-slate-800 bg-white dark:bg-slate-800',
                                    )}
                                    style={isActive
                                        ? {
                                            backgroundColor: filterTheme.activeBg,
                                            color: filterTheme.activeText,
                                            borderColor: filterTheme.activeBorder,
                                        }
                                        : {
                                            color: filterTheme.inactiveText,
                                            borderColor: filterTheme.inactiveBorder,
                                        }
                                    }
                                >
                                    <span>{status.label}</span>
                                    {count > 0 && (
                                        <span
                                            className="ml-1 text-xs font-semibold"
                                            style={{ color: isActive ? filterTheme.activeText : filterTheme.inactiveText }}
                                        >
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                        {canViewStampedPostFilters && (
                            <>
                                <span className="mx-1 h-5 w-px bg-slate-200 shrink-0" />
                                {[
                                    { id: 'criticism', label: 'Criticism' },
                                    { id: 'suggestion', label: 'Suggestion' },
                                ].map((reportBtn) => {
                                    const isActiveReport = activeStatus === reportBtn.id;
                                    return (
                                        <button
                                            key={reportBtn.id}
                                            onClick={() => onStatusChange?.(reportBtn.id)}
                                            className={cn(
                                                'px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 whitespace-nowrap border active:scale-95 active:translate-y-[1px]',
                                                isActiveReport
                                                    ? 'shadow-sm'
                                                    : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
                                            )}
                                            style={isActiveReport
                                                ? reportBtn.id === 'criticism'
                                                    ? { backgroundColor: '#ffe4e6', color: '#be123c', borderColor: '#fb7185' }
                                                    : { backgroundColor: '#ede9fe', color: '#6d28d9', borderColor: '#a78bfa' }
                                                : undefined
                                            }
                                        >
                                            {reportBtn.label}
                                        </button>
                                    );
                                })}
                            </>
                        )}
                        {visibleStatusFilters.length === 0 && (
                            <span className="px-2 py-1 text-xs text-slate-500">
                                No grievance features assigned
                            </span>
                        )}
                    </div>
                    {/* Sentiment (sentiment service). Pinned right so it stays visible
                        while the status pills scroll; clicking an active pill clears it. */}
                    <div className="flex shrink-0 items-center gap-1 border-l border-slate-200 pl-3 dark:border-slate-700">
                        {SENTIMENT_FILTERS.map((option) => {
                            const isActive = activeSentiment === option.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    title={isActive ? `Clear ${option.label.toLowerCase()} filter` : `Show ${option.label.toLowerCase()} grievances`}
                                    onClick={() => onSentimentChange?.(isActive ? 'all' : option.id)}
                                    className={cn(
                                        'whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 active:scale-95',
                                        option.className,
                                        isActive
                                            ? 'bg-slate-100 shadow-sm dark:bg-slate-700'
                                            : 'bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800'
                                    )}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>


                </div>}
            </div>

            {/* ─────────────────────────────────────────────────── */
            /*     SECTION 3: MONITORED ACCOUNTS + DATE RANGE        */
            /* ─────────────────────────────────────────────────── */}
            {!isReportsMode && (
                <div className="bg-slate-50 dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 px-6 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Account picker: available on every tab, including All. */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className="flex min-w-[220px] max-w-[320px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                >
                                    {selectedHandleData ? (
                                        <>
                                            <Avatar className="h-5 w-5 shrink-0">
                                                <AvatarImage src={selectedHandleData.profile_image_url} />
                                                <AvatarFallback className="bg-slate-100 text-[10px] dark:bg-slate-700">
                                                    {selectedHandleData.display_name?.charAt(0) || selectedHandleData.handle?.charAt(0) || <User className="h-3 w-3" />}
                                                </AvatarFallback>
                                            </Avatar>
                                            <span className="truncate">{selectedHandleData.display_name || selectedHandleData.handle}</span>
                                        </>
                                    ) : (
                                        <span className="truncate text-slate-500 dark:text-slate-400">
                                            All accounts ({platformSources.length})
                                        </span>
                                    )}
                                    <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-400" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="max-h-[420px] w-80 overflow-y-auto">
                                <DropdownMenuLabel className="text-xs text-slate-500">
                                    {platformSources.length} account{platformSources.length === 1 ? '' : 's'} monitored
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => onHandleChange?.(null)} className="cursor-pointer">
                                    <span className="flex-1">All accounts</span>
                                    {!selectedHandle && <Check className="h-4 w-4 text-blue-600" />}
                                </DropdownMenuItem>
                                {platformSources.length > 0 && <DropdownMenuSeparator />}
                                {platformSources.map((source) => (
                                    <DropdownMenuItem
                                        key={source.id || source.handle}
                                        onClick={() => onHandleChange?.(selectedHandle === source.handle ? null : source.handle)}
                                        className="cursor-pointer gap-2"
                                    >
                                        <Avatar className="h-6 w-6 shrink-0 rounded-full border border-slate-100 dark:border-slate-700">
                                            <AvatarImage src={source.profile_image_url} />
                                            <AvatarFallback className="bg-slate-100 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                                                {source.display_name?.charAt(0) || source.handle?.charAt(0) || <User className="h-3 w-3" />}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1 truncate">
                                                <span className="truncate font-medium">{source.display_name || source.handle}</span>
                                                {source.is_verified && <BadgeCheck className="h-3 w-3 shrink-0 text-blue-500" />}
                                            </div>
                                            <p className="truncate text-[11px] text-slate-400">
                                                {source.platform === 'facebook' ? 'Facebook' : `@${String(source.handle || '').replace(/^@/, '')}`}
                                                {source.districts?.length ? ` · ${source.districts.join(', ')}` : ''}
                                            </p>
                                        </div>
                                        {selectedHandle === source.handle && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
                                        {/* stopPropagation so these do not also select the account. */}
                                        <button
                                            type="button"
                                            className="shrink-0 rounded p-1 text-slate-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950/40"
                                            onClick={(e) => { e.stopPropagation(); onFetchSourceHistory?.(source); }}
                                            title="Fetch History"
                                        >
                                            <Calendar className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                            onClick={(e) => { e.stopPropagation(); onRemoveSource?.(source); }}
                                            title="Remove Account"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <button
                            type="button"
                            onClick={onAddSource}
                            className="flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-blue-950/30"
                        >
                            <Plus className="h-4 w-4" />
                            Add New Account
                        </button>

                        {activePlatform === 'facebook' && onDiscoverFacebook && (
                            <button
                                type="button"
                                onClick={onDiscoverFacebook}
                                className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#1877F2]/40 px-3 py-2 text-sm font-medium text-[#1877F2] transition-colors hover:bg-blue-50 dark:hover:bg-blue-950/30"
                            >
                                <FacebookLogo className="h-4 w-4" />
                                Find Facebook Pages
                            </button>
                        )}

                        {/* Date range — filters post_date for the list and the status counts. */}
                        {onDateRangeChange && (
                            <div className="ml-auto flex flex-wrap items-center gap-2">
                                <div className="flex items-center gap-1">
                                    {DATE_PRESETS.map((preset) => (
                                        <button
                                            key={preset.key}
                                            type="button"
                                            onClick={() => onDateRangeChange(activeDatePreset === preset.key ? { from: null, to: null } : presetRange(preset.days))}
                                            className={cn(
                                                'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                                                activeDatePreset === preset.key
                                                    ? 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                                                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                                            )}
                                        >
                                            {preset.label}
                                        </button>
                                    ))}
                                </div>
                                <div className={cn(
                                    'flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 dark:bg-slate-800',
                                    hasDateRange ? 'border-blue-400' : 'border-slate-300 dark:border-slate-600'
                                )}>
                                    <Calendar className="h-4 w-4 shrink-0 text-slate-500" />
                                    {/* Fill one box for a single day, both for a range. */}
                                    <input
                                        type="date"
                                        aria-label="From date"
                                        value={fromValue}
                                        max={toValue || undefined}
                                        onChange={(e) => onDateRangeChange({ from: fromDateInputValue(e.target.value), to: dateRange?.to || null })}
                                        className="bg-transparent text-sm text-slate-700 outline-none dark:text-slate-200"
                                    />
                                    <span className="text-xs text-slate-400">&rarr;</span>
                                    <input
                                        type="date"
                                        aria-label="To date"
                                        value={toValue}
                                        min={fromValue || undefined}
                                        onChange={(e) => onDateRangeChange({ from: dateRange?.from || null, to: fromDateInputValue(e.target.value, true) })}
                                        className="bg-transparent text-sm text-slate-700 outline-none dark:text-slate-200"
                                    />
                                    {hasDateRange && (
                                        <button
                                            type="button"
                                            onClick={() => onDateRangeChange({ from: null, to: null })}
                                            className="rounded-full p-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
                                            title="Clear date filter"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default GrievanceTopNavbar;
