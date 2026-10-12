// Dedicated local helper. Never prints runtime errors, inherits credentials,
// writes stdout, opens a listener, or owns any broker state.
import { write } from 'node:fs';
import { writeDiagnosticLine } from './diagnostic-fd.mjs';

process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
let busy = false;

process.on('message', (message) => {
  if (busy) { process.exit(0); return; }
  busy = true;
  writeDiagnosticLine(message?.line, write, (ok) => {
    busy = false;
    if (!process.connected) { process.exit(0); return; }
    process.send({ ok }, (error) => { if (error || !ok) process.exit(0); });
  });
});
