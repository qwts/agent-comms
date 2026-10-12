// One explicitly requested artifact, one owned stdout writer. No credentials,
// preload environment, stderr output, broker authority or additional children.
import { writeDiagnosticExport, DIAGNOSTIC_EXPORT_LIMITS } from './diagnostic-export.mjs';
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));
process.on('disconnect', () => process.exit(1));
let received = false;
process.on('message', async (message) => {
  if (received || typeof message?.output !== 'string'
    || Buffer.byteLength(message.output) > DIAGNOSTIC_EXPORT_LIMITS.outputBytes) process.exit(1);
  received = true;
  try {
    await writeDiagnosticExport(process.stdout, message.output);
    if (!process.connected) process.exit(1);
    process.send({ ok: true }, (error) => process.exit(error ? 1 : 0));
  } catch { process.exit(1); }
});
