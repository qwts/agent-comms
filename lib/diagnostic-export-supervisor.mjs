// Never writes stdout. Its event loop remains available if the owned writer's
// OS output syscall blocks. No additional authority or persistent service.
import { spawnDiagnosticExportHelper } from './platform/diagnostic-export-process.mjs';
import { DIAGNOSTIC_EXPORT_LIMITS } from './diagnostic-export.mjs';
let child;
let received = false;
let acknowledged = false;
let stopping = false;
let timedOut = false;
let timer;
function terminate(timeout = false) {
  stopping = true; timedOut ||= timeout;
  if (!child) process.exit(1);
  try { child.kill('SIGKILL'); } catch { /* Cannot invent a close receipt. */ }
}
function reply(ok) {
  clearTimeout(timer);
  if (!process.connected) process.exit(ok ? 0 : 1);
  try { process.send({ ok, ...(timedOut ? { timeout: true } : {}) }, () => process.exit(ok ? 0 : 1)); }
  catch { process.exit(1); }
}
process.on('disconnect', () => terminate());
process.on('uncaughtException', () => terminate());
process.on('unhandledRejection', () => terminate());
process.on('message', (message) => {
  if (message?.cancel === true) { terminate(); return; }
  if (received || typeof message?.output !== 'string'
    || Buffer.byteLength(message.output) > DIAGNOSTIC_EXPORT_LIMITS.outputBytes) { terminate(); return; }
  received = true;
  timer = setTimeout(() => terminate(true), DIAGNOSTIC_EXPORT_LIMITS.outputDeadlineMs);
  try {
    const writer = new URL('./diagnostic-export-writer.mjs', import.meta.url).href;
    child = spawnDiagnosticExportHelper(writer);
    child.on('error', () => terminate());
    child.on('message', (receipt) => { if (receipt?.ok === true && !acknowledged) acknowledged = true; else terminate(); });
    child.on('close', (code, signal) => reply(!stopping && acknowledged && code === 0 && signal === null));
    process.send({ stage: 'writer-started', pid: child.pid }, (error) => { if (error) terminate(); });
    child.send({ output: message.output }, (error) => { if (error) terminate(); });
  } catch { terminate(); }
});
