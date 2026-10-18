// Test-only artifact integrity check. Reads public fixture/dependency metadata;
// no credential, enrolled identity or production owner-decision API is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const receipt = JSON.parse(read('artifacts/crate-verification.json'));
const deps = JSON.parse(read('artifacts/dependency-checksums.json'));
const locked = read('Cargo.lock').split('[[package]]').slice(1).map((block) =>
  Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"/gm)].map((m) => [m[1], m[2]])))
  .filter((p) => p.source?.startsWith('registry+'));
assert.equal(locked.length, deps.length);
for (const dep of deps) {
  const match = locked.find((p) => p.name === dep.name && p.version === dep.version);
  assert(match); assert.equal(match.checksum, dep.sha256);
}
const hpke = locked.find((p) => p.name === 'hpke');
assert(hpke, 'Cargo.lock must contain the pinned hpke registry package');
assert.equal(hpke.version, receipt.version);
assert.equal(hpke.checksum, receipt.checksum);
const vector = JSON.parse(read('artifacts/rfc9180-auth-x25519-chacha.json'));
assert.deepEqual([vector.mode, vector.kem_id, vector.kdf_id, vector.aead_id], [2, 32, 1, 3]);
assert.equal(vector.encryptions.length, 257); assert.equal(vector.exports.length, 3);
console.log(`Pinned metadata agrees for ${deps.length} registry archives and selected RFC9180 Auth vector.`);
console.log(`Selected fixture SHA-256: ${createHash('sha256').update(read('artifacts/rfc9180-auth-x25519-chacha.json')).digest('hex')}`);
console.log('Cargo verifies downloaded archives against lock checksums; this check is not a dependency security audit.');
