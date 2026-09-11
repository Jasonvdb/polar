/* Real recurring payments use the same wallets, Pubky streams and durable commands as the UI. */
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { sleep } = require('./paykit-harness');
const ONCHAIN = 'btc-onchain';
const BOLT11 = 'btc-lightning-bolt11';
const stages = ['recurring-validation', 'recurring-onchain-manual', 'recurring-onchain-autopay', 'recurring-onchain-missed', 'recurring-lightning-manual', 'recurring-lightning-autopay', 'recurring-lightning-missed', 'recurring-persistence-cancel', 'recurring-failure-safety', 'recurring-wallet-clock', 'recurring-core-unsigned-restart', 'recurring-core-broadcast-restart'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const utc = value => new Date(value).toISOString().replace('.000Z', 'Z');
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort()); }
function assertEndpointCommitment(commitment, binding, source, method) {
  keys(commitment, 'source method reservationId endpointHash');
  assert.equal(commitment.source, source); assert.equal(commitment.method, method);
  assert.match(commitment.reservationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(commitment.endpointHash, /^[0-9a-f]{64}$/);
  assert.equal(binding.source, source); assert.equal(binding.method, method);
  assert.equal(binding.reservationId, commitment.reservationId);
  assert.equal(typeof binding.endpoint, 'string'); assert(binding.endpoint.length > 0);
  assert.equal(createHash('sha256').update(binding.endpoint, 'utf8').digest('hex'), commitment.endpointHash, 'Actual endpoint differs from the selected period commitment');
}
function validateEvidence(evidence) {
  keys(evidence, 'version rails persistence failures clock regressions'); assert.equal(evidence.version, 1);
  assert.equal(evidence.rails.length, 2);
  assert.deepEqual(evidence.rails.map(r => r.method), [ONCHAIN, BOLT11]);
  for (const field of ['requestId', 'receiptId']) assert.equal(new Set(evidence.rails.map(r => r[field])).size, 2);
  for (const rail of evidence.rails) {
    keys(rail, 'requestId method source amountSats periods receiptId missedBefore missedAfter duplicateBefore duplicateAfter canceled');
    assert.match(rail.requestId, /^[0-9a-f-]{36}$/); assert.match(rail.receiptId, /^[0-9a-f-]{36}$/);
    assert.equal(rail.source, rail.method === ONCHAIN ? 'public' : 'private');
    assert.match(rail.amountSats, /^[1-9][0-9]*$/); assert.equal(rail.canceled, true);
    assert.equal(rail.periods.length, 3);
    for (const [index, period] of rail.periods.entries()) {
      keys(period, 'index startsAt endsAt executionId proofId paymentReference mode verified');
      assert.equal(period.index, index); assert.equal(period.mode, index === 1 ? 'automatic' : 'manual');
      for (const id of [period.executionId, period.proofId]) assert.match(id, /^[0-9a-f-]{36}$/);
      assert.match(period.paymentReference, /^[a-f0-9]{64}$/); assert.equal(period.verified, true);
      assert.equal(utc(Date.parse(period.startsAt)), period.startsAt);
      assert.equal(Date.parse(period.endsAt) - Date.parse(period.startsAt), 60000);
      if (index) assert.equal(period.startsAt, rail.periods[index - 1].endsAt);
    }
    for (const field of ['executionId', 'proofId', 'paymentReference']) assert.equal(new Set(rail.periods.map(p => p[field])).size, 3);
    for (const kind of ['missed', 'duplicate']) {
      assert.match(rail[`${kind}Before`], /^[a-f0-9]{64}$/);
      assert.equal(rail[`${kind}Before`], rail[`${kind}After`]);
    }
  }
  keys(evidence.persistence, 'before after clocksRetained receiverIsolated');
  assert.match(evidence.persistence.before, /^[a-f0-9]{64}$/);
  assert.equal(evidence.persistence.before, evidence.persistence.after);
  assert.equal(evidence.persistence.clocksRetained, true); assert.equal(evidence.persistence.receiverIsolated, true);
  keys(evidence.failures, 'insufficientFunds expiredInvoice uncertainReconciled uncertainPaymentReference uncertainBefore uncertainAfter');
  for (const field of ['insufficientFunds', 'expiredInvoice', 'uncertainReconciled']) assert.equal(evidence.failures[field], true);
  for (const field of ['uncertainPaymentReference', 'uncertainBefore']) assert.match(evidence.failures[field], /^[a-f0-9]{64}$/);
  assert.equal(evidence.failures.uncertainBefore, evidence.failures.uncertainAfter);
  keys(evidence.clock, 'blockBefore blockAfter invoiceTimestamp invoiceExpiry applicationNow invoicePaid resetRejected');
  assert.match(evidence.clock.blockBefore, /^[a-f0-9]{64}$/); assert.equal(evidence.clock.blockBefore, evidence.clock.blockAfter);
  assert(Number.isSafeInteger(evidence.clock.invoiceTimestamp) && evidence.clock.invoiceTimestamp > 0);
  assert(Number.isSafeInteger(evidence.clock.invoiceExpiry) && evidence.clock.invoiceExpiry > 0);
  assert(Date.parse(evidence.clock.applicationNow) / 1000 > evidence.clock.invoiceTimestamp + evidence.clock.invoiceExpiry);
  assert.equal(evidence.clock.invoicePaid, true); assert.equal(evidence.clock.resetRejected, true);
  keys(evidence.regressions, 'oversizedRejected oldOfferIndex oldCurrentIndex oldManual coreRestarts');
  assert.equal(evidence.regressions.oversizedRejected, true); assert.equal(evidence.regressions.oldOfferIndex, 0);
  assert(evidence.regressions.oldCurrentIndex >= 128); assert.equal(evidence.regressions.oldManual, true);
  assert.deepEqual(evidence.regressions.coreRestarts.map(r => r.phase), ['unsigned', 'broadcast']);
  for (const r of evidence.regressions.coreRestarts) {
    keys(r, 'phase executionId txid transactionDigest originalDigest walletWasUnloaded walletDirectoryBefore walletDirectoryAfter sendsBefore sendsAfter');
    assert.match(r.executionId, /^[0-9a-f-]{36}$/); assert.match(r.txid, /^[a-f0-9]{64}$/);
    assert.match(r.transactionDigest, /^[a-f0-9]{64}$/); assert.equal(r.transactionDigest, r.originalDigest);
    assert.equal(r.walletWasUnloaded, true); assert.deepEqual(r.walletDirectoryBefore, r.walletDirectoryAfter);
    assert(r.walletDirectoryBefore.length > 0 && r.walletDirectoryBefore.every(w => typeof w === 'string' && w.startsWith('paykit-')));
    assert(Number.isInteger(r.sendsBefore) && r.sendsBefore >= 0); assert.equal(r.sendsAfter, r.sendsBefore + 1);
  }
  return evidence;
}
async function run({ initial, state, command, request, stage, signal, walletFixture: fixture, requests, restartEnvironment }) {
  const { alice, bob, carol, server, peer, view, wait, mine, verify } = requests;
  const owner = r => initial.participants.find(p => p.id === r.participantId).publicKey;
  const workspace = (s, r) => s.receiverWorkspaces.find(w => w.receiverId === r.id);
  const subscription = (w, id) => w.subscriptions.find(s => s.requestId === id);
  const execution = (w, id, index) => w.executions.find(e => e.requestId === id && e.periodIndex === index);
  const period = (w, id, index) => subscription(w, id)?.periods.find(p => p.index === index);
  const history = () => ({
    core: [alice, bob, carol].map(r => fixture.core('listtransactions', ['*', 10000, 0, true], `paykit-${owner(r)}`).filter(t => t.category === 'send').map(t => ({ txid: t.txid, vout: t.vout, address: t.address, amount: t.amount })).sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`))),
    lightning: [0, 1, 2].map(i => fixture.lnd(i, 'listpayments', '--include_incomplete').payments.map(p => ({ hash: p.payment_hash, index: p.payment_index, status: p.status, value: p.value_sat }))),
  });
  const stableTicks = async () => { const before = digest(history()); await sleep(4500, signal); const after = digest(history()); assert.equal(after, before, 'Unexpected wallet side effect across background ticks'); return { before, after }; };
  const configure = (receiver, walletId, method) => command('method.configure', { receiverId: receiver.id, walletId, enabledMethods: [method], preference: [method] });
  let now = Math.ceil(Math.max(Date.now(), ...[alice, bob, carol].map(r => Date.parse(workspace(initial, r)?.applicationClock?.now) || 0)) / 1000) * 1000 + 3600000;
  const set = async (receivers, value) => { for (const receiver of receivers) await command('clock.set', { receiverId: receiver.id, now: utc(value) }); };
  const create = async (method, amountSats, payer = alice, payee = bob, walletId = fixture.walletIds.bob) => {
    await configure(payee, walletId, method);
    const existing = new Set((await view(payee)).requests.map(r => r.id));
    await command('request.create', { ...peer(payee, payer), amountSats, description: 'Recurring real-network scenario', expirySeconds: 600, acceptedMethods: [method], recurrence: { every: 1, unit: 'minute', startsAt: utc(now), anchor: utc(now), endsAt: null } });
    const record = (await view(payee)).requests.find(r => !existing.has(r.id)); assert(record);
    await wait(s => workspace(s, payer).requests.some(r => r.id === record.id));
    await command('request.accept', { receiverId: payer.id, requestId: record.id });
    await wait(s => ['accepted', 'activeRecurring'].includes(workspace(s, payee).requests.find(r => r.id === record.id)?.lifecycle));
    return { id: record.id, method, amountSats, payer, payee, source: method === ONCHAIN ? 'public' : 'private', anchor: now };
  };
  const prepare = async (r, index, expirySeconds = 600) => {
    await command('subscription.prepare', { receiverId: r.payee.id, requestId: r.id, periodIndex: index, source: r.source, expirySeconds });
    await wait(s => period(workspace(s, r.payer), r.id, index)?.offerId);
    const received = period(await view(r.payer), r.id, index);
    const prepared = period(await view(r.payee), r.id, index);
    assert.equal(received.endpointCommitments.length, 1);
    assert.deepEqual(received.endpointCommitments, prepared.endpointCommitments);
    assertEndpointCommitment(received.endpointCommitments[0], prepared.endpointBindings.find(b => b.source === r.source && b.method === r.method), r.source, r.method);
    return received;
  };
  const selection = (r, index, walletId = fixture.walletIds.alice) => ({ receiverId: r.payer.id, requestId: r.id, periodIndex: index, walletId, source: r.source, method: r.method });
  const authorize = (r, walletId = fixture.walletIds.alice) => { const { periodIndex, ...input } = selection(r, 0, walletId); return command('subscription.authorize', input); };
  const disable = r => command('subscription.disable', { receiverId: r.payer.id, requestId: r.id });
  const finish = async (r, index, automatic = false, mineBlocks = mine) => {
    if (automatic) await wait(s => execution(workspace(s, r.payer), r.id, index)?.status === 'succeeded');
    const payerView = await view(r.payer);
    const spend = execution(payerView, r.id, index); assert.equal(spend?.status, 'succeeded');
    const paidPeriod = period(payerView, r.id, index);
    const binding = paidPeriod.endpointBindings.find(b => b.source === r.source && b.method === r.method);
    assertEndpointCommitment(paidPeriod.endpointCommitments.find(c => c.source === r.source && c.method === r.method), binding, r.source, r.method);
    assert.equal(binding.endpoint, spend.endpoint, 'Execution must use the endpoint authenticated by the period commitment');
    if (!automatic) await command('proof.submit', { receiverId: r.payer.id, requestId: r.id, executionId: spend.id });
    await wait(s => workspace(s, r.payee).proofs.some(p => p.requestId === r.id && p.periodIndex === index));
    const proof = (await view(r.payee)).proofs.find(p => p.requestId === r.id && p.periodIndex === index);
    const billingPeriod = { startsAt: utc(r.anchor + index * 60000), endsAt: utc(r.anchor + (index + 1) * 60000) };
    assert.deepEqual(spend.billingPeriod, billingPeriod); assert.deepEqual(proof.billingPeriod, billingPeriod);
    if (r.method === ONCHAIN) {
      const tx = fixture.core('getrawtransaction', [spend.txid, true]);
      assert.equal(tx.vout[spend.outputIndex].scriptPubKey.address, spend.endpoint);
      assert.equal(BigInt(tx.vout[spend.outputIndex].value.toFixed(8).replace('.', '')), BigInt(r.amountSats));
      await mineBlocks(1);
    } else {
      const invoice = fixture.lnd(r.payee === bob ? 1 : 2, 'lookupinvoice', spend.paymentHash);
      assert.equal(invoice.state, 'SETTLED'); assert.equal(invoice.amt_paid_sat, r.amountSats);
    }
    const settlement = await verify(r.id, proof, 1, r.payee); assert.equal(settlement.status, 'verified');
    assert.deepEqual(settlement.billingPeriod, billingPeriod); assert.equal(settlement.periodIndex, index);
    return { index, ...billingPeriod, executionId: spend.id, proofId: proof.id, paymentReference: spend.txid || spend.paymentHash, mode: automatic ? 'automatic' : 'manual', verified: true };
  };
  const cancel = async r => {
    await command('request.cancel', { receiverId: r.payee.id, requestId: r.id });
    await wait(s => workspace(s, r.payer).requests.find(v => v.id === r.id)?.lifecycle === 'canceled');
    assert.equal(subscription(await view(r.payer), r.id).autopay.enabled, false);
  };
  const evidence = { version: 1, rails: [], regressions: { coreRestarts: [] } };
  const blockBefore = fixture.core('getbestblockhash');
  const serverClock = (await view(server)).applicationClock.mode;
  await set([alice, bob, carol], now);
  assert.equal((await view(server)).applicationClock.mode, serverClock);
  const blockAfter = fixture.core('getbestblockhash'); assert.equal(blockAfter, blockBefore);
  const input = { ...peer(bob, alice), amountSats: '701', description: 'Invalid recurrence', expirySeconds: 600, acceptedMethods: [ONCHAIN], recurrence: { every: 1, unit: 'minute', startsAt: utc(now), anchor: utc(now), endsAt: null } };
  for (const recurrence of [{ ...input.recurrence, every: 0 }, { ...input.recurrence, every: 1.5 }, { ...input.recurrence, anchor: utc(now + 1000) }, { ...input.recurrence, endsAt: utc(now + 30000) }, { ...input.recurrence, unit: 'fortnight' }]) assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'request.create', input: { ...input, recurrence } })).status, 400);
  const unchangedProposalState = () => state().then(s => s.receiverWorkspaces.map(w => ({ receiverId: w.receiverId, requestIds: w.requests.map(r => r.id).sort(), reservationIds: w.reservations.map(r => r.id).sort() })).sort((a, b) => a.receiverId.localeCompare(b.receiverId)));
  const beforeOversized = await unchangedProposalState();
  const oversized = await command('request.create', { ...input, description: 'x'.repeat(500) }, randomUUID(), 'failed');
  assert.match(oversized.operation.error.message, /[Ss]horten the description/);
  assert.deepEqual(await unchangedProposalState(), beforeOversized);
  evidence.regressions.oversizedRejected = true;
  stage('recurring-validation');
  const subscriptions = [];
  for (const method of [ONCHAIN, BOLT11]) {
    const name = method === ONCHAIN ? 'onchain' : 'lightning';
    const r = await create(method, method === ONCHAIN ? '701' : '73'); subscriptions.push(r);
    assert.equal(subscription(await view(alice), r.id).autopay.enabled, false);
    await command('subscription.prepare', { receiverId: bob.id, requestId: r.id, periodIndex: 1, source: r.source, expirySeconds: 600 }, randomUUID(), 'failed');
    await command('payment.execute', selection(r, 1), randomUUID(), 'failed');
    const offer = await prepare(r, 0);
    assert.deepEqual(offer.endpointBindings, [], 'Payer receives commitments before explicit endpoint resolution');
    assert(!(await view(alice)).requests.some(v => v.id === offer.offerId));
    await command('request.accept', { receiverId: alice.id, requestId: offer.offerId }, randomUUID(), 'failed');
    await command('payment.execute', { ...selection(r, 0), requestId: offer.offerId, periodIndex: undefined }, randomUUID(), 'failed');
    const noOptIn = await stableTicks(); assert.equal(execution(await view(alice), r.id, 0), undefined);
    let invoice;
    if (method === BOLT11) {
      invoice = fixture.lnd(1, 'decodepayreq', period(await view(bob), r.id, 0).endpointBindings.find(b => b.method === method).endpoint);
      assert(now / 1000 > Number(invoice.timestamp) + Number(invoice.expiry));
    } else await mine(1);
    await command('payment.execute', selection(r, 0));
    const paid = [await finish(r, 0)];
    const issuanceResult = await command('receipt.prepare', { receiverId: bob.id, requestId: r.id, proofId: paid[0].proofId });
    const receiptId = issuanceResult.operation.result.receiptId;
    await command('receipt.process', { receiverId: bob.id, receiptId });
    await wait(s => workspace(s, alice).receiptAccess.some(a => a.receiptId === receiptId));
    await command('receipt.retrieve', { ...peer(alice, bob), receiptId });
    for (const [receiver, field, idField] of [[bob, 'receiptIssuances', 'id'], [alice, 'receiptAccess', 'receiptId'], [alice, 'receipts', 'id']]) {
      assert.deepEqual((await view(receiver))[field].find(v => v[idField] === receiptId).billingPeriod, { startsAt: paid[0].startsAt, endsAt: paid[0].endsAt });
    }
    stage(`recurring-${name}-manual`);
    await authorize(r);
    const authorization = subscription(await view(alice), r.id).autopay;
    assert.equal(authorization.enabled, true); assert.equal(authorization.walletId, fixture.walletIds.alice);
    assert.equal(authorization.source, r.source); assert.equal(authorization.method, method);
    now = r.anchor + 60000; await set([bob, alice], now);
    assert.equal(execution(await view(alice), r.id, 1), undefined);
    await stableTicks();
    await prepare(r, 1); paid.push(await finish(r, 1, true));
    const duplicateBefore = digest(history());
    const duplicateId = randomUUID(); await command('payment.execute', selection(r, 1), duplicateId);
    assert.equal((await request('/v1/commands', { commandId: duplicateId, command: 'payment.execute', input: selection(r, 1) })).data.operationId, duplicateId);
    await authorize(r); await prepare(r, 1); await command('proof.submit', { receiverId: alice.id, requestId: r.id, executionId: paid[1].executionId });
    const duplicateAfter = digest(history()); assert.equal(duplicateAfter, duplicateBefore);
    stage(`recurring-${name}-autopay`);
    await command('receiver.stop', { receiverId: alice.id });
    now = r.anchor + 180000; await set([bob], now);
    await command('receiver.start', { receiverId: alice.id }); await set([alice], now);
    await prepare(r, 2);
    const missed = await stableTicks(); assert.equal(execution(await view(alice), r.id, 2), undefined);
    if (method === ONCHAIN) await mine(1);
    await command('payment.execute', selection(r, 2)); paid.push(await finish(r, 2));
    await disable(r);
    evidence.rails.push({ requestId: r.id, method, source: r.source, amountSats: r.amountSats, periods: paid, receiptId, missedBefore: missed.before, missedAfter: missed.after, duplicateBefore, duplicateAfter, canceled: false });
    if (invoice) evidence.clock = { blockBefore, blockAfter, invoiceTimestamp: Number(invoice.timestamp), invoiceExpiry: Number(invoice.expiry), applicationNow: utc(r.anchor), invoicePaid: true, resetRejected: false };
    assert.equal(noOptIn.before, noOptIn.after);
    stage(`recurring-${name}-missed`);
    now += 60000; await set([alice, bob, carol], now);
  }
  // An offer that arrives after its period leaves the default 128-period window must remain manually usable.
  const old = await create(ONCHAIN, '703'); await authorize(old);
  now = old.anchor + 128 * 60000; await set([bob, alice, carol], now);
  await prepare(old, 0);
  const oldView = subscription(await view(alice), old.id);
  assert.equal(oldView.currentPeriodIndex, 128); assert(oldView.periods.some(p => p.index === 0 && p.offerId && p.endpointCommitments.some(c => c.source === old.source && c.method === old.method)));
  await stableTicks(); assert.equal(execution(await view(alice), old.id, 0), undefined);
  await mine(1); await command('payment.execute', selection(old, 0)); await finish(old, 0);
  await disable(old); await cancel(old);
  Object.assign(evidence.regressions, { oldOfferIndex: 0, oldCurrentIndex: 128, oldManual: true });
  const persisted = async () => Promise.all([alice, bob].map(async r => {
    const w = await view(r); return { clock: w.applicationClock, subscriptions: w.subscriptions.filter(s => subscriptions.some(r => r.id === s.requestId)) };
  }));
  // Keep a real authorization enabled across restart, waiting for an unprepared current period.
  await authorize(subscriptions[1]);
  const before = digest(history()); const records = await persisted(); await restartEnvironment();
  assert.deepEqual(await persisted(), records); const after = digest(history()); assert.equal(after, before);
  assert.equal((await view(server)).subscriptions.length, 0);
  evidence.persistence = { before, after, clocksRetained: true, receiverIsolated: true };
  for (const [i, r] of subscriptions.entries()) { await cancel(r); evidence.rails[i].canceled = true; }
  now += 60000; await set([alice, bob, carol], now); await stableTicks();
  for (const r of subscriptions) await command('subscription.prepare', { receiverId: bob.id, requestId: r.id, periodIndex: 4, source: r.source, expirySeconds: 600 }, randomUUID(), 'failed');
  stage('recurring-persistence-cancel');

  const poor = await create(ONCHAIN, '20000000'); await authorize(poor); await prepare(poor, 0);
  await wait(s => subscription(workspace(s, alice), poor.id).autopay.status === 'blocked');
  assert.equal(execution(await view(alice), poor.id, 0)?.status, 'failed');
  const failedExecution = execution(await view(alice), poor.id, 0).id;
  await authorize(poor); await stableTicks(); assert.equal(execution(await view(alice), poor.id, 0).id, failedExecution); await disable(poor); await cancel(poor);
  const expired = await create(BOLT11, '79'); await prepare(expired, 0, 3);
  const actualExpiry = fixture.lnd(1, 'decodepayreq', period(await view(bob), expired.id, 0).endpointBindings.find(b => b.method === BOLT11).endpoint);
  const frozenBeforeExpiry = (await view(alice)).applicationClock;
  await sleep(3500, signal);
  assert(Date.now() / 1000 >= Number(actualExpiry.timestamp) + Number(actualExpiry.expiry));
  assert.deepEqual((await view(alice)).applicationClock, frozenBeforeExpiry); await authorize(expired);
  await wait(s => subscription(workspace(s, alice), expired.id).autopay.status === 'blocked');
  assert.equal(execution(await view(alice), expired.id, 0), undefined); await stableTicks(); await disable(expired); await cancel(expired);
  const uncertain = await create(BOLT11, '81', bob, carol, fixture.walletIds.carol);
  await prepare(uncertain, 0);
  const gateCount = fixture.counts().lnd.executionSuccess;
  const fault = fixture.arm('lnd', 'drop', 'sendpayment'); await authorize(uncertain, fixture.walletIds.fault); await fixture.waitReady('lnd', fault);
  await wait(s => execution(workspace(s, bob), uncertain.id, 0)?.status === 'uncertain');
  const lost = execution(await view(bob), uncertain.id, 0); await stableTicks();
  await command('receiver.restart', { receiverId: bob.id });
  await command('payment.reconcile', { receiverId: bob.id, executionId: lost.id });
  const recovered = execution(await view(bob), uncertain.id, 0); assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.paymentHash, lost.paymentHash);
  await finish(uncertain, 0); assert.equal(fixture.counts().lnd.executionSuccess, gateCount + 1);
  const uncertainBefore = digest(history()); await authorize(uncertain, fixture.walletIds.fault); await command('payment.execute', selection(uncertain, 0, fixture.walletIds.fault)); await stableTicks(); const uncertainAfter = digest(history());
  await disable(uncertain); await cancel(uncertain);
  evidence.failures = { insufficientFunds: true, expiredInvoice: true, uncertainReconciled: true, uncertainPaymentReference: recovered.paymentHash, uncertainBefore, uncertainAfter };
  stage('recurring-failure-safety');
  const clock = (await view(alice)).applicationClock;
  await command('clock.reset', { receiverId: alice.id }, randomUUID(), 'failed'); assert.deepEqual((await view(alice)).applicationClock, clock);
  evidence.clock.resetRejected = true; stage('recurring-wallet-clock');
  // The gate proves an actual wallet response existed before losing it; Core is restarted independently of Paykit.
  const miningAddress = fixture.core('getnewaddress', [], '');
  const mineAfterRestart = async count => fixture.core('generatetoaddress', [count, miningAddress]);
  const walletName = `paykit-${owner(alice)}`;
  const sendIds = () => [...new Set(fixture.core('listtransactions', ['*', 10000, 0, true], walletName).filter(t => t.category === 'send').map(t => t.txid))].sort();
  const walletDirectory = () => fixture.core('listwalletdir').wallets.map(w => w.name).filter(w => w.startsWith('paykit-')).sort();
  for (const phase of ['unsigned', 'broadcast']) {
    await mineAfterRestart(1);
    const r = await create(ONCHAIN, phase === 'unsigned' ? '709' : '719'); await prepare(r, 0);
    const sendsBefore = sendIds(); const walletDirectoryBefore = walletDirectory();
    const operation = phase === 'unsigned' ? 'signrawtransactionwithwallet' : 'sendrawtransaction';
    const gateBefore = fixture.counts().core.executionSuccess;
    const nonce = fixture.arm('core', 'hold', operation);
    const commandId = randomUUID();
    const pending = command('payment.execute', selection(r, 0, fixture.walletIds.fault), commandId, 'failed').then(value => ({ value }), error => ({ error }));
    // Observe a successful real response before interrupting Core; the held response cannot complete Paykit yet.
    const ready = await fixture.waitReady('core', nonce);
    let originalDigest = ready.signedTransactionDigest;
    if (phase === 'broadcast') {
      assert.match(ready.transactionId, /^[a-f0-9]{64}$/);
      originalDigest = createHash('sha256').update(Buffer.from(fixture.core('getrawtransaction', [ready.transactionId, false]), 'hex')).digest('hex');
    }
    await fixture.stopCore(); fixture.release('core', nonce, 'drop');
    const outcome = await pending; if (outcome.error) throw outcome.error;
    const interrupted = execution(await view(alice), r.id, 0); assert.equal(interrupted.status, 'uncertain');
    if (phase === 'unsigned') assert.equal(interrupted.txid, null);
    else assert.equal(interrupted.txid, ready.transactionId);
    await fixture.startCore();
    assert(!fixture.core('listwallets').includes(walletName), 'Core must leave the persisted participant wallet unloaded for this regression');
    assert.deepEqual(walletDirectory(), walletDirectoryBefore);
    await command('payment.reconcile', { receiverId: alice.id, executionId: interrupted.id });
    const recovered = execution(await view(alice), r.id, 0); assert.equal(recovered.id, interrupted.id); assert.equal(recovered.status, 'succeeded');
    if (phase === 'broadcast') { assert.equal(recovered.txid, interrupted.txid); assert.equal(recovered.txid, ready.transactionId); }
    const raw = fixture.core('getrawtransaction', [recovered.txid, false]);
    const transactionDigest = createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex'); assert.equal(transactionDigest, originalDigest);
    if (phase === 'unsigned') {
      const signing = fixture.evidence().gateEvents.filter(e => e.event === 'upstream.completed' && e.successfulSigning && e.identityDigest === ready.identityDigest);
      assert.equal(signing.length, 2, 'Original unsigned transaction must be signed again byte-for-byte after reload');
      assert(signing.every(e => e.signedTransactionDigest === originalDigest));
    }
    await finish(r, 0, false, mineAfterRestart);
    await command('payment.reconcile', { receiverId: alice.id, executionId: recovered.id });
    await command('payment.execute', selection(r, 0, fixture.walletIds.fault));
    const sendsAfter = sendIds(); assert.deepEqual(sendsAfter, [...new Set([...sendsBefore, recovered.txid])].sort()); assert.equal(sendsAfter.length, sendsBefore.length + 1);
    assert.equal(fixture.counts().core.executionSuccess, gateBefore + 1); assert.deepEqual(walletDirectory(), walletDirectoryBefore);
    evidence.regressions.coreRestarts.push({ phase, executionId: recovered.id, txid: recovered.txid, transactionDigest, originalDigest, walletWasUnloaded: true, walletDirectoryBefore, walletDirectoryAfter: walletDirectory(), sendsBefore: sendsBefore.length, sendsAfter: sendsAfter.length });
    await cancel(r); stage(`recurring-core-${phase}-restart`);
  }
  return validateEvidence(evidence);
}
module.exports = { stages, run, validateEvidence, assertEndpointCommitment };
