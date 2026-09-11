#!/usr/bin/env node
const assert = require('assert/strict');
const test = require('node:test');
const { relinkDiagnostic, waitForRequestState } = require('./paykit-request-scenarios');

const receiver = (id, status, generation, extra = {}) => ({ id, status, generation, secret: 'receiver-secret', ...extra });
const link = (state, generation, extra = {}) => ({ state, generation, handshakeRole: 'Initiator', pendingMessages: 2, failureCount: 1, lastSyncAt: '2026-09-11T00:00:00Z', lastReceiveAt: '2026-09-11T00:00:01Z', peerPublicKey: 'peer-secret', peerReceiverPath: 'peer/secret', endpoint: 'endpoint-secret', ...extra });

test('relink timeout reports both sides and only explicit public fields', async () => {
  const local = { id: 'local', path: 'alice/wallet' }; const remote = { id: 'remote', path: 'bob/wallet' };
  const snapshot = { receivers: [receiver('local', 'running', 3), receiver('remote', 'error', 4, { lastError: 'public receiver error' })], receiverWorkspaces: [
    { receiverId: 'local', links: [link('linking', 7)] },
    { receiverId: 'remote', links: [link('notLinked', 8, { handshakeRole: 'None', lastError: 'public link error' })] },
  ] };
  const owner = value => value.id === 'local' ? 'local-key' : 'remote-key';
  Object.assign(snapshot.receiverWorkspaces[0].links[0], { peerPublicKey: owner(remote), peerReceiverPath: remote.path });
  Object.assign(snapshot.receiverWorkspaces[1].links[0], { peerPublicKey: owner(local), peerReceiverPath: local.path });
  const operations = [
    { id: 'initiate', command: 'link.initiate', status: 'succeeded', result: { secret: 'result-secret' } },
    { id: 'accept', command: 'link.accept', status: 'failed', error: { code: 'public_code', message: 'public error', private: 'error-secret' }, result: { secret: 'result-secret' } },
  ];
  let tick = 0;
  await assert.rejects(waitForRequestState({ state: async () => snapshot, predicate: () => false, sleep: async () => {}, diagnostic: value => relinkDiagnostic(value, local, remote, owner, operations), timeoutMs: 2, now: () => tick++ }), error => {
    assert.match(error.message, /^Request scenario state condition timed out: /);
    const diagnostic = JSON.parse(error.message.slice(error.message.indexOf(': ') + 2));
    assert.deepEqual(Object.keys(diagnostic.receivers), ['local', 'remote']);
    assert.equal(diagnostic.links.local.state, 'linking'); assert.equal(diagnostic.links.remote.state, 'notLinked');
    assert.deepEqual(Object.keys(diagnostic.links.remote), ['state', 'generation', 'handshakeRole', 'pendingMessages', 'failureCount', 'lastSyncAt', 'lastReceiveAt', 'lastError']);
    assert.deepEqual(Object.keys(diagnostic.operations[0]), ['id', 'command', 'status']);
    assert.deepEqual(Object.keys(diagnostic.operations[1]), ['id', 'command', 'status', 'error']);
    assert.deepEqual(diagnostic.operations[1].error, { code: 'public_code', message: 'public error' });
    for (const forbidden of ['receiver-secret', 'peer-secret', 'peer/secret', 'endpoint-secret', 'result-secret', 'error-secret']) assert(!error.message.includes(forbidden));
    return true;
  });
});

test('relink wait preserves immediate success semantics', async () => {
  const snapshot = { ready: true }; let diagnostics = 0;
  const result = await waitForRequestState({ state: async () => snapshot, predicate: value => value.ready, sleep: async () => assert.fail('success must not sleep'), diagnostic: () => { diagnostics++; return {}; }, timeoutMs: 2, now: () => 0 });
  assert.equal(result, snapshot); assert.equal(diagnostics, 0);
});
