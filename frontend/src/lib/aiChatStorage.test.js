import { chatKey, clearAllAiChat, conversationKey, LEGACY_CHAT_KEY } from './aiChatStorage';

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        get length() { return Object.keys(data).length; },
        key: (i) => Object.keys(data)[i] ?? null,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
        dump: () => ({ ...data }),
    };
}

test('keys are per tenant and per officer', () => {
    const a = { id: 'u1', tenant_id: 't1' };
    const b = { id: 'u2', tenant_id: 't1' };
    const c = { id: 'u1', tenant_id: 't2' };
    expect(chatKey(a)).not.toEqual(chatKey(b));
    expect(chatKey(a)).not.toEqual(chatKey(c));
    expect(conversationKey(a)).not.toEqual(chatKey(a));
});

test('nobody signed in means nothing is persisted', () => {
    expect(chatKey(null)).toBeNull();
    expect(conversationKey({})).toBeNull();
});

test('logout clears every AI chat key, including the old unscoped one', () => {
    const s = memoryStorage({
        [LEGACY_CHAT_KEY]: '[]',
        'soceye.ai.chat.v2:t1:u1': '[]',
        'soceye.ai.conv.v1:t1:u1': '"abc"',
        'soceye.ai.useDb': 'true',
        tenantSlug: 'x',
    });
    expect(clearAllAiChat(s)).toBe(3);
    expect(s.dump()).toEqual({ 'soceye.ai.useDb': 'true', tenantSlug: 'x' });
});
