import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import {
    History, ArrowLeft, Search, RefreshCw, CheckCircle2, XCircle, Users, Monitor, FileSpreadsheet
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useRbac } from '../contexts/RbacContext';
import TablePagination from '../components/TablePagination';
import { exportRowsToExcel } from '../lib/excelExport';

const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

// Why an attempt was rejected — stored on the audit entry by authController.
const FAILURE_REASONS = {
    invalid_password: 'Wrong password',
    user_not_found: 'Unknown email',
    account_inactive: 'Account inactive',
    tenant_inactive: 'Tenant inactive'
};

// The backend stores a parsed `device` label (same parser as the single-session
// dialog). This fallback only matters for entries logged before that existed.
const deviceLabel = (entry) => {
    if (entry.device) return entry.device;
    const ua = entry.user_agent;
    if (!ua) return 'Unknown device';

    let browser = 'Unknown browser';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';

    let os = '';
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    return os ? `${browser} on ${os}` : browser;
};

const formatWhen = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
};

const relativeTime = (value) => {
    if (!value) return '';
    const diffMs = Date.now() - new Date(value).getTime();
    if (Number.isNaN(diffMs)) return '';
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
};

const StatCard = ({ icon: Icon, label, value, tone }) => {
    const tones = {
        emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
        rose: 'bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400',
        indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400'
    };
    return (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm p-4 flex items-center gap-4">
            <div className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 ${tones[tone]}`}>
                <Icon size={20} />
            </div>
            <div className="min-w-0">
                <p className="text-2xl font-bold text-gray-900 dark:text-white leading-tight">{value}</p>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
            </div>
        </div>
    );
};

/**
 * Login access history for the tenant, built from the audit trail. Rendered
 * either as its own route (/access-management/login-history[/:userId]) or
 * inline from the Access Management list — see ModulePermissions for why both
 * entry points exist.
 */
const LoginHistory = ({ userId: userIdProp, onBack }) => {
    const { user } = useAuth();
    const { hasFeatureAccess } = useRbac();
    const params = useParams();
    const navigate = useNavigate();

    const lockedUserId = userIdProp || params.userId || '';

    const [entries, setEntries] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const [userFilter, setUserFilter] = useState(lockedUserId || 'all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [days, setDays] = useState('30');
    const [search, setSearch] = useState('');

    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    const goBack = useCallback(() => {
        if (onBack) return onBack();
        navigate('/access-management');
    }, [onBack, navigate]);

    const loadHistory = useCallback(async ({ silent = false } = {}) => {
        try {
            if (silent) setRefreshing(true); else setLoading(true);
            const query = { limit: 500 };
            if (days !== 'all') query.days = days;
            if (userFilter !== 'all') query.user_id = userFilter;
            if (statusFilter !== 'all') query.status = statusFilter;

            const res = await api.get('/rbac/login-history', { params: query });
            setEntries(res.data || []);
        } catch (error) {
            toast.error(error.response?.data?.message || 'Failed to load login history');
            console.error(error);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [days, userFilter, statusFilter]);

    useEffect(() => { loadHistory(); }, [loadHistory]);

    useEffect(() => {
        // Only needed to label the officer dropdown when the page isn't locked to one.
        if (lockedUserId) return;
        api.get('/rbac/users')
            .then(res => setUsers(res.data || []))
            .catch(() => setUsers([]));
    }, [lockedUserId]);

    useEffect(() => { setPage(1); }, [search, userFilter, statusFilter, days, pageSize]);

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return entries;
        return entries.filter(e =>
            (e.user_name || '').toLowerCase().includes(term) ||
            (e.user_email || '').toLowerCase().includes(term) ||
            (e.ip || '').toLowerCase().includes(term)
        );
    }, [entries, search]);

    const stats = useMemo(() => {
        const success = filtered.filter(e => e.status === 'success').length;
        return {
            success,
            failed: filtered.length - success,
            uniqueUsers: new Set(filtered.map(e => e.user_email)).size
        };
    }, [filtered]);

    const pageRows = useMemo(
        () => filtered.slice((page - 1) * pageSize, page * pageSize),
        [filtered, page, pageSize]
    );

    const lockedUserName = lockedUserId ? entries[0]?.user_name : null;

    // Exports every entry matching the current filters and search, not just the
    // visible page. The raw user agent is kept as its own column — the parsed
    // "Chrome on Windows" label is for reading, the raw string for auditing.
    const handleExportExcel = () => {
        if (filtered.length === 0) {
            toast.error('No login activity to export.');
            return;
        }

        try {
            exportRowsToExcel({
                rows: filtered.map(entry => ({
                    'Date & Time': formatWhen(entry.timestamp),
                    'Officer': entry.user_name || 'Unknown user',
                    'Email': entry.user_email || '',
                    'Status': entry.status === 'success' ? 'Success' : 'Failed',
                    'Reason': entry.status === 'failed'
                        ? (FAILURE_REASONS[entry.reason] || entry.reason || '')
                        : '',
                    'IP Address': entry.ip || '',
                    'Device': deviceLabel(entry),
                    'User Agent': entry.user_agent || ''
                })),
                sheetName: 'Login History',
                fileName: lockedUserId ? 'login_history_officer' : 'login_history'
            });
            toast.success(`Exported ${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'} to Excel.`);
        } catch (error) {
            console.error('Excel Export Error:', error);
            toast.error('Could not generate the Excel file.');
        }
    };

    // Admins always have access; officers need the Access Management tab granted.
    if (user?.role !== 'admin' && !hasFeatureAccess('/settings', 'access_management_tab_access')) {
        return <Navigate to="/dashboard" replace />;
    }

    return (
        <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="mb-4 lg:mb-6">
                <button
                    onClick={goBack}
                    className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-3 transition-colors"
                >
                    <ArrowLeft size={16} />
                    Back to Officers
                </button>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-lg">
                            <History className="text-indigo-600" size={24} />
                        </div>
                        <div>
                            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Login Access History</h1>
                            <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">
                                {lockedUserId
                                    ? `Sign-in activity for ${lockedUserName || 'this officer'}`
                                    : 'Successful and failed sign-in attempts across your tenant'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleExportExcel}
                            disabled={loading || filtered.length === 0}
                            className="flex items-center gap-2 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <FileSpreadsheet size={15} />
                            Export Excel
                        </button>
                        <button
                            onClick={() => loadHistory({ silent: true })}
                            disabled={refreshing}
                            className="flex items-center gap-2 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                        >
                            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
                            Refresh
                        </button>
                    </div>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 lg:mb-6">
                <StatCard icon={CheckCircle2} label="Successful Logins" value={stats.success} tone="emerald" />
                <StatCard icon={XCircle} label="Failed Attempts" value={stats.failed} tone="rose" />
                <StatCard icon={Users} label="Unique Officers" value={stats.uniqueUsers} tone="indigo" />
            </div>

            {/* Table Card */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                        <History size={18} className="text-gray-400" />
                        Activity
                        <span className="text-sm font-normal text-gray-400">({filtered.length})</span>
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search officer or IP..."
                                className="w-full sm:w-56 pl-9 pr-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            />
                        </div>
                        {!lockedUserId && (
                            <select
                                value={userFilter}
                                onChange={(e) => setUserFilter(e.target.value)}
                                className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer max-w-[200px]"
                            >
                                <option value="all">All Officers</option>
                                {users.map(u => (
                                    <option key={u.id} value={u.id}>{u.full_name}</option>
                                ))}
                            </select>
                        )}
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="all">All Status</option>
                            <option value="success">Successful</option>
                            <option value="failed">Failed</option>
                        </select>
                        <select
                            value={days}
                            onChange={(e) => setDays(e.target.value)}
                            className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="7">Last 7 days</option>
                            <option value="30">Last 30 days</option>
                            <option value="90">Last 90 days</option>
                            <option value="all">All time</option>
                        </select>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent"></div>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                        <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
                            <History size={28} className="text-gray-400" />
                        </div>
                        <h3 className="text-gray-700 dark:text-gray-300 font-medium mb-1">No Login Activity</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
                            No sign-in attempts match the current filters. Activity is recorded from the moment an officer logs in.
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[760px]">
                                <thead>
                                    <tr className="bg-gray-50/70 dark:bg-slate-800/70 border-b border-gray-200 dark:border-slate-700">
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Officer</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">IP Address</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Device</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">When</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                                    {pageRows.map(entry => (
                                        <tr key={entry.id} className="hover:bg-gray-50/60 dark:hover:bg-slate-800/60 transition-colors">
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                                                        {getInitials(entry.user_name)}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{entry.user_name || 'Unknown user'}</p>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{entry.user_email}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border ${entry.status === 'success'
                                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
                                                    : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'
                                                    }`}>
                                                    {entry.status === 'success' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                                                    {entry.status === 'success' ? 'Success' : 'Failed'}
                                                </span>
                                                {entry.status === 'failed' && entry.reason && (
                                                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                                                        {FAILURE_REASONS[entry.reason] || entry.reason}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">{entry.ip || '—'}</span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400" title={entry.user_agent || ''}>
                                                    <Monitor size={14} className="text-gray-400" />
                                                    {deviceLabel(entry)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <p className="text-sm text-gray-700 dark:text-gray-300">{formatWhen(entry.timestamp)}</p>
                                                <p className="text-xs text-gray-400">{relativeTime(entry.timestamp)}</p>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <TablePagination
                            page={page}
                            pageSize={pageSize}
                            totalItems={filtered.length}
                            onPageChange={setPage}
                            onPageSizeChange={setPageSize}
                            label="entries"
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default LoginHistory;
