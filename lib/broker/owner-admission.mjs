// Ephemeral load limits, never authority or persisted accepted-ID accounting.
import { performance } from 'node:perf_hooks';
import { fail } from '../errors.mjs';
import { ownerDecisionAccount } from '../owner-decision-identities.mjs';

export function createOwnerDecisionAdmissionLimiter({ elapsed = () => performance.now() } = {}) {
  const buckets = new Map();
  let previous = 0;
  const refuse = () => fail('rate-limited', 'Owner-decision preparation is rate limited.');
  return Object.freeze({
    admit(principal, account) {
      if (!ownerDecisionAccount(account)) fail('bad-request', 'The owner-decision account is invalid.');
      const instant = elapsed();
      if (!Number.isFinite(instant) || instant < previous || instant < 0) refuse();
      previous = instant;
      // Principal comes only from existing successful pairing authentication.
      // Pair keys cannot collide because the existing identity grammar excludes
      // the separator; both kinds count toward one finite 4096-entry bound.
      const keys = [`principal:${principal}`, `pair:${principal}/${account}`];
      for (const [key, times] of buckets) {
        const fresh = times.filter(time => instant - time < 60000);
        if (fresh.length) buckets.set(key, fresh); else buckets.delete(key);
      }
      const current = keys.map(key => buckets.get(key) ?? []);
      if (current[0].length >= 12 || current[1].length >= 6
          || buckets.size + keys.filter(key => !buckets.has(key)).length > 4096) refuse();
      // Check both quotas/capacity before charging either one.
      keys.forEach((key, i) => buckets.set(key, [...current[i], instant]));
    },
    close() { buckets.clear(); },
  });
}
