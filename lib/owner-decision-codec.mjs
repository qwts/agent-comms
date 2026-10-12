// Pure protocol validation, transitively imported by fail-closed owner ingress.
// A valid action/signature is not presence, authority or permission
// to mutate; callers still need the reviewed challenge/journal/grant adapters.
import { createHash, KeyObject, verify } from 'node:crypto';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { ownerDecisionAccount, ownerDecisionSoul } from './owner-decision-identities.mjs';

const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const principalId = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const revision = /^sha256:[0-9a-f]{64}$/;
// Display policy only: preserve permitted scalars exactly; never normalize.
// Frozen Unicode 17.0.0 Cc/Cf/Zl/Zp; see display-rejections-v1.json.
const unsafeDisplay = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{600}-\u{605}\u{61C}\u{6DD}\u{70F}\u{890}-\u{891}\u{8E2}\u{180E}\u{200B}-\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/u;
const operations = new Set(['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit', 'cold-wake.set']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('invalid-owner-decision'); };
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const time = value => Number.isSafeInteger(value) && value >= 0;

function fields(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail();
}

function identities(value) {
  if (value.v !== 1 || !matches(uuid4, value.requestId) || !matches(principalId, value.principal)
      || !ownerDecisionAccount(value.account) || !ownerDecisionSoul(value.soul)
      || !operations.has(value.operation)) fail();
}

function reason(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 500
      || unsafeDisplay.test(value)) fail();
}

function host(value) {
  if (typeof value !== 'string' || !/^[\x00-\x7f]+$/.test(value)
      || value.length > 253 || value !== value.toLowerCase()) fail();
  const parsed = new URL(`https://${value}/`);
  if (parsed.host !== value || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.username || parsed.password) fail();
}

function summary(action) {
  const p = action.parameters;
  if (action.operation === 'revision.approve' || action.operation === 'revision.reject') {
    fields(p, ['proposalId', 'expectedRevision', 'reason']);
    if (!matches(uuid4, p.proposalId) || !matches(revision, p.expectedRevision)) fail();
    reason(p.reason);
    return `proposal=${JSON.stringify(p.proposalId)}; reason=${JSON.stringify(p.reason)}`;
  }
  if (action.operation === 'revision.adopt' || action.operation === 'revision.edit') {
    const editing = action.operation === 'revision.edit';
    fields(p, ['stagingId', 'packageDigest', 'expectedRevision', 'reason', ...(editing ? ['apply'] : [])]);
    if (!matches(uuid4, p.stagingId) || !matches(digest, p.packageDigest)
        || (editing ? !matches(revision, p.expectedRevision) || typeof p.apply !== 'boolean' : p.expectedRevision !== null)) fail();
    reason(p.reason);
    return `package sha256:${p.packageDigest}; ${editing ? `apply=${p.apply}; ` : ''}reason=${JSON.stringify(p.reason)}`;
  }
  if (p?.mode === 'on' || p?.mode === 'off') {
    fields(p, ['mode']);
    return `mode=${p.mode}`;
  }
  if (p?.mode === 'resume') {
    fields(p, ['mode', 'policy']);
    if (p.policy !== 'read-only' && p.policy !== 'workspace') fail();
    return `mode=resume; policy=${p.policy}`;
  }
  if (p?.mode === 'webhook') {
    fields(p, ['mode', 'stagingId', 'configurationDigest', 'host']);
    if (!matches(uuid4, p.stagingId) || !matches(digest, p.configurationDigest)) fail();
    host(p.host);
    return `mode=webhook; host=${JSON.stringify(p.host)}; configuration sha256:${p.configurationDigest}`;
  }
  fail();
}

export function decodeOwnerDecisionAction(bytes) {
  try {
    const snapshot = snapshotOwnerDecisionBytes(bytes);
    const action = decodeOwnerDecisionCanonical(snapshot);
    fields(action, ['v', 'requestId', 'principal', 'account', 'soul', 'operation', 'parameters']);
    identities(action);
    const typedSummary = summary(action);
    const payloadDigest = hash(snapshot);
    const actionText = `Owner decision ${action.operation} for ${action.account}/${action.soul}: ${typedSummary}; request ${action.requestId}; payload sha256:${payloadDigest}`;
    if ([...actionText].length > 400 || Buffer.byteLength(actionText) > 500 || unsafeDisplay.test(actionText)) fail();
    return { action, payloadDigest, summary: typedSummary, actionText };
  } catch { fail(); }
}

function base64url(segment, length) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) fail();
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment || (length !== undefined && decoded.length !== length)) fail();
  return decoded;
}

// The caller must supply its independently enrolled public key; never resolve a
// new trusted key from token fields. This verifies d1 only, not the separate p1
// proof or the saved action/challenge, grants, deadlines and one-shot release.
export function verifySignedOwnerDecisionReceipt(token, options = {}) {
  try {
    const { brokerPublicKey, nowMilliseconds } = options;
    if (typeof token !== 'string' || token.length > 4096 || !/^[\x00-\x7f]+$/.test(token)) fail();
    if (!(brokerPublicKey instanceof KeyObject) || brokerPublicKey.type !== 'public'
        || brokerPublicKey.asymmetricKeyType !== 'ed25519' || !time(nowMilliseconds)) fail();
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'd1') fail();
    const payload = decodeOwnerDecisionCanonical(base64url(parts[1]));
    fields(payload, ['v', 'aud', 'brokerKey', 'requestId', 'principal', 'account', 'soul', 'operation',
      'payloadDigest', 'nonce', 'presenceKey', 'presenceDigest', 'iat', 'exp']);
    identities(payload);
    if (payload.aud !== 'agent-comms-owner-decision') fail();
    for (const key of ['brokerKey', 'payloadDigest', 'presenceKey', 'presenceDigest']) {
      if (!matches(digest, payload[key])) fail();
    }
    base64url(payload.nonce, 32);
    const now = Math.floor(nowMilliseconds / 1000);
    if (!time(payload.iat) || !time(payload.exp) || payload.exp <= payload.iat
        || payload.exp - payload.iat > 60 || payload.iat > now + 30 || now >= payload.exp) fail();
    if (payload.brokerKey !== hash(brokerPublicKey.export({ type: 'spki', format: 'der' }))) fail();
    if (!verify(null, Buffer.from(parts[1], 'ascii'), brokerPublicKey, base64url(parts[2], 64))) fail();
    return { payload, receiptDigest: hash(token) };
  } catch { fail(); }
}
