// Internal synthetic enrollment state for disabled coordinator composition.
// This is NOT an enrollment ceremony, persistence format, or protected key
// provider. Production construction remains unsupported. A pair revision
// changes atomically; revocation/reinstallation cannot revive a pending attempt.
import { createHash, createPublicKey, KeyObject } from 'node:crypto';
import { ownerDecisionAccount } from '../owner-decision-identities.mjs';

const invalid = () => { throw new Error('invalid-owner-enrollment'); };
const hash = key => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
};
export class DisabledOwnerDecisionEnrollment {
  #namespace; #service; #current = null;
  constructor({ namespaceDigest, service } = {}) {
    if (typeof namespaceDigest !== 'string' || namespaceDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(namespaceDigest)) invalid();
    exact(service, ['account', 'uid']);
    const { account, uid } = service;
    if (!ownerDecisionAccount(account) || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) invalid();
    this.#namespace = namespaceDigest;
    this.#service = Object.freeze({ account, uid });
  }
  install(record) {
    exact(record, ['revision', 'brokerPrivateKey', 'presencePublicKey']);
    const { revision, brokerPrivateKey, presencePublicKey } = record;
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1023 || revision <= (this.#current?.revision ?? 0)) invalid();
    for (const [key, type] of [[brokerPrivateKey, 'private'], [presencePublicKey, 'public']]) {
      if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== 'ed25519') invalid();
    }
    const brokerPublicKey = createPublicKey(brokerPrivateKey);
    const brokerKey = hash(brokerPublicKey), presenceKey = hash(presencePublicKey);
    if (brokerKey === presenceKey) invalid();
    this.#current = Object.freeze({ namespaceDigest: this.#namespace, service: this.#service, revision,
      active: true, brokerKey, presenceKey, brokerPrivateKey, brokerPublicKey, presencePublicKey });
  }
  revoke(revision) {
    if (!this.#current || !Number.isSafeInteger(revision) || revision > 1024 || revision <= this.#current.revision) invalid();
    this.#current = Object.freeze({ ...this.#current, revision, active: false });
  }
  snapshot() { return this.#current; }
}
