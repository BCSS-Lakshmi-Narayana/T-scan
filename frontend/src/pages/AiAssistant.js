/**
 * The AI Assistant page.
 *
 * This page owns conversation state and the request to the assistant; every
 * surface it renders lives in components/ai. The backend scopes every answer
 * to the caller's tenant and districts, so nothing here needs to filter
 * results — but nothing here may widen them either: the question goes out as
 * typed.
 *
 * The conversation starts empty. A seeded greeting would spend the officer's
 * first screen on the tool describing itself; the empty state does that job in
 * a glance and is replaced the moment a question is asked.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { AlertCircle } from 'lucide-react';

import api from '../lib/api';
import { cn } from '../lib/utils';
import { isAtBottom } from '../lib/scrollStick';
import { useRbac } from '../contexts/RbacContext';
import { useAuth } from '../contexts/AuthContext';
import { chatKey, conversationKey, LEGACY_CHAT_KEY, readJson, withoutSeededGreeting, writeJson }
    from '../lib/aiChatStorage';
import SoceyeDailyReport from '../components/reports/SoceyeDailyReport';

import AssistantHeader from '../components/ai/AssistantHeader';
import ChatMessage from '../components/ai/ChatMessage';
import ThinkingIndicator from '../components/ai/ThinkingIndicator';
import PromptGallery from '../components/ai/PromptGallery';
import SuggestionRail from '../components/ai/SuggestionRail';
import Composer from '../components/ai/Composer';
import { followupsFor } from '../components/ai/prompts';

const USE_DB_KEY = 'soceye.ai.useDb';
const MAX_PERSISTED_MESSAGES = 80;
// A scan can confirm hundreds of records; history keeps the first page's worth.
const MAX_PERSISTED_CARDS = 60;
const SCAN_POLL_MS = 900;
// The deep reading can run for minutes on a cold cache, so this is polled
// slowly: the officer already has a usable answer and is watching it deepen,
// not waiting on it.
const ANALYSIS_POLL_MS = 2500;

/** localStorage is unavailable in private mode and can throw on read. */
const readStored = (key, fallback) => {
    try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : raw;
    } catch {
        return fallback;
    }
};

export default function AiAssistant() {
    const { hasFeatureAccess } = useRbac();
    const { user } = useAuth();
    // History belongs to the signed-in officer: per tenant + user id, cleared
    // on logout. The old shared key is dropped — its owner cannot be known.
    const storageKey = chatKey(user);
    const convKey = conversationKey(user);

    const [activeTab, setActiveTab] = useState('chat');
    const [messages, setMessages] = useState(() => {
        try { window.localStorage.removeItem(LEGACY_CHAT_KEY); } catch { /* ignore */ }
        return withoutSeededGreeting(readJson(window.localStorage, storageKey, null));
    });
    const [v2Enabled, setV2Enabled] = useState(false);
    const [conversationId, setConversationId] = useState(() => readJson(window.localStorage, convKey, null));
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [health, setHealth] = useState(null);
    const [windowDays, setWindowDays] = useState(7);
    const [useDb, setUseDb] = useState(() => readStored(USE_DB_KEY, 'true') !== 'false');

    const scrollRef = useRef(null);
    // Whether the officer is reading the newest turn or has scrolled up into
    // the evidence. Deep analysis rewrites the answer every couple of seconds,
    // and following new content unconditionally dragged them back down each
    // time, which made anything above the fold unreadable while it ran.
    const stickRef = useRef(true);
    const abortRef = useRef(null);
    const composerRef = useRef(null);
    // jobId -> pending poll timer, so unmount stops every poll.
    const pollersRef = useRef(new Map());
    const mountedRef = useRef(true);

    /* ─── tabs (RBAC-gated) ─── */
    const TABS = useMemo(() => ([
        { id: 'chat', featureId: 'ai_chat', label: 'Assistant' },
        { id: 'dsr', featureId: 'soceye_daily_report', label: 'Daily Report' },
    ].filter((tab) => hasFeatureAccess('/ai-assistant', tab.featureId))), [hasFeatureAccess]);

    const tabIds = TABS.map((t) => t.id).join(',');
    useEffect(() => {
        if (TABS.length && !TABS.some((tab) => tab.id === activeTab)) setActiveTab(TABS[0].id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabIds]);

    /* ─── service health ─── */
    useEffect(() => {
        api.get('/rag/health')
            .then((r) => setHealth(r.data))
            .catch(() => setHealth({ healthy: false }));
    }, []);

    /* ─── the v2 pipeline is used only when the backend says it is on ─── */
    useEffect(() => {
        api.get('/rag/v2/status')
            .then((r) => setV2Enabled(!!r.data?.enabled))
            .catch(() => setV2Enabled(false));
    }, []);

    /* ─── persistence (per officer; nothing is kept when signed out) ─── */
    // The officer can arrive after the first render. When the key changes,
    // load THAT officer's history, and skip the write that would otherwise
    // store the previous state under the new key.
    const hydratedKeyRef = useRef(storageKey);
    const skipWriteRef = useRef(false);
    useEffect(() => {
        if (hydratedKeyRef.current === storageKey) return;
        hydratedKeyRef.current = storageKey;
        skipWriteRef.current = true;
        setMessages(withoutSeededGreeting(readJson(window.localStorage, storageKey, null)));
        setConversationId(readJson(window.localStorage, convKey, null));
    }, [storageKey, convKey]);

    useEffect(() => {
        if (skipWriteRef.current) {
            skipWriteRef.current = false;
            return;
        }
        const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => (
            m.scan ? { ...m, scan: { ...m.scan, matches: (m.scan.matches || []).slice(0, MAX_PERSISTED_CARDS) } } : m
        ));
        writeJson(window.localStorage, storageKey, trimmed);
        writeJson(window.localStorage, convKey, conversationId);
    }, [messages, storageKey, conversationId, convKey]);

    useEffect(() => {
        try { window.localStorage.setItem(USE_DB_KEY, String(useDb)); } catch { /* ignore */ }
    }, [useDb]);

    /* ─── follow the newest turn, but only for a reader who is at the bottom ─── */
    const onConversationScroll = useCallback(() => {
        stickRef.current = isAtBottom(scrollRef.current);
    }, []);

    useEffect(() => {
        if (!stickRef.current) return;
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages, loading]);

    /* ─── on-demand scans: poll until the backend finishes judging ─── */
    const updateScan = useCallback((jobId, patch) => {
        setMessages((all) => all.map((m) => (
            m.scan?.job_id === jobId ? { ...m, scan: { ...m.scan, ...patch } } : m
        )));
    }, []);

    const pollScan = useCallback((jobId) => {
        const timers = pollersRef.current;
        if (timers.has(jobId)) return;
        let failures = 0;

        const tick = async () => {
            if (!mountedRef.current) return;
            try {
                const { data } = await api.get(`/rag/scan/${jobId}`);
                if (!mountedRef.current) return;
                failures = 0;
                updateScan(jobId, data);
                if (data.status !== 'running') {
                    timers.delete(jobId);
                    return;
                }
            } catch (e) {
                // 404: the service restarted or the job outlived its TTL.
                if (e?.response?.status === 404 || ++failures >= 6) {
                    timers.delete(jobId);
                    updateScan(jobId, {
                        status: 'error',
                        error: 'This scan is no longer available. Ask the question again to re-run it.',
                    });
                    return;
                }
            }
            if (mountedRef.current) timers.set(jobId, setTimeout(tick, SCAN_POLL_MS));
        };
        timers.set(jobId, setTimeout(tick, 250));
    }, [updateScan]);

    // Resume scans that were still running when the page was left.
    useEffect(() => {
        messages.forEach((m) => {
            if (m.scan?.status === 'running') pollScan(m.scan.job_id);
            if (m.v2?.analysis?.status === 'running') pollAnalysis(m.v2.analysis.job_id);
        });
        const timers = pollersRef.current;
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            timers.forEach((t) => clearTimeout(t));
            timers.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ─── deep analysis: the reading that follows the answer ─── */
    // The answer is already on screen. This fills in the populations, the
    // progress and — when it finishes — replaces the initial retrieval with
    // the evidence chosen because of what was actually read.
    const pollAnalysis = useCallback((jobId) => {
        const timers = pollersRef.current;
        if (timers.has(jobId)) return;
        let failures = 0;

        const apply = (data, done) => {
            setMessages((all) => all.map((m) => {
                if (m.v2?.analysis?.job_id !== jobId) return m;
                const v2 = {
                    ...m.v2,
                    analysis: { ...(m.v2.analysis || {}), ...data },
                    populations: {
                        ...(m.v2.populations || {}),
                        analysed: data?.progress?.analysed ?? m.v2.populations?.analysed ?? 0,
                        ...(done && data.evidence
                            ? { displayed: data.evidence.length } : {}),
                    },
                    // Only swap the evidence once the representative set exists:
                    // until then what is on screen is the initial retrieval and
                    // is labelled that way.
                    ...(done && data.evidence?.length
                        ? { evidence: [...data.evidence,
                                       ...(m.v2.evidence || []).filter(
                                           (e) => e && e.type !== 'record' && e.type !== 'verdict')] }
                        : {}),
                };
                return { ...m, v2 };
            }));
        };

        const tick = async () => {
            if (!mountedRef.current) return;
            try {
                const { data } = await api.get(`/rag/v2/analysis/${jobId}`);
                if (!mountedRef.current) return;
                failures = 0;
                const done = data.status !== 'running';
                apply(data, done);
                if (done) {
                    timers.delete(jobId);
                    return;
                }
            } catch (e) {
                // The answer stands without the deep reading, so a lost job is
                // reported on the message rather than as a page error.
                if (e?.response?.status === 404 || ++failures >= 5) {
                    timers.delete(jobId);
                    apply({ status: 'error' }, true);
                    return;
                }
            }
            if (mountedRef.current) timers.set(jobId, setTimeout(tick, ANALYSIS_POLL_MS));
        };
        timers.set(jobId, setTimeout(tick, 600));
    }, []);

    const cancelScan = useCallback((jobId) => {
        api.delete(`/rag/scan/${jobId}`).catch(() => { /* the poll reports the outcome */ });
    }, []);

    const deepScan = useCallback(async (question) => {
        try {
            const { data } = await api.post('/rag/scan', { question, deep: true });
            setMessages((m) => [...m, { role: 'assistant', content: '', scan: data, ts: Date.now() }]);
            pollScan(data.job_id);
        } catch (e) {
            setMessages((m) => [...m, {
                role: 'assistant',
                content: `**Deep scan could not start.** ${e?.response?.data?.error || e.message}`,
                ts: Date.now(),
            }]);
        }
    }, [pollScan]);

    /* ─── ask ─── */
    const sendQuery = useCallback(async (question) => {
        const q = (question || '').trim();
        if (!q || loading) return;

        setInput('');
        // Asking is an explicit request to see the answer, wherever they were.
        stickRef.current = true;
        setMessages((m) => [...m, { role: 'user', content: q, ts: Date.now() }]);
        setLoading(true);

        const ctrl = new AbortController();
        abortRef.current = ctrl;

        // The toggle decides the PATH, not just a flag on it. General chat is a
        // question for the model alone; the v2 pipeline exists to answer from
        // scoped, verified records. Sending general chat through it returned a
        // record dump — "who is the prime minister of India" came back as 1,077
        // posts about the BJP — because the grounded path has no other move.
        if (v2Enabled && useDb) {
            try {
                // The server owns the conversation: follow-ups are resolved there,
                // re-checked against the officer's current scope, and answered
                // from verified evidence. A stale id (expired, other session)
                // simply starts a new conversation.
                const ask = (cid) => api.post('/rag/v2/query', { question: q, conversation_id: cid }, { signal: ctrl.signal });
                let res;
                try {
                    res = await ask(conversationId);
                } catch (e) {
                    if (e?.response?.status !== 404 || !conversationId) throw e;
                    res = await ask(null);
                }
                const { data } = res;
                setConversationId(data.conversation_id || null);
                const r = data.response || {};
                setMessages((m) => [...m, {
                    role: 'assistant',
                    content: r.answer || '',
                    v2: r,
                    followups: r.status === 'answered' ? followupsFor(`${r.answer} ${q}`) : [],
                    ts: Date.now(),
                }]);
                if (r.analysis?.job_id && r.analysis?.status === 'running') {
                    pollAnalysis(r.analysis.job_id);
                }
            } catch (e) {
                const aborted = e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED';
                // The officer is told the investigation did not complete and is
                // given the question back to retry. The underlying error is for
                // the console, not for them: a status code or a stack trace is
                // not something they can act on.
                if (!aborted) console.error('AI assistant request failed', e);
                setMessages((m) => [...m, {
                    role: 'assistant',
                    content: aborted ? '_(generation stopped)_' : '',
                    failure: aborted ? null : { question: q },
                    ts: Date.now(),
                }]);
            } finally {
                setLoading(false);
                abortRef.current = null;
            }
            return;
        }

        try {
            // The signal belongs in axios's CONFIG argument. Passing it inside
            // the body — as this page did — sends it as a field and leaves the
            // request un-abortable, so Stop did nothing.
            const { data } = await api.post(
                '/rag/query',
                {
                    question: q,
                    collection: 'all',
                    top_k: 12,
                    time_window_days: useDb ? (windowDays || null) : null,
                    use_db: useDb,
                },
                { signal: ctrl.signal },
            );

            // An untagged concept comes back as a running scan, not an answer.
            if (data.scan?.job_id) {
                setMessages((m) => [...m, {
                    role: 'assistant',
                    content: '',
                    scan: data.scan,
                    followups: followupsFor(q),
                    ts: Date.now(),
                }]);
                pollScan(data.scan.job_id);
                return;
            }

            const answer = data.answer || '_(no answer)_';
            setMessages((m) => [...m, {
                role: 'assistant',
                content: answer,
                sources: data.sources || [],
                window: data.window_doc_count,
                followups: followupsFor(`${answer} ${q}`),
                ts: Date.now(),
            }]);
        } catch (e) {
            const aborted = e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED';
            setMessages((m) => [...m, {
                role: 'assistant',
                content: aborted
                    ? '_(generation stopped)_'
                    : `**Something went wrong.** ${e?.response?.data?.detail || e.message}`,
                ts: Date.now(),
            }]);
        } finally {
            setLoading(false);
            abortRef.current = null;
        }
    }, [loading, windowDays, useDb, pollScan, pollAnalysis, v2Enabled, conversationId]);

    const stopGenerating = useCallback(() => abortRef.current?.abort(), []);

    /** Put a suggested question in the box without sending it. */
    const composeQuery = useCallback((text) => {
        setInput(text);
        composerRef.current?.focus();
    }, []);

    const clearChat = useCallback(() => {
        if (!messages.length) return;
        if (!window.confirm('Clear the entire chat history?')) return;
        setMessages([]);
        setConversationId(null);
        try { if (storageKey) window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }, [messages.length, storageKey]);

    const showStarters = messages.length === 0;
    const lastIndex = messages.length - 1;

    return (
        <div className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-950">
            <AssistantHeader
                tabs={TABS}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                health={health}
                busy={loading}
                useDb={useDb}
                windowDays={windowDays}
                onClear={clearChat}
                canClear={activeTab === 'chat' && messages.length > 0}
            />

            <div className="min-h-0 flex-1 overflow-hidden">
                {activeTab === 'chat' && (
                    <div className="flex h-full min-h-0 flex-col">
                        {health && !health.healthy && (
                            <div className="flex items-start gap-2 border-b border-amber-200/70 bg-amber-50 px-4 py-2 text-[12px] text-amber-800 sm:px-6 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                                <AlertCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
                                The intelligence service is not responding. Answers may be
                                unavailable or incomplete.
                            </div>
                        )}

                        <div className="flex min-h-0 flex-1">
                            {/* The wide screen's spare band, put to work: the
                                suggestions stay reachable mid-conversation, not
                                only on the first screen. */}
                            <SuggestionRail
                                className="hidden lg:flex"
                                onPick={sendQuery}
                                disabled={loading}
                            />

                            {/* `relative` so the composer can float over the end
                                of the conversation instead of sitting in a bar
                                below it. */}
                            <div className="relative flex min-w-0 flex-1 flex-col">
                                <div ref={scrollRef} onScroll={onConversationScroll}
                                    className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-36 sm:px-6">
                                    <div className={cn('mx-auto flex w-full max-w-3xl flex-col',
                                        showStarters && 'min-h-full')}>
                                        {messages.map((m, i) => (
                                            <div
                                                key={`${m.ts || 'seed'}-${i}`}
                                                className={cn(
                                                    'min-w-0',
                                                    // A question opens a new turn, so the rule goes
                                                    // above it — never between a question and the
                                                    // answer it belongs to.
                                                    m.role === 'user' && i > 0
                                                        && 'mt-7 border-t border-slate-100 pt-7 dark:border-slate-900',
                                                    m.role === 'user' ? '' : 'mt-5',
                                                    i === 0 && 'mt-6',
                                                )}
                                            >
                                                <ChatMessage
                                                    message={m}
                                                    isLast={i === lastIndex && !loading}
                                                    onFollowup={sendQuery}
                                                    onDeepScan={deepScan}
                                                    onCancelScan={cancelScan}
                                                    onRetry={sendQuery}
                                                    onCompose={composeQuery}
                                                />
                                            </div>
                                        ))}

                                        {/* Direct child of AnimatePresence, or its exit
                                            animation never runs. */}
                                        <AnimatePresence>
                                            {loading && <ThinkingIndicator className="mt-5" grounded={useDb} />}
                                        </AnimatePresence>

                                        {showStarters && !loading && (
                                            <div className="flex min-h-0 flex-1 flex-col">
                                                <PromptGallery onPick={sendQuery} disabled={loading} />
                                            </div>
                                        )}

                                    </div>
                                </div>

                                <Composer
                                    ref={composerRef}
                                    value={input}
                                    onChange={setInput}
                                    onSend={() => sendQuery(input)}
                                    onStop={stopGenerating}
                                    loading={loading}
                                    useDb={useDb}
                                    onUseDbChange={setUseDb}
                                    windowDays={windowDays}
                                    onWindowChange={setWindowDays}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'dsr' && (
                    <div className="h-full overflow-y-auto">
                        <SoceyeDailyReport />
                    </div>
                )}
            </div>
        </div>
    );
}
