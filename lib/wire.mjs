// Newline-delimited JSON over a Unix socket. A client sends one request line;
// the broker answers with one line, or, for a watch, a line per event until
// either side closes. A watch in wake mode folds a burst into one wake line.

import { isUtf8 } from 'node:buffer';
import { hasOwnerDecisionOperation, MAX_OWNER_FRAME_BYTES } from './owner-decision-frame-classifier.mjs';

// `count` is how many messages folded into this signal. `cursor` is the seq
// of the first message still unacknowledged, not a read `after` token:
// passing it as `--after` skips that message. Read with no `--after`.
export function wakeEvent(count, cursor) {
  return { event: 'wake', count, cursor };
}

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 128 * 1024;
const frames = new WeakMap();
// Only lineReader can attest original received bytes. A request field or a
// reconstructed/decoded string cannot manufacture this transport metadata.
export const receivedFrameBytes = metadata => frames.get(metadata)?.frameBytes ?? null;
export const receivedFrameUtf8Valid = metadata => frames.get(metadata)?.utf8Valid === true;

// The limit applies to every line and to whatever is buffered, newline or
// not, so no peer can make the broker hold or parse more than one bounded
// line. The first violation stops the reader; the caller drops the socket.
export function lineReader(socket, onLine, onError, { ownerRequests = false } = {}) {
  let buffer = Buffer.alloc(0);
  let originalBytes = true;
  let stopped = false;
  const stop = (message) => {
    stopped = true;
    buffer = Buffer.alloc(0);
    onError(new Error(message));
  };
  socket.on('data', (chunk) => {
    if (stopped) return;
    // Fresh broker sockets deliver Buffers. Decoded-stream compatibility is
    // retained for existing consumers, but cannot attest raw owner frames.
    if (!Buffer.isBuffer(chunk)) originalBytes = false;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline;
    while (!stopped && (newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_LINE_BYTES) {
        stop('line exceeds the protocol limit');
        return;
      }
      if (!line.length) continue;
      const utf8Valid = originalBytes && isUtf8(line);
      // Trusted broker-server mode only. A single raw scan precedes payload
      // decoding; the shared generic buffering ceiling remains 128 KiB.
      if (ownerRequests && hasOwnerDecisionOperation(line)
          && (line.length + 1 > MAX_OWNER_FRAME_BYTES || !utf8Valid)) {
        stop('the owner-decision frame is invalid');
        return;
      }
      let value;
      try {
        value = JSON.parse(line.toString('utf8'));
      } catch {
        stop('line is not JSON');
        return;
      }
      const metadata = Object.freeze({ frameBytes: originalBytes ? line.length + 1 : null,
        utf8Valid });
      if (originalBytes) frames.set(metadata, metadata);
      onLine(value, metadata);
    }
    if (!stopped && buffer.length > MAX_LINE_BYTES) stop('line exceeds the protocol limit');
  });
}

export const writeLine = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
