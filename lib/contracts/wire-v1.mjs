// wire/v1 frame codec (platform PDR-0024, seam wire-v1). agent-comms is the
// provider: the broker's delivery and relay layer frames routed messages in
// this outer frame. The local client request protocol in lib/wire.mjs sits
// below the seam and is unchanged.
//
// Live delivery does not frame messages yet. Every frame needs the receiving
// Soul's installation epoch, which HQ admission supplies (Stage 1); the
// per-account daemon epoch in lib/state.mjs means something else. See #300.
//
// This codec neither changes wire/v1 nor implements sealed-inner-v1. A
// `sealed` object is checked for shape only and never opened.

import { CommsError } from '../errors.mjs';
import { admit } from './schemas.mjs';
import { parseStrict } from './strict-json.mjs';

const FRAME = 'wire/v1/wire-frame.schema.json';
const DIRECTIVE = 'wire/v1/directive-or-query.schema.json';

// Inline frames carry at most 256 KiB (draft 0.4 section 6); larger
// artifacts travel as authorized content references.
export const MAX_INLINE_PAYLOAD_BYTES = 256 * 1024;
const OVERRIDES = { '/payload_size:maximum': 'frame_too_large' };

const parse = (raw) => {
  if (typeof raw !== 'string') return raw;
  try {
    return parseStrict(raw);
  } catch (error) {
    throw new CommsError('bad-request', `frame is not strict JSON: ${error.message}`);
  }
};

// Admits one inbound frame, given as strict-JSON text or a parsed value.
// `now` (milliseconds) and the capabilities negotiated with the sender are
// required: the broker always checks expiry and capabilities.
export function admitFrame(raw, { now, negotiatedCapabilities } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('admitFrame needs now in milliseconds');
  if (!Array.isArray(negotiatedCapabilities)) throw new TypeError('admitFrame needs the negotiated capabilities');
  const frame = admit(FRAME, parse(raw), OVERRIDES);
  if (Date.parse(frame.expires_at) < now) {
    throw new CommsError('message_expired', 'the frame expired before delivery');
  }
  const missing = frame.required_capabilities.filter((c) => !negotiatedCapabilities.includes(c));
  if (missing.length) {
    throw new CommsError('required_capability_missing', `capability not negotiated: ${missing.join(', ')}`);
  }
  return frame;
}

export const admitDirectiveOrQuery = (raw) => admit(DIRECTIVE, parse(raw));

// Builds the frame for one routed message. The caller supplies the
// destination's installation epoch; nothing here guesses it.
export function frameRoutedMessage({ messageId, destinationSoul, destinationEpoch, expiresAt,
  payloadSize, wakeClass, requiredCapabilities = [], sealed }) {
  // Checked before conversion: toISOString throws on an invalid time, and
  // null or a string would coerce to a valid-looking but wrong expiry.
  if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())) {
    throw new CommsError('bad-request', 'expiresAt must be a timestamp in milliseconds');
  }
  const frame = {
    wire_version: 1,
    message_id: messageId,
    destination_soul: destinationSoul,
    destination_epoch: destinationEpoch,
    expires_at: new Date(expiresAt).toISOString().replace(/\.000Z$/, 'Z'),
    payload_size: payloadSize,
    wake_class: wakeClass,
    required_capabilities: [...requiredCapabilities],
    ...(sealed === undefined ? {} : { sealed }),
  };
  return admit(FRAME, frame, OVERRIDES);
}
