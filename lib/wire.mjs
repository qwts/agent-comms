// Newline-delimited JSON over a Unix socket. A client sends one request line;
// the broker answers with one line, or, for a watch, a line per event until
// either side closes. A watch in wake mode folds a burst into one wake line.

// `count` is how many messages folded into this signal. `cursor` is the seq
// of the first message still unacknowledged, not a read `after` token:
// passing it as `--after` skips that message. Read with no `--after`.
export function wakeEvent(count, cursor) {
  return { event: 'wake', count, cursor };
}

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 128 * 1024;

// The limit applies to every line and to whatever is buffered, newline or
// not, so no peer can make the broker hold or parse more than one bounded
// line. The first violation stops the reader; the caller drops the socket.
export function lineReader(socket, onLine, onError) {
  let buffer = '';
  let stopped = false;
  const stop = (message) => {
    stopped = true;
    buffer = '';
    onError(new Error(message));
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (stopped) return;
    buffer += chunk;
    let newline;
    while (!stopped && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        stop('line exceeds the protocol limit');
        return;
      }
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        stop('line is not JSON');
        return;
      }
      onLine(value);
    }
    if (!stopped && Buffer.byteLength(buffer) > MAX_LINE_BYTES) stop('line exceeds the protocol limit');
  });
}

export const writeLine = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
