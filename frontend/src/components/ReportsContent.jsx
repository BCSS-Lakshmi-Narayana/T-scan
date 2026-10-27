import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import {
    FileText, Search, Download, Eye, Calendar,
    User, Hash, RefreshCw, ExternalLink,
    LayoutList, CheckCircle, ChevronLeft, ChevronRight
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Calendar as CalendarComponent } from '../components/ui/calendar';
import { endOfDay, format, startOfDay } from 'date-fns';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { toast } from 'sonner';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "../components/ui/hover-card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "../components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { ScrollArea } from "../components/ui/scroll-area";
import { TwitterAlertCard, YoutubeAlertCard } from '../components/AlertCards';
import { useScopedLocation } from '../hooks/useScopedLocation';

const CardsMetric = ({ label, value, icon }) => (
    <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
        <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {icon}
        </div>
        <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
    </div>
);

const REPORT_STATUS_FILTERS = ['sent_to_intermediary', 'closed', 'all'];

const ReportsContent = ({ platformFilter: sharedPlatform, dateRange: sharedDateRange, searchQuery: sharedSearch, keywordFilter: sharedKeyword, alertCategory: sharedCategory, sourceCategoryFilter: sharedSourceCategory, viewHandle, onClearHandle }) => {
    const [reports, setReports] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [searchParams, setSearchParams] = useSearchParams();

    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
    const REPORTS_PER_PAGE = 20;

    // Filters
    const [dateRange, setDateRange] = useState({ from: undefined, to: undefined });
    const [platformFilter, setPlatformFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('sent_to_intermediary');
    const [keywordFilter, setKeywordFilter] = useState('all');
    const [alertCategory, setAlertCategory] = useState('all');
    const [sourceCategoryFilter, setSourceCategoryFilter] = useState('all');
    const [districtFilter, setDistrictFilter] = useState('all');
    const { districtOptions } = useScopedLocation();

    // Expanded closing remarks tracker
    const [expandedRemarks, setExpandedRemarks] = useState({});

    // Status change confirmation dialog
    const [confirmDialog, setConfirmDialog] = useState({
        open: false,
        reportId: null,
        newStatus: null,
        oldStatus: null,
        closingRemarks: ''
    });

    useEffect(() => {
        const reportStatusParam = searchParams.get('reportStatus');
        if (!reportStatusParam) return;
        if (REPORT_STATUS_FILTERS.includes(reportStatusParam)) {
            setStatusFilter(reportStatusParam);
        }
    }, [searchParams]);

    // Sync shared filters when they change
    useEffect(() => {
        if (sharedPlatform) setPlatformFilter(sharedPlatform);
    }, [sharedPlatform]);

    useEffect(() => {
        if (sharedKeyword) setKeywordFilter(sharedKeyword);
    }, [sharedKeyword]);

    useEffect(() => {
        if (sharedCategory) setAlertCategory(sharedCategory);
    }, [sharedCategory]);

    useEffect(() => {
        if (sharedSourceCategory) setSourceCategoryFilter(sharedSourceCategory);
    }, [sharedSourceCategory]);

    useEffect(() => {
        if (sharedDateRange) {
            setDateRange({
                from: sharedDateRange.start ? new Date(sharedDateRange.start) : undefined,
                to: sharedDateRange.end ? new Date(sharedDateRange.end) : undefined
            });
        }
    }, [sharedDateRange]);

    useEffect(() => {
        if (sharedSearch !== undefined) setSearchQuery(sharedSearch);
    }, [sharedSearch]);

    // Debounce search input (400ms) to avoid hammering the backend on every keystroke
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchQuery), 400);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Reset to page 1 when any filter changes
    useEffect(() => {
        setCurrentPage(1);
    }, [platformFilter, statusFilter, debouncedSearch, dateRange, keywordFilter, alertCategory, sourceCategoryFilter, districtFilter, viewHandle]);

    // Profile Details
    const [selectedProfile, setSelectedProfile] = useState(null);
    const [profileReports, setProfileReports] = useState([]);
    const [profileLoading, setProfileLoading] = useState(false);

    // Fetch full history when profile is selected
    useEffect(() => {
        const fetchProfileReports = async () => {
            if (!selectedProfile?.handle) return;

            setProfileLoading(true);
            try {
                // Fetch ALL reports for this user (ignore global status filters)
                const response = await api.get('/reports', {
                    params: {
                        search: selectedProfile.handle.replace('@', ''),
                        // Explicitly clear status filter to get closed reports too
                        status: undefined
                    }
                });
                const data = response.data;
                setProfileReports(data && data.items ? data.items : Array.isArray(data) ? data : []);
            } catch (error) {
                console.error('Failed to fetch profile reports:', error);
            } finally {
                setProfileLoading(false);
            }
        };

        if (selectedProfile) {
            fetchProfileReports();
        }
    }, [selectedProfile?.handle]);

    const getUserStats = (handle) => {
        // Use profileReports if we are viewing that profile and it matches, otherwise fallback to global reports
        // But getUserStats is also used for the main table hover cards. 
        // For the main table, we want stats based on specific logic or global? 
        // The original logic filtered `reports` (which is filtered by global params?).
        // Actually original `getUserStats` filtered `reports`. `reports` in `ReportsContent` is the main list.
        // If main list is filtered by "Sent to Intermediary", `reports` won't have "Closed".
        // So `getUserStats` for HoverCard might be inaccurate if `reports` is partial.
        // However, for the **Selected Profile View**, we should definitely use `profileReports`.

        const targetReports = selectedProfile && selectedProfile.handle === handle ? profileReports : reports;

        const userReports = targetReports.filter(r =>
            r.target_user_details?.handle?.toLowerCase() === handle?.toLowerCase() ||
            r.target_user_details?.handle?.replace('@', '').toLowerCase() === handle?.toLowerCase().replace('@', '')
        );

        const total = userReports.length;
        const awaiting = userReports.filter(r => r.status === 'sent_to_intermediary' || r.status === 'awaiting_reply').length;
        const closed = userReports.filter(r => r.status === 'closed' || r.status === 'resolved').length;
        return { total, awaiting, closed, userReports };
    };

    // Export reports to Excel/CSV
    const exportToExcel = (reportsToExport, filename = 'reports') => {
        if (!reportsToExport || reportsToExport.length === 0) {
            toast.error('No reports to export');
            return;
        }

        // Define CSV headers
        const headers = [
            'Report ID',
            'Generated Date',
            'Platform',
            'Target User Name',
            'Target User Handle',
            'Category',
            'Content Summary',
            'Content URL',
            'Status',
            'Risk Level',
            'Sent to Intermediary',
            'Awaiting Reply',
            'Closed',
            'Times Escalated'
        ];

        // Convert reports to CSV rows
        const rows = reportsToExport.map(report => {
            const userStats = getUserStats(report.target_user_details?.handle);
            return [
                report.serial_number || '',
                report.generated_at ? format(new Date(report.generated_at), 'yyyy-MM-dd HH:mm:ss') : '',
                report.platform || '',
                report.target_user_details?.name || '',
                report.target_user_details?.handle || '',
                (report.source_category || '').replace(/_/g, ' '),
                (report.content_summary || report.alert_data?.description || '').replace(/"/g, '""').substring(0, 500),
                report.joined_content_url || report.alert_data?.content_url || '',
                report.status?.replace(/_/g, ' ') || '',
                report.alert_data?.risk_level || '',
                userStats.userReports.filter(r => r.status === 'sent_to_intermediary').length,
                userStats.userReports.filter(r => r.status === 'awaiting_reply').length,
                userStats.userReports.filter(r => r.status === 'closed' || r.status === 'resolved').length,
                userStats.total
            ];
        });

        // Create CSV content
        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        // Create blob and download
        const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `${filename}_${format(new Date(), 'yyyy-MM-dd_HHmm')}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        toast.success(`Exported ${reportsToExport.length} reports successfully`);
    };

    // Helper to map Report back to Alert format for cards
    const mapReportToAlert = (report) => {
        // content_data contains the full Content model data (tweet text, media, etc.)
        const contentData = report.content_data || {};
        // alert_data contains the Alert model data (threat_details, policies, etc.)
        const alertData = report.alert_data || {};

        // Construct 'content' object that Card expects
        const content = {
            id: contentData.id || alertData.content_id,
            text: contentData.text || report.content_summary || alertData.description || '',
            media: contentData.media || [],
            engagement: contentData.engagement || {},
            published_at: contentData.published_at || report.generated_at,
            author_handle: contentData.author_handle || report.target_user_details?.handle,
            author: contentData.author || report.target_user_details?.name,
            author_name: contentData.author || report.target_user_details?.name,
            author_avatar: report.target_user_details?.avatar_url,
            url: contentData.content_url || alertData.content_url || report.joined_content_url,
            content_url: contentData.content_url || alertData.content_url || report.joined_content_url,
            risk_level: contentData.risk_level || alertData.risk_level || 'medium',
            risk_score: contentData.risk_score || alertData.threat_details?.risk_score,
            quoted_content: contentData.quoted_content || null,
            is_repost: contentData.is_repost || false,
            original_author: contentData.original_author,
            original_author_name: contentData.original_author_name,
            original_author_avatar: contentData.original_author_avatar,
            // Analysis data for ReasonModal
            analysis: {
                risk_score: contentData.risk_score || alertData.threat_details?.risk_score,
                risk_level: contentData.risk_level || alertData.risk_level,
                reasons: contentData.threat_reasons || alertData.threat_details?.reasons || [],
                highlights: alertData.threat_details?.highlights || [],
                intent: alertData.threat_details?.intent
            }
        };

        // Construct 'alert' object that Card expects - include all fields ReasonModal needs
        const alert = {
            id: report.alert_id,
            status: report.status,
            risk_level: alertData.risk_level || contentData.risk_level || 'medium',
            risk_score: alertData.threat_details?.risk_score || contentData.risk_score || 0,
            content_url: contentData.content_url || alertData.content_url || report.joined_content_url,
            // Full threat_details for ReasonModal
            threat_details: alertData.threat_details || {
                risk_score: contentData.risk_score,
                reasons: contentData.threat_reasons || [],
                highlights: [],
                intent: contentData.threat_intent
            },
            // LLM analysis object — ReasonModal reads category, score, reasoning, policies, legal from here
            llm_analysis: alertData.llm_analysis || null,
            // Policy and legal data for ReasonModal
            violated_policies: alertData.violated_policies || [],
            legal_sections: alertData.legal_sections || [],
            classification_explanation: alertData.classification_explanation || '',
            // Keywords for ReasonModal
            matched_keywords_normalized: alertData.matched_keywords_normalized || [],
            triggered_keywords: alertData.triggered_keywords || contentData.risk_factors?.keywords || [],
            highlights: alertData.threat_details?.highlights || [],
            primary_intent: alertData.primary_intent || alertData.threat_details?.intent || '',
            // Additional alert properties
            title: alertData.title,
            description: alertData.description,
            platform: report.platform || alertData.platform
        };

        const source = {
            name: contentData.author || report.target_user_details?.name,
            handle: contentData.author_handle || report.target_user_details?.handle
        };

        return { alert, content, source };
    };

    const fetchReports = async () => {
        setLoading(true);
        try {
            const params = {
                page: currentPage,
                limit: REPORTS_PER_PAGE,
                platform: platformFilter !== 'all' ? platformFilter : undefined,
                status: statusFilter !== 'all' ? statusFilter : undefined,
                search: viewHandle || debouncedSearch || undefined,
                keyword: keywordFilter !== 'all' ? keywordFilter : undefined,
                category: sourceCategoryFilter !== 'all' ? sourceCategoryFilter : undefined,
                district: districtFilter !== 'all' ? districtFilter : undefined,
                startDate: dateRange.from ? startOfDay(dateRange.from).toISOString() : undefined,
                endDate: dateRange.to ? endOfDay(dateRange.to).toISOString() : undefined
            };

            // Map alertCategory to risk_level or alert_type
            if (alertCategory !== 'all') {
                if (alertCategory === 'viral') {
                    params.alert_type = 'velocity';
                } else if (alertCategory === 'risk') {
                    params.alert_type = 'risk';
                } else if (['high', 'medium', 'low', 'critical'].includes(alertCategory)) {
                    params.risk_level = alertCategory;
                }
            }

            const response = await api.get('/reports', { params });
            const data = response.data;

            // Handle both old (array) and new ({ items, pagination }) response formats
            if (data && data.items) {
                setReports(data.items);
                setPagination(data.pagination || { page: 1, limit: REPORTS_PER_PAGE, total: data.items.length, totalPages: 1 });
            } else if (Array.isArray(data)) {
                setReports(data);
                setPagination({ page: 1, limit: REPORTS_PER_PAGE, total: data.length, totalPages: 1 });
            }
        } catch (error) {
            console.error('Failed to fetch reports:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReports();
    }, [platformFilter, statusFilter, debouncedSearch, dateRange, keywordFilter, alertCategory, sourceCategoryFilter, districtFilter, viewHandle, currentPage]);

    const hasActiveFilters =
        Boolean(dateRange.from) ||
        Boolean(dateRange.to) ||
        platformFilter !== 'all' ||
        statusFilter !== 'sent_to_intermediary' ||
        (searchQuery || '').trim() !== '' ||
        keywordFilter !== 'all' ||
        alertCategory !== 'all' ||
        sourceCategoryFilter !== 'all' ||
        districtFilter !== 'all';

    const clearFilters = () => {
        setDateRange({ from: undefined, to: undefined });
        setPlatformFilter('all');
        setStatusFilter('sent_to_intermediary');
        setSearchQuery('');
        setKeywordFilter('all');
        setAlertCategory('all');
        setSourceCategoryFilter('all');
        setDistrictFilter('all');
        setCurrentPage(1);
        if (typeof onClearHandle === 'function') {
            onClearHandle();
        }
    };

    // Auto-select profile if viewHandle is present and matches a report
    useEffect(() => {
        if (viewHandle && reports.length > 0 && !selectedProfile) {
            const match = reports.find(r =>
                r.target_user_details?.handle?.toLowerCase() === viewHandle.toLowerCase() ||
                r.target_user_details?.handle?.toLowerCase() === viewHandle.toLowerCase().replace('@', '')
            );

            if (match) {
                setSelectedProfile({
                    ...match.target_user_details,
                    reportHistory: getUserStats(match.target_user_details?.handle)
                });
            }
        }
    }, [viewHandle, reports, selectedProfile]);

    // Server already filters — no client-side re-filtering needed
    // filteredReports removed: replaced with reports directly

    const handleStatusChange = (reportId, newStatus) => {
        // Find the report to get its old status
        // Check both lists because 'reports' might be filtered, but 'profileReports' has everything for the user
        const report = reports.find(r => r.alert_id === reportId) || profileReports.find(r => r.alert_id === reportId);
        if (!report) return;

        // Show confirmation dialog
        setConfirmDialog({
            open: true,
            reportId,
            newStatus,
            oldStatus: report.status,
            closingRemarks: ''
        });
    };

    const confirmStatusUpdate = async () => {
        const { reportId, newStatus, closingRemarks } = confirmDialog;
        if (newStatus === 'closed' && !closingRemarks.trim()) {
            toast.error('Please enter closing remarks before closing the report');
            return;
        }
        try {
            const updateData = { status: newStatus };
            if (newStatus === 'closed' && closingRemarks.trim()) {
                updateData.closing_remarks = closingRemarks.trim();
            }
            // Optimistic update for main reports list
            setReports(prev => prev.map(r =>
                r.alert_id === reportId ? { ...r, status: newStatus, closing_remarks: updateData.closing_remarks || r.closing_remarks } : r
            ));

            // Optimistic update for profile reports list (The Grid View)
            setProfileReports(prev => prev.map(r =>
                r.alert_id === reportId ? { ...r, status: newStatus, closing_remarks: updateData.closing_remarks || r.closing_remarks } : r
            ));

            // Also update selectedProfile if viewing a profile (legacy structure but still used for stats in some places?)
            if (selectedProfile) {
                setSelectedProfile(prev => ({
                    ...prev,
                    reportHistory: {
                        ...prev.reportHistory,
                        userReports: prev.reportHistory?.userReports?.map(r =>
                            r.alert_id === reportId ? { ...r, status: newStatus } : r
                        ) || []
                    }
                }));
            }

            await api.put(`/reports/${reportId}`, updateData);
            toast.success('Report status updated');
            setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' });
        } catch (error) {
            console.error('Failed to update status:', error);
            toast.error('Failed to update status');
            // Revert changes if needed
            fetchReports();
            setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' });
        }
    };

    if (selectedProfile) {
        return (
            <div className="space-y-0">
                {/* Blue Banner */}
                <div className="h-28 bg-gradient-to-r from-sky-400 to-cyan-500 relative">
                    {/* Back Button */}
                    <button
                        onClick={() => {
                            setSelectedProfile(null);
                            // Clear URL param to prevent auto-reselection
                            setSearchParams(params => {
                                const newParams = new URLSearchParams(params);
                                newParams.delete('handle');
                                return newParams;
                            });
                            if (onClearHandle) onClearHandle();
                        }}
                        className="absolute top-4 left-4 flex items-center gap-2 bg-white/90 text-gray-800 text-xs font-semibold px-3 py-1.5 rounded-full shadow hover:bg-white transition-colors"
                    >
                        ← Back to Reports
                    </button>
                    {/* View on X Button */}
                    <a
                        href={`https://x.com/${selectedProfile?.handle?.replace('@', '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="absolute top-4 right-4 flex items-center gap-2 bg-white/90 text-gray-800 text-xs font-semibold px-3 py-1.5 rounded-full shadow hover:bg-white transition-colors"
                    >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                        View on X
                    </a>
                </div>

                {/* Profile Header (Overlapping Avatar) */}
                <div className="relative px-6 pb-4 -mt-12 bg-white dark:bg-[#0f0f0f]">
                    <div className="flex items-end gap-4">
                        <Avatar className="h-24 w-24 border-4 border-white dark:border-[#0f0f0f] shadow-lg">
                            <AvatarImage src={selectedProfile?.avatar_url} />
                            <AvatarFallback className="text-2xl bg-slate-800 text-white">
                                {selectedProfile?.name?.charAt(0) || '@'}
                            </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 pb-2">
                            <h1 className="text-xl font-bold text-gray-900 dark:text-white">{selectedProfile?.name || selectedProfile?.handle}</h1>
                            <div className="text-sm text-muted-foreground font-mono">@{selectedProfile?.handle?.replace('@', '')}</div>
                            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                    <Calendar className="h-3 w-3" />
                                    First Report: {selectedProfile?.reportHistory?.userReports?.[0] ?
                                        format(new Date(selectedProfile.reportHistory.userReports[selectedProfile.reportHistory.userReports.length - 1].generated_at), "M/d/yyyy")
                                        : 'N/A'}
                                </span>
                                <span className="flex items-center gap-1">
                                    <FileText className="h-3 w-3" />
                                    {getUserStats(selectedProfile?.handle).total} Reports Generated
                                </span>
                            </div>
                        </div>

                        {/* Status Counts Section */}
                        <div className="flex items-center gap-4 pb-2">
                            {/* Times Escalated (Total Reports Count) */}
                            <div className="text-center">
                                <div className="text-2xl font-bold text-purple-600">
                                    {getUserStats(selectedProfile?.handle).total}
                                </div>
                                <div className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">No of Times Escalated</div>
                            </div>
                            {/* Sent to Intermediary */}
                            <div className="text-center">
                                <div className="text-2xl font-bold text-blue-600">
                                    {getUserStats(selectedProfile?.handle).awaiting}
                                </div>
                                <div className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Sent to Intermediary</div>
                            </div>
                            {/* Closed */}
                            <div className="text-center">
                                <div className="text-2xl font-bold text-green-600">
                                    {getUserStats(selectedProfile?.handle).closed}
                                </div>
                                <div className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Closed</div>
                            </div>
                        </div>
                    </div>
                </div>



                {/* Filter Row */}
                <div className="px-6 py-3 flex items-center justify-between border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-black/20">
                    <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 font-semibold">
                            {getUserStats(selectedProfile?.handle).total} reports
                        </Badge>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => exportToExcel(
                            profileReports || [],
                            `${selectedProfile?.handle?.replace('@', '') || 'profile'}_reports`
                        )}
                    >
                        <Download className="h-3 w-3 mr-1.5" />
                        Export Excel
                    </Button>
                </div>

                {/* Reports Feed - Grid Layout */}
                <div className="p-6 bg-gray-50 dark:bg-black min-h-[500px]">
                    {profileLoading ? (
                        <div className="flex gap-6 w-full items-start">
                            {[0, 1, 2].map(col => (
                                <div key={col} className="flex-1 min-w-0 flex flex-col gap-6">
                                    {[1, 2].map(i => (
                                        <div key={i} className="h-96 w-full bg-gray-100 dark:bg-gray-800 animate-pulse rounded-xl" />
                                    ))}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="flex gap-6 w-full items-start">
                            {(() => {
                                const colCount = 3;
                                const cols = Array.from({ length: colCount }, () => []);
                                profileReports.forEach((report, i) => cols[i % colCount].push(report));
                                return cols.map((colReports, colIdx) => (
                                    <div key={colIdx} className="flex-1 min-w-0 flex flex-col gap-6" style={{ contain: 'layout style' }}>
                                        {colReports.map((report) => {
                                            const { alert, content, source } = mapReportToAlert(report);
                                            return (
                                                <div key={report.alert_id} className="group relative flex flex-col will-change-transform" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 400px' }}>
                                                    {report.platform === 'youtube' ? (
                                                        <YoutubeAlertCard
                                                            alert={alert}
                                                            content={content}
                                                            source={source}
                                                            viewMode="grid"
                                                            hideActions={false}
                                                            isInvestigatedResult={false}
                                                            report={report}
                                                        />
                                                    ) : (
                                                        <TwitterAlertCard
                                                            alert={alert}
                                                            content={content}
                                                            source={source}
                                                            viewMode="grid"
                                                            hideActions={false}
                                                            isInvestigatedResult={false}
                                                            report={report}
                                                        />
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ));
                            })()}
                        </div>
                    )}
                </div>

                {/* Status Change Confirmation Dialog */}
                <Dialog open={confirmDialog.open} onOpenChange={(open) => !open && setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' })}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold">
                                {confirmDialog.newStatus === 'closed' ? 'Close Report' : 'Confirm Status Update'}
                            </DialogTitle>
                        </DialogHeader>

                        <div className="space-y-4 py-4">
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                                <p className="text-sm text-gray-700 dark:text-gray-300">
                                    Do you want to update the report status from{' '}
                                    <span className="font-semibold text-amber-700 dark:text-amber-400 capitalize">
                                        {confirmDialog.oldStatus?.replace(/_/g, ' ')}
                                    </span>
                                    {' '}to{' '}
                                    <span className="font-semibold text-blue-700 dark:text-blue-400 capitalize">
                                        {confirmDialog.newStatus?.replace(/_/g, ' ')}
                                    </span>
                                    ?
                                </p>
                            </div>
                            {confirmDialog.newStatus === 'closed' && (
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                        Closing Remarks <span className="text-red-500">*</span>
                                    </label>
                                    <textarea
                                        value={confirmDialog.closingRemarks || ''}
                                        onChange={(e) => setConfirmDialog(prev => ({ ...prev, closingRemarks: e.target.value }))}
                                        placeholder="Enter closing remarks (e.g., content removed, account suspended, no action needed...)"
                                        className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                                        rows={4}
                                    />
                                </div>
                            )}
                        </div>

                        <div className="flex gap-3 justify-end">
                            <Button
                                variant="outline"
                                onClick={() => setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' })}
                                className="px-4"
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={confirmStatusUpdate}
                                disabled={confirmDialog.newStatus === 'closed' && !confirmDialog.closingRemarks?.trim()}
                                className="px-4 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                            >
                                {confirmDialog.newStatus === 'closed' ? 'Close Report' : 'Continue'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }

    return (
        <div className="space-y-6">

            <Card className="border-none shadow-sm bg-white dark:bg-[#0f0f0f]">
                <CardContent className="p-4">
                    <div className="flex flex-col md:flex-row gap-4">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <Input
                                placeholder="Search by SN, User, or Handle..."
                                className="pl-10 h-10"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2 shrink-0">
                            {/* From Date */}
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant={"outline"}
                                        className={cn(
                                            "w-[160px] justify-start text-left font-normal",
                                            !dateRange.from && "text-muted-foreground"
                                        )}
                                    >
                                        <Calendar className="mr-2 h-4 w-4" />
                                        {dateRange.from ? format(dateRange.from, "LLL dd, y") : <span>From Date</span>}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto border bg-white p-0 shadow-md" align="end">
                                    <CalendarComponent
                                        initialFocus
                                        mode="single"
                                        selected={dateRange.from}
                                        onSelect={(date) => setDateRange(prev => ({ ...prev, from: date }))}
                                        numberOfMonths={1}
                                    />
                                </PopoverContent>
                            </Popover>

                            {/* To Date */}
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant={"outline"}
                                        className={cn(
                                            "w-[160px] justify-start text-left font-normal",
                                            !dateRange.to && "text-muted-foreground"
                                        )}
                                    >
                                        <Calendar className="mr-2 h-4 w-4" />
                                        {dateRange.to ? format(dateRange.to, "LLL dd, y") : <span>To Date</span>}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto border bg-white p-0 shadow-md" align="end">
                                    <CalendarComponent
                                        initialFocus
                                        mode="single"
                                        selected={dateRange.to}
                                        onSelect={(date) => setDateRange(prev => ({ ...prev, to: date }))}
                                        disabled={(date) => dateRange.from ? date < dateRange.from : false}
                                        numberOfMonths={1}
                                    />
                                </PopoverContent>
                            </Popover>

                            {/* Platform Filter */}
                            <Select value={platformFilter} onValueChange={setPlatformFilter}>
                                <SelectTrigger className="w-[150px]">
                                    <SelectValue placeholder="Platform" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Platforms</SelectItem>
                                    <SelectItem value="x">X (Twitter)</SelectItem>
                                    <SelectItem value="youtube">YouTube</SelectItem>
                                    <SelectItem value="facebook">Facebook</SelectItem>
                                    <SelectItem value="instagram">Instagram</SelectItem>
                                </SelectContent>
                            </Select>

                            {/* Status Filter */}
                            <Select value={statusFilter} onValueChange={setStatusFilter}>
                                <SelectTrigger className="w-[200px]">
                                    <SelectValue placeholder="Status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="sent_to_intermediary">Sent to Intermediary</SelectItem>
                                    <SelectItem value="closed">Closed</SelectItem>
                                </SelectContent>
                            </Select>

                            {/* District Filter */}
                            <Select value={districtFilter} onValueChange={setDistrictFilter}>
                                <SelectTrigger className="w-[160px]">
                                    <SelectValue placeholder="District" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Districts</SelectItem>
                                    {districtOptions.map((d) => (
                                        <SelectItem key={d} value={d}>{d}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <div className="flex gap-2 md:ml-auto">
                                <Button
                                    onClick={() => exportToExcel(reports, 'all_reports')}
                                    variant="outline"
                                    className="h-9 px-3 gap-1.5 text-sm"
                                >
                                    <Download className="h-4 w-4" />
                                    Export Excel
                                </Button>
                                <Button
                                    onClick={fetchReports}
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9"
                                    title="Refresh"
                                    aria-label="Refresh reports"
                                >
                                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                                </Button>
                            </div>

                        </div>
                    </div>
                </CardContent>
            </Card>

            {hasActiveFilters && (
                <div className="flex justify-end px-1 -mt-2">
                    <Button
                        onClick={clearFilters}
                        variant="outline"
                        className="h-9 px-3 text-sm"
                    >
                        Clear Filters
                    </Button>
                </div>
            )}

            {loading ? (
                <div className="grid gap-4">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-24 w-full bg-gray-100 dark:bg-gray-800 animate-pulse rounded-xl" />
                    ))}
                </div>
            ) : reports.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-[#0f0f0f] rounded-2xl border border-dashed border-gray-200 dark:border-gray-800">
                    <FileText className="h-12 w-12 text-gray-300 mb-4" />
                    <p className="text-gray-500">No formal reports found.</p>
                </div>
            ) : (
                <>
                    {/* Desktop Table View */}
                    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
                        <table className="min-w-[900px] w-full table-fixed text-left border-collapse bg-white dark:bg-[#0f0f0f]">
                            <colgroup>
                                <col className="w-[120px] lg:w-[12%]" />
                                <col className="w-[160px] lg:w-[16%]" />
                                <col className="w-[110px] lg:w-[11%]" />
                                <col className="w-[75px] lg:w-[7%]" />
                                <col className="w-[100px] lg:w-[10%]" />
                                <col className="w-[160px] lg:w-[16%]" />
                                <col className="w-[180px] lg:w-[19%]" />
                                <col className="w-[90px] lg:w-[9%]" />
                            </colgroup>
                            <thead>
                                <tr className="bg-gray-50 dark:bg-gray-900/50 text-gray-500 text-xs font-bold uppercase tracking-wider border-b border-gray-200 dark:border-gray-800">
                                    <th className="px-4 py-3 text-center">Report ID</th>
                                    <th className="px-4 py-3 text-center">Target User</th>
                                    <th className="px-4 py-3 text-center">Category</th>
                                    <th className="px-4 py-3 text-center">Post Link</th>
                                    <th className="px-4 py-3 text-center">Generated At</th>
                                    <th className="px-4 py-3 text-center">Status</th>
                                    <th className="px-4 py-3 text-center">Closing Remarks</th>
                                    <th className="px-4 py-3 text-center">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-gray-800/50">
                                {reports.map(report => (
                                    <tr key={report.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2 truncate">
                                                <Hash className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                                                <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{report.serial_number}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <HoverCard>
                                                <HoverCardTrigger asChild>
                                                    <div
                                                        className="flex items-center gap-2.5 cursor-pointer hover:opacity-80 transition-opacity min-w-0"
                                                        onClick={() => setSelectedProfile({
                                                            ...report.target_user_details,
                                                            reportHistory: getUserStats(report.target_user_details?.handle)
                                                        })}
                                                    >
                                                        <div className="h-8 w-8 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden shrink-0">
                                                            {report.target_user_details?.avatar_url ? (
                                                                <img src={report.target_user_details.avatar_url} className="h-full w-full object-cover" alt={report.target_user_details?.name} />
                                                            ) : (
                                                                <User className="h-full w-full p-1.5 text-gray-400" />
                                                            )}
                                                        </div>
                                                        <div className="flex flex-col min-w-0">
                                                            <span className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">{report.target_user_details?.name}</span>
                                                            <span className="text-xs text-gray-500 truncate">@{report.target_user_details?.handle?.replace('@', '')}</span>
                                                        </div>
                                                    </div>
                                                </HoverCardTrigger>
                                                <HoverCardContent
                                                    className="w-[500px] p-0 z-[60] bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200/50 shadow-2xl"
                                                    side="top"
                                                    align="start"
                                                    sideOffset={10}
                                                >
                                                    <div className="p-4 border-b border-slate-100 dark:border-slate-800">
                                                        <div className="flex items-center gap-3">
                                                            <Avatar className="h-12 w-12 border-2 border-slate-100 dark:border-slate-800">
                                                                <AvatarImage src={report.target_user_details?.avatar_url} />
                                                                <AvatarFallback className="bg-slate-100 text-slate-500">
                                                                    {report.target_user_details?.name?.charAt(0)}
                                                                </AvatarFallback>
                                                            </Avatar>
                                                            <div>
                                                                <div className="font-bold text-lg text-slate-900 dark:text-white">{report.target_user_details?.name}</div>
                                                                <div className="text-slate-500 text-sm font-mono">@{report.target_user_details?.handle?.replace('@', '')}</div>
                                                            </div>
                                                            <div className="ml-auto flex gap-4 text-center">
                                                                <div>
                                                                    <div className="text-lg font-bold text-purple-600">{getUserStats(report.target_user_details?.handle).total}</div>
                                                                    <div className="text-[9px] uppercase text-slate-400 font-bold leading-tight">No of Times<br />Escalated</div>
                                                                </div>
                                                                <div>
                                                                    <div className="text-lg font-bold text-blue-600">{getUserStats(report.target_user_details?.handle).userReports?.filter(r => r.status === 'sent_to_intermediary').length || 0}</div>
                                                                    <div className="text-[9px] uppercase text-slate-400 font-bold leading-tight">Sent to<br />Intermediary</div>
                                                                </div>
                                                                <div>
                                                                    <div className="text-lg font-bold text-green-600">{getUserStats(report.target_user_details?.handle).userReports?.filter(r => r.status === 'closed' || r.status === 'resolved').length || 0}</div>
                                                                    <div className="text-[9px] uppercase text-slate-400 font-bold">Closed</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="p-0">
                                                        <div className="px-4 py-2 bg-slate-50/50 dark:bg-slate-900/50 text-[10px] font-bold uppercase text-slate-500 flex justify-between border-b border-slate-100 dark:border-slate-800">
                                                            <span>Recent Activity</span>
                                                            <span className="text-blue-500 cursor-pointer hover:underline" onClick={() => setSelectedProfile({
                                                                ...report.target_user_details,
                                                                reportHistory: getUserStats(report.target_user_details?.handle)
                                                            })}>View Full History →</span>
                                                        </div>
                                                        <table className="w-full text-left text-sm">
                                                            <thead className="text-[10px] uppercase text-slate-400 bg-white/50 dark:bg-slate-900/50">
                                                                <tr>
                                                                    <th className="px-4 py-2 font-medium">Serial No</th>
                                                                    <th className="px-4 py-2 font-medium">Date</th>
                                                                    <th className="px-4 py-2 font-medium">Status</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                                                {getUserStats(report.target_user_details?.handle).userReports.slice(0, 5).map((histReport) => (
                                                                    <tr key={histReport.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/50">
                                                                        <td className="px-4 py-2 font-mono text-xs font-bold text-slate-900 dark:text-slate-100">{histReport.serial_number}</td>
                                                                        <td className="px-4 py-2 text-xs text-slate-500">{format(new Date(histReport.generated_at), "MMM d, y")}</td>
                                                                        <td className="px-4 py-2">
                                                                            <Badge variant="secondary" className="text-[10px] h-5 font-normal bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                                                                {histReport.status.replace(/_/g, ' ')}
                                                                            </Badge>
                                                                        </td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </HoverCardContent>
                                            </HoverCard>
                                        </td>

                                        <td className="px-4 py-3 text-center">
                                            {report.source_category ? (
                                                <Badge variant="outline" className="text-xs capitalize">
                                                    {report.source_category.replace(/_/g, ' ')}
                                                </Badge>
                                            ) : (
                                                <span className="text-gray-400 text-xs italic">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            {(report.edited_content?.contentUrl || report.joined_content_url) ? (
                                                <a
                                                    href={report.edited_content?.contentUrl || report.joined_content_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-800 text-sm font-medium hover:underline"
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                                                    View Post
                                                </a>
                                            ) : (
                                                <span className="text-gray-400 text-sm italic">N/A</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
                                                <Calendar className="h-3.5 w-3.5 shrink-0" />
                                                {format(new Date(report.generated_at), 'dd/MM/yyyy')}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <Select
                                                value={report.status}
                                                onValueChange={(value) => handleStatusChange(report.alert_id, value)}
                                            >
                                                <SelectTrigger className="w-full h-8 text-xs font-bold uppercase">
                                                    <SelectValue placeholder="Status" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="sent_to_intermediary">Sent to Intermediary</SelectItem>
                                                    <SelectItem value="closed">Closed</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </td>
                                        <td className="px-4 py-3 align-middle">
                                            {report.status === 'closed' && report.closing_remarks ? (
                                                <div className="text-xs text-gray-700 dark:text-gray-300 break-words">
                                                    <span className={expandedRemarks[report.alert_id] ? '' : 'line-clamp-2'}>{report.closing_remarks}</span>
                                                    {report.closing_remarks.length > 80 && (
                                                        <button
                                                            onClick={() => setExpandedRemarks(prev => ({ ...prev, [report.alert_id]: !prev[report.alert_id] }))}
                                                            className="text-blue-600 hover:text-blue-800 text-[11px] font-medium mt-0.5 block"
                                                        >
                                                            {expandedRemarks[report.alert_id] ? 'Show Less' : 'Read More'}
                                                        </button>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-gray-400 text-sm block text-center">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                                                    <Link to={`/reports/generate/${report.alert_id}`}>
                                                        <Eye className="h-4 w-4" />
                                                    </Link>
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                                                    <Link to={`/reports/generate/${report.alert_id}?print=true`}>
                                                        <Download className="h-4 w-4" />
                                                    </Link>
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination Controls */}
                    {pagination.totalPages > 1 && (
                        <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-[#0f0f0f] border-t border-gray-200 dark:border-gray-800 rounded-b-xl">
                            <span className="text-sm text-gray-500">
                                Showing {((pagination.page - 1) * pagination.limit) + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} reports
                            </span>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2"
                                    disabled={currentPage <= 1}
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                    Prev
                                </Button>
                                <span className="text-sm font-medium px-2">
                                    Page {pagination.page} of {pagination.totalPages}
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2"
                                    disabled={currentPage >= pagination.totalPages}
                                    onClick={() => setCurrentPage(p => Math.min(pagination.totalPages, p + 1))}
                                >
                                    Next
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Status Change Confirmation Dialog */}
            <Dialog open={confirmDialog.open} onOpenChange={(open) => !open && setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' })}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold">
                            {confirmDialog.newStatus === 'closed' ? 'Close Report' : 'Confirm Status Update'}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4 py-4">
                        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                            <p className="text-sm text-gray-700 dark:text-gray-300">
                                Do you want to update the report status from{' '}
                                <span className="font-semibold text-amber-700 dark:text-amber-400 capitalize">
                                    {confirmDialog.oldStatus?.replace(/_/g, ' ')}
                                </span>
                                {' '}to{' '}
                                <span className="font-semibold text-blue-700 dark:text-blue-400 capitalize">
                                    {confirmDialog.newStatus?.replace(/_/g, ' ')}
                                </span>
                                ?
                            </p>
                        </div>
                        {confirmDialog.newStatus === 'closed' && (
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                    Closing Remarks <span className="text-red-500">*</span>
                                </label>
                                <textarea
                                    value={confirmDialog.closingRemarks || ''}
                                    onChange={(e) => setConfirmDialog(prev => ({ ...prev, closingRemarks: e.target.value }))}
                                    placeholder="Enter closing remarks (e.g., content removed, account suspended, no action needed...)"
                                    className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                                    rows={4}
                                />
                            </div>
                        )}
                    </div>

                    <div className="flex gap-3 justify-end">
                        <Button
                            variant="outline"
                            onClick={() => setConfirmDialog({ open: false, reportId: null, newStatus: null, oldStatus: null, closingRemarks: '' })}
                            className="px-4"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={confirmStatusUpdate}
                            disabled={confirmDialog.newStatus === 'closed' && !confirmDialog.closingRemarks?.trim()}
                            className="px-4 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                        >
                            {confirmDialog.newStatus === 'closed' ? 'Close Report' : 'Continue'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

        </div>
    );
};

export default ReportsContent;