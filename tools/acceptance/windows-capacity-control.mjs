// Dev-only finite control transport. Failure records never contain child output.
const PHASES = new Set(['bootstrap-ready','script-entry','compile-supervisor','supervisor-compiled','module-observation','import-utility','utility-imported','serialize-ready','ready-serialized','control-read','parse-control','control-parsed','cim-module-observation','verify-fixture-existence','verify-fixture-parent','verify-fixture-executable','parse-fixture-command','verify-fixture-argument-count','verify-fixture-arguments','convert-fixture-creation','verify-job-limit','cim-module-refused','import-cim','cim-imported','query-fixture','fixture-queried','create-private-job','private-job-assigned','read-control','verify-fixture','assign-private-job','sample-job','query-members','close-job']);
export const FIXTURE_PHASES = new Set(['fixture-imports','fixture-broker-start','fixture-pair','fixture-approve','fixture-join-first','fixture-join-second','fixture-delivery-send','fixture-delivery-read','fixture-delivery-ack','fixture-delivery-empty','fixture-ready']);
// Diagnostic-only comparison: never used by the production connector.
export function utilityProbeCommand(explicit = false) {
  const observe = `$manifest=[IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1');$present=[IO.File]::Exists($manifest);$expected=[string]::Equals([IO.Path]::GetFullPath($PSHOME),[IO.Path]::GetFullPath([IO.Path]::Combine([Environment]::GetEnvironmentVariable('SystemRoot'),'System32\\WindowsPowerShell\\v1.0')),[StringComparison]::OrdinalIgnoreCase);[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"module-observation","manifestPresent":'+$present.ToString().ToLowerInvariant()+',"expectedPSHome":'+$expected.ToString().ToLowerInvariant()+'}');[Console]::Out.Flush();`;
  const load = explicit ? `if (-not $present -or -not $expected) {[Console]::Out.WriteLine('{"id":0,"ok":false,"failure":{"phase":"module-observation"}}');[Console]::Out.Flush();exit 1};[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"import-utility"}');[Console]::Out.Flush();Import-Module -Name $manifest -ErrorAction Stop;[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"utility-imported"}');[Console]::Out.Flush();` : '';
  return observe + load + `[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"serialize-ready"}');[Console]::Out.Flush();$json=(@{id=0;ok=$true;phase='ready'} | ConvertTo-Json -Depth 8 -Compress);[Console]::Out.WriteLine($json);[Console]::Out.Flush();[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"ready-serialized"}');[Console]::Out.Flush()`;
}
export function encodingSignature(chunk) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return 'utf16le-bom';
  if (chunk[0] === 0xfe && chunk[1] === 0xff) return 'utf16be-bom';
  if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) return 'utf8-bom';
  if (chunk[0] === 0x7b && chunk[1] === 0) return 'utf16le-json';
  if (chunk.subarray(0, 9).toString('ascii') === '#< CLIXML') return 'clixml';
  return chunk.subarray(0, 16).every((byte) => byte < 128) ? 'ascii-compatible' : 'other';
}
// A subsequent diagnostic must not overlap a child whose lifetime is unknown.
export async function collectSupervisorProbes(probe, record, variants = ['supervisor-script']) {
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 2
      || new Set(variants).size !== variants.length
      || variants.some(variant => !['json-command','explicit-utility-command','supervisor-script','supervisor-attach'].includes(variant))) throw new Error('control-invalid');
  let mayContinue = true;
  for (const variant of variants) {
    if (!mayContinue) {
      await record({ runType: 'supervisor-only-no-workload', variant, productionImported: false,
        status: 'not-run', reason: 'prior-cleanup-unconfirmed' });
      continue;
    }
    const result = await probe(variant);
    await record(result);
    mayContinue = result.ownedTerminalConfirmed === true && result.stdioClosedConfirmed === true;
  }
}
export function createCapacityController(owned, { ipc = false, classifyFailure = () => new Error('job-supervisor-failed') } = {}) {
  const pending = new Map(); let id = 1, bytes = '', rejected, phase, encoding, moduleObservation, cimModuleObservation;
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
    if (record.id === -1 && ipc) {
      if (!FIXTURE_PHASES.has(record.phase) || Object.keys(record).some(key => !['id','phase'].includes(key))) { fail('control-invalid'); return; }
      phase = record.phase;
    } else if (record.id === -1 && !ipc) {
      if (!PHASES.has(record.phase)) { fail('control-invalid'); return; }
      if (record.phase === 'module-observation') {
        if (typeof record.manifestPresent !== 'boolean' || typeof record.expectedPSHome !== 'boolean'
            || Object.keys(record).some(key => !['id','ok','phase','manifestPresent','expectedPSHome'].includes(key))) {
          fail('control-invalid'); return;
        }
        moduleObservation = { manifestPresent: record.manifestPresent, expectedPSHome: record.expectedPSHome };
      }
      if (record.phase === 'cim-module-observation') {
        if (typeof record.manifestPresent !== 'boolean'
            || Object.keys(record).some(key => !['id','ok','phase','manifestPresent'].includes(key))) {
          fail('control-invalid'); return;
        }
        cimModuleObservation = { manifestPresent: record.manifestPresent };
      }
      phase = record.phase;
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
  return { startup, state: () => ({ phase: phase ?? null, encoding: encoding ?? null,
    ...(moduleObservation === undefined ? {} : { moduleObservation: { ...moduleObservation } }),
    ...(cimModuleObservation === undefined ? {} : { cimModuleObservation: { ...cimModuleObservation } }) }),
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
