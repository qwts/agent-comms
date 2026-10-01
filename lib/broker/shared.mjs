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
});

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
