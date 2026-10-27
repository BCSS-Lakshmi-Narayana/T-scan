import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { ShieldCheck, Check, Crown, Save, ArrowLeft, Search, LayoutGrid } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useRbac } from '../contexts/RbacContext';

const ROLE_LABELS = { admin: 'Admin', 'level-1': 'Officer' };
const roleLabel = (role) => ROLE_LABELS[role] || role;

const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

// Clusters a page's features by their optional `group` (e.g. Settings' features
// carry group: 'Configuration' | 'Profiles' | ... to mirror Settings.js's own
// tabs). Ungrouped features come first as a single unlabeled bucket.
const groupFeatures = (features = []) => {
    const order = [];
    const byGroup = {};
    features.forEach((feat) => {
        const key = feat.group || '';
        if (!byGroup[key]) { byGroup[key] = []; order.push(key); }
        byGroup[key].push(feat);
    });
    return order.map((group) => ({ group: group || null, features: byGroup[group] }));
};

/**
 * Module permissions editor for a single officer. Rendered two ways:
 *  - as its own route (/access-management/permissions/:userId) — reads the id
 *    from the URL and goes back via the router
 *  - inline from the Access Management officer list (including the Settings tab,
 *    where routing away would drop the user out of Settings) — receives
 *    `userId` / `onBack` as props instead.
 */
const ModulePermissions = ({ userId: userIdProp, onBack }) => {
    const { user } = useAuth();
    const { hasFeatureAccess } = useRbac();
    const params = useParams();
    const navigate = useNavigate();

    const userId = userIdProp || params.userId;
    const canAssignPermissions = hasFeatureAccess('/settings', 'assign_permissions');

    const [targetUser, setTargetUser] = useState(null);
    const [pages, setPages] = useState([]);
    const [permissions, setPermissions] = useState({});
    const [hasCustomPermissions, setHasCustomPermissions] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);
    const [search, setSearch] = useState('');

    const goBack = useCallback(() => {
        if (onBack) return onBack();
        navigate('/access-management');
    }, [onBack, navigate]);

    useEffect(() => {
        let cancelled = false;

        const fetchData = async () => {
            if (!userId) return;
            try {
                setLoading(true);
                const requests = [api.get('/rbac/pages'), api.get('/rbac/users')];
                if (canAssignPermissions) {
                    requests.push(api.get(`/rbac/permissions/${userId}`));
                }
                const [pagesRes, usersRes, permsRes] = await Promise.all(requests);
                if (cancelled) return;

                setPages(pagesRes.data);
                setTargetUser(usersRes.data.find(u => u.id === userId) || null);
                setPermissions(permsRes?.data?.permissions || {});
                setHasCustomPermissions(permsRes?.data?.has_custom_permissions || false);
                setIsDirty(false);
            } catch (error) {
                if (!cancelled) toast.error('Failed to load permissions');
                console.error(error);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchData();
        return () => { cancelled = true; };
    }, [userId, canAssignPermissions]);

    const assignablePages = useMemo(
        () => pages.filter(p => p.path !== '/access-management'),
        [pages]
    );

    const visiblePages = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return assignablePages;
        return assignablePages.filter(p =>
            p.name.toLowerCase().includes(term) || p.path.toLowerCase().includes(term)
        );
    }, [assignablePages, search]);

    const enabledCount = useMemo(
        () => assignablePages.filter(p => permissions[p.path]?.enabled).length,
        [assignablePages, permissions]
    );

    const togglePage = (pagePath) => {
        setPermissions(prev => {
            const current = prev[pagePath] || { enabled: false, features: [] };
            const enabled = !current.enabled;
            const pageData = pages.find(p => p.path === pagePath);
            const allFeatures = pageData?.features?.map(f => f.id) || [];

            setIsDirty(true);
            return {
                ...prev,
                [pagePath]: {
                    ...current,
                    enabled,
                    features: enabled ? allFeatures : []
                }
            };
        });
    };

    const toggleFeature = (pagePath, featureId) => {
        setPermissions(prev => {
            const current = prev[pagePath] || { enabled: true, features: [] };
            const isCurrentlySelected = current.features.includes(featureId);

            const newFeatures = isCurrentlySelected
                ? current.features.filter(f => f !== featureId)
                : [...current.features, featureId];

            setIsDirty(true);
            return {
                ...prev,
                [pagePath]: {
                    ...current,
                    features: newFeatures
                }
            };
        });
    };

    const selectAll = () => {
        const newPerms = {};
        assignablePages.forEach(p => {
            newPerms[p.path] = {
                enabled: true,
                features: p.features ? p.features.map(f => f.id) : []
            };
        });
        setPermissions(newPerms);
        setIsDirty(true);
    };

    const deselectAll = () => {
        setPermissions({});
        setIsDirty(true);
    };

    const handleSave = async () => {
        if (!userId) return;

        const validationErrors = [];
        pages.forEach((page) => {
            const hasSubFeatures = Array.isArray(page.features) && page.features.length > 0;
            const pagePerm = permissions[page.path];
            if (!hasSubFeatures || !pagePerm?.enabled) return;
            if (!Array.isArray(pagePerm.features) || pagePerm.features.length === 0) {
                validationErrors.push(`${page.name} requires at least one feature`);
            }
        });

        if (validationErrors.length > 0) {
            toast.error(validationErrors[0]);
            return;
        }

        try {
            setSaving(true);
            await api.put(`/rbac/permissions/${userId}`, { permissions });
            setHasCustomPermissions(true);
            setIsDirty(false);
            toast.success(`Permissions updated for ${targetUser?.full_name || 'officer'}`);
        } catch (error) {
            const msg = error.response?.data?.message || 'Failed to save permissions';
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    // Admins always have access; officers need the Access Management tab granted.
    if (user?.role !== 'admin' && !hasFeatureAccess('/settings', 'access_management_tab_access')) {
        return <Navigate to="/dashboard" replace />;
    }

    const isTargetAdmin = targetUser?.role === 'admin';
    // An officer with the grant may not edit their own permissions — the backend
    // rejects it too (self-service escalation).
    const isSelfAsOfficer = user?.role !== 'admin' && targetUser?.id === user?.id;

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
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-50 dark:bg-indigo-950 rounded-lg">
                        <LayoutGrid className="text-indigo-600" size={24} />
                    </div>
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Module Permissions</h1>
                        <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Choose the pages and features this officer can access</p>
                    </div>
                </div>
            </div>

            {/* Officer Banner */}
            {targetUser && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm p-4 mb-4 flex flex-wrap items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-semibold text-sm flex-shrink-0">
                        {getInitials(targetUser.full_name)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 dark:text-white truncate">{targetUser.full_name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{targetUser.email}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`px-2 py-1 text-xs font-medium rounded-md border ${isTargetAdmin
                            ? 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800'
                            : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-slate-800 dark:text-gray-300 dark:border-slate-600'
                            }`}>
                            {isTargetAdmin && <Crown size={12} className="inline mr-1" />}
                            {roleLabel(targetUser.role).toUpperCase()}
                        </span>
                        {targetUser.districts?.length > 0 && (
                            <span className="px-2 py-1 text-xs font-medium rounded-md bg-gray-100 text-gray-600 border border-gray-200 dark:bg-slate-800 dark:text-gray-300 dark:border-slate-600">
                                {targetUser.districts.join(', ')}
                            </span>
                        )}
                        <span className={`px-2 py-1 text-xs font-medium rounded-md border ${targetUser.is_active === false
                            ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800'
                            : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800'
                            }`}>
                            {targetUser.is_active === false ? 'Inactive' : 'Active'}
                        </span>
                        {hasCustomPermissions && !isTargetAdmin && (
                            <span className="px-2 py-1 text-xs font-medium rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                                Custom
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* Permissions Card */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm flex flex-col min-h-[420px]">
                <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <h2 className="font-semibold text-gray-700 dark:text-gray-300">Modules</h2>
                        {!isTargetAdmin && !loading && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                                {enabledCount} / {assignablePages.length} enabled
                            </span>
                        )}
                    </div>

                    {!isTargetAdmin && canAssignPermissions && !loading && (
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative">
                                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search modules..."
                                    className="w-full sm:w-56 pl-9 pr-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-sm dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                />
                            </div>
                            <button
                                onClick={selectAll}
                                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg transition-colors"
                            >
                                Select All
                            </button>
                            <button
                                onClick={deselectAll}
                                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg transition-colors"
                            >
                                Clear
                            </button>
                        </div>
                    )}
                </div>

                {loading ? (
                    <div className="flex-1 flex items-center justify-center py-20">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent"></div>
                    </div>
                ) : !targetUser ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                        <div className="w-16 h-16 bg-gray-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
                            <ShieldCheck size={28} className="text-gray-400" />
                        </div>
                        <h3 className="text-gray-700 dark:text-gray-300 font-medium mb-1">Officer Not Found</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">This account no longer exists in your tenant.</p>
                    </div>
                ) : isTargetAdmin ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                        <div className="w-16 h-16 bg-purple-100 dark:bg-purple-950 rounded-full flex items-center justify-center mb-4">
                            <Crown size={28} className="text-purple-600" />
                        </div>
                        <h3 className="text-gray-700 dark:text-gray-300 font-medium mb-1">Full Admin Access</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">Admins have unrestricted access to all modules and features.</p>
                    </div>
                ) : !canAssignPermissions ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                        <div className="w-16 h-16 bg-red-50 dark:bg-red-950 rounded-full flex items-center justify-center mb-4">
                            <ShieldCheck size={28} className="text-red-400" />
                        </div>
                        <h3 className="text-gray-700 dark:text-gray-300 font-medium mb-1">Access Denied</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">You don't have permission to assign module permissions.</p>
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto p-3 sm:p-4 max-h-[calc(100vh-24rem)] min-h-[300px]">
                            <div className="space-y-2">
                                {visiblePages.length === 0 ? (
                                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-10">No modules match "{search}"</p>
                                ) : visiblePages.map(page => {
                                    const perm = permissions[page.path] || { enabled: false, features: [] };
                                    const isActive = perm.enabled;
                                    const hasSubFeatures = page.features && page.features.length > 0;

                                    return (
                                        <div
                                            key={page.path}
                                            className={`border rounded-lg transition-all ${isActive
                                                ? 'border-indigo-200 bg-indigo-50/30 dark:border-indigo-800 dark:bg-indigo-950/30'
                                                : 'border-gray-200 dark:border-slate-700'
                                                }`}
                                        >
                                            {/* Page Row */}
                                            <div className="p-3 flex items-center gap-3">
                                                <button
                                                    onClick={() => togglePage(page.path)}
                                                    className={`w-5 h-5 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${isActive
                                                        ? 'bg-indigo-600 border-indigo-600 text-white'
                                                        : 'border-gray-300 hover:border-indigo-400 dark:border-slate-600'
                                                        }`}
                                                >
                                                    {isActive && <Check size={12} />}
                                                </button>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2">
                                                        <span className="font-medium text-gray-900 dark:text-white truncate">{page.name}</span>
                                                        <span className="text-xs text-gray-400 truncate hidden sm:inline">{page.path}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Features — grouped under sub-headers when the page
                                                (e.g. Settings) clusters permissions by tab via feat.group */}
                                            {hasSubFeatures && isActive && (
                                                <div className="px-3 pb-3 pl-11 space-y-3">
                                                    {groupFeatures(page.features).map(({ group, features }) => (
                                                        <div key={group || '_ungrouped'}>
                                                            {group && (
                                                                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">{group}</p>
                                                            )}
                                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                                {features.map(feat => {
                                                                    const isFeatSelected = perm.features.includes(feat.id);
                                                                    return (
                                                                        <label
                                                                            key={feat.id}
                                                                            className="flex items-center gap-2 cursor-pointer group"
                                                                        >
                                                                            <button
                                                                                onClick={() => toggleFeature(page.path, feat.id)}
                                                                                className={`w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center transition-colors ${isFeatSelected
                                                                                    ? 'bg-indigo-600 border-indigo-600 text-white'
                                                                                    : 'border-gray-300 group-hover:border-indigo-400 dark:border-slate-600'
                                                                                    }`}
                                                                            >
                                                                                {isFeatSelected && <Check size={10} />}
                                                                            </button>
                                                                            <span className="text-sm text-gray-600 dark:text-gray-400">{feat.label}</span>
                                                                        </label>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Save Bar */}
                        <div className="p-4 border-t border-gray-200 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-800/50 rounded-b-xl">
                            <div className="flex items-center justify-end gap-4">
                                {isDirty && (
                                    <span className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 bg-amber-500 rounded-full"></span>
                                        Unsaved changes
                                    </span>
                                )}
                                <button
                                    onClick={goBack}
                                    className="px-4 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving || !isDirty || isSelfAsOfficer}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${saving || !isDirty || isSelfAsOfficer
                                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed dark:bg-slate-800 dark:text-gray-600'
                                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm hover:shadow'
                                        }`}
                                >
                                    <Save size={16} />
                                    {saving ? 'Saving...' : 'Save Permissions'}
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ModulePermissions;
