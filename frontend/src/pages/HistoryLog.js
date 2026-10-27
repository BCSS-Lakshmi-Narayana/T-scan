import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table';
import { History, Search, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Plus, Pencil, Trash2, User, Clock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useTenant } from '../context/TenantContext';

const MODULES = [
  { value: 'sources', label: 'Alerts / Profiles' },
  { value: 'events', label: 'Events' },
  { value: 'master_calendar_recurring', label: 'HCP Recurring' },
  { value: 'master_calendar_non_recurring', label: 'HCP Non-Recurring' },
  { value: 'viral_campaigns', label: 'Viral Campaign' },
  { value: 'rss_keywords', label: 'RSS News Keywords' },
  { value: 'keywords', label: 'Settings Keywords' },
  { value: 'policies', label: 'Policy Manager' },
  { value: 'users', label: 'Access Management' },
  { value: 'grievances', label: 'Grievances' },
  { value: 'report_templates', label: 'Report Templates' },
];
const MODULE_LABELS = Object.fromEntries(MODULES.map((m) => [m.value, m.label]));

const ROLE_LABELS = {
  'level-1': 'Officer',
  admin: 'Admin',
  superadmin: 'Super Admin',
};
const roleLabel = (role) => ROLE_LABELS[role] || role;

const ACTION_CONFIG = {
  create: { label: 'Created', icon: Plus, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  update: { label: 'Updated', icon: Pencil, className: 'bg-amber-50 text-amber-700 border-amber-200' },
  delete: { label: 'Deleted', icon: Trash2, className: 'bg-red-50 text-red-700 border-red-200' },
};

const ActionBadge = ({ action }) => {
  const cfg = ACTION_CONFIG[action] || { label: action, icon: History, className: 'bg-slate-100 text-slate-600 border-slate-200' };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${cfg.className}`}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </span>
  );
};

const PAGE_SIZE = 25;

const HistoryLog = () => {
  const { state: tenantState, districts: tenantDistricts } = useTenant();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const [moduleFilter, setModuleFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [districtFilter, setDistrictFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async (targetPage = 1) => {
    setLoading(true);
    try {
      const params = { page: targetPage, limit: PAGE_SIZE };
      if (moduleFilter !== 'all') params.module = moduleFilter;
      if (actionFilter !== 'all') params.action = actionFilter;
      if (stateFilter !== 'all') params.state = stateFilter;
      if (districtFilter !== 'all') params.district = districtFilter;
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      if (search.trim()) params.search = search.trim();

      const res = await api.get('/history-logs', { params });
      setLogs(res.data?.data || []);
      setTotal(res.data?.total || 0);
      setPages(res.data?.pages || 1);
      setPage(res.data?.page || targetPage);
    } catch {
      toast.error('Failed to load history log');
    } finally {
      setLoading(false);
    }
  }, [moduleFilter, actionFilter, stateFilter, districtFilter, startDate, endDate, search]);

  useEffect(() => { load(1); }, [load]);

  const resetFilters = () => {
    setModuleFilter('all'); setActionFilter('all'); setStateFilter('all'); setDistrictFilter('all'); setStartDate(''); setEndDate(''); setSearch('');
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-indigo-50 flex items-center justify-center">
          <History className="h-5 w-5 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-800">History Log</h1>
          <p className="text-sm text-gray-500">Every add, edit, and delete across all modules, with who did it and when.</p>
        </div>
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search record or user..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-9 text-sm" />
          </div>
          <Select value={moduleFilter} onValueChange={setModuleFilter}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Module" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modules</SelectItem>
              {MODULES.map((m) => (<SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Action" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectItem value="create">Created</SelectItem>
              <SelectItem value="update">Updated</SelectItem>
              <SelectItem value="delete">Deleted</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="State" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              {tenantState && (<SelectItem value={tenantState}>{tenantState}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={districtFilter} onValueChange={setDistrictFilter}>
            <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="District" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All districts</SelectItem>
              {(tenantDistricts || []).map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
            </SelectContent>
          </Select>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 text-sm" />
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 text-sm" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{total} record{total !== 1 ? 's' : ''}</span>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetFilters}>Clear filters</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16 text-sm text-muted-foreground">No history entries match these filters.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-8" />
                <TableHead>Timestamp</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Performed By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const isOpen = expandedId === log.id;
                return (
                  <React.Fragment key={log.id}>
                    <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => setExpandedId(isOpen ? null : log.id)}>
                      <TableCell>{isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        <span className="flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" />{new Date(log.created_at).toLocaleString()}</span>
                      </TableCell>
                      <TableCell className="text-xs font-medium">{MODULE_LABELS[log.module] || log.module}</TableCell>
                      <TableCell><ActionBadge action={log.action} /></TableCell>
                      <TableCell className="text-xs font-medium max-w-[220px] truncate">{log.record_label || '—'}</TableCell>
                      <TableCell className="text-xs">
                        <span className="flex items-center gap-1 text-muted-foreground"><User className="h-3 w-3" />{log.performed_by_name || log.performed_by_email || 'Unknown'}</span>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={6} className="text-xs">
                          <div className="py-2 px-1 space-y-1.5">
                            <div className="text-[11px] text-muted-foreground">
                              {log.performed_by_email} {log.performed_by_role ? `· ${roleLabel(log.performed_by_role)}` : ''}
                              {(log.state || (log.districts && log.districts.length > 0)) && (
                                <> · {log.state} {log.districts && log.districts.length > 0 ? `(${log.districts.join(', ')})` : ''}</>
                              )}
                            </div>
                            {log.changes && Object.keys(log.changes).length > 0 ? (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                {Object.entries(log.changes).map(([key, value]) => (
                                  <div key={key} className="flex gap-2 text-[12px]">
                                    <span className="font-semibold text-slate-500 shrink-0">{key}:</span>
                                    <span className="text-slate-700 dark:text-slate-300 break-all">
                                      {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-muted-foreground italic">No additional details recorded.</p>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Page {page} of {pages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Previous
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1" disabled={page >= pages || loading} onClick={() => load(page + 1)}>
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryLog;
