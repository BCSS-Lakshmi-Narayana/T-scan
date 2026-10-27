import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../lib/api';
import { useRbac } from '../contexts/RbacContext';
import { Save, Plus, Trash2, TrendingUp, ShieldAlert, BrainCircuit, Wand2, FileText, Upload, Star, ChevronDown, ChevronUp, Eye, Pencil, Copy, Check, X, HelpCircle, AlertTriangle, Clock, Activity, MessageSquare, Radio, Settings2, Zap, Bot, Youtube, Facebook, Instagram, Gauge, Loader2 } from 'lucide-react';

const XLogo = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { ScrollArea } from '../components/ui/scroll-area';
import { toast } from 'sonner';
import DOMPurify from 'dompurify';
import Sources from './Sources';
import AccessManagement from './AccessManagement';
import PolicyManager from '../components/PolicyManager';
import { Badge } from '../components/ui/badge';
import RichTextEditor from '../components/RichTextEditor';
import DistrictField, { hasValidDistrictSelection } from '../components/DistrictField';
import { useScopedLocation } from '../hooks/useScopedLocation';
import { cn } from '../lib/utils';

const PLACEHOLDERS_GUIDE = [
  { key: 'SERIAL_NUMBER', desc: 'Case ID / Serial (e.g. X-2026-001)' },
  { key: 'DATE', desc: 'Current date (dd.mm.yyyy)' },
  { key: 'DATE_LONG', desc: 'Full date (e.g. 1st January 2026)' },
  { key: 'PLATFORM', desc: 'Platform name (X, YouTube, etc.)' },
  { key: 'PLATFORM_OPERATOR', desc: 'Company name (X Corp., Meta)' },
  { key: 'PLATFORM_DOMAIN', desc: 'URL (www.x.com, www.youtube.com)' },
  { key: 'AUTHOR_NAME', desc: 'Target user display name' },
  { key: 'AUTHOR_HANDLE', desc: 'Target user handle (with @)' },
  { key: 'PROFILE_URL', desc: 'Link to target profile' },
  { key: 'CONTENT_URL', desc: 'Link to the flagged post' },
  { key: 'CONTENT_TEXT', desc: 'Text content of the violation' },
  { key: 'POST_DATE', desc: 'Original post date' },
  { key: 'LEGAL_SECTIONS', desc: 'Full Law/BNS sections' },
  { key: 'LEGAL_SECTIONS_NUMBERS', desc: 'Just section numbers (e.g. 152)' },
  { key: 'CATEGORY', desc: 'Violation category (e.g. Hate Speech)' },
  { key: 'RISK_LEVEL', desc: 'Threat level (HIGH, MEDIUM, LOW)' },
  { key: 'IS_REPOST', desc: 'Repost flag (Yes/No)' },
  { key: 'ALERT_DESCRIPTION', desc: 'Full alert description' },
  { key: 'DEPARTMENT_NAME', desc: 'Police Department name' },
  { key: 'GOVERNMENT_NAME', desc: 'Government name' },
];

const PlaceholderSidebar = ({ onClose }) => {
  const [copiedKey, setCopiedKey] = useState(null);

  const handleCopy = (key) => {
    navigator.clipboard.writeText('{{' + key + '}}');
    setCopiedKey(key);
    toast.success(`Copied {{${key}}}`, {
      description: "Paste into your document",
      duration: 1500,
    });
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div className="w-56 shrink-0 bg-secondary/5 border-l flex flex-col min-h-0 animate-in slide-in-from-right-2 duration-200">
      <div className="p-2.5 border-b bg-secondary/10 flex items-center justify-between">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <BrainCircuit className="h-3 w-3" /> Data Tags
        </h4>
        <Button variant="ghost" size="icon" className="h-5 w-5 opacity-50 hover:opacity-100" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {PLACEHOLDERS_GUIDE.map(p => (
            <div
              key={p.key}
              onClick={() => handleCopy(p.key)}
              className="p-1.5 rounded-md bg-background border border-border/40 hover:border-primary/30 hover:bg-secondary/5 transition-all group cursor-pointer active:scale-[0.98]"
            >
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <code className="text-[9px] font-mono font-bold text-slate-700 dark:text-slate-300 tracking-tight bg-slate-100 dark:bg-slate-800 px-1 rounded">
                  {'{{' + p.key + '}}'}
                </code>
                <div className="flex items-center text-muted-foreground group-hover:text-primary transition-colors">
                  {copiedKey === p.key ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </div>
              </div>
              <p className="text-[8.5px] text-muted-foreground leading-tight">{p.desc}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="p-2 border-t bg-secondary/5">
        <div className="flex items-start gap-1.5">
          <div className="h-1 w-1 rounded-full bg-primary mt-1 shrink-0" />
          <p className="text-[8.5px] leading-relaxed text-muted-foreground italic">
            <strong>Click to copy</strong>
          </p>
        </div>
      </div>
    </div>
  );
};

// Module-level settings cache — survives component remounts (back-navigation)
let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60_000; // 1 minute
const VALID_TABS = ['general', 'sources', 'keywords', 'templates', 'access', 'policies'];
// tab key -> the feature id that grants its TabsTrigger (see rbacConfig.js "Tabs Settings" group)
const TAB_FEATURE_MAP = {
  general: 'configuration_tab_access',
  sources: 'profile_tab_access',
  keywords: 'Keywords_tab_access',
  templates: 'report_templates_tab_access',
  access: 'access_management_tab_access',
  policies: 'policy_manager_tab_access',
};

const Settings = () => {
  const { hasFeatureAccess } = useRbac();
  const [searchParams, setSearchParams] = useSearchParams();
  const [settings, setSettings] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [monPlatformTab, setMonPlatformTab] = useState('x');
  const [monCategory, setMonCategory] = useState('political');
  const [newKeyword, setNewKeyword] = useState({ category: 'violence', language: 'en', keyword: '', districts: [] });
  const { state: scopedState, districtOptions: scopedDistrictOptions } = useScopedLocation();
  const [transliterationEnabled, setTransliterationEnabled] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [thresholds, setThresholds] = useState([]);

  // Report Templates state
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templatePlatform, setTemplatePlatform] = useState('all');
  const [templateDistricts, setTemplateDistricts] = useState([]);
  const [templateDistrictFilter, setTemplateDistrictFilter] = useState('all');
  const [templateIsDefault, setTemplateIsDefault] = useState(false);
  const [templateFile, setTemplateFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [showPlaceholders, setShowPlaceholders] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  // 2-step upload: parse first, edit, then save
  const [uploadStep, setUploadStep] = useState(1); // 1 = pick file, 2 = edit content
  const [parsedHtml, setParsedHtml] = useState('');
  const [editedHtml, setEditedHtml] = useState('');
  const [showPlaceholderGuide, setShowPlaceholderGuide] = useState(true);
  // Edit existing template
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingHtml, setEditingHtml] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [thresholdsLoading, setThresholdsLoading] = useState(false);
  const tabFromUrl = searchParams.get('tab');
  const initialTab = VALID_TABS.includes(tabFromUrl) ? tabFromUrl : 'general';
  const [activeTab, setActiveTab] = useState(initialTab);
  const [isSaving, setIsSaving] = useState(false);

  // Ensure URL always has ?tab= on mount (so back-navigation works)
  useEffect(() => {
    if (!searchParams.get('tab')) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', initialTab);
        return next;
      }, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // View mode: 'tabs' or 'editor'
  const [viewMode, setViewMode] = useState('tabs');

  // ─── Unsaved changes tracking ───
  const [savedSettings, setSavedSettings] = useState(null);
  const [savedThresholds, setSavedThresholds] = useState([]);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const pendingTabRef = useRef(null);

  const hasUnsavedChanges = useCallback(() => {
    if (!savedSettings || !settings) return false;
    return JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
           JSON.stringify(thresholds) !== JSON.stringify(savedThresholds);
  }, [settings, savedSettings, thresholds, savedThresholds]);

  const handleTabChange = (newTab) => {
    if (hasUnsavedChanges()) {
      pendingTabRef.current = newTab;
      setShowUnsavedDialog(true);
    } else {
      // Only update the URL — the effect below will sync activeTab from it,
      // avoiding a race where setActiveTab and setSearchParams update at different ticks.
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', newTab);
        if (newTab !== 'sources') next.delete('platform');
        return next;
      }, { replace: true });
    }
  };

  // Single source of truth: activeTab always follows the URL (covers clicks + back/forward)
  useEffect(() => {
    const tabFromUrl = searchParams.get('tab');
    if (tabFromUrl && VALID_TABS.includes(tabFromUrl) && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the active tab isn't one this officer is granted (e.g. the default
  // "Configuration" landing tab), redirect to the first tab they do have —
  // otherwise they land on a hidden tab with no visible trigger and a blank pane.
  const visibleTabs = VALID_TABS.filter((t) => hasFeatureAccess('/settings', TAB_FEATURE_MAP[t]));
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.includes(activeTab)) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', visibleTabs[0]);
        return next;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabs.join(','), activeTab]);

  // Warn on browser/tab close
  useEffect(() => {
    const handler = (e) => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);



  // Transliteration logic
  const handleKeywordChange = async (e) => {
    const val = e.target.value;
    setNewKeyword(prev => ({ ...prev, keyword: val }));

    if (transliterationEnabled &&
      newKeyword.language !== 'en' &&
      newKeyword.language !== 'all') {

      const words = val.split(' ');
      const lastWord = words[words.length - 1];
      const isSpace = val.endsWith(' ');

      if (isSpace && words.length > 1) {
        const wordToConvert = words[words.length - 2];
        if (wordToConvert) {
          const langCode = newKeyword.language === 'te' ? 'te-t-i0-und' : 'hi-t-i0-und';
          try {
            const response = await fetch(
              `https://inputtools.google.com/request?text=${encodeURIComponent(wordToConvert)}&itc=${langCode}&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8`
            );
            const data = await response.json();
            if (data[0] === 'SUCCESS' && data[1] && data[1][0] && data[1][0][1]) {
              const transliteratedWord = data[1][0][1][0];
              const newVal = val.substring(0, val.lastIndexOf(wordToConvert)) + transliteratedWord + ' ';
              setNewKeyword(prev => ({ ...prev, keyword: newVal }));
            }
          } catch (err) { }
        }
        setSuggestions([]);
        return;
      }

      if (lastWord && lastWord.length > 0) {
        const langCode = newKeyword.language === 'te' ? 'te-t-i0-und' : 'hi-t-i0-und';
        try {
          const response = await fetch(
            `https://inputtools.google.com/request?text=${encodeURIComponent(lastWord)}&itc=${langCode}&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8`
          );
          const data = await response.json();
          if (data[0] === 'SUCCESS' && data[1] && data[1][0] && data[1][0][1]) {
            setSuggestions(data[1][0][1]);
          } else {
            setSuggestions([]);
          }
        } catch (err) {
          setSuggestions([]);
        }
      } else {
        setSuggestions([]);
      }
    } else {
      setSuggestions([]);
    }
  };

  const handleSuggestionClick = (suggestion) => {
    const val = newKeyword.keyword;
    const words = val.split(' ');
    words.pop();
    words.push(suggestion);
    const newVal = words.join(' ') + ' ';
    setNewKeyword(prev => ({ ...prev, keyword: newVal }));
    setSuggestions([]);

    setTimeout(() => {
      document.querySelector('input[name="keywordInput"]')?.focus();
    }, 10);
  };

  useEffect(() => {
    // Use cached data if fresh (instant back-navigation)
    if (_settingsCache && Date.now() - _settingsCacheTime < SETTINGS_CACHE_TTL) {
      const { settings: s, keywords: k, thresholds: t, templates: tp } = _settingsCache;
      setSettings(s);
      setSavedSettings(JSON.parse(JSON.stringify(s)));
      setKeywords(k);
      setThresholds(t);
      setSavedThresholds(JSON.parse(JSON.stringify(t)));
      setTemplates(tp);
      setLoading(false);
      setThresholdsLoading(false);
      setTemplatesLoading(false);
    } else {
      fetchAllSettingsData();
    }
  }, []);

  const fetchTemplates = async (district = templateDistrictFilter) => {
    try {
      setTemplatesLoading(true);
      const res = await api.get('/templates', { params: district && district !== 'all' ? { district } : {} });
      setTemplates(res.data);
    } catch (error) {
      console.error('Failed to load templates');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleUploadTemplate = async (e) => {
    e.preventDefault();
    if (!templateFile || !templateName.trim()) {
      toast.error('Please provide a template name and DOCX file');
      return;
    }
    if (!hasValidDistrictSelection(templateDistricts)) {
      toast.error('Please select at least one district');
      return;
    }
    // Step 1: Parse the DOCX first
    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('template', templateFile);
      const res = await api.post('/templates/parse', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setParsedHtml(res.data.html);
      setEditedHtml(res.data.html);
      setUploadStep(2);
      setTemplateDialogOpen(false);
      setViewMode('editor');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to parse document');
    } finally {
      setUploading(false);
    }
  };

  const handleSaveWithEditor = async () => {
    try {
      setUploading(true);
      // Upload original file to create the template record
      const formData = new FormData();
      formData.append('template', templateFile);
      formData.append('name', templateName.trim());
      formData.append('platform', templatePlatform);
      formData.append('is_default', templateIsDefault);
      formData.append('state', scopedState || '');
      formData.append('districts', JSON.stringify(templateDistricts));
      const res = await api.post('/templates/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      // Always save the edited HTML (user may have made edits or content was cleaned on load)
      await api.put(`/templates/${res.data.id}/content`, { html_content: editedHtml });
      toast.success('Template saved successfully');
      resetUploadDialog();
      setViewMode('tabs');
      fetchTemplates();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Save failed');
    } finally {
      setUploading(false);
    }
  };

  const resetUploadDialog = () => {
    setTemplateDialogOpen(false);
    setTemplateName('');
    setTemplatePlatform('all');
    setTemplateDistricts([]);
    setTemplateIsDefault(false);
    setTemplateFile(null);
    setUploadStep(1);
    setParsedHtml('');
    setEditedHtml('');
    setViewMode('tabs');
  };

  const handleEditTemplate = async (template) => {
    setEditingTemplate(template);
    setEditingHtml(template.html_content);
    setViewMode('editor');
  };

  const handleSaveEditedTemplate = async () => {
    try {
      setSavingEdit(true);
      await api.put(`/templates/${editingTemplate.id}/content`, { html_content: editingHtml });
      toast.success('Template updated');
      setEditingTemplate(null);
      setViewMode('tabs');
      fetchTemplates();
    } catch (error) {
      toast.error('Failed to save template');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteTemplate = async (id) => {
    try {
      await api.delete(`/templates/${id}`);
      toast.success('Template deleted');
      fetchTemplates();
    } catch (error) {
      toast.error('Failed to delete template');
    }
  };

  const handleSetDefault = async (id) => {
    try {
      await api.put(`/templates/${id}/default`);
      toast.success('Default template updated');
      fetchTemplates();
    } catch (error) {
      toast.error('Failed to set default');
    }
  };

  const handlePreviewTemplate = async (id) => {
    try {
      const res = await api.post(`/templates/${id}/preview`);
      setPreviewHtml(res.data.html);
      setPreviewOpen(true);
    } catch (error) {
      toast.error('Preview failed');
    }
  };

  // Single API call to load all settings page data
  const fetchAllSettingsData = async () => {
    try {
      const res = await api.get('/settings/all');
      const { settings: s, keywords: k, thresholds: t, templates: tp } = res.data;
      setSettings(s);
      setSavedSettings(JSON.parse(JSON.stringify(s)));
      setKeywords(k);
      setThresholds(t);
      setSavedThresholds(JSON.parse(JSON.stringify(t)));
      setTemplates(tp);
      // Populate module-level cache
      _settingsCache = { settings: s, keywords: k, thresholds: t, templates: tp };
      _settingsCacheTime = Date.now();
    } catch (error) {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
      setThresholdsLoading(false);
      setTemplatesLoading(false);
    }
  };

  const fetchData = async () => {
    try {
      const [settingsRes, keywordsRes] = await Promise.all([
        api.get('/settings'),
        api.get('/keywords')
      ]);
      setSettings(settingsRes.data);
      setSavedSettings(JSON.parse(JSON.stringify(settingsRes.data)));
      setKeywords(keywordsRes.data);
    } catch (error) {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const fetchThresholds = async () => {
    try {
      setThresholdsLoading(true);
      const res = await api.get('/alert-thresholds');
      setThresholds(res.data);
      setSavedThresholds(JSON.parse(JSON.stringify(res.data)));
    } catch (error) {
      toast.error('Failed to load velocity thresholds');
    } finally {
      setThresholdsLoading(false);
    }
  };

  const handleSaveThresholds = async () => {
    try {
      await api.put('/alert-thresholds/bulk', { thresholds });
      setSavedThresholds(JSON.parse(JSON.stringify(thresholds)));
      toast.success('Viral alert thresholds saved');
    } catch (error) {
      toast.error('Failed to save thresholds');
    }
  };



  const updateThreshold = (platform, metric, field, value) => {
    setThresholds(prev => prev.map(t =>
      t.platform === platform
        ? { ...t, [field]: parseInt(value) || 0 }
        : t
    ));
  };

  const handleSaveSettings = async (e) => {
    if (e) e.preventDefault();
    try {
      const res = await api.put('/settings', settings);
      setSavedSettings(JSON.parse(JSON.stringify(res.data)));
      setSettings(res.data);
      _settingsCache = null; // Invalidate cache on save
      toast.success('Settings saved successfully');
    } catch (error) {
      toast.error('Failed to save settings');
    }
  };

  const handleAddKeyword = async (e) => {
    e.preventDefault();
    if (!hasValidDistrictSelection(newKeyword.districts)) {
      toast.error('Please select at least one district');
      return;
    }
    try {
      await api.post('/keywords', { ...newKeyword, state: scopedState || '' });
      toast.success('Keyword added successfully');
      setDialogOpen(false);
      setNewKeyword({ category: 'violence', language: 'en', keyword: '', districts: [] });
      fetchData();
    } catch (error) {
      toast.error('Failed to add keyword');
    }
  };

  const handleDeleteKeyword = async (id) => {
    try {
      await api.delete(`/keywords/${id}`);
      toast.success('Keyword deleted successfully');
      fetchData();
    } catch (error) {
      toast.error('Failed to delete keyword');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (viewMode === 'editor') {
    const isEditing = !!editingTemplate;
    const title = isEditing ? `Edit Template — ${editingTemplate.name}` : `Upload Template — ${templateName}`;
    const handleSave = isEditing ? handleSaveEditedTemplate : handleSaveWithEditor;
    const currentHtml = isEditing ? editingHtml : editedHtml;
    const setCurrentHtml = isEditing ? setEditingHtml : setEditedHtml;
    const isSaving = isEditing ? savingEdit : uploading;

    return (
      <div className="flex flex-col h-[calc(100vh-120px)] bg-background border rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-300 select-text">
        {/* Editor Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-50/50 dark:bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-600/10 flex items-center justify-center">
              <FileText className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white leading-none">{title}</h2>
              <p className="text-xs text-gray-500 mt-1">Refine your legal document structure and placeholders.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => isEditing ? setViewMode('tabs') : resetUploadDialog()} className="h-9 px-4">
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving} className="h-9 px-6 bg-blue-600 hover:bg-blue-700 text-white font-semibold">
              {isSaving ? 'Saving...' : 'Save Template'}
            </Button>
          </div>
        </div>

        {/* Editor Content Area */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Main Editor Surface */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <RichTextEditor
              initialContent={currentHtml}
              onChange={setCurrentHtml}
              minHeight="100%"
              placeholder="Start drafting your template content..."
            />
          </div>

          {/* Integration Sidebar */}
          <PlaceholderSidebar />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300 p-4 md:p-6 lg:p-8 max-w-none" data-testid="settings-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Settings</h1>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="h-10 p-1 bg-muted/50 rounded-lg">
          {hasFeatureAccess('/settings', 'configuration_tab_access') && (
          <TabsTrigger value="general" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Configuration</TabsTrigger>
          )}
          {hasFeatureAccess('/settings', 'profile_tab_access') && (
          <TabsTrigger value="sources" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Profiles</TabsTrigger>
          )}
          {hasFeatureAccess('/settings', 'Keywords_tab_access') && (
          <TabsTrigger value="keywords" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Keywords</TabsTrigger>
          )}
          {hasFeatureAccess('/settings', 'report_templates_tab_access') && (  
          <TabsTrigger value="templates" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Report Templates</TabsTrigger>
          )}
          {hasFeatureAccess('/settings', 'access_management_tab_access') && (
          <TabsTrigger value="access" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Access Management</TabsTrigger>
          )}
          {hasFeatureAccess('/settings', 'policy_manager_tab_access') && (
          <TabsTrigger value="policies" className="text-xs px-5 py-2 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md data-[state=active]:font-semibold">Policy Manager</TabsTrigger>
          )}
        </TabsList>

      {/* Unsaved changes dialog */}
      <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Unsaved Changes
            </DialogTitle>
            <DialogDescription>
              You have unsaved changes. Do you want to save them before leaving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => {
              setSettings(JSON.parse(JSON.stringify(savedSettings)));
              setThresholds(JSON.parse(JSON.stringify(savedThresholds)));
              setIsDirty(false);
              setShowUnsavedDialog(false);
              if (pendingTabRef.current) {
                const t = pendingTabRef.current;
                setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('tab', t); if (t !== 'sources') next.delete('platform'); return next; }, { replace: true });
                pendingTabRef.current = null;
              }
            }}>Discard</Button>
            <Button onClick={async () => {
              await handleSaveSettings();
              await handleSaveThresholds();
              setShowUnsavedDialog(false);
              if (pendingTabRef.current) {
                const t = pendingTabRef.current;
                setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('tab', t); if (t !== 'sources') next.delete('platform'); return next; }, { replace: true });
                pendingTabRef.current = null;
              }
            }}>Save & Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

        {/* ═══ Configuration Tab ═══ */}
        {hasFeatureAccess('/settings', 'configuration_tab_access') && (
        <TabsContent value="general" className="space-y-6">

          {/* Save Bar */}
          {hasUnsavedChanges() && (
            <div className="sticky top-0 z-10 flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2.5 shadow-sm">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm font-medium">You have unsaved changes</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
                  setSettings(JSON.parse(JSON.stringify(savedSettings)));
                  setThresholds(JSON.parse(JSON.stringify(savedThresholds)));
                }}>Discard</Button>
                <Button size="sm" className="h-8 text-xs" disabled={isSaving} onClick={async () => { setIsSaving(true); try { await handleSaveSettings(); await handleSaveThresholds(); } finally { setIsSaving(false); } }}>
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />} {isSaving ? 'Saving...' : 'Save All Changes'}
                </Button>
              </div>
            </div>
          )}

          {/* ── Row 1: Profile Monitoring + Risk Levels + Viral Alerts ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Profile Monitoring */}
            {hasFeatureAccess('/settings', 'profile_monitoring') && (
            <Card className="border shadow-sm">
              <div className="flex items-center justify-between px-4 py-2.5 border-b">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Profile Monitoring</h3>
                </div>
                <Switch className="scale-90"
                  checked={settings?.api_config?.monitoring?.enabled !== false}
                  onCheckedChange={(checked) => setSettings(prev => ({
                    ...prev,
                    api_config: { ...prev?.api_config, monitoring: { ...prev?.api_config?.monitoring, enabled: checked } }
                  }))}
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex gap-0.5 bg-muted/50 p-0.5 rounded-md">
                  {[
                    { key: 'x', label: 'X', Icon: XLogo },
                    { key: 'instagram', label: 'Instagram', Icon: Instagram },
                    { key: 'facebook', label: 'Facebook', Icon: Facebook },
                    { key: 'youtube', label: 'YouTube', Icon: Youtube }
                  ].map(({ key, label, Icon }) => (
                    <button key={key} onClick={() => setMonPlatformTab(key)}
                      className={cn(
                        'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all',
                        monPlatformTab === key
                          ? 'bg-primary text-primary-foreground shadow-md ring-1 ring-primary/30 font-semibold'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  {[
                    { key: 'political', label: 'Political' },
                    { key: 'communal', label: 'Communal' },
                    { key: 'trouble_makers', label: 'Trouble Makers' },
                    { key: 'defamation', label: 'Defamation' },
                    { key: 'narcotics', label: 'Narcotics' },
                    { key: 'history_sheeters', label: 'History Sheeters' },
                    { key: 'others', label: 'Others' }
                  ].map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-xs">{label}</span>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="text" inputMode="numeric"
                          value={Math.round((settings?.api_config?.monitoring?.frequencies?.[monPlatformTab]?.[key] ?? 0) / 60)}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^0-9]/g, '');
                            const hrs = raw === '' ? 0 : parseInt(raw);
                            setSettings(prev => ({
                              ...prev,
                              api_config: {
                                ...prev?.api_config,
                                monitoring: {
                                  ...prev?.api_config?.monitoring,
                                  frequencies: {
                                    ...prev?.api_config?.monitoring?.frequencies,
                                    [monPlatformTab]: {
                                      ...prev?.api_config?.monitoring?.frequencies?.[monPlatformTab],
                                      [key]: hrs * 60
                                    }
                                  }
                                }
                              }
                            }));
                          }}
                          className="h-7 w-16 text-xs text-center"
                          disabled={settings?.api_config?.monitoring?.enabled === false}
                        />
                        <span className="text-[10px] text-muted-foreground">hrs</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
            )}

            {/* Risk Levels */}
            {hasFeatureAccess('/settings', 'risk_levels') && (
            <Card className="border shadow-sm">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                <ShieldAlert className="h-4 w-4 text-red-500" />
                <h3 className="text-sm font-semibold">Risk Levels</h3>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-red-500" /> High Risk
                  </Label>
                  <span className="text-[10px] text-red-500 font-medium">{settings?.risk_threshold_high ?? 70} – 100</span>
                </div>
                <Input
                  type="text" inputMode="numeric"
                  value={settings?.risk_threshold_high ?? 70}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setSettings({ ...settings, risk_threshold_high: raw === '' ? 0 : parseInt(raw) });
                  }}
                  className="h-8 text-xs"
                />
                <div className="flex items-center justify-between">
                  <Label className="text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-amber-500" /> Medium Risk
                  </Label>
                  <span className="text-[10px] text-amber-500 font-medium">{settings?.risk_threshold_medium ?? 40} – {(settings?.risk_threshold_high ?? 70) - 1}</span>
                </div>
                <Input
                  type="text" inputMode="numeric"
                  value={settings?.risk_threshold_medium ?? 40}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setSettings({ ...settings, risk_threshold_medium: raw === '' ? 0 : parseInt(raw) });
                  }}
                  className="h-8 text-xs"
                />
                <div className="flex items-center justify-between">
                  <Label className="text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-green-500" /> Low Risk
                  </Label>
                  <span className="text-[10px] text-green-500 font-medium">0 – {(settings?.risk_threshold_medium ?? 40) - 1}</span>
                </div>
              </div>
            </Card>
            )}

            {/* Viral Alerts */}
            {hasFeatureAccess('/settings', 'viral_alerts') && (
            <Card className="border shadow-sm">
              <div className="flex items-center justify-between px-4 py-2.5 border-b">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-purple-500" />
                  <h3 className="text-sm font-semibold">Viral Alerts</h3>
                </div>
                <div className="flex items-center gap-2">
                  <Switch className="scale-90"
                    checked={settings?.velocity_alerts_enabled ?? true}
                    onCheckedChange={(checked) => setSettings({ ...settings, velocity_alerts_enabled: checked })}
                  />
                </div>
              </div>
              <div className="p-4">
                <div className="rounded border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/30">
                        <th className="text-left font-medium px-2 py-1.5 text-muted-foreground"></th>
                        <th className="text-center font-medium px-1 py-1.5 text-green-600">Low</th>
                        <th className="text-center font-medium px-1 py-1.5 text-amber-600">Med</th>
                        <th className="text-center font-medium px-1 py-1.5 text-red-600">High</th>
                        <th className="text-center font-medium px-1 py-1.5 text-muted-foreground">Hrs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { platform: 'x', name: 'X', Icon: XLogo },
                        { platform: 'instagram', name: 'Instagram', Icon: Instagram },
                        { platform: 'facebook', name: 'Facebook', Icon: Facebook },
                        { platform: 'youtube', name: 'YouTube', Icon: Youtube }
                      ].map(({ platform, name, Icon }) => {
                        const t = thresholds.find(th => th.platform === platform);
                        if (!t) return null;
                        return (
                          <tr key={platform} className="border-t">
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="font-medium">{name}</span>
                              </div>
                            </td>
                            <td className="px-0.5 py-1.5">
                              <Input type="text" inputMode="numeric" value={t.low_threshold}
                                onChange={(e) => { const raw = e.target.value.replace(/[^0-9]/g, ''); updateThreshold(platform, null, 'low_threshold', raw === '' ? 0 : raw); }}
                                className="h-6 text-xs text-center px-1" />
                            </td>
                            <td className="px-0.5 py-1.5">
                              <Input type="text" inputMode="numeric" value={t.medium_threshold}
                                onChange={(e) => { const raw = e.target.value.replace(/[^0-9]/g, ''); updateThreshold(platform, null, 'medium_threshold', raw === '' ? 0 : raw); }}
                                className="h-6 text-xs text-center px-1" />
                            </td>
                            <td className="px-0.5 py-1.5">
                              <Input type="text" inputMode="numeric" value={t.high_threshold}
                                onChange={(e) => { const raw = e.target.value.replace(/[^0-9]/g, ''); updateThreshold(platform, null, 'high_threshold', raw === '' ? 0 : raw); }}
                                className="h-6 text-xs text-center px-1" />
                            </td>
                            <td className="px-0.5 py-1.5">
                              <Input type="text" inputMode="numeric" value={Math.round((t.time_window_minutes ?? 0) / 60)}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^0-9]/g, '');
                                  const hrs = raw === '' ? 0 : parseInt(raw);
                                  updateThreshold(platform, null, 'time_window_minutes', hrs * 60);
                                }}
                                className="h-6 text-xs text-center px-1" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
            )}
          </div>

          {/* ── Row 2: Event + Grievance ────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {hasFeatureAccess('/settings', 'events_monitoring') && (
            <Card className="border shadow-sm">
              <div className="flex items-center justify-between px-4 py-2.5 border-b">
                <div className="flex items-center gap-2">
                  <Radio className="h-4 w-4 text-amber-500" />
                  <h3 className="text-sm font-semibold">Events Monitoring</h3>
                </div>
                <Switch className="scale-90"
                  checked={settings?.api_config?.events?.enabled !== false}
                  onCheckedChange={(checked) => setSettings(prev => ({
                    ...prev,
                    api_config: { ...prev?.api_config, events: { ...prev?.api_config?.events, enabled: checked } }
                  }))}
                />
              </div>
              <div className="p-4 space-y-2">
                {[
                  { key: 'x', label: 'X', Icon: XLogo },
                  { key: 'instagram', label: 'Instagram', Icon: Instagram },
                  { key: 'facebook', label: 'Facebook', Icon: Facebook },
                  { key: 'youtube', label: 'YouTube', Icon: Youtube }
                ].map(({ key, label, Icon }) => (
                  <div key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs">{label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="text" inputMode="numeric"
                        value={Math.round((settings?.api_config?.events?.[key] ?? 0) / 60)}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/[^0-9]/g, '');
                          const hrs = raw === '' ? 0 : parseInt(raw);
                          setSettings(prev => ({
                            ...prev,
                            api_config: { ...prev?.api_config, events: { ...prev?.api_config?.events, [key]: hrs * 60 } }
                          }));
                        }}
                        className="h-7 w-16 text-xs text-center"
                        disabled={settings?.api_config?.events?.enabled === false}
                      />
                      <span className="text-[10px] text-muted-foreground">hrs</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            )}

            {hasFeatureAccess('/settings', 'grievance_monitoring') && (
            <Card className="border shadow-sm">
              <div className="flex items-center justify-between px-4 py-2.5 border-b">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-emerald-500" />
                  <h3 className="text-sm font-semibold">Grievance Monitoring</h3>
                </div>
                <Switch className="scale-90"
                  checked={settings?.api_config?.grievances?.enabled !== false}
                  onCheckedChange={(checked) => setSettings(prev => ({
                    ...prev,
                    api_config: { ...prev?.api_config, grievances: { ...prev?.api_config?.grievances, enabled: checked } }
                  }))}
                />
              </div>
              <div className="p-4 space-y-2">
                {[
                  { key: 'x', label: 'X', Icon: XLogo },
                  { key: 'facebook', label: 'Facebook', Icon: Facebook }
                ].map(({ key, label, Icon }) => (
                  <div key={key} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs">{label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="text" inputMode="numeric"
                        value={Math.round((settings?.api_config?.grievances?.[key] ?? 0) / 60)}
                        onChange={(e) => {
                          const raw = e.target.value.replace(/[^0-9]/g, '');
                          const hrs = raw === '' ? 0 : parseInt(raw);
                          setSettings(prev => ({
                            ...prev,
                            api_config: { ...prev?.api_config, grievances: { ...prev?.api_config?.grievances, [key]: hrs * 60 } }
                          }));
                        }}
                        className="h-7 w-16 text-xs text-center"
                        disabled={settings?.api_config?.grievances?.enabled === false}
                      />
                      <span className="text-[10px] text-muted-foreground">hrs</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            )}
          </div>

          {/* Save */}
          <div className="flex justify-end">
            <Button disabled={isSaving} onClick={async () => { setIsSaving(true); try { await handleSaveSettings(); await handleSaveThresholds(); } finally { setIsSaving(false); } }} className="px-6">
              {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />} {isSaving ? 'Saving...' : 'Save All Changes'}
            </Button>
          </div>
        </TabsContent>

            )}

        <TabsContent value="sources" className="mt-2">
          <Sources />
        </TabsContent>

        {/* Keywords */}
        <TabsContent value="keywords" className="space-y-4">
          <Card className="p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Keywords</h3>
                <div className="flex gap-2">
                  <Button
                    variant="outline" size="sm" className="h-7 px-2 text-xs"
                    onClick={async () => {
                      try { await api.post('/keywords/scan'); toast.success('Scan started'); }
                      catch { toast.error('Scan failed'); }
                    }}
                  >Scan</Button>
                  {hasFeatureAccess('/settings', 'add_keywords') && (
                  <Dialog open={dialogOpen} onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) { setNewKeyword({ category: 'violence', language: 'en', keyword: '', districts: [] }); setTransliterationEnabled(true); setSuggestions([]); }
                  }}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="h-7 px-2 text-xs"><Plus className="h-3 w-3 mr-1" /> Add</Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[400px]">
                      <DialogHeader>
                        <DialogTitle className="text-base">Add Keyword</DialogTitle>
                        <DialogDescription className="text-[10px]">
                          Enter a specific keyword or phrase to monitor for potential violations.
                        </DialogDescription>
                      </DialogHeader>
                      <form onSubmit={handleAddKeyword} className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Category</Label>
                            <Select value={newKeyword.category} onValueChange={(v) => setNewKeyword({ ...newKeyword, category: v })}>
                              <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="violence">Violence</SelectItem>
                                <SelectItem value="threat">Threat</SelectItem>
                                <SelectItem value="hate">Hate</SelectItem>
                                <SelectItem value="other">Others</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Language</Label>
                            <Select value={newKeyword.language} onValueChange={(v) => setNewKeyword({ ...newKeyword, language: v })}>
                              <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="en">English</SelectItem>
                                <SelectItem value="hi">Hindi</SelectItem>
                                <SelectItem value="te">Telugu</SelectItem>
                                <SelectItem value="all">All</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Keyword</Label>
                          {newKeyword.language !== 'en' && newKeyword.language !== 'all' && (
                            <div className="flex items-center gap-2 mt-1 mb-1">
                              <Switch checked={transliterationEnabled} onCheckedChange={setTransliterationEnabled} className="scale-75" />
                              <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Wand2 className="h-3 w-3" /> Auto-transliterate</span>
                            </div>
                          )}
                          <div className="relative">
                            <Input name="keywordInput" value={newKeyword.keyword} onChange={handleKeywordChange} placeholder="Enter keyword" required className="h-8 text-xs" autoComplete="off" />
                            {suggestions.length > 0 && (
                              <div className="absolute z-50 w-full mt-1 bg-background border rounded-md shadow-lg">
                                {suggestions.map((s, i) => (
                                  <button key={i} type="button" onClick={() => handleSuggestionClick(s)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent">{s}</button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">State</Label>
                          <Input disabled value={scopedState || 'No state assigned'} className="h-8 text-xs mt-1 bg-muted text-muted-foreground" />
                        </div>
                        <div>
                          <Label className="text-xs">Districts *</Label>
                          <div className="mt-1">
                            <DistrictField value={newKeyword.districts} onChange={(v) => setNewKeyword({ ...newKeyword, districts: v })} />
                          </div>
                        </div>
                        <Button type="submit" className="w-full h-8 text-xs">Add</Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                  )}
                </div>
              </div>

              <Tabs defaultValue="violence" className="space-y-2">
                <TabsList className="h-8 p-1">
                  <TabsTrigger value="violence" className="text-xs px-3">Violence</TabsTrigger>
                  <TabsTrigger value="threat" className="text-xs px-3">Threat</TabsTrigger>
                  <TabsTrigger value="hate" className="text-xs px-3">Hate</TabsTrigger>
                  <TabsTrigger value="other" className="text-xs px-3">Others</TabsTrigger>
                </TabsList>
                {['violence', 'threat', 'hate', 'other'].map(category => {
                  const catKw = keywords.filter(k => k.category === category);
                  return (
                    <TabsContent key={category} value={category}>
                      {catKw.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-6">No keywords</p>
                      ) : (
                        <ScrollArea className="h-[200px]">
                          <div className="flex flex-wrap gap-2 pr-2">
                            {catKw.map(kw => (
                              <div key={kw.id} className="group inline-flex items-center gap-1.5 px-2 py-1 rounded border bg-secondary/30 text-xs" title={`${kw.created_by ? `Added by ${kw.created_by}` : ''}${kw.created_at ? ` on ${new Date(kw.created_at).toLocaleDateString()}` : ''}${kw.districts?.length ? ` · ${kw.districts.join(', ')}` : ''}`}>
                                <Badge variant="outline" className="text-[10px] px-1 py-0">{kw.language?.toUpperCase() || 'EN'}</Badge>
                                <span>{kw.keyword}</span>
                                <button onClick={() => handleDeleteKeyword(kw.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      )}
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>
          </Card>
        </TabsContent>

        {/* Report Templates */}
        <TabsContent value="templates" className="space-y-4">
          <Card className="p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold">Report Templates</h3>
                    <p className="text-[10px] text-muted-foreground">Upload any DOCX — edit before saving. Alert data auto-fills when generating reports.</p>
                  </div>
                </div>

                {/* Upload Template Dialog */}
                {hasFeatureAccess('/settings', 'upload_template') && (
                <Dialog open={templateDialogOpen} onOpenChange={(open) => {
                  if (!open) resetUploadDialog();
                  else setTemplateDialogOpen(true);
                }}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="h-7 px-2 text-xs"><Upload className="h-3 w-3 mr-1" /> Upload Template</Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[450px]">
                    <DialogHeader>
                      <DialogTitle className="text-base">Upload DOCX Template</DialogTitle>
                      <DialogDescription className="text-[10px]">Select a DOCX file to use as a report base.</DialogDescription>
                    </DialogHeader>

                    <form onSubmit={handleUploadTemplate} className="space-y-4">
                      <div>
                        <Label className="text-xs">Template Name</Label>
                        <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. IT Cell Notice - X" className="h-8 text-xs mt-1" required />
                      </div>
                      <div>
                        <Label className="text-xs">Platform</Label>
                        <Select value={templatePlatform} onValueChange={setTemplatePlatform}>
                          <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Platforms</SelectItem>
                            <SelectItem value="x">X (Twitter)</SelectItem>
                            <SelectItem value="youtube">YouTube</SelectItem>
                            <SelectItem value="facebook">Facebook</SelectItem>
                            <SelectItem value="instagram">Instagram</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">State</Label>
                        <Input disabled value={scopedState || 'No state assigned'} className="h-8 text-xs mt-1 bg-secondary/30" />
                      </div>
                      <div>
                        <Label className="text-xs">Districts *</Label>
                        <div className="mt-1">
                          <DistrictField value={templateDistricts} onChange={setTemplateDistricts} />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs">DOCX File</Label>
                        <div className="mt-1 border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors" onClick={() => document.getElementById('template-file-input').click()}>
                          <input id="template-file-input" type="file" accept=".docx,.doc" className="hidden" onChange={(e) => setTemplateFile(e.target.files[0])} />
                          {templateFile ? (
                            <div className="flex items-center justify-center gap-2">
                              <FileText className="h-4 w-4 text-green-600" />
                              <span className="text-xs font-medium">{templateFile.name}</span>
                            </div>
                          ) : (
                            <div>
                              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-1" />
                              <p className="text-xs text-muted-foreground">Click to browse or drag a .docx file</p>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={templateIsDefault} onCheckedChange={setTemplateIsDefault} className="scale-75" />
                        <Label className="text-xs">Set as default for this platform</Label>
                      </div>
                      <Button type="submit" className="w-full h-8 text-xs" disabled={uploading}>
                        {uploading ? 'Parsing document...' : 'Next — Parse & Edit ▸'}
                      </Button>
                    </form>
                  </DialogContent>
                </Dialog>
                )}
              </div>

              {/* District Filter */}
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">Filter by District</Label>
                <Select
                  value={templateDistrictFilter}
                  onValueChange={(v) => { setTemplateDistrictFilter(v); fetchTemplates(v); }}
                >
                  <SelectTrigger className="h-7 text-xs w-[200px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Districts</SelectItem>
                    {scopedDistrictOptions.map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Placeholder Reference */}
              <div className="border rounded-lg">
                <button onClick={() => setShowPlaceholders(!showPlaceholders)} className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-accent/50 transition-colors">
                  <span className="flex items-center gap-1.5"><BrainCircuit className="h-3.5 w-3.5" /> Placeholders Reference</span>
                  {showPlaceholders ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {showPlaceholders && (
                  <div className="px-3 pb-3 border-t">
                    <p className="text-[10px] text-muted-foreground mt-2 mb-2">For advanced control, add these placeholders in your DOCX</p>
                    <div className="grid grid-cols-2 gap-1">
                      {[
                        { key: 'SERIAL_NUMBER', desc: 'Report serial number' },
                        { key: 'DATE', desc: 'Current date (dd.mm.yyyy)' },
                        { key: 'DATE_LONG', desc: 'Full date format' },
                        { key: 'PLATFORM', desc: 'Platform name' },
                        { key: 'PLATFORM_OPERATOR', desc: 'Platform company' },
                        { key: 'PLATFORM_DOMAIN', desc: 'Platform URL' },
                        { key: 'AUTHOR_NAME', desc: 'User display name' },
                        { key: 'AUTHOR_HANDLE', desc: 'User handle (@)' },
                        { key: 'PROFILE_URL', desc: 'Profile URL' },
                        { key: 'CONTENT_URL', desc: 'Flagged post URL' },
                        { key: 'CONTENT_TEXT', desc: 'Flagged content text' },
                        { key: 'POST_DATE', desc: 'Post publish date' },
                        { key: 'LEGAL_SECTIONS', desc: 'Full legal sections' },
                        { key: 'LEGAL_SECTIONS_NUMBERS', desc: 'Section numbers' },
                        { key: 'CATEGORY', desc: 'Alert category' },
                        { key: 'RISK_LEVEL', desc: 'Risk level' },
                        { key: 'IS_REPOST', desc: 'Repost flag (Yes/No)' },
                        { key: 'ORIGINAL_AUTHOR', desc: 'Original author' },
                        { key: 'INTENT', desc: 'Detected intent' },
                        { key: 'ALERT_DESCRIPTION', desc: 'Alert description' },
                      ].map(p => (
                        <div key={p.key} className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary/30 text-[10px]">
                          <code className="font-mono font-bold text-primary">{'{{' + p.key + '}}'}</code>
                          <span className="text-muted-foreground truncate">{p.desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Template List */}
              {templates.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="text-xs text-muted-foreground">No templates uploaded yet</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Upload any DOCX to get started — no placeholders needed!</p>
                </div>
              ) : (
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2 pr-2">
                    {templates.map(t => (
                      <div key={t.id} className="group flex items-center justify-between p-3 rounded-lg border hover:border-primary/30 transition-colors bg-background">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="shrink-0 h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                            <FileText className="h-4 w-4 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold truncate">{t.name}</span>
                              {t.is_default && (
                                <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-300 text-amber-600 shrink-0">
                                  <Star className="h-2 w-2 mr-0.5 fill-current" /> Default
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge variant="secondary" className="text-[9px] px-1 py-0">
                                {t.platform === 'all' ? 'All Platforms' : t.platform.charAt(0).toUpperCase() + t.platform.slice(1)}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {(t.placeholders?.length || 0) > 0 ? `${t.placeholders.length} placeholders` : 'Auto-fill mode'}
                              </span>
                              <span className="text-[10px] text-muted-foreground">{t.original_filename}</span>
                              {(t.districts?.length || 0) > 0 && (
                                <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                                  {t.districts.length > 1 ? `${t.districts[0]} +${t.districts.length - 1}` : t.districts[0]}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleEditTemplate(t)} title="Edit Template">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleEditTemplate(t)} title="View / Edit Template">
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {!t.is_default && (
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleSetDefault(t.id)} title="Set as default">
                              <Star className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => handleDeleteTemplate(t.id)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="access" className="mt-2">
          <AccessManagement />
        </TabsContent>

        <TabsContent value="policies" className="mt-2">
          <PolicyManager />
        </TabsContent>

        {/* Template Preview Dialog */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="sm:max-w-[700px] max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base">Template Preview</DialogTitle>
              <DialogDescription className="sr-only">Visual preview of how the report will look with sample data.</DialogDescription>
            </DialogHeader>
            <div className="border rounded-lg p-6 bg-white dark:bg-slate-900 text-black dark:text-white prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }} />
          </DialogContent>
        </Dialog>

        {/* Edit Existing Template Dialog replaced by Full-Page Editor */}
      </Tabs>
    </div>
  );
};

export default Settings;
