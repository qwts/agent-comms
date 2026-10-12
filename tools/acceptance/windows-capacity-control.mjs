// Dev-only finite control transport. Failure records never contain child output.
const PHASES = new Set(['script-entry','policy-query','compile-supervisor','read-control','verify-fixture','assign-private-job','sample-job','query-members','close-job']);
export function encodingSignature(chunk) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return 'utf16le-bom';
  if (chunk[0] === 0xfe && chunk[1] === 0xff) return 'utf16be-bom';
  if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) return 'utf8-bom';
  if (chunk[0] === 0x7b && chunk[1] === 0) return 'utf16le-json';
  if (chunk.subarray(0, 9).toString('ascii') === '#< CLIXML') return 'clixml';
  return chunk.subarray(0, 16).every((byte) => byte < 128) ? 'ascii-compatible' : 'other';
}
export function createCapacityController(owned, { ipc = false, classifyFailure = () => new Error('job-supervisor-failed') } = {}) {
  const pending = new Map(); let id = 1, bytes = '', rejected, phase, encoding, policy;
  let resolveStartup, rejectStartup;
  const startup = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  startup.catch(() => {}); // A startup failure may precede the parent's await.
  function closed() {
    fail('control-closed');
  }
  function fail(code) {
    rejected ??= new Error(code); rejectStartup(rejected);
    for (const entry of pending.values()) entry.reject(rejected);
  }
  function receive(record) {
    if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.id)) { fail('control-invalid'); return; }
    if (record.id === -1 && !ipc) {
      if (!PHASES.has(record.phase)) { fail('control-invalid'); return; }
      phase = record.phase;
      if (['Restricted','AllSigned','RemoteSigned','Unrestricted','Bypass','Undefined'].includes(record.executionPolicy)) policy = record.executionPolicy;
    } else if (record.id === 0) resolveStartup(record);
    else pending.get(record.id)?.resolve(record);
  }
  if (ipc) owned.child.on('message', receive);
  else owned.child.stdout.on('data', (chunk) => {
    encoding ??= encodingSignature(chunk);
    if (rejected) return;
    bytes += chunk.toString('utf8');
    if (bytes.length > 65536) { bytes = ''; fail('control-output-bound'); return; }
    while (bytes.includes('\n')) {
      const end = bytes.indexOf('\n'), line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { fail('control-invalid'); return; }
    }
  });
  owned.exited.then(closed);
  owned.child.stdin?.on('error', closed); owned.child.stdout?.on('error', closed);
  return { startup, state: () => ({ phase: phase ?? null, encoding: encoding ?? null, executionPolicy: policy ?? null }),
    async request(op, fields = {}, timeout = 5000) {
      if (rejected) throw rejected;
      if (owned.terminal()) throw new Error('control-closed');
      const requestId = id++; let timer;
      const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      try {
        const record = { id: requestId, op, ...fields };
        if (ipc) owned.child.send(record, (error) => { if (error) fail('control-closed'); });
        else owned.child.stdin.write(`${JSON.stringify(record)}\n`);
        const result = await Promise.race([response, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('control-deadline')), timeout); })]);
        // A valid receipt may arrive just before the child exits. Persistent
        // closure rejects unresolved/future requests without erasing that ack.
        if (rejected && rejected.message !== 'control-closed') throw rejected;
        if (result.ok === false) throw classifyFailure(result);
        return result;
      } finally { clearTimeout(timer); pending.delete(requestId); }
    } };
}
