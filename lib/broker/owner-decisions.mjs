// Disabled connected coordinator, exercised only by explicit synthetic fixtures.
// Broker ingress imports the refusing production factory. Construction refuses until a reviewed
// native provider and supported physical journal exist. Authentication uses the
// real pairing collaborator, never a generic caller-selected auth callback.
import { createHash, createPublicKey } from 'node:crypto';
import { Broker } from '../broker.mjs';
import { CommsError, fail } from '../errors.mjs';
import { OwnerDecisionJournalStore } from '../owner-decision-journal.mjs';
import { ownerDecisionJournalError } from '../owner-decision-journal-errors.mjs';
import { decodeOwnerDecisionCanonical } from '../owner-decision-canonical.mjs';
import { decodeOwnerDecisionAction } from '../owner-decision-codec.mjs';
import { decodeOwnerDecisionPrepared } from '../owner-decision-prepared.mjs';
import { prepareOwnerDecisionReceipt, ownerDecisionReceiptSigningInput, finishOwnerDecisionReceipt, discardOwnerDecisionReceipt, issueOwnerDecisionReceipt } from '../owner-decision-issuer.mjs';
import { verifyOwnerDecisionProof } from '../owner-decision-proof.mjs';
import { validateStoredOwnerGrants } from '../owner-scoped-grants.mjs';
import { ownerGrantCovers } from './owner-grants.mjs';
import { covers } from './shared.mjs';
import { writeLine } from '../wire.mjs';
import { SyntheticOwnerReceiptCapability } from './owner-receipt-fixture.mjs';
import { DisabledOwnerDecisionEnrollment } from './owner-enrollment.mjs';
import { ownerDecisionReadiness } from '../platform/owner-decision-readiness.mjs';

// Bound before recursive serialization even for direct internal callers. This
// does not replace transport framing or the exact typed operation decoders.
const bytes = value => {
  const parts = []; let size = 0;
  const add = text => { size += Buffer.byteLength(text); if (size > 32768) deny('bad-request'); parts.push(text); };
  const visit = (v, depth) => {
    if (depth > 8) deny('bad-request');
    if (v === null || typeof v === 'boolean') return add(JSON.stringify(v));
    if (typeof v === 'string') { if (v.length > 32768) deny('bad-request'); return add(JSON.stringify(v)); }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || Object.is(v, -0)) deny('bad-request'); return add(String(v)); }
    if (!v || typeof v !== 'object') deny('bad-request');
    const keys = Object.keys(v).sort(); if (keys.length > 32) deny('bad-request');
    if (Array.isArray(v)) {
      if (v.length > 32) deny('bad-request'); add('[');
      for (let i = 0; i < v.length; i++) { if (i) add(','); visit(v[i], depth + 1); }
      return add(']');
    }
    add('{');
    for (const [i, key] of keys.entries()) { if (key.length > 64) deny('bad-request'); if (i) add(','); add(JSON.stringify(key)); add(':'); visit(v[key], depth + 1); }
    add('}');
  };
  visit(value, 0); return Buffer.from(parts.join(''));
};
const canonical = value => bytes(value).toString('utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const match = (re, value) => typeof value === 'string' && re.exec(value)?.[0] === value;
const messages = {
  'bad-request': 'The owner-decision input is invalid.', conflict: 'The owner-decision content conflicts with retained state.',
  'owner-decision-unavailable': 'The owner decision is unavailable.',
  'owner-decision-unsupported': 'The owner-decision provider is unsupported.',
  'daemon-unavailable': 'The selected daemon watch is unavailable.',
  'preparation-stale': 'The owner-decision preparation is stale.',
  'presence-invalid': 'The owner-decision presence proof is invalid.',
};
const deny = code => fail(code, messages[code]);
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) deny('bad-request');
};
const disabledCoordinators = new WeakSet();
export const isDisabledOwnerDecisionCoordinator = value => disabledCoordinators.has(value);
const bindingNames = ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId'];

export function createDisabledOwnerDecisionCoordinator({ broker, pairing, watches, journal, enrollment,
  namespaceDigest, syntheticFixture = false, signingCapability, signingTimeoutMilliseconds = 10000 } = {}) {
  if (!syntheticFixture || !(broker instanceof Broker) || !(journal instanceof OwnerDecisionJournalStore)
      || !(enrollment instanceof DisabledOwnerDecisionEnrollment)
      || (signingCapability !== undefined && !(signingCapability instanceof SyntheticOwnerReceiptCapability))
      || !Number.isSafeInteger(signingTimeoutMilliseconds) || signingTimeoutMilliseconds < 1 || signingTimeoutMilliseconds > 10000) deny('owner-decision-unsupported');
  const coordinator = composeOwnerDecisionCoordinator({ broker, pairing, watches, journal, enrollment, namespaceDigest, signingCapability, signingTimeoutMilliseconds });
  disabledCoordinators.add(coordinator); return coordinator;
}

export function createProductionOwnerDecisionCoordinator({ broker, pairing, watches } = {}) {
  if (!(broker instanceof Broker)) deny('owner-decision-unsupported');
  const readiness = ownerDecisionReadiness(broker);
  // Protected installation/enrollment and physical eligibility producers are
  // not implemented. Never substitute synthetic state or derive fresh trust.
  if (!readiness.supported) deny('owner-decision-unsupported');
  // The supported branch requires the reviewed producer adapter, not caller
  // parameters. No production construction or authority is available yet.
  deny('owner-decision-unsupported');
}

function composeOwnerDecisionCoordinator({ broker, pairing, watches, journal, enrollment, namespaceDigest, signingCapability, signingTimeoutMilliseconds }) {
  let closed = false;
  const inFlight = new Map(); // Finite, retained until actual signer promise terminal.
  const sourceIdentity = s => canonical([s.namespaceDigest, s.revision, s.brokerKey, s.presenceKey, s.service,
    s.brokerEnrollmentHeadDigest ?? null, s.observationDigest ?? null, s.custodyFingerprint ?? null]);
  const selected = new Map(); // At most one entry per retained ID, never failover.
  const now = () => {
    const milliseconds = broker.now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) deny('bad-request');
    return milliseconds;
  };
  const second = () => Math.floor(now() / 1000);
  const currentEnrollment = () => {
    const snapshot = signingCapability ? signingCapability.observe() : enrollment.snapshot();
    if (!snapshot?.active || snapshot.namespaceDigest !== namespaceDigest
        || snapshot.service.uid !== process.getuid()) deny('owner-decision-unsupported');
    return snapshot;
  };
  const mappedFailure = error => {
    if (error instanceof CommsError) throw error;
    const result = ownerDecisionJournalError(error); fail(result.code, result.message);
  };
  const run = fn => request => {
    try {
      if (closed) deny('owner-decision-unsupported');
      const result = fn(request);
      return result instanceof Promise ? result.catch(mappedFailure) : result;
    } catch (error) { return mappedFailure(error); }
  };
  const envelope = (request, op, fields, kind) => {
    bytes(request); // Reject excessive depth/size/cycles before auth/serialization.
    const identity = kind === 'principal' ? pairing.principal(request) : pairing.daemon(request);
    if (kind === 'principal' && pairing.isInbound(request)) fail('unauthenticated', 'A presented principal credential is required.');
    exact(request, ['v', 'op', 'auth', ...fields]);
    exact(request.auth, [kind, 'secret']);
    if (request.v !== 1 || request.op !== op) deny('bad-request');
    return identity;
  };
  // Before preparation this checks only requested selectors. It does not claim
  // local soul existence/ownership: that comes from selected daemon preparation.
  const selectorScope = (principal, action) => {
    try {
      const state = broker.state, row = state.principals.get(principal);
      if (row?.state !== 'approved' || state.pairings.get(action.account)?.state !== 'approved'
          || state.daemons.get(action.account)?.state !== 'approved') return false;
      validateStoredOwnerGrants(row);
      if (!covers(row.grant, { account: action.account, agentId: action.soul })) return false;
      return (row.ownerGrants ?? []).some(entry => entry.account === action.account
        && (entry.souls === '*' || entry.souls.includes(action.soul)) && entry.operations.includes(action.operation));
    } catch { return false; }
  };
  const view = (requestId, access = null) => {
    if (!match(uuid4, requestId)) deny('bad-request');
    const read = journal.read(requestId);
    if (read.finding === 'absent') return null;
    // Public callers must not distinguish foreign visible/orphan IDs from
    // absence before independently establishing their retained ownership.
    if (access && (!read.actionBytes || !read.acceptanceBytes)) deny('owner-decision-unavailable');
    const action = decodeOwnerDecisionAction(read.actionBytes).action;
    if (access?.principal && (action.principal !== access.principal || !selectorScope(access.principal, action))) deny('owner-decision-unavailable');
    if (access?.account && action.account !== access.account) deny('owner-decision-unavailable');
    if (read.finding !== 'admission-complete' || !read.slots) throw new Error('owner-journal-recovery-required');
    const acceptance = decodeOwnerDecisionCanonical(read.acceptanceBytes);
    const saved = { originalActionBytes: read.actionBytes, acceptedAt: acceptance.acceptedAt,
      daemonKey: acceptance.daemonKey, daemonEpoch: acceptance.daemonEpoch, watchId: acceptance.watchId };
    const json = slot => read.slots.has(slot) ? decodeOwnerDecisionCanonical(read.slots.get(slot)) : null;
    return { ...read, action, acceptance, saved, prepared: read.slots.has('prepared-challenge')
      ? decodeOwnerDecisionPrepared(read.slots.get('prepared-challenge'), saved) : null,
    authorization: json('authorization'), outcome: json('initial-outcome') };
  };
  const principalView = (principal, requestId) => {
    const row = view(requestId, { principal });
    if (!row || row.action.principal !== principal || !selectorScope(principal, row.action)) deny('owner-decision-unavailable');
    return row;
  };
  const currentDaemon = account => {
    const daemon = broker.state.daemons.get(account);
    if (broker.state.pairings.get(account)?.state !== 'approved' || daemon?.state !== 'approved') deny('preparation-stale');
    return { daemonEpoch: daemon.epoch,
      daemonKey: hash(createPublicKey(daemon.publicKey).export({ type: 'spki', format: 'der' })) };
  };
  const boundDaemon = (identity, request, row) => {
    const a = row.acceptance, daemon = currentDaemon(identity.account);
    if (identity.account !== a.account) deny('owner-decision-unavailable');
    for (const name of bindingNames) if (request[name] !== a[name]) deny('preparation-stale');
    if (daemon.daemonKey !== a.daemonKey || daemon.daemonEpoch !== a.daemonEpoch) deny('preparation-stale');
  };
  const liveSelection = row => {
    const choice = selected.get(row.requestId), snapshot = currentEnrollment();
    if (!choice || choice.sourceIdentity !== sourceIdentity(snapshot)) deny('preparation-stale');
    const binding = watches.accountWatchBinding(choice.socket), a = row.acceptance;
    if (!binding) deny('daemon-unavailable');
    if (binding.account !== a.account || binding.watchId !== a.watchId || binding.daemonKey !== a.daemonKey
        || binding.daemonEpoch !== a.daemonEpoch) deny('preparation-stale');
    if (snapshot.brokerKey === a.daemonKey || snapshot.presenceKey === a.daemonKey) deny('owner-decision-unsupported');
    return { choice, snapshot };
  };
  const currentAuthority = row => {
    if (!row.prepared || !ownerGrantCovers(broker.state, row.action.principal,
      { account: row.acceptance.account, agentId: row.action.soul }, row.action.operation)) deny('owner-decision-unavailable');
    return liveSelection(row);
  };
  const statusValue = row => {
    if (row.slots.has('terminal-reference')) deny('owner-decision-unsupported');
    return { requestId: row.requestId, payloadDigest: row.acceptance.payloadDigest, state: row.state,
      challenge: row.state === 'prepared' ? row.prepared.challenge : null, outcome: row.outcome?.outcome ?? null };
  };
  const recordBrokerOutcome = (row, state, code) => journal.recordOutcome(row.requestId, bytes({ v: 1, kind: 'outcome',
    requestId: row.requestId, payloadDigest: row.acceptance.payloadDigest, state,
    receiptDigest: row.slots.has('receipt') ? hash(row.slots.get('receipt')) : null,
    outcome: { code, effectDigest: null }, source: 'broker', reportingDaemonKey: null, reportingDaemonEpoch: null, at: second() }));
  const expire = row => {
    if (row.outcome) return row;
    const deadline = row.authorization?.exp ?? row.prepared?.challenge.exp ?? row.acceptance.acceptedAt + 180;
    if (second() >= deadline && ['preparing', 'prepared', 'authorized'].includes(row.state)) {
      recordBrokerOutcome(row, row.state === 'authorized' ? 'refused' : 'expired', 'deadline-expired');
      return view(row.requestId);
    }
    return row;
  };
  const boundEvent = event => {
    bytes(event);
    if (Buffer.byteLength(JSON.stringify(event) + '\n') > 32768) deny('bad-request');
    return event;
  };
  const sendOnce = (socket, event) => {
    try { writeLine(socket, event); } catch { deny('daemon-unavailable'); }
  };

  const prepare = run(request => {
    const { principal } = envelope(request, 'owner-decision-prepare', ['requestId', 'account', 'soul', 'operation', 'parameters'], 'principal');
    const actionBytes = bytes({ v: 1, requestId: request.requestId, principal, account: request.account,
      soul: request.soul, operation: request.operation, parameters: request.parameters });
    let decoded;
    try { decoded = decodeOwnerDecisionAction(actionBytes); } catch { deny('bad-request'); }
    const action = decoded.action;
    if (!selectorScope(principal, action)) deny('owner-decision-unavailable');
    const prior = view(action.requestId, { principal });
    if (prior) {
      if (prior.action.principal !== principal) deny('owner-decision-unavailable');
      if (!prior.actionBytes.equals(actionBytes)) deny('conflict');
      return statusValue(expire(prior));
    }
    const snapshot = currentEnrollment(), choice = watches.selectAccountWatch(action.account);
    if (!choice) deny('daemon-unavailable');
    if (snapshot.brokerKey === choice.binding.daemonKey || snapshot.presenceKey === choice.binding.daemonKey) deny('owner-decision-unsupported');
    if (selected.size >= 4096) fail('journal-capacity', 'The owner-decision journal cannot admit another request.');
    const acceptance = { v: 1, kind: 'acceptance', requestId: action.requestId, principal, account: action.account,
      soul: action.soul, operation: action.operation, payloadDigest: decoded.payloadDigest, namespaceDigest,
      acceptedAt: second(), daemonKey: choice.binding.daemonKey, daemonEpoch: choice.binding.daemonEpoch,
      watchId: choice.binding.watchId, reservationBytes: 262144 };
    const event = boundEvent({ event: 'owner-decision-prepare', requestId: action.requestId, principal,
      account: action.account, soul: action.soul, operation: action.operation, parameters: action.parameters, payloadDigest: decoded.payloadDigest,
      action: actionBytes.toString('base64url'), acceptedAt: acceptance.acceptedAt,
      daemonKey: acceptance.daemonKey, daemonEpoch: acceptance.daemonEpoch, watchId: acceptance.watchId });
    const admitted = journal.admit(actionBytes, bytes(acceptance));
    if (admitted.duplicate) return statusValue(view(action.requestId));
    selected.set(action.requestId, Object.freeze({ socket: choice.socket, sourceIdentity: sourceIdentity(snapshot) }));
    const row = view(action.requestId); liveSelection(row);
    sendOnce(choice.socket, event);
    return statusValue(row);
  });
  const prepared = run(request => {
    const identity = envelope(request, 'owner-decision-prepared', [...bindingNames, 'nonce', 'preparedAt', 'exp', 'stage'], 'daemon');
    const row = view(request.requestId, { account: identity.account }); if (!row) deny('owner-decision-unavailable');
    boundDaemon(identity, request, row);
    const a = row.acceptance;
    const challenge = { requestId: row.requestId, principal: a.principal, account: a.account, soul: a.soul,
      operation: a.operation, payloadDigest: a.payloadDigest, action: row.actionBytes.toString('base64url'),
      nonce: request.nonce, acceptedAt: a.acceptedAt, preparedAt: request.preparedAt, exp: request.exp,
      daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId };
    const wrapperBytes = bytes({ v: 1, challenge, stage: request.stage });
    try { decodeOwnerDecisionPrepared(wrapperBytes, row.saved); } catch { deny('bad-request'); }
    if (!row.prepared) {
      if (expire(row).state !== 'preparing') return { requestId: row.requestId, state: view(row.requestId).state };
      liveSelection(row);
      if (!selectorScope(row.action.principal, row.action)) deny('owner-decision-unavailable');
    }
    const result = journal.recordPrepared(row.requestId, wrapperBytes);
    return { requestId: row.requestId, state: result.state };
  });
  const confirmLegacyFixture = run(request => {
    const { principal } = envelope(request, 'owner-decision', ['requestId', 'payloadDigest', 'presence'], 'principal');
    let row = principalView(principal, request.requestId);
    if (request.payloadDigest !== row.acceptance.payloadDigest) deny('conflict');
    if (typeof request.presence !== 'string' || request.presence.length > 4096 || !/^[\x00-\x7f]+$/.test(request.presence)) deny('bad-request');
    row = expire(row);
    if (row.slots.has('presence') && !row.slots.get('presence').equals(Buffer.from(request.presence))) deny('conflict');
    if (row.state !== 'prepared') return statusValue(row);
    if (row.slots.has('presence')) throw new Error('owner-journal-recovery-required');
    const { choice, snapshot } = currentAuthority(row);
    let intent;
    try { intent = prepareOwnerDecisionReceipt({ preparedBytes: row.slots.get('prepared-challenge'), saved: row.saved,
      presenceToken: request.presence, presencePublicKey: snapshot.presencePublicKey,
      brokerPublicKey: snapshot.brokerPublicKey, nowMilliseconds: now() }); } catch { deny('presence-invalid'); }
    const estimate = ownerDecisionReceiptSigningInput(intent), challenge = row.prepared.challenge;
    boundEvent({ event: 'owner-decision', requestId: row.requestId, action: row.actionBytes.toString('base64url'),
      presence: request.presence, receipt: 'x'.repeat(estimate.receiptLength), receiptDigest: '0'.repeat(64),
      daemonKey: challenge.daemonKey, daemonEpoch: challenge.daemonEpoch, watchId: challenge.watchId });
    discardOwnerDecisionReceipt(intent);
    const signingHandle = journal.beginSigning(row.requestId, Buffer.from(request.presence));
    let issued;
    try { issued = issueOwnerDecisionReceipt({ preparedBytes: row.slots.get('prepared-challenge'), saved: row.saved,
      presenceToken: request.presence, presencePublicKey: snapshot.presencePublicKey,
      brokerPrivateKey: snapshot.brokerPrivateKey, nowMilliseconds: now() }); }
    catch { journal.abandonSigning(signingHandle); deny('presence-invalid'); }
    const p = issued.payload, c = row.prepared.challenge;
    const authorization = { v: 1, kind: 'authorization', requestId: row.requestId, payloadDigest: row.acceptance.payloadDigest,
      nonce: c.nonce, actionDigest: hash(row.prepared.actionText), challengeDigest: hash(row.prepared.challengeBytes),
      presenceDigest: p.presenceDigest, receiptDigest: issued.receiptDigest, exp: p.exp,
      daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId };
    const event = boundEvent({ event: 'owner-decision', requestId: row.requestId,
      action: row.actionBytes.toString('base64url'), presence: request.presence, receipt: issued.receiptToken,
      receiptDigest: issued.receiptDigest, daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId });
    const stored = journal.finishSigning(signingHandle, { receiptBytes: Buffer.from(issued.receiptToken), authorizationBytes: bytes(authorization) });
    if (!stored.duplicate) {
      row = expire(view(row.requestId));
      if (row.state === 'authorized') {
        currentAuthority(row);
        sendOnce(choice.socket, event);
      }
    }
    return statusValue(view(row.requestId));
  });
  const confirmAsync = run(async input => {
    // Copy the authenticated envelope before suspension; caller mutation cannot
    // replace credentials/proof/bindings while the native operation is pending.
    const request = JSON.parse(canonical(input));
    const { principal } = envelope(request, 'owner-decision', ['requestId', 'payloadDigest', 'presence'], 'principal');
    let row = expire(principalView(principal, request.requestId));
    if (request.payloadDigest !== row.acceptance.payloadDigest) deny('conflict');
    if (typeof request.presence !== 'string' || request.presence.length > 4096 || !/^[\x00-\x7f]+$/.test(request.presence)) deny('bad-request');
    if (row.slots.has('presence') && !row.slots.get('presence').equals(Buffer.from(request.presence))) deny('conflict');
    if (row.state !== 'prepared') return statusValue(row);
    if (row.slots.has('presence') || inFlight.has(row.requestId)) throw new Error('owner-journal-id-spent');
    if (inFlight.size >= 32 || [...inFlight.values()].filter(job => job.principal === principal).length >= 4)
      deny('owner-decision-unsupported');
    const { choice, snapshot } = currentAuthority(row), identity = sourceIdentity(snapshot);
    let intent;
    try { intent = prepareOwnerDecisionReceipt({ preparedBytes: row.slots.get('prepared-challenge'), saved: row.saved,
      presenceToken: request.presence, presencePublicKey: snapshot.presencePublicKey,
      brokerPublicKey: snapshot.brokerPublicKey, nowMilliseconds: now() }); }
    catch { deny('presence-invalid'); }
    const candidate = ownerDecisionReceiptSigningInput(intent), c = row.prepared.challenge;
    // Reject an already unframeable eventual event BEFORE spending the nonce.
    boundEvent({ event: 'owner-decision', requestId: row.requestId, action: row.actionBytes.toString('base64url'),
      presence: request.presence, receipt: 'x'.repeat(candidate.receiptLength), receiptDigest: '0'.repeat(64),
      daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId });
    const command = Object.freeze({ v: 1, op: 'issue-decision-receipt', namespaceDigest,
      brokerLocalRevision: snapshot.revision, brokerEnrollmentHeadDigest: snapshot.brokerEnrollmentHeadDigest,
      observationDigest: snapshot.observationDigest, prepared: candidate.prepared.toString('base64url'),
      originalAction: candidate.originalAction.toString('base64url'), presence: candidate.presence, iat: candidate.iat, exp: candidate.exp });
    const handle = journal.beginSigning(row.requestId, Buffer.from(request.presence));
    const controller = new AbortController(), job = { principal, controller };
    inFlight.set(row.requestId, job);
    let timer, terminal = false, started = false;
    const live = () => {
      if (closed || controller.signal.aborted) deny('owner-decision-unavailable');
      envelope(request, 'owner-decision', ['requestId', 'payloadDigest', 'presence'], 'principal');
      row = expire(principalView(principal, request.requestId));
      if (row.state !== 'prepared' || !row.slots.get('presence')?.equals(Buffer.from(request.presence))) deny('preparation-stale');
      const current = currentAuthority(row);
      if (current.choice.socket !== choice.socket || sourceIdentity(current.snapshot) !== identity) deny('preparation-stale');
    };
    try {
      live();
      // Timeout aborts the attempt, but does not pretend a helper exited. The
      // finite map slot remains charged until the owned operation is terminal.
      const settled = Promise.resolve().then(async () => {
        live(); // Cancel/close in the initial microtask gap starts no signer.
        // Conservatively charge even a launch throw: only a separate owned
        // terminal receipt can establish that resources are no longer live.
        started = true;
        const invocation = signingCapability.startDecisionReceipt(command, { signal: controller.signal });
        const terminalReceipt = Promise.resolve(invocation.terminal).then(receipt => {
          if (receipt?.terminalConfirmed === true && receipt.safeClose === true) {
            terminal = true; inFlight.delete(request.requestId);
          }
          return receipt;
        }, () => null); // Rejected terminal is handled immediately, never refunded.
        const result = await invocation.result;
        const receipt = await terminalReceipt;
        if (receipt?.terminalConfirmed !== true || receipt.safeClose !== true) deny('owner-decision-unsupported');
        return result;
      });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('owner-receipt-unavailable'));
      }, signingTimeoutMilliseconds); });
      const result = await Promise.race([settled, timeout]);
      if (!result) deny('owner-decision-unsupported');
      live();
      let issued;
      try { issued = finishOwnerDecisionReceipt(intent, result.signature, now()); }
      catch { deny('presence-invalid'); }
      const p = issued.payload;
      const authorization = { v: 1, kind: 'authorization', requestId: row.requestId, payloadDigest: row.acceptance.payloadDigest,
        nonce: c.nonce, actionDigest: hash(row.prepared.actionText), challengeDigest: hash(row.prepared.challengeBytes),
        presenceDigest: p.presenceDigest, receiptDigest: issued.receiptDigest, exp: p.exp,
        daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId };
      const event = boundEvent({ event: 'owner-decision', requestId: row.requestId, action: row.actionBytes.toString('base64url'),
        presence: request.presence, receipt: issued.receiptToken, receiptDigest: issued.receiptDigest,
        daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId });
      live(); // No await between current authority and synchronous journal commit.
      journal.finishSigning(handle, { receiptBytes: Buffer.from(issued.receiptToken), authorizationBytes: bytes(authorization) });
      row = expire(principalView(principal, request.requestId));
      if (!closed && !controller.signal.aborted && row.state === 'authorized') {
        const fresh = currentAuthority(row);
        if (fresh.choice.socket !== choice.socket || sourceIdentity(fresh.snapshot) !== identity) deny('preparation-stale');
        sendOnce(choice.socket, event);
      }
      return statusValue(row);
    } finally {
      clearTimeout(timer); controller.abort(); journal.abandonSigning(handle); discardOwnerDecisionReceipt(intent);
      if (terminal || !started) inFlight.delete(request.requestId);
    }
  });
  const confirm = signingCapability ? confirmAsync : confirmLegacyFixture;
  const check = run(request => {
    const identity = envelope(request, 'owner-decision-check', [...bindingNames, 'receiptDigest'], 'daemon');
    let row = view(request.requestId, { account: identity.account }); if (!row) deny('owner-decision-unavailable');
    boundDaemon(identity, request, row);
    if (!row.authorization || request.receiptDigest !== row.authorization.receiptDigest) deny('preparation-stale');
    const response = mayApply => ({ requestId: row.requestId, payloadDigest: row.acceptance.payloadDigest,
      receiptDigest: row.authorization.receiptDigest, daemonKey: row.acceptance.daemonKey,
      daemonEpoch: row.acceptance.daemonEpoch, watchId: row.acceptance.watchId,
      state: row.state, mayApply, exp: row.authorization.exp });
    row = expire(row);
    if (row.state !== 'authorized') return response(false);
    let snapshot;
    try { ({ snapshot } = currentAuthority(row)); }
    catch (error) {
      recordBrokerOutcome(row, 'refused', 'authority-refused'); row = view(row.requestId);
      if (error instanceof CommsError && error.code === 'owner-decision-unsupported') throw error;
      return response(false);
    }
    try { verifyOwnerDecisionProof({ challengeBytes: row.prepared.challengeBytes, saved: { ...row.saved,
      ...(row.prepared.wrapper.stage ? { stageExpiresAt: row.prepared.wrapper.stage.expiresAt } : {}) },
    receiptToken: row.slots.get('receipt').toString('ascii'), presenceToken: row.slots.get('presence').toString('ascii'),
    brokerPublicKey: snapshot.brokerPublicKey, presencePublicKey: snapshot.presencePublicKey, nowMilliseconds: now() }); }
    catch { recordBrokerOutcome(row, 'refused', 'validation-refused'); row = view(row.requestId); return response(false); }
    const result = journal.recordRelease(row.requestId, bytes({ ...response(true), state: 'released' }));
    row = view(row.requestId);
    let mayApply = !result.duplicate && second() < row.authorization.exp;
    if (mayApply) { try { currentAuthority(row); } catch { mayApply = false; } }
    if (!mayApply && !result.duplicate && !row.outcome) {
      recordBrokerOutcome(row, 'indeterminate', 'effect-uncertain'); row = view(row.requestId);
    }
    return response(mayApply);
  });
  const result = run(request => {
    const identity = envelope(request, 'owner-decision-result', [...bindingNames, 'receiptDigest', 'state', 'outcome', 'reconciliation'], 'daemon');
    const row = view(request.requestId, { account: identity.account }); if (!row) deny('owner-decision-unavailable');
    boundDaemon(identity, request, row);
    if (request.reconciliation !== null) deny('owner-decision-unsupported');
    const report = { state: request.state, receiptDigest: request.receiptDigest, outcome: request.outcome };
    if (row.outcome) {
      const old = { state: row.outcome.state, receiptDigest: row.outcome.receiptDigest, outcome: row.outcome.outcome };
      if (row.outcome.source !== 'daemon' || canonical(old) !== canonical(report)) deny('conflict');
      return { requestId: row.requestId, state: row.state, recorded: false };
    }
    const stored = journal.recordOutcome(row.requestId, bytes({ v: 1, kind: 'outcome', requestId: row.requestId,
      payloadDigest: row.acceptance.payloadDigest, ...report, source: 'daemon',
      reportingDaemonKey: row.acceptance.daemonKey, reportingDaemonEpoch: row.acceptance.daemonEpoch, at: second() }));
    return { requestId: row.requestId, state: stored.state, recorded: !stored.duplicate };
  });
  const status = run(request => {
    const { principal } = envelope(request, 'owner-decision-status', ['requestId'], 'principal');
    return statusValue(expire(principalView(principal, request.requestId)));
  });
  const cancel = run(request => {
    const { principal } = envelope(request, 'owner-decision-cancel', ['requestId'], 'principal');
    const row = expire(principalView(principal, request.requestId));
    if (['preparing', 'prepared'].includes(row.state)) {
      recordBrokerOutcome(row, 'cancelled', 'cancelled');
      inFlight.get(row.requestId)?.controller.abort();
      const choice = selected.get(row.requestId);
      if (choice && watches.accountWatchBinding(choice.socket)) {
        const a = row.acceptance;
        try { sendOnce(choice.socket, { event: 'owner-decision-cancel', requestId: row.requestId,
          payloadDigest: a.payloadDigest, daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId }); }
        catch { /* Best effort only; durable cancellation is authoritative. */ }
      }
    }
    return statusValue(view(row.requestId));
  });
  return Object.freeze({ prepare, prepared, confirm, check, result, status, cancel,
    close() { closed = true; for (const job of inFlight.values()) job.controller.abort(); },
    capabilities: Object.freeze({ syntheticFixtureOnly: true, productionSupported: false,
      authorizationSupported: false, physicalAllocationSupported: false }) });
}
