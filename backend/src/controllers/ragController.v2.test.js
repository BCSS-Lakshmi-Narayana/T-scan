// The v2 proxy must forward the AUTHENTICATED caller and nothing the body
// claims about who the caller is.
const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('./ragController');

const officer = {
  tenantId: 'tenant-alpha',
  user: { id: 'u-1', role: 'level-1', districts: ['Karimnagar'] },
  rbac: { permissions: { '/ai-assistant': { enabled: true, features: ['ai_chat'] } } },
};

test('caller identity comes from the session, not the body', () => {
  const body = rag.v2QueryBody({
    ...officer,
    body: {
      question: ' alerts ', tenant_id: 'tenant-beta', user_id: 'admin-1', role: 'admin',
      districts: null, permissions: { '/ai-assistant': { enabled: true, features: ['ai_deep_scan'] } },
    },
  });
  assert.equal(body.tenant_id, 'tenant-alpha');
  assert.equal(body.user_id, 'u-1');
  assert.equal(body.role, 'level-1');
  assert.deepEqual(body.districts, ['Karimnagar']);
  assert.deepEqual(body.permissions, officer.rbac.permissions);
  assert.equal(body.question, 'alerts');
});

test('admin is sent as unrestricted (null), an officer with no districts as []', () => {
  assert.equal(rag.v2Caller({ tenantId: 't', user: { id: 'a', role: 'admin' } }).districts, null);
  assert.deepEqual(rag.v2Caller({ tenantId: 't', user: { id: 'o', role: 'level-1' } }).districts, []);
});

test('superadmin is not treated as unrestricted by the proxy', () => {
  // Mirrors districtsFor(): only role "admin" is sent as null.
  assert.deepEqual(rag.v2Caller({ tenantId: 't', user: { id: 's', role: 'superadmin', districts: [] } }).districts, []);
});

test('requested districts pass only as a list; conversation id defaults to null', () => {
  const b = rag.v2QueryBody({ ...officer, body: { question: 'x', requested_districts: 'Hyderabad' } });
  assert.equal(b.requested_districts, null);
  assert.equal(b.conversation_id, null);
});
