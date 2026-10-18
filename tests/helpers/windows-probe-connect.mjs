// A fixture start must settle even when the connector closes without error.
export function waitForProbeConnect(raw) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      raw.removeListener('connect', connected);
      raw.removeListener('error', failed);
      raw.removeListener('close', closed);
    };
    const connected = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(new Error('probe-connect-closed')); };
    raw.once('connect', connected);
    raw.once('error', failed);
    raw.once('close', closed);
    if (raw.destroyed) closed();
  });
}
