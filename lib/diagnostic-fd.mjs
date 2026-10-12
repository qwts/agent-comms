// One bounded line, one asynchronous fd write at a time, no retries without
// positive progress. The dedicated helper owns process-lifetime isolation.
export function writeDiagnosticLine(line, write, complete) {
  if (typeof line !== 'string') { complete(false); return; }
  const bytes = Buffer.from(line);
  if (!bytes.length || bytes.length > 512) { complete(false); return; }
  let offset = 0;
  function next() {
    try {
      write(2, bytes, offset, bytes.length - offset, null, (error, count) => {
        if (error || !Number.isInteger(count) || count <= 0 || count > bytes.length - offset) { complete(false); return; }
        offset += count;
        if (offset === bytes.length) complete(true);
        else next();
      });
    } catch { complete(false); }
  }
  next();
}
