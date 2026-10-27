import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
    ShieldCheck, Users, Crown, Plus, X, UserPlus, Edit2, Trash2, ArrowLeft, Calendar, Hash,
    Search, SlidersHorizontal, UserCheck, UserX, Power, History, Check, FileSpreadsheet,
    ChevronDown, ChevronRight
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useTenant } from '../context/TenantContext';
import DistrictMultiSelect from '../components/DistrictMultiSelect';
import { useRbac } from '../contexts/RbacContext';
import { useScopedLocation } from '../hooks/useScopedLocation';
import ModulePermissions from './ModulePermissions';
import LoginHistory from './LoginHistory';
import TablePagination from '../components/TablePagination';
import { exportRowsToExcel } from '../lib/excelExport';

// role value -> display label. 'level-1' stays as the underlying role value
// (route-level authorize() checks elsewhere still key off it) — only the label
// shown to admins changed to "Officer".
const ROLE_LABELS = { admin: 'Admin', 'level-1': 'Officer' };
const roleLabel = (role) => ROLE_LABELS[role] || role;

// Monitoring volume limits. Kept in sync with backend utils/monitoringLimits.js
// DEFAULT_LIMITS. The form PRE-FILLS these defaults so the admin always sees the
// concrete number in effect (rather than a blank box); they can override any
// field. Clearing a field back to blank still falls back to the default on save.
const LIMIT_DEFAULTS = { platform: 100, events: 10, keywords: 50 };
const LIMIT_PLATFORMS = [
    { key: 'x', label: 'X (Twitter)', badge: 'X', badgeCls: 'bg-gray-900 text-white' },
    { key: 'instagram', label: 'Instagram', badge: 'IG', badgeCls: 'bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600 text-white text-[9px]' },
    { key: 'facebook', label: 'Facebook', badge: 'f', badgeCls: 'bg-blue-600 text-white' },
    { key: 'youtube', label: 'YouTube', badge: '▶', badgeCls: 'bg-red-600 text-white text-[9px]' },
];

// A fresh monitoring_limits form object PRE-FILLED with the system defaults, so
// new officers show 100/100/100/100 profiles, 10 events, 50 keywords by default.
const emptyLimits = () => ({
    per_platform: {
        x: String(LIMIT_DEFAULTS.platform),
        instagram: String(LIMIT_DEFAULTS.platform),
        facebook: String(LIMIT_DEFAULTS.platform),
        youtube: String(LIMIT_DEFAULTS.platform),
    },
    max_active_events: String(LIMIT_DEFAULTS.events),
    max_keywords_per_event: String(LIMIT_DEFAULTS.keywords),
});

// Convert a stored monitoring_limits doc (or null) into the form shape. A field
// the admin never set (null/undefined) shows its system default; an explicitly
// stored value (including 0) is preserved exactly.
const limitsToForm = (ml) => {
    if (!ml || typeof ml !== 'object') return emptyLimits();
    const pp = ml.per_platform || {};
    const s = (v, def) => (v === null || v === undefined ? String(def) : String(v));
    return {
        per_platform: {
            x: s(pp.x, LIMIT_DEFAULTS.platform),
            instagram: s(pp.instagram, LIMIT_DEFAULTS.platform),
            facebook: s(pp.facebook, LIMIT_DEFAULTS.platform),
            youtube: s(pp.youtube, LIMIT_DEFAULTS.platform),
        },
        max_active_events: s(ml.max_active_events, LIMIT_DEFAULTS.events),
        max_keywords_per_event: s(ml.max_keywords_per_event, LIMIT_DEFAULTS.keywords),
    };
};

// The "Monitoring Volume Configuration" fields, reused by the Create and Edit
// officer modals. Only rendered for District Officers (role 'level-1'). `form`
// is the parent modal's form object; `setForm` its setter.
const MonitoringLimitsFields = ({ form, setForm }) => {
    const ml = form.monitoring_limits || emptyLimits();
    const setPlatform = (key, value) => {
        const clean = value.replace(/[^0-9]/g, '');
        setForm((prev) => ({
            ...prev,
            monitoring_limits: {
                ...(prev.monitoring_limits || emptyLimits()),
                per_platform: { ...((prev.monitoring_limits || emptyLimits()).per_platform), [key]: clean },
            },
        }));
    };
    const setField = (field, value) => {
        const clean = value.replace(/[^0-9]/g, '');
        setForm((prev) => ({
            ...prev,
            monitoring_limits: { ...(prev.monitoring_limits || emptyLimits()), [field]: clean },
        }));
    };
    const numInput = 'w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-sm text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition';
    const badge = (cls, content) => (
        <span className={`w-6 h-6 shrink-0 rounded-lg flex items-center justify-center text-[11px] font-bold leading-none ${cls}`}>{content}</span>
    );
    const sectionLabel = 'text-[11px] font-semibold uppercase tracking-wider text-gray-400';

    return (
        <div className="mt-6 pt-6 border-t border-gray-200 dark:border-slate-700">
            <h4 className="text-base font-semibold text-gray-900 dark:text-white">Monitoring Volume Configuration</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-5">
                Caps how much this officer can actively monitor (rations the shared API quota). Officers may add unlimited profiles and events, but only the numbers below can be <span className="font-medium text-gray-700 dark:text-gray-300">active</span> at once. Defaults are pre-filled — adjust as needed.
            </p>

            {/* ── Profile limits ── */}
            <p className={`${sectionLabel} mb-3`}>Profile Limits <span className="normal-case font-normal text-gray-400">— active profiles per platform</span></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                {LIMIT_PLATFORMS.map((p) => (
                    <div key={p.key}>
                        <div className="flex items-center gap-2 mb-1.5">
                            {badge(p.badgeCls, p.badge)}
                            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{p.label}</span>
                        </div>
                        <input
                            type="number" min="0" inputMode="numeric"
                            value={ml.per_platform?.[p.key] ?? ''}
                            onChange={(e) => setPlatform(p.key, e.target.value)}
                            placeholder={`Default ${LIMIT_DEFAULTS.platform}`}
                            className={numInput}
                        />
                    </div>
                ))}
            </div>

            {/* ── Event limits ── */}
            <p className={`${sectionLabel} mt-6 mb-3`}>Event Limits <span className="normal-case font-normal text-gray-400">— manual events only</span></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                <div>
                    <div className="flex items-center gap-2 mb-1.5">
                        {badge('bg-violet-100 text-violet-600', <Calendar className="w-3.5 h-3.5" />)}
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Active manual events</span>
                    </div>
                    <input
                        type="number" min="0" inputMode="numeric"
                        value={ml.max_active_events ?? ''}
                        onChange={(e) => setField('max_active_events', e.target.value)}
                        placeholder={`Default ${LIMIT_DEFAULTS.events}`}
                        className={numInput}
                    />
                </div>
                <div>
                    <div className="flex items-center gap-2 mb-1.5">
                        {badge('bg-emerald-100 text-emerald-600', <Hash className="w-3.5 h-3.5" />)}
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Keywords per event</span>
                    </div>
                    <input
                        type="number" min="0" inputMode="numeric"
                        value={ml.max_keywords_per_event ?? ''}
                        onChange={(e) => setField('max_keywords_per_event', e.target.value)}
                        placeholder={`Default ${LIMIT_DEFAULTS.keywords}`}
                        className={numInput}
                    />
                </div>
            </div>
        </div>
    );
};

// Read-only summary of an officer's EFFECTIVE monitoring limits, shown in the
// expanded row so the admin sees the defined caps at a glance without opening
// the edit modal. Unset fields fall back to the system default and are shown
// greyed; custom (admin-set) values are highlighted.
const MonitoringLimitsSummary = ({ user }) => {
    const ml = (user && user.monitoring_limits) || {};
    const pp = ml.per_platform || {};
    const eff = (stored, def) => {
        const v = (stored === null || stored === undefined || stored === '') ? null : Number(stored);
        // Treat an unset field OR one explicitly equal to the system default as
        // "default" (shown grey); only a value that differs is a custom cap.
        if (v === null || v === def) return { value: def, isDefault: true };
        return { value: v, isDefault: false };
    };
    const rows = [
        ...LIMIT_PLATFORMS.map((p) => ({ label: p.label, ...eff(pp[p.key], LIMIT_DEFAULTS.platform) })),
        { label: 'Active events', ...eff(ml.max_active_events, LIMIT_DEFAULTS.events) },
        { label: 'Keywords / event', ...eff(ml.max_keywords_per_event, LIMIT_DEFAULTS.keywords) },
    ];
    return (
        <div>
            <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">Monitoring Limits</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                {rows.map((r) => (
                    <div key={r.label} className="flex justify-between gap-2">
                        <span className="text-gray-500 dark:text-gray-400 truncate">{r.label}</span>
                        <span className={r.isDefault ? 'text-gray-400 dark:text-gray-500' : 'font-semibold text-indigo-600 dark:text-indigo-400'}>{r.value}</span>
                    </div>
                ))}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5">
                Grey = default · <span className="text-indigo-600 dark:text-indigo-400 font-medium">colour</span> = custom
            </p>
        </div>
    );
};

const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

// is_active is only absent on legacy docs created before the flag existed —
// treat those as active.
const isUserActive = (u) => u?.is_active !== false;

// last_login comes from the audit trail, so officers created before their first
// sign-in (or before login auditing) simply have none.
const formatLastLogin = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
};

const StatCard = ({ icon: Icon, label, value, tone }) => {
    const tones = {
        indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400',
        emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
        rose: 'bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400'
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

const AccessManagement = () => {
    const { user } = useAuth();
    const { hasFeatureAccess } = useRbac();
    const { districts: tenantDistricts, state: tenantState } = useTenant();
    const { districtOptions: ownScopedDistricts } = useScopedLocation();
    const location = useLocation();
    const navigate = useNavigate();

    // Non-admins who reach this page via a granted `access_management_tab_access`
    // permission must only be able to assign users to their OWN district(s), not
    // every district in the tenant — true admins keep the full tenant list.
    const isAdmin = user?.role === 'admin';
    const assignableDistricts = isAdmin ? tenantDistricts : ownScopedDistricts;

    const canAddUser = hasFeatureAccess('/settings', 'add_user');
    const canEditUser = hasFeatureAccess('/settings', 'edit_user');
    const canDeleteUser = hasFeatureAccess('/settings', 'delete_user');
    const canAssignPermissions = hasFeatureAccess('/settings', 'assign_permissions');

    // State
    const [users, setUsers] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [roleFilter, setRoleFilter] = useState('all');
    const [districtFilter, setDistrictFilter] = useState('all');
    const [togglingId, setTogglingId] = useState(null);
    const [expandedId, setExpandedId] = useState(null);

    // Selection + pagination
    const [selectedIds, setSelectedIds] = useState([]);
    const [bulkDeleting, setBulkDeleting] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    // When set, the Module Permissions / Login History screen replaces this list.
    // Kept as local state (not a route push) so it also works inside the
    // Settings > Access Management tab, where navigating away would drop the
    // user out of Settings.
    const [view, setView] = useState({ type: 'list', userId: null });

    // Create User Modal State
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newUserForm, setNewUserForm] = useState({
        full_name: '',
        email: '',
        password: '',
        role: 'level-1',
        districts: [],
        monitoring_limits: emptyLimits()
    });
    const [creatingUser, setCreatingUser] = useState(false);

    // Edit User Modal State
    const [editingUser, setEditingUser] = useState(null);
    const [editUserForm, setEditUserForm] = useState({
        full_name: '',
        email: '',
        password: '',
        role: 'level-1',
        districts: [],
        monitoring_limits: emptyLimits()
    });
    const [updatingUser, setUpdatingUser] = useState(false);
    const [deletingId, setDeletingId] = useState(null);

    const fetchUsers = useCallback(async () => {
        const usersRes = await api.get('/rbac/users');
        setUsers(usersRes.data);
        return usersRes.data;
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                setLoadingUsers(true);
                await fetchUsers();
            } catch (error) {
                toast.error('Failed to load officers');
                console.error(error);
            } finally {
                setLoadingUsers(false);
            }
        };
        load();
    }, [fetchUsers]);

    const stats = useMemo(() => {
        const active = users.filter(isUserActive).length;
        return { total: users.length, active, inactive: users.length - active };
    }, [users]);

    const filteredUsers = useMemo(() => {
        const term = search.trim().toLowerCase();
        return users.filter(u => {
            if (statusFilter === 'active' && !isUserActive(u)) return false;
            if (statusFilter === 'inactive' && isUserActive(u)) return false;
            if (roleFilter === 'admin' && u.role !== 'admin') return false;
            if (roleFilter === 'officer' && u.role === 'admin') return false;
            if (districtFilter !== 'all' && !(u.districts || []).includes(districtFilter)) return false;
            if (!term) return true;
            return (
                (u.full_name || '').toLowerCase().includes(term) ||
                (u.email || '').toLowerCase().includes(term) ||
                (u.districts || []).some(d => d.toLowerCase().includes(term))
            );
        });
    }, [users, search, statusFilter, roleFilter, districtFilter]);

    // Filters changing can shrink the list below the current page.
    useEffect(() => { setPage(1); }, [search, statusFilter, roleFilter, districtFilter, pageSize]);

    const pageUsers = useMemo(
        () => filteredUsers.slice((page - 1) * pageSize, page * pageSize),
        [filteredUsers, page, pageSize]
    );

    // Admin accounts and your own account are never bulk-deletable — the backend
    // enforces the same rules and reports them back as `skipped`.
    const isSelectable = useCallback(
        (u) => canDeleteUser && u.role !== 'admin' && u.id !== user?.id,
        [canDeleteUser, user]
    );

    const selectablePageUsers = useMemo(
        () => pageUsers.filter(isSelectable),
        [pageUsers, isSelectable]
    );

    const allPageSelected = selectablePageUsers.length > 0 &&
        selectablePageUsers.every(u => selectedIds.includes(u.id));

    const toggleSelect = (id) => {
        setSelectedIds(prev => (
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        ));
    };

    const toggleSelectPage = () => {
        const pageIds = selectablePageUsers.map(u => u.id);
        setSelectedIds(prev => (
            allPageSelected
                ? prev.filter(id => !pageIds.includes(id))
                : [...new Set([...prev, ...pageIds])]
        ));
    };

    const handleCreateUser = async (e) => {
        e.preventDefault();
        if (newUserForm.role !== 'admin' && newUserForm.districts.length === 0) {
            toast.error('Select at least one district for this role.');
            return;
        }
        try {
            setCreatingUser(true);
            const payload = { ...newUserForm, state: tenantState };
            await api.post('/rbac/users', payload);

            toast.success(`User ${newUserForm.full_name} created successfully!`);
            await fetchUsers();

            setShowCreateModal(false);
            setNewUserForm({
                full_name: '',
                email: '',
                password: '',
                role: 'level-1',
                districts: [],
                monitoring_limits: emptyLimits()
            });
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to create user. Email may already exist.';
            toast.error(msg);
        } finally {
            setCreatingUser(false);
        }
    };

    const handleEditUserClick = (target) => {
        setEditUserForm({
            full_name: target.full_name,
            email: target.email,
            password: '', // Blank password means don't change it
            role: target.role,
            districts: target.districts || [],
            monitoring_limits: limitsToForm(target.monitoring_limits)
        });
        setEditingUser(target);
    };

    const handleUpdateUser = async (e) => {
        e.preventDefault();
        if (!editingUser) return;
        if (editUserForm.role !== 'admin' && editUserForm.districts.length === 0) {
            toast.error('Select at least one district for this role.');
            return;
        }

        try {
            setUpdatingUser(true);
            const payload = { ...editUserForm, state: tenantState };
            // If password is empty, remove it from the payload
            if (!payload.password) {
                delete payload.password;
            }

            const updRes = await api.put(`/rbac/users/${editingUser.id}`, payload);
            toast.success('User updated successfully!');
            // Surface auto-pause reconciliation so it's never silent.
            const rec = updRes.data?.reconciled;
            const paused = (rec?.paused_profiles || 0) + (rec?.paused_events || 0);
            if (paused > 0) {
                toast.info(`Paused ${rec.paused_profiles || 0} profile(s) and ${rec.paused_events || 0} event(s) to fit the new limits.`);
            }

            await fetchUsers();
            setEditingUser(null);
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to update user.';
            toast.error(msg);
        } finally {
            setUpdatingUser(false);
        }
    };

    const handleToggleStatus = async (target) => {
        const nextActive = !isUserActive(target);
        if (!nextActive && !window.confirm(`Deactivate ${target.full_name}? They will not be able to log in.`)) {
            return;
        }

        try {
            setTogglingId(target.id);
            await api.patch(`/rbac/users/${target.id}/status`, { is_active: nextActive });
            setUsers(prev => prev.map(u => (u.id === target.id ? { ...u, is_active: nextActive } : u)));
            toast.success(`${target.full_name} ${nextActive ? 'activated' : 'deactivated'}.`);
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to update officer status.';
            toast.error(msg);
        } finally {
            setTogglingId(null);
        }
    };

    const handleDeleteUser = async (target) => {
        // Prevent self-deletion
        if (target.id === user?.id) {
            toast.error("You cannot delete your own account.");
            return;
        }

        if (!window.confirm(`Are you sure you want to delete ${target.full_name}? This action cannot be undone.`)) {
            return;
        }

        try {
            setDeletingId(target.id);
            await api.delete(`/rbac/users/${target.id}`);
            toast.success('Officer deleted successfully.');
            setSelectedIds(prev => prev.filter(id => id !== target.id));
            await fetchUsers();
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to delete officer.';
            toast.error(msg);
        } finally {
            setDeletingId(null);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedIds.length === 0) return;
        if (!window.confirm(`Delete ${selectedIds.length} selected officer(s)? This action cannot be undone.`)) {
            return;
        }

        try {
            setBulkDeleting(true);
            const res = await api.post('/rbac/users/bulk-delete', { user_ids: selectedIds });
            const { deleted_count = 0, skipped = [] } = res.data || {};

            if (deleted_count > 0) {
                toast.success(`${deleted_count} officer(s) deleted.`);
            }
            if (skipped.length > 0) {
                toast.warning(`${skipped.length} skipped — ${skipped[0].reason}`);
            }

            setSelectedIds([]);
            await fetchUsers();
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to delete officers.';
            toast.error(msg);
        } finally {
            setBulkDeleting(false);
        }
    };

    // Exports everything the current search/filters match — not just the page
    // on screen — so the sheet matches what the header count says.
    const handleExportExcel = () => {
        if (filteredUsers.length === 0) {
            toast.error('No officers to export.');
            return;
        }

        try {
            exportRowsToExcel({
                rows: filteredUsers.map(u => ({
                    'Full Name': u.full_name || '',
                    'Email': u.email || '',
                    'Role': roleLabel(u.role),
                    'State': u.state || '',
                    'Districts': (u.districts || []).join(', '),
                    'Status': isUserActive(u) ? 'Active' : 'Inactive',
                    'Last Login': formatLastLogin(u.last_login) || 'Never'
                })),
                sheetName: 'Officers',
                fileName: 'access_management_officers'
            });
            toast.success(`Exported ${filteredUsers.length} officer(s) to Excel.`);
        } catch (error) {
            console.error('Excel Export Error:', error);
            toast.error('Could not generate the Excel file.');
        }
    };

    // Admins always have access; officers need the Access Management tab granted.
    if (!isAdmin && !hasFeatureAccess('/settings', 'access_management_tab_access')) {
        return <Navigate to="/dashboard" replace />;
    }

    // Permissions and history live on their own screens — the list is replaced entirely.
    if (view.type === 'permissions') {
        return (
            <ModulePermissions
                userId={view.userId}
                onBack={() => setView({ type: 'list', userId: null })}
            />
        );
    }
    if (view.type === 'history') {
        return (
            <LoginHistory
                userId={view.userId}
                onBack={() => setView({ type: 'list', userId: null })}
            />
        );
    }

    const districtOptions = [...new Set(users.flatMap(u => u.districts || []))].sort();

    return (
        <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="mb-4 lg:mb-6 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    {location.state?.fromTools && (
                        <button onClick={() => navigate('/analysis-tools')} className="w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex items-center justify-center text-gray-500 hover:text-indigo-600 hover:border-indigo-400 transition-colors shrink-0">
                            <ArrowLeft className="w-4 h-4" />
                        </button>
                    )}
                    <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-lg">
                        <ShieldCheck className="text-indigo-600" size={24} />
                    </div>
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Access Management</h1>
                        <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Manage officers and their page and feature-level permissions</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        onClick={handleExportExcel}
                        disabled={filteredUsers.length === 0}
                        className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <FileSpreadsheet size={16} />
                        Export Excel
                    </button>
                    <button
                        onClick={() => setView({ type: 'history', userId: null })}
                        className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors text-sm font-medium"
                    >
                        <History size={16} />
                        Login History
                    </button>
                    {canAddUser && (
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium shadow-sm"
                        >
                            <Plus size={16} />
                            Add Officer
                        </button>
                    )}
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 lg:mb-6">
                <StatCard icon={Users} label="Total Officers" value={stats.total} tone="indigo" />
                <StatCard icon={UserCheck} label="Active" value={stats.active} tone="emerald" />
                <StatCard icon={UserX} label="Inactive" value={stats.inactive} tone="rose" />
            </div>

            {/* Officers Card */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                {/* Toolbar */}
                <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                        <Users size={18} className="text-gray-400" />
                        Officers
                        <span className="text-sm font-normal text-gray-400">({filteredUsers.length})</span>
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search name, email or district..."
                                className="w-full sm:w-64 pl-9 pr-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            />
                        </div>
                        <select
                            value={roleFilter}
                            onChange={(e) => setRoleFilter(e.target.value)}
                            className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="all">All Roles</option>
                            <option value="admin">Admin</option>
                            <option value="officer">Officer</option>
                        </select>
                        {districtOptions.length > 0 && (
                            <select
                                value={districtFilter}
                                onChange={(e) => setDistrictFilter(e.target.value)}
                                className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer max-w-[180px]"
                            >
                                <option value="all">All Districts</option>
                                {districtOptions.map(d => (
                                    <option key={d} value={d}>{d}</option>
                                ))}
                            </select>
                        )}
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="all">All Status</option>
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                        </select>
                    </div>
                </div>

                {/* Bulk Action Bar */}
                {selectedIds.length > 0 && (
                    <div className="px-4 py-3 bg-indigo-50/60 dark:bg-indigo-950/40 border-b border-indigo-100 dark:border-indigo-900 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-medium text-indigo-900 dark:text-indigo-200">
                            {selectedIds.length} officer{selectedIds.length > 1 ? 's' : ''} selected
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setSelectedIds([])}
                                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-md transition-colors"
                            >
                                Clear Selection
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                disabled={bulkDeleting}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Trash2 size={14} />
                                {bulkDeleting ? 'Deleting...' : 'Delete Selected'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Table */}
                {loadingUsers ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent"></div>
                    </div>
                ) : filteredUsers.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                        <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
                            <Users size={28} className="text-gray-400" />
                        </div>
                        <h3 className="text-gray-700 dark:text-gray-300 font-medium mb-1">No Officers Found</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
                            {users.length === 0
                                ? 'Create your first officer to start assigning permissions.'
                                : 'No officers match the current search or filters.'}
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[900px]">
                                <thead>
                                    <tr className="bg-gray-50/70 dark:bg-slate-800/70 border-b border-gray-200 dark:border-slate-700">
                                        {canDeleteUser && (
                                            <th className="w-10 px-4 py-3">
                                                <button
                                                    onClick={toggleSelectPage}
                                                    disabled={selectablePageUsers.length === 0}
                                                    title="Select all on this page"
                                                    className={`w-4 h-4 rounded border flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${allPageSelected
                                                        ? 'bg-indigo-600 border-indigo-600 text-white'
                                                        : 'bg-white dark:bg-slate-900 border-gray-300 dark:border-slate-600 hover:border-indigo-400'
                                                        }`}
                                                >
                                                    {allPageSelected && <Check size={11} />}
                                                </button>
                                            </th>
                                        )}
                                        <th className="w-8 px-2 py-3"></th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Officer</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Role</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Districts</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
                                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Last Login</th>
                                        <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                                    {pageUsers.map(u => {
                                        const active = isUserActive(u);
                                        const isSelf = u.id === user?.id;
                                        const isTargetAdmin = u.role === 'admin';
                                        // Officers acting through a grant can never touch an admin
                                        // account or their own — the backend enforces both.
                                        const officerBlocked = !isAdmin && (isTargetAdmin || isSelf);
                                        const canEditThis = canEditUser && !officerBlocked;
                                        const canToggleThis = canEditUser && !isSelf && !(!isAdmin && isTargetAdmin);
                                        const canDeleteThis = canDeleteUser && !isTargetAdmin && !isSelf;
                                        const canPermsThis = canAssignPermissions && !isTargetAdmin && !(!isAdmin && isSelf);
                                        const selected = selectedIds.includes(u.id);
                                        const lastLogin = formatLastLogin(u.last_login);
                                        const expanded = expandedId === u.id;

                                        return (
                                            <React.Fragment key={u.id}>
                                                <tr className={`transition-colors ${selected ? 'bg-indigo-50/40 dark:bg-indigo-950/20' : 'hover:bg-gray-50/60 dark:hover:bg-slate-800/60'}`}>
                                                    {canDeleteUser && (
                                                        <td className="px-4 py-3">
                                                            <button
                                                                onClick={() => toggleSelect(u.id)}
                                                                disabled={!isSelectable(u)}
                                                                title={isSelectable(u) ? 'Select officer' : 'This account cannot be bulk deleted'}
                                                                className={`w-4 h-4 rounded border flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${selected
                                                                    ? 'bg-indigo-600 border-indigo-600 text-white'
                                                                    : 'bg-white dark:bg-slate-900 border-gray-300 dark:border-slate-600 hover:border-indigo-400'
                                                                    }`}
                                                            >
                                                                {selected && <Check size={11} />}
                                                            </button>
                                                        </td>
                                                    )}
                                                    <td className="px-2 py-3">
                                                        <button
                                                            onClick={() => setExpandedId(expanded ? null : u.id)}
                                                            title={expanded ? 'Hide details' : 'Show monitoring limits'}
                                                            className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
                                                        >
                                                            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                                        </button>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                                                                {getInitials(u.full_name)}
                                                            </div>
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                                                                    {u.full_name}
                                                                    {isSelf && <span className="ml-2 text-xs font-normal text-gray-400">(You)</span>}
                                                                </p>
                                                                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{u.email}</p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-md border ${isTargetAdmin
                                                            ? 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800'
                                                            : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-slate-800 dark:text-gray-300 dark:border-slate-600'
                                                            }`}>
                                                            {isTargetAdmin && <Crown size={12} className="mr-1" />}
                                                            {roleLabel(u.role)}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {isTargetAdmin ? (
                                                            <span className="text-xs text-gray-400">All districts</span>
                                                        ) : (u.districts || []).length > 0 ? (
                                                            <span className="text-sm text-gray-600 dark:text-gray-300" title={u.districts.join(', ')}>
                                                                {u.districts.slice(0, 2).join(', ')}
                                                                {u.districts.length > 2 && (
                                                                    <span className="text-gray-400"> +{u.districts.length - 2}</span>
                                                                )}
                                                            </span>
                                                        ) : (
                                                            <span className="text-sm text-gray-400">—</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md border ${active
                                                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
                                                            : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'
                                                            }`}>
                                                            <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                                                            {active ? 'Active' : 'Inactive'}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {lastLogin ? (
                                                            <span className="text-sm text-gray-600 dark:text-gray-300">{lastLogin}</span>
                                                        ) : (
                                                            <span className="text-sm text-gray-400">Never</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center justify-end gap-1.5">
                                                            {canPermsThis && (
                                                                <button
                                                                    onClick={() => setView({ type: 'permissions', userId: u.id })}
                                                                    title="Module permissions"
                                                                    className="flex items-center gap-1.5 px-2.5 py-1.5 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 rounded-md text-xs font-medium hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                                                >
                                                                    <SlidersHorizontal size={14} />
                                                                    Permissions
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => setView({ type: 'history', userId: u.id })}
                                                                title="Login history"
                                                                className="p-1.5 border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                                            >
                                                                <History size={14} />
                                                            </button>
                                                            {canToggleThis && (
                                                                <button
                                                                    onClick={() => handleToggleStatus(u)}
                                                                    disabled={togglingId === u.id}
                                                                    title={active ? 'Deactivate officer' : 'Activate officer'}
                                                                    className={`p-1.5 border rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${active
                                                                        ? 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800'
                                                                        : 'border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950'
                                                                        }`}
                                                                >
                                                                    <Power size={14} />
                                                                </button>
                                                            )}
                                                            {canEditThis && (
                                                                <button
                                                                    onClick={() => handleEditUserClick(u)}
                                                                    title="Edit officer"
                                                                    className="p-1.5 border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                                                >
                                                                    <Edit2 size={14} />
                                                                </button>
                                                            )}
                                                            {canDeleteThis && (
                                                                <button
                                                                    onClick={() => handleDeleteUser(u)}
                                                                    disabled={deletingId === u.id}
                                                                    title="Delete officer"
                                                                    className="p-1.5 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-950 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                >
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>

                                                {/* Expanded details — monitoring caps and provenance, which
                                                    used to live in the selected-officer side panel. */}
                                                {expanded && (
                                                    <tr className="bg-gray-50/60 dark:bg-slate-800/40">
                                                        <td colSpan={canDeleteUser ? 8 : 7} className="px-6 py-4">
                                                            <div className="flex flex-col gap-3">
                                                                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                                                                    {u.state && <span>State: <span className="text-gray-700 dark:text-gray-300 font-medium">{u.state}</span></span>}
                                                                    {(u.districts || []).length > 0 && (
                                                                        <span>Districts: <span className="text-gray-700 dark:text-gray-300 font-medium">{u.districts.join(', ')}</span></span>
                                                                    )}
                                                                    {u.created_by && (
                                                                        <span>Added by <span className="text-gray-700 dark:text-gray-300 font-medium">{users.find(x => x.id === u.created_by)?.full_name || 'a former officer'}</span></span>
                                                                    )}
                                                                </div>
                                                                {!isTargetAdmin && <MonitoringLimitsSummary user={u} />}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <TablePagination
                            page={page}
                            pageSize={pageSize}
                            totalItems={filteredUsers.length}
                            onPageChange={setPage}
                            onPageSizeChange={setPageSize}
                            label="officers"
                        />
                    </>
                )}
            </div>

            {/* Create User Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-xl max-w-2xl w-full shadow-xl animate-in fade-in zoom-in duration-200">
                        <div className="p-6 max-h-[88vh] overflow-y-auto">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-lg">
                                        <UserPlus size={20} className="text-indigo-600 dark:text-indigo-400" />
                                    </div>
                                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Create New Officer</h2>
                                </div>
                                <button
                                    onClick={() => setShowCreateModal(false)}
                                    className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                >
                                    <X size={18} className="text-gray-500 dark:text-gray-400" />
                                </button>
                            </div>

                            <form onSubmit={handleCreateUser} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name</label>
                                    <input
                                        type="text"
                                        required
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        placeholder="e.g. Inspector John Doe"
                                        value={newUserForm.full_name}
                                        onChange={(e) => setNewUserForm({ ...newUserForm, full_name: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Address</label>
                                    <input
                                        type="email"
                                        required
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        placeholder="officer@example.com"
                                        value={newUserForm.email}
                                        onChange={(e) => setNewUserForm({ ...newUserForm, email: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                                    <input
                                        type="password"
                                        required
                                        minLength={8}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        placeholder="Minimum 8 characters"
                                        value={newUserForm.password}
                                        onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
                                    <select
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        value={newUserForm.role}
                                        onChange={(e) => setNewUserForm({ ...newUserForm, role: e.target.value, districts: e.target.value === 'admin' ? [] : newUserForm.districts })}
                                    >
                                        <option value="admin">Admin</option>
                                        <option value="level-1">Officer</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">State</label>
                                    <input
                                        disabled
                                        value={tenantState || 'No state assigned'}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-gray-50 dark:bg-slate-800 text-gray-500 dark:text-gray-400"
                                    />
                                </div>
                                {newUserForm.role !== 'admin' && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Districts</label>
                                        <DistrictMultiSelect
                                            options={assignableDistricts}
                                            value={newUserForm.districts}
                                            onChange={(v) => setNewUserForm({ ...newUserForm, districts: v })}
                                        />
                                    </div>
                                )}
                                {newUserForm.role !== 'admin' && (
                                    <div className="sm:col-span-2">
                                        <MonitoringLimitsFields form={newUserForm} setForm={setNewUserForm} />
                                    </div>
                                )}
                                <div className="flex gap-3 pt-4 sm:col-span-2">
                                    <button
                                        type="button"
                                        onClick={() => setShowCreateModal(false)}
                                        className="flex-1 px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={creatingUser}
                                        className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:bg-indigo-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                    >
                                        {creatingUser ? (
                                            <>
                                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                                                Creating...
                                            </>
                                        ) : 'Create Officer'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit User Modal */}
            {editingUser && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-xl max-w-2xl w-full shadow-xl animate-in fade-in zoom-in duration-200">
                        <div className="p-6 max-h-[88vh] overflow-y-auto">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-lg">
                                        <Edit2 size={20} className="text-indigo-600 dark:text-indigo-400" />
                                    </div>
                                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Edit Officer</h2>
                                </div>
                                <button
                                    onClick={() => setEditingUser(null)}
                                    className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                                >
                                    <X size={18} className="text-gray-500 dark:text-gray-400" />
                                </button>
                            </div>

                            <form onSubmit={handleUpdateUser} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name</label>
                                    <input
                                        type="text"
                                        required
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        value={editUserForm.full_name}
                                        onChange={(e) => setEditUserForm({ ...editUserForm, full_name: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Address</label>
                                    <input
                                        type="email"
                                        required
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        value={editUserForm.email}
                                        onChange={(e) => setEditUserForm({ ...editUserForm, email: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Password (Optional)</label>
                                    <input
                                        type="password"
                                        minLength={8}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        placeholder="Leave blank to keep current password"
                                        value={editUserForm.password}
                                        onChange={(e) => setEditUserForm({ ...editUserForm, password: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
                                    <select
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                        value={editUserForm.role}
                                        onChange={(e) => setEditUserForm({ ...editUserForm, role: e.target.value, districts: e.target.value === 'admin' ? [] : editUserForm.districts })}
                                    >
                                        <option value="admin">Admin</option>
                                        <option value="level-1">Officer</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">State</label>
                                    <input
                                        disabled
                                        value={tenantState || 'No state assigned'}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm bg-gray-50 dark:bg-slate-800 text-gray-500 dark:text-gray-400"
                                    />
                                </div>
                                {editUserForm.role !== 'admin' && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Districts</label>
                                        <DistrictMultiSelect
                                            options={assignableDistricts}
                                            value={editUserForm.districts}
                                            onChange={(v) => setEditUserForm({ ...editUserForm, districts: v })}
                                        />
                                    </div>
                                )}
                                {editUserForm.role !== 'admin' && (
                                    <div className="sm:col-span-2">
                                        <MonitoringLimitsFields form={editUserForm} setForm={setEditUserForm} />
                                    </div>
                                )}
                                <div className="flex gap-3 pt-4 sm:col-span-2">
                                    <button
                                        type="button"
                                        onClick={() => setEditingUser(null)}
                                        className="flex-1 px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={updatingUser}
                                        className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:bg-indigo-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                    >
                                        {updatingUser ? (
                                            <>
                                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                                                Saving...
                                            </>
                                        ) : 'Save Changes'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AccessManagement;
