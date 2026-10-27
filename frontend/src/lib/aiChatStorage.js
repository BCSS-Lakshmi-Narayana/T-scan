/**
 * Browser-side AI chat state, keyed to the signed-in officer.
 *
 * The chat used to live under one fixed key ('soceye.ai.chat.v1') that logout
 * never cleared, so on a shared machine the next officer saw the previous
 * officer's chat — including answers scoped to the previous officer's
 * districts. Now every key carries the tenant and the user id, and logout
 * removes every AI chat key, old and new.
 *
 * This is convenience state only. The server decides what anyone may see;
 * nothing stored here is ever sent back as authority.
 */

export const LEGACY_CHAT_KEY = 'soceye.ai.chat.v1';
const PREFIXES = ['soceye.ai.chat', 'soceye.ai.conv'];

const who = (user) => {
    const id = user?.id || user?._id;
    if (!id) return null;
    return `${user?.tenant_id || 'default'}:${id}`;
};

/** Chat history key for this officer, or null when nobody is signed in. */
export const chatKey = (user) => (who(user) ? `soceye.ai.chat.v2:${who(user)}` : null);

/** Server conversation id key for this officer, or null. */
export const conversationKey = (user) => (who(user) ? `soceye.ai.conv.v1:${who(user)}` : null);

/** Remove every AI chat key in this browser: all officers, all versions. */
export const clearAllAiChat = (storage = typeof window !== 'undefined' ? window.localStorage : null) => {
    if (!storage) return 0;
    let removed = 0;
    try {
        const keys = [];
        for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
        keys.filter((k) => k && PREFIXES.some((p) => k.startsWith(p))).forEach((k) => {
            storage.removeItem(k);
            removed += 1;
        });
    } catch { /* private mode: nothing was stored */ }
    return removed;
};

export const readJson = (storage, key, fallback) => {
    if (!key || !storage) return fallback;
    try {
        const raw = storage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
};

export const writeJson = (storage, key, value) => {
    if (!key || !storage) return;
    try { storage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
};

/**
 * Drop the greeting the assistant used to seed every conversation with.
 *
 * That message was written into each officer's saved history, so removing it
 * from the code did not remove it from their screen: it came back on load as a
 * saved turn, and because the conversation was then not empty, the starter
 * questions never appeared.
 *
 * A real turn always carries the timestamp it was created with. The seed never
 * did, which is exactly what identifies it — no matching on its wording, which
 * changed over time.
 */
export const withoutSeededGreeting = (messages) => (
    Array.isArray(messages)
        ? messages.filter((m) => !(m && m.role === 'assistant' && !m.ts))
        : []
);
