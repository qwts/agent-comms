// Newline-delimited JSON over a Unix socket. A client sends one request line;
// the broker answers with one line, or, for a watch, a line per event until
// either side closes.

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 128 * 1024;

export function lineReader(socket, onLine, onError) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes('\n')) {
      onError(new Error('line exceeds the protocol limit'));
      buffer = '';
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        onError(new Error('line is not JSON'));
        continue;
      }
      onLine(value);
    }
  });
}

export const writeLine = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
