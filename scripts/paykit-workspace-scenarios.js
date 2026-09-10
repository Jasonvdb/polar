/* PR3 real Pubky scenarios. Success requires actual receiver state and public readback. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { sleep } = require('./paykit-harness');
const stages = ['explicit-links', 'link-validation', 'outbound-pause', 'encrypted-empty-list', 'offline-delivery', 'inbound-pause', 'blocked-peer', 'profiles-avatars', 'profile-validation', 'private-contacts', 'public-contacts', 'workspace-persistence'];
async function run({ initial, state, command, request, stage, docker, serviceContainer, signal }) {
  const alice = initial.participants.find(p => p.name === 'Alice');
  const bob = initial.participants.find(p => p.name === 'Bob');
  const aw = initial.receivers.find(r => r.participantId === alice.id);
  const bw = initial.receivers.find(r => r.participantId === bob.id && r.path.endsWith('/wallet'));
  const bs = initial.receivers.find(r => r.participantId === bob.id && r.path.endsWith('/server'));
  const owner = receiver => initial.participants.find(p => p.id === receiver.participantId).publicKey;
  const peer = (local, remote) => ({ receiverId: local.id, peerPublicKey: owner(remote), peerReceiverPath: remote.path });
  const workspace = (snapshot, receiver) => snapshot.receiverWorkspaces.find(w => w.receiverId === receiver.id);
  const link = (snapshot, local, remote) => workspace(snapshot, local)?.links.find(l => l.peerPublicKey === owner(remote) && l.peerReceiverPath === remote.path);
  const wait = async predicate => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const snapshot = await state();
      if (predicate(snapshot)) return snapshot;
      await sleep(400, signal);
    }
    throw new Error('Workspace state condition timed out');
  };
  const establish = async (remote, acceptanceDelay = 0) => {
    const started = await command('link.initiate', peer(aw, remote));
    if (acceptanceDelay) {
      await sleep(acceptanceDelay, signal);
      assert.equal(link(await state(), aw, remote).state, 'linking', 'Initiator must wait safely for human acceptance');
      assert.equal(link(await state(), remote, aw).state, 'notLinked', 'No implicit acceptance during relinking');
    }
    await command('link.accept', peer(remote, aw));
    await wait(s => link(s, aw, remote)?.state === 'linked' && link(s, remote, aw)?.state === 'linked');
    const duplicate = await request('/v1/commands', started.body);
    assert.equal(duplicate.data.operationId, started.operation.id);
  };
  await command('link.initiate', peer(aw, bw));
  await sleep(2200, signal);
  assert(!link(await state(), bw, aw), 'No implicit acceptance');
  await command('link.accept', peer(bw, aw));
  await wait(s => link(s, aw, bw)?.state === 'linked' && link(s, bw, aw)?.state === 'linked');
  await establish(bs);
  assert.equal(workspace(await state(), aw).links.length, 2);
  stage('explicit-links');

  await command('link.initiate', peer(bw, bs), randomUUID(), 'failed');
  for (const input of [{ ...peer(aw, bw), peerPublicKey: 'invalid' }, { ...peer(aw, bw), peerReceiverPath: '../wallet' }]) {
    assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'link.initiate', input })).status, 400);
  }
  stage('link-validation');

  await command('delivery.pause', { receiverId: aw.id });
  const queued = await command('link.sendEmptyList', peer(aw, bw));
  assert.equal(typeof queued.operation.result.outboundMessageId, 'string');
  assert.equal((await request('/v1/commands', queued.body)).data.operationId, queued.operation.id);
  await command('delivery.sync', { receiverId: aw.id }, randomUUID(), 'failed');
  await command('receiver.restart', { receiverId: aw.id });
  await sleep(2200, signal);
  let snapshot = await state();
  assert.equal(workspace(snapshot, aw).deliveryPaused, true);
  assert.equal(link(snapshot, aw, bw).pendingMessages, 1);
  assert.equal(link(snapshot, bw, aw).latestReceivedListId, undefined);
  stage('outbound-pause');
  await command('delivery.resume', { receiverId: aw.id });
  snapshot = await wait(s => link(s, aw, bw)?.lastSentMessageId === queued.operation.result.outboundMessageId && link(s, bw, aw)?.latestReceivedListId !== undefined);
  let received = link(snapshot, bw, aw).latestReceivedListId;
  if (serviceContainer) {
    await command('receiver.stop', { receiverId: bw.id });
    const actual = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-private-list', bw.id, alice.publicKey, aw.path));
    assert.equal(actual.endpointCount, 0); assert.equal(actual.validListCount, 1); assert.equal(actual.latestStreamItemId, received);
    await command('receiver.start', { receiverId: bw.id });
  }
  stage('encrypted-empty-list');

  await command('receiver.stop', { receiverId: bw.id });
  const offline = await command('link.sendEmptyList', peer(aw, bw));
  await wait(s => link(s, aw, bw)?.lastSentMessageId === offline.operation.result.outboundMessageId);
  assert.equal(link(await state(), bs, aw).latestReceivedListId, undefined);
  await command('receiver.start', { receiverId: bw.id });
  snapshot = await wait(s => link(s, bw, aw)?.latestReceivedListId !== received);
  received = link(snapshot, bw, aw).latestReceivedListId;
  await command('delivery.sync', { receiverId: bw.id });
  assert.equal(link(await state(), bw, aw).latestReceivedListId, received);
  stage('offline-delivery');

  await command('delivery.pause', { receiverId: bw.id });
  const inbound = await command('link.sendEmptyList', peer(aw, bw));
  await wait(s => link(s, aw, bw)?.lastSentMessageId === inbound.operation.result.outboundMessageId);
  await command('receiver.restart', { receiverId: bw.id });
  await sleep(2200, signal);
  snapshot = await state();
  assert(workspace(snapshot, bw).deliveryPaused);
  assert.equal(link(snapshot, bw, aw).latestReceivedListId, received);
  await command('delivery.resume', { receiverId: bw.id });
  await wait(s => link(s, bw, aw)?.latestReceivedListId !== received);
  stage('inbound-pause');

  await command('link.block', peer(aw, bw));
  await command('link.sendEmptyList', peer(aw, bw), randomUUID(), 'failed');
  assert.equal(link(await state(), aw, bw).state, 'blocked');
  await command('link.unblock', peer(aw, bw));
  await sleep(2200, signal);
  assert.equal(link(await state(), aw, bw).state, 'notLinked');
  assert.equal(link(await state(), aw, bs).state, 'linked');
  await command('link.block', peer(bw, aw));
  await command('link.unblock', peer(bw, aw));
  const beforeRelink = await state();
  const oldReceived = link(beforeRelink, bw, aw).latestReceivedListId;
  const siblingGeneration = beforeRelink.receivers.find(r => r.id === bs.id).generation;
  await establish(bw, 5200);
  // A linked badge alone missed stale ciphertext from the abandoned outbox.
  const afterRelink = await command('link.sendEmptyList', peer(aw, bw));
  snapshot = await wait(s => link(s, aw, bw)?.lastSentMessageId === afterRelink.operation.result.outboundMessageId && link(s, bw, aw)?.latestReceivedListId !== oldReceived);
  const freshReceived = link(snapshot, bw, aw).latestReceivedListId;
  await command('delivery.sync', { receiverId: bw.id });
  assert.equal(link(await state(), bw, aw).latestReceivedListId, freshReceived);
  assert.equal((await state()).receivers.find(r => r.id === bs.id).generation, siblingGeneration);
  assert.equal(link(await state(), aw, bs).state, 'linked');
  assert.equal(link(await state(), bs, aw).latestReceivedListId, undefined);
  if (serviceContainer) {
    await command('receiver.stop', { receiverId: bw.id });
    const actual = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-private-list', bw.id, alice.publicKey, aw.path));
    assert.equal(actual.endpointCount, 0); assert.equal(actual.validListCount, 4); assert.equal(actual.latestStreamItemId, freshReceived);
    await command('receiver.start', { receiverId: bw.id });
  }
  const siblingSend = await command('link.sendEmptyList', peer(aw, bs));
  await wait(s => link(s, aw, bs)?.lastSentMessageId === siblingSend.operation.result.outboundMessageId && link(s, bs, aw)?.latestReceivedListId !== undefined);
  assert.equal(link(await state(), bw, aw).latestReceivedListId, freshReceived);
  stage('blocked-peer');

  const red = fs.readFileSync(path.join(__dirname, '../paykit/tests/fixtures/avatar-red.png')).toString('base64');
  const blue = fs.readFileSync(path.join(__dirname, '../paykit/tests/fixtures/avatar-blue.jpg')).toString('base64');
  await command('profile.publish', { receiverId: bw.id, displayName: 'Bob wallet', about: 'Wallet profile', avatarBase64: red, avatarMime: 'image/png' });
  await command('profile.publish', { receiverId: bs.id, displayName: 'Bob server', about: 'Server profile', avatarBase64: blue, avatarMime: 'image/jpeg' });
  await command('profile.fetch', peer(aw, bw));
  await command('profile.fetch', peer(aw, bs));
  snapshot = await state();
  const fetched = workspace(snapshot, aw).profiles;
  const walletProfile = fetched.find(p => p.peerReceiverPath === bw.path);
  const serverProfile = fetched.find(p => p.peerReceiverPath === bs.path);
  assert.equal(walletProfile.displayName, 'Bob wallet');
  for (const profile of [walletProfile, serverProfile]) {
    assert(profile.avatarDataUrl.startsWith('data:image/png;base64,'));
    assert(profile.avatarDataUrl.length <= 16384);
  }
  const inspectAvatar = (receiver, uri) => JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-avatar', owner(receiver), receiver.path, uri.split('/').pop()));
  if (serviceContainer) {
    assert.equal(inspectAvatar(bw, walletProfile.imageUri).base64, red);
    assert.equal(inspectAvatar(bs, serverProfile.imageUri).base64, blue);
  }
  assert.notEqual(walletProfile.path, serverProfile.path);
  await command('profile.publish', { receiverId: bw.id, displayName: 'Bob updated', about: 'Updated without avatar' });
  await command('profile.fetch', peer(aw, bw));
  assert.equal(workspace(await state(), aw).profiles.find(p => p.peerReceiverPath === bw.path).imageUri, walletProfile.imageUri);
  await command('profile.publish', { receiverId: bw.id, displayName: 'Bob replacement', about: '', avatarBase64: blue, avatarMime: 'image/jpeg' });
  if (serviceContainer) assert.equal(inspectAvatar(bw, walletProfile.imageUri).exists, false);
  await command('profile.publish', { receiverId: bw.id, displayName: 'Bob no avatar', about: '', avatarBase64: '', avatarMime: '' });
  await command('profile.fetch', peer(aw, bw));
  assert.equal(workspace(await state(), aw).profiles.find(p => p.peerReceiverPath === bw.path).imageUri, undefined);
  await command('profile.delete', { receiverId: bw.id });
  await command('profile.fetch', peer(aw, bw));
  assert(!workspace(await state(), aw).profiles.some(p => p.peerReceiverPath === bw.path));
  assert.equal(workspace(await state(), bs).profile.displayName, 'Bob server');
  stage('profiles-avatars');
  for (const input of [
    { displayName: 'Bad', about: '', avatarBase64: red.slice(0, 32), avatarMime: 'image/png' },
    { displayName: 'Bad', about: '', avatarBase64: red, avatarMime: 'image/jpeg' },
    { displayName: 'é'.repeat(41), about: '' },
  ]) assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'profile.publish', input: { receiverId: bw.id, ...input } })).status, 400);
  stage('profile-validation');

  await command('contact.discover', { receiverId: aw.id, peerPublicKey: bob.publicKey });
  snapshot = await state();
  assert.deepEqual(workspace(snapshot, aw).discoveries.find(d => d.peerPublicKey === bob.publicKey).receiverPaths.sort(), [bw.path, bs.path].sort());
  assert.equal(workspace(snapshot, aw).contacts.length, 0);
  const contact = { receiverId: aw.id, peerPublicKey: bob.publicKey, label: 'Private label', receiverPaths: [bw.path, bs.path] };
  await command('contact.save', contact);
  await command('contact.save', { ...contact, label: 'Edited local label' });
  const inspectContact = remote => serviceContainer && JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-contact', alice.publicKey, aw.path, bob.publicKey, remote.path));
  if (serviceContainer) {assert.equal(inspectContact(bw).exists, false); assert.equal(inspectContact(bs).exists, false);}
  stage('private-contacts');
  await command('contact.publish', peer(aw, bw));
  assert.equal(workspace(await state(), aw).contacts[0].publicSharing, 'public');
  if (serviceContainer) {const marker = inspectContact(bw); assert(marker.exists); assert.equal(marker.hasLocalLabel, false); assert.equal(marker.publicKey, bob.publicKey); assert.equal(marker.receiverPath, bw.path);}
  await command('contact.publish', peer(aw, bs), randomUUID(), 'failed');
  await command('contact.remove', { receiverId: aw.id, peerPublicKey: bob.publicKey }, randomUUID(), 'failed');
  await command('contact.save', { ...contact, receiverPaths: [bs.path] }, randomUUID(), 'failed');
  await command('contact.unpublish', peer(aw, bw));
  await command('contact.publish', peer(aw, bs));
  if (serviceContainer) {assert.equal(inspectContact(bw).exists, false); assert.equal(inspectContact(bs).exists, true);}
  await command('contact.unpublish', peer(aw, bs));
  await command('contact.remove', { receiverId: aw.id, peerPublicKey: bob.publicKey });
  if (serviceContainer) {assert.equal(inspectContact(bw).exists, false); assert.equal(inspectContact(bs).exists, false);}
  stage('public-contacts');

  await command('contact.save', contact);
  await command('delivery.pause', { receiverId: aw.id });
  const before = await state();
  await command('receiver.restart', { receiverId: aw.id });
  snapshot = await wait(s => workspace(s, aw)?.deliveryPaused && workspace(s, aw)?.contacts.length === 1);
  assert.deepEqual(workspace(snapshot, aw).contacts, workspace(before, aw).contacts);
  assert.equal(link(snapshot, aw, bs).state, 'linked');
  assert.equal(snapshot.receivers.find(r => r.id === bs.id).generation, before.receivers.find(r => r.id === bs.id).generation);
  await command('delivery.resume', { receiverId: aw.id });
  stage('workspace-persistence');
}
module.exports = { run, stages };
