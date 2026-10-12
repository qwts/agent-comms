// Private native receipt framing. Parsing is never custody or authorization.
import { decodeOwnerDecisionCanonical } from '../owner-decision-canonical.mjs';
const commandFields = ['v','op','namespaceDigest','brokerLocalRevision','brokerEnrollmentHeadDigest','observationDigest',
  'prepared','originalAction','presence','iat','exp'];
const responseFields = ['v','kind','requestId','brokerEnrollmentHeadDigest','signature'];
const digest = /^[a-f0-9]{64}$/;
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const invalid = () => { throw new Error('owner-receipt-unavailable'); };
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !Object.hasOwn(descriptors, name))) invalid();
  const copy = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    copy[name] = descriptor.value;
  }
  return copy;
}
function encodedBytes(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > Math.ceil(maximum * 4 / 3)
      || !matches(/^[A-Za-z0-9_-]+$/, value)) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.length > maximum || decoded.toString('base64url') !== value) invalid();
  return decoded;
}
function canonical(value) {
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))));
}
export function encodeOwnerReceiptNativeCommand(command) {
  try {
    // Every command field is a bounded scalar: no recursive serialization of
    // arbitrary caller objects or accessors, and no mutable buffer inputs.
    const c = fields(command, commandFields);
    if (c.v !== 1 || c.op !== 'issue-decision-receipt'
        || !matches(digest, c.namespaceDigest) || !matches(digest, c.brokerEnrollmentHeadDigest)
        || !matches(digest, c.observationDigest) || !Number.isSafeInteger(c.brokerLocalRevision)
        || c.brokerLocalRevision < 1 || c.brokerLocalRevision > 1023
        || !Number.isSafeInteger(c.iat) || c.iat < 0 || Object.is(c.iat, -0)
        || !Number.isSafeInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > 60
        || !matches(/^[\x00-\x7f]{1,4096}$/, c.presence) || !c.presence.startsWith('p1.')) invalid();
    // Canonical embedded JSON is necessary framing, not typed/signature proof.
    decodeOwnerDecisionCanonical(encodedBytes(c.prepared, 32768));
    decodeOwnerDecisionCanonical(encodedBytes(c.originalAction, 32768));
    const bytes = canonical(c);
    if (bytes.length > 131072) invalid();
    return bytes;
  } catch { invalid(); }
}
export function decodeOwnerReceiptNativeResponse(input, expected) {
  try {
    const e = fields(expected, ['requestId','brokerEnrollmentHeadDigest']);
    if (!matches(uuid4, e.requestId) || !matches(digest, e.brokerEnrollmentHeadDigest)) invalid();
    // Snapshot once via the shared byte-only canonical decoder. The transport
    // already caps original stdout; this separate bound protects direct calls.
    if (!(input instanceof Uint8Array)) invalid();
    const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
    if (byteLength.call(input) < 1 || byteLength.call(input) > 1024) invalid();
    const response = fields(decodeOwnerDecisionCanonical(input), responseFields);
    if (response.v !== 1 || response.kind !== 'owner-decision-receipt-signature'
        || response.requestId !== e.requestId || response.brokerEnrollmentHeadDigest !== e.brokerEnrollmentHeadDigest) invalid();
    const signature = encodedBytes(response.signature, 64);
    if (signature.length !== 64) invalid();
    return Object.freeze({ signature });
  } catch { invalid(); }
}
