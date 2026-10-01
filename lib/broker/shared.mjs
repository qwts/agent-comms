// Shared limits and hashing used by the broker's policy modules.

import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({
  bodyBytes: 32 * 1024,
  refs: 16,
  refChars: 256,
  readPage: 100,
  unackedPerMailbox: 1000,
  replyDepth: 8,
  sendsPerAccountPerMinute: 120,
  sendsPerPairPerMinute: 30,
  proofMaxAgeMs: 5 * 60 * 1000,
  // Leading window for one soul's watch wake. The first message arms it;
  // later messages in the window only add to the count. account-watch uses
  // this same window, then spaces its own events with wakeRateMs.
  wakeWindowMs: 1000,
  // Minimum gap between account-watch wake events for one soul. Events that
  // would have fired inside the gap share the next one (ADR-0008 decision 7).
  wakeRateMs: 2000,
});

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
