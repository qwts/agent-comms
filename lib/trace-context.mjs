// Untrusted correlation only. Never normalize, authorize or persist this value.
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
export const validTraceparent = (value) => typeof value === 'string' && value.length === 55
  && TRACEPARENT.test(value) && value.slice(3, 35) !== '0'.repeat(32) && value.slice(36, 52) !== '0'.repeat(16)
  ? value : undefined;
