import React, { useState, useCallback, useEffect, useRef } from 'react';
import api from '../lib/api';
import { toast } from 'sonner';
import {
  Search, RefreshCw, Loader2, Rss, MapPin, Globe, Calendar,
  Tag, ExternalLink, BookOpen, Trash2, X, Plus, Key,
  Clock, AlertTriangle,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import { useRbac } from '../contexts/RbacContext';
import DistrictField, { hasValidDistrictSelection } from '../components/DistrictField';
import { useScopedLocation } from '../hooks/useScopedLocation';

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORY_CONFIG = {
  crime:           { label: 'Crime',            color: 'bg-red-500 text-white' },
  accident:        { label: 'Accident',          color: 'bg-rose-600 text-white' },
  law_order:       { label: 'Law & Order',       color: 'bg-orange-500 text-white' },
  drugs:           { label: 'Drugs',             color: 'bg-purple-600 text-white' },
  cyber_crime:     { label: 'Cyber Crime',       color: 'bg-indigo-600 text-white' },
  pocso:           { label: 'POCSO',             color: 'bg-pink-600 text-white' },
  police_operation:{ label: 'Police Operation',  color: 'bg-blue-600 text-white' },
  general:         { label: 'General',           color: 'bg-slate-500 text-white' },
};

const LANG_CONFIG = {
  en:      { label: 'EN', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  te:      { label: 'TE', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  hi:      { label: 'HI', color: 'bg-green-100 text-green-700 border-green-200' },
  unknown: { label: '?',  color: 'bg-slate-100 text-slate-500 border-slate-200' },
};

function timeAgo(date) {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── News Card ─────────────────────────────────────────────────────────────────
const NewsCard = ({ article, onReadMore, onDelete, canDelete }) => {
  const [imgError, setImgError] = useState(false);
  const catConfig  = CATEGORY_CONFIG[article.category] || CATEGORY_CONFIG.general;
  const langConfig = LANG_CONFIG[article.language]  || LANG_CONFIG.en;
  const hasLocation = article.detected_location?.location_found;
  const locationLabel = article.detected_location?.district || article.detected_location?.city || '';
  const displayTitle   = article.title_english || article.title;
  const displaySummary = article.summary_english || article.summary;
  const pubDate = article.published_date ? new Date(article.published_date) : null;

  return (
    <div
      className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-lg hover:border-blue-300 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden flex flex-col group cursor-pointer"
      onClick={() => onReadMore?.(article)}
    >
      {/* Image */}
      <div className="relative w-full h-44 shrink-0 overflow-hidden bg-gradient-to-br from-slate-100 to-blue-50">
        {article.image_url && !imgError ? (
          <img
            src={article.image_url} alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <AlertTriangle className="h-10 w-10 text-blue-200" />
            <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">No Image</span>
          </div>
        )}
        {/* Category badge */}
        <span className={cn('absolute top-2.5 left-2.5 text-[10px] font-bold px-2 py-0.5 rounded-full shadow-md', catConfig.color)}>
          {catConfig.label}
        </span>
        {/* Language badge */}
        <span className={cn('absolute top-2.5 right-2.5 text-[10px] font-bold px-2 py-0.5 rounded-full border bg-white/90 backdrop-blur-sm', langConfig.color)}>
          {langConfig.label}
        </span>
        {/* Location badge */}
        {hasLocation && locationLabel && (
          <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-black/50 text-white backdrop-blur-sm">
            <MapPin className="h-2.5 w-2.5" />{locationLabel}
          </span>
        )}
        {/* Delete button */}
        {canDelete && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete?.(article._id || article.id); }}
            className="absolute bottom-2.5 right-2.5 p-1.5 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-red-700"
            title="Delete article"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 p-4 gap-2.5 min-w-0">
        {/* Source + time */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe className="h-3 w-3 text-blue-400 shrink-0" />
            <span className="text-[11px] font-semibold text-blue-700 truncate">
              {article.source_name || article.source_domain || 'Unknown'}
            </span>
          </div>
          {article.scraped_at && (
            <span className="flex items-center gap-1 text-[10px] text-slate-400 shrink-0">
              <Clock className="h-2.5 w-2.5" />{timeAgo(article.scraped_at)}
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className="text-sm font-bold text-slate-900 leading-snug line-clamp-2 group-hover:text-blue-700 transition-colors">
          {displayTitle}
        </h3>

        {/* Summary */}
        {displaySummary && (
          <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-3 flex-1">
            {displaySummary}
          </p>
        )}

        {/* Keywords */}
        {article.keywords_matched?.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <Tag className="h-2.5 w-2.5 text-slate-300 shrink-0" />
            {article.keywords_matched.slice(0, 4).map((kw, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded-md font-semibold border border-blue-100">{kw}</span>
            ))}
            {article.keywords_matched.length > 4 && (
              <span className="text-[9px] text-slate-400">+{article.keywords_matched.length - 4}</span>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 mt-auto">
          {pubDate && (
            <span className="flex items-center gap-1 text-[10px] text-slate-400">
              <Calendar className="h-2.5 w-2.5" />{format(pubDate, 'dd MMM yyyy')}
            </span>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onReadMore?.(article); }}
              className="flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 transition-colors"
            >
              <BookOpen className="h-2.5 w-2.5" /> Read More
            </button>
            <a
              href={article.source_url} target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-700 transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" /> Source
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────
const HYDERABAD_ZONES = [
  'Hyderabad','Secunderabad','Cyberabad','Rachakonda','Old City',
  'Rangareddy','Medchal-Malkajgiri','Karimnagar','Warangal','Nizamabad',
  'Khammam','Nalgonda','Adilabad','Mahbubnagar','Sangareddy','Medak',
  'Suryapet','Siddipet',
];

const PoliceRssNews = () => {
  const { hasFeatureAccess } = useRbac();
  const canAddKeywords = hasFeatureAccess('/police-rss-news', 'view_keywords');
  const canDeleteKeywords = hasFeatureAccess('/police-rss-news', 'delete_keywords');
  const [articles,    setArticles]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagination,  setPagination]  = useState({ page: 1, pages: 1, total: 0, limit: 20 });
  const [canDelete,   setCanDelete]   = useState(false);

  // Filters
  const [search,     setSearch]     = useState('');
  const [district,   setDistrict]   = useState('all');
  const [category,   setCategory]   = useState('all');
  const [language,   setLanguage]   = useState('all');

  // Modals
  const [readArticle,    setReadArticle]    = useState(null);
  const [clearConfirm,   setClearConfirm]   = useState(false);
  const [kwOpen,         setKwOpen]         = useState(false);
  const [keywords,       setKeywords]       = useState([]);
  const [kwLoading,      setKwLoading]      = useState(false);
  const [kwInput,        setKwInput]        = useState('');
  const [kwSaving,       setKwSaving]       = useState(false);
  const [kwDistricts,    setKwDistricts]    = useState([]);
  const { state: scopedState } = useScopedLocation();

  // Refs for silent poll
  const searchTimer   = useRef(null);
  const pollTimer     = useRef(null);
  const latestIdRef   = useRef(null);

  // ── Fetch articles ─────────────────────────────────────────────────────────
  const fetchArticles = useCallback(async (page = 1, append = false) => {
    if (page === 1) setLoading(true);
    else setLoadingMore(true);
    try {
      const res = await api.get('/police-news', {
        params: {
          page, limit: 20,
          search:   search   || undefined,
          district: district !== 'all' ? district : undefined,
          category: category !== 'all' ? category : undefined,
          language: language !== 'all' ? language : undefined,
        },
      });
      const { articles: data = [], pagination: pg, can_delete } = res.data;
      setArticles(prev => append ? [...prev, ...data] : data);
      if (!append && data.length) latestIdRef.current = data[0]._id;
      setPagination(pg || { page: 1, pages: 1, total: 0, limit: 20 });
      if (!append) setCanDelete(!!can_delete);
    } catch (err) {
      console.error('[PoliceRss] fetch error:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [search, district, category, language]);

  // Initial load + filter changes
  useEffect(() => {
    setArticles([]);
    latestIdRef.current = null;
    fetchArticles(1, false);
  }, [search, district, category, language, fetchArticles]);

  // Silent background poll every 30s
  useEffect(() => {
    pollTimer.current = setInterval(async () => {
      try {
        const res = await api.get('/police-news', {
          params: {
            page: 1, limit: 20,
            search:   search   || undefined,
            district: district !== 'all' ? district : undefined,
            category: category !== 'all' ? category : undefined,
            language: language !== 'all' ? language : undefined,
          },
        });
        const { articles: data = [], pagination: pg, can_delete } = res.data;
        if (!data.length) return;
        const newestId = data[0]._id;
        if (!latestIdRef.current) { latestIdRef.current = newestId; return; }
        if (newestId === latestIdRef.current) return;
        setArticles(prev => {
          const existingIds = new Set(prev.map(a => a._id));
          const fresh = data.filter(a => !existingIds.has(a._id));
          if (!fresh.length) return prev;
          return [...fresh, ...prev];
        });
        setPagination(p => ({ ...p, total: pg?.total ?? p.total }));
        setCanDelete(!!can_delete);
        latestIdRef.current = newestId;
      } catch (_) {}
    }, 30000);
    return () => clearInterval(pollTimer.current);
  }, [search, district, category, language]);

  // ── Keywords ───────────────────────────────────────────────────────────────
  const fetchKeywords = useCallback(async () => {
    setKwLoading(true);
    try {
      const res = await api.get('/police-news/keywords');
      setKeywords(Array.isArray(res.data) ? res.data : []);
    } catch { toast.error('Failed to load keywords'); }
    finally { setKwLoading(false); }
  }, []);

  const handleAddKw = async () => {
    const kw = kwInput.trim();
    if (!kw) return;
    if (!hasValidDistrictSelection(kwDistricts)) {
      toast.error('Please select at least one district');
      return;
    }
    setKwSaving(true);
    try {
      await api.post('/police-news/keywords', { keyword: kw, state: scopedState || '', districts: kwDistricts });
      toast.success(`"${kw}" added`);
      setKwInput('');
      setKwDistricts([]);
      fetchKeywords();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to add keyword');
    } finally { setKwSaving(false); }
  };

  const handleToggleKw = async (id) => {
    try {
      const res = await api.patch(`/police-news/keywords/${id}`);
      setKeywords(prev => prev.map(k => k._id === id ? res.data : k));
    } catch { toast.error('Failed to toggle keyword'); }
  };

  const handleDeleteKw = async (id) => {
    try {
      await api.delete(`/police-news/keywords/${id}`);
      setKeywords(prev => prev.filter(k => k._id !== id));
      toast.success('Keyword removed');
    } catch { toast.error('Failed to delete keyword'); }
  };

  // ── Article delete ─────────────────────────────────────────────────────────
  const handleDeleteArticle = async (articleId) => {
    try {
      await api.delete(`/police-news/${articleId}`);
      setArticles(prev => prev.filter(a => (a._id || a.id) !== articleId));
      toast.success('Article deleted');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to delete article');
    }
  };

  // ── Clear all ──────────────────────────────────────────────────────────────
  const handleClearAll = async () => {
    try {
      const res = await api.delete('/police-news/clear-all');
      setArticles([]);
      setPagination({ page: 1, pages: 1, total: 0, limit: 20 });
      toast.success(res.data?.message || 'All articles cleared');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to clear articles');
    } finally { setClearConfirm(false); }
  };

  return (
    <div className="p-4 space-y-4 min-h-screen bg-slate-50">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-xl">
          <Rss className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-lg font-black text-slate-900">Police RSS News</h1>
          <p className="text-xs text-slate-500">Hyderabad Police · Crime · Law & Order</p>
        </div>
      </div>

      {/* ── Read More Modal ─────────────────────────────────────────────────── */}
      {readArticle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setReadArticle(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            {readArticle.image_url && (
              <div className="w-full h-56 overflow-hidden rounded-t-2xl">
                <img src={readArticle.image_url} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={e => e.target.style.display='none'} />
              </div>
            )}
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn('text-[11px] font-bold px-2.5 py-1 rounded-full', (CATEGORY_CONFIG[readArticle.category] || CATEGORY_CONFIG.general).color)}>
                  {(CATEGORY_CONFIG[readArticle.category] || CATEGORY_CONFIG.general).label}
                </span>
                <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
                  {readArticle.language?.toUpperCase()}
                </span>
                {readArticle.detected_location?.location_found && (
                  <span className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-700">
                    <MapPin className="h-3 w-3" />{readArticle.detected_location.district || readArticle.detected_location.city}
                  </span>
                )}
              </div>
              <h2 className="text-lg font-black text-slate-900 leading-snug">
                {readArticle.title_english || readArticle.title}
              </h2>
              {readArticle.is_translated && readArticle.title !== readArticle.title_english && (
                <p className="text-xs text-slate-400 italic">Original: {readArticle.title}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap border-b border-slate-100 pb-3">
                <span className="flex items-center gap-1 font-semibold text-blue-700"><Globe className="h-3 w-3" />{readArticle.source_name}</span>
                {readArticle.published_date && (
                  <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{format(new Date(readArticle.published_date), 'dd MMM yyyy, h:mm a')}</span>
                )}
              </div>
              {(readArticle.summary_english || readArticle.summary) && (
                <p className="text-sm text-slate-700 font-medium leading-relaxed">
                  {readArticle.summary_english || readArticle.summary}
                </p>
              )}
              {readArticle.content && (
                <div className="text-sm text-slate-600 leading-relaxed whitespace-pre-line border-t border-slate-100 pt-3">
                  {readArticle.content}
                </div>
              )}
              {readArticle.keywords_matched?.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-slate-100">
                  <Tag className="h-3 w-3 text-slate-400" />
                  {readArticle.keywords_matched.map((kw, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 bg-blue-50 text-blue-700 rounded-md font-semibold border border-blue-100">{kw}</span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 pt-2">
                <a href={readArticle.source_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors">
                  <ExternalLink className="h-3.5 w-3.5" /> Open Full Article
                </a>
                <button onClick={() => setReadArticle(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50 transition-colors">
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Clear All Confirm ───────────────────────────────────────────────── */}
      {clearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setClearConfirm(false)}>
          <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 text-base mb-2">Clear all RSS articles?</h3>
            <p className="text-xs text-slate-500 mb-4">This deletes every article from the database. Run the scraper again to repopulate.</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setClearConfirm(false)}>Cancel</Button>
              <Button size="sm" onClick={handleClearAll} className="bg-red-600 hover:bg-red-700 text-white">Delete All</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Keywords Modal ──────────────────────────────────────────────────── */}
      {kwOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setKwOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900">RSS Relevance Keywords</h3>
                <p className="text-xs text-slate-500 mt-0.5">Articles matching ≥1 keyword are imported. Changes take effect on the next scrape run.</p>
              </div>
              <button onClick={() => setKwOpen(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400"><X className="h-4 w-4" /></button>
            </div>
             {hasFeatureAccess('/police-rss-news', 'add_keywords') && (
            <div className="px-5 py-3 border-b border-slate-100 space-y-2">
              <div className="flex gap-2">
              <input
                type="text" value={kwInput}
                onChange={e => setKwInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddKw(); }}
                placeholder="Add keyword, e.g. cyberabad, pocso, drug bust..."
                disabled={kwSaving}
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-400"
              />
             
              <Button size="sm" onClick={handleAddKw} disabled={kwSaving || !kwInput.trim()} className="bg-blue-600 hover:bg-blue-700 text-white gap-1">
                {kwSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Add
              </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400 shrink-0">{scopedState || 'No state assigned'} ·</span>
                <div className="flex-1"><DistrictField value={kwDistricts} onChange={setKwDistricts} /></div>
              </div>
            </div>
            )}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {kwLoading ? (
                <div className="flex items-center justify-center py-8 text-xs text-slate-400 gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>
              ) : keywords.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400">No keywords yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {keywords.map(kw => (
                    <div key={kw._id} className={cn('flex items-center justify-between px-3 py-2 rounded-lg border', kw.is_active ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-100 opacity-60')}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn('text-sm font-medium truncate', kw.is_active ? 'text-slate-800' : 'text-slate-400 line-through')}>{kw.keyword}</span>
                        {kw.source === 'config' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 border border-blue-100 shrink-0">default</span>
                        )}
                        {kw.districts?.length > 0 && (
                          <span className="text-[9px] text-slate-400 shrink-0">{kw.districts.join(', ')}</span>
                        )}
                        {kw.added_by && (
                          <span className="text-[9px] text-slate-300 shrink-0">· {kw.added_by}{kw.created_at ? ` · ${new Date(kw.created_at).toLocaleDateString()}` : ''}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => handleToggleKw(kw._id)}
                          className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border transition-colors', kw.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200' : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200')}
                        >{kw.is_active ? 'Active' : 'Disabled'}</button>
                        {canDeleteKeywords && (
                          <button onClick={() => handleDeleteKw(kw._id)} className="p-1 rounded hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors"><Trash2 className="h-3 w-3" /></button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-3">
              <span>{keywords.filter(k => k.is_active).length} active</span>
              <span>·</span>
              <span>{keywords.filter(k => !k.is_active).length} disabled</span>
              <span>·</span>
              <span className="text-blue-400">{keywords.filter(k => k.source === 'config').length} built-in defaults</span>
              <span>·</span>
              <span className="text-slate-500">{keywords.filter(k => k.source !== 'config').length} user-added</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Filter Bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-slate-200 rounded-xl px-4 py-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
          <input
            type="text" placeholder="Search articles..." value={search}
            onChange={(e) => {
              clearTimeout(searchTimer.current);
              const v = e.target.value;
              searchTimer.current = setTimeout(() => setSearch(v), 400);
            }}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-400"
          />
        </div>

        {/* Zone/District */}
        <select value={district} onChange={e => setDistrict(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="all">All Zones</option>
          {HYDERABAD_ZONES.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* Category */}
        <select value={category} onChange={e => setCategory(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="all">All Categories</option>
          {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        {/* Language */}
        <select value={language} onChange={e => setLanguage(e.target.value)}
          className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="all">All Languages</option>
          <option value="en">English</option>
          <option value="te">Telugu</option>
          <option value="hi">Hindi</option>
        </select>

        {/* Actions */}
        <div className="ml-auto flex items-center gap-2">
          {!loading && pagination.total > 0 && (
            <span className="text-xs text-slate-500 whitespace-nowrap">
              <span className="font-semibold text-slate-700">{pagination.total}</span> articles
            </span>
          )}
         {hasFeatureAccess('/police-rss-news', 'view_keywords') && (
          <Button variant="outline" size="sm"
            onClick={() => { setKwOpen(true); fetchKeywords(); }}
            className="h-7 gap-1.5 text-xs text-blue-600 border-blue-200 hover:bg-blue-50">
            <Key className="h-3 w-3" /> Keywords
          </Button>)}
          
          {canDelete && (
            <Button variant="outline" size="sm" onClick={() => setClearConfirm(true)}
              className="h-7 gap-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50">
              <Trash2 className="h-3 w-3" /> Clear All
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => fetchArticles(1, false)} disabled={loading}
            className="h-7 gap-1.5 text-xs text-blue-600 border-blue-200 hover:bg-blue-50">
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {/* ── Skeleton ───────────────────────────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-white rounded-2xl border border-slate-200 overflow-hidden animate-pulse">
              <div className="h-44 bg-slate-100" />
              <div className="p-4 space-y-2.5">
                <div className="h-3 bg-slate-100 rounded w-1/2" />
                <div className="h-4 bg-slate-100 rounded w-full" />
                <div className="h-4 bg-slate-100 rounded w-3/4" />
                <div className="h-3 bg-slate-100 rounded w-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!loading && articles.length === 0 && (
        <div className="text-center py-16 bg-white rounded-xl border-2 border-dashed border-slate-200">
          <AlertTriangle className="h-12 w-12 mx-auto text-slate-200 mb-3" />
          <h3 className="text-sm font-semibold text-slate-700">No police news articles found</h3>
          <p className="text-xs text-slate-400 mt-1">
            {(district !== 'all' || category !== 'all' || language !== 'all' || search)
              ? 'Try clearing some filters.'
              : 'Run the Blura Engine to populate news: python police_main.py'}
          </p>
          {(district !== 'all' || category !== 'all' || language !== 'all' || search) && (
            <Button variant="outline" size="sm" className="mt-3 text-xs"
              onClick={() => { setSearch(''); setDistrict('all'); setCategory('all'); setLanguage('all'); }}>
              Clear Filters
            </Button>
          )}
        </div>
      )}

      {/* ── Article Grid ────────────────────────────────────────────────────── */}
      {!loading && articles.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {articles.map(article => (
              <NewsCard
                key={article._id || article.source_url}
                article={article}
                onReadMore={setReadArticle}
                onDelete={handleDeleteArticle}
                canDelete={canDelete}
              />
            ))}
          </div>

          {/* Load More */}
          {pagination.page < pagination.pages && (
            <div className="flex justify-center py-4">
              <Button variant="outline"
                onClick={() => {
                  const next = pagination.page + 1;
                  setPagination(p => ({ ...p, page: next }));
                  fetchArticles(next, true);
                }}
                disabled={loadingMore}
                className="gap-2 text-sm text-blue-600 border-blue-200 hover:bg-blue-50"
              >
                {loadingMore
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading...</>
                  : <>Load More · Page {pagination.page + 1} of {pagination.pages}</>
                }
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PoliceRssNews;
