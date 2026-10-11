import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Cleanup failures are evidence, and must never replace the case failure or
// prevent writing its report. Do not copy arbitrary errors containing paths
// or command output into this credential-free artifact.
export async function cleanupWindowsAcceptance({ result, root, local, taskLabels, command,
  stopSupervisor = () => {}, remove = rmSync }) {
  const errors = [];
  const failed = (operation, error) => errors.push({ operation,
    code: typeof error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : 'cleanup-failed' });
  try { stopSupervisor(); } catch (error) { failed('stop-supervisor', error); }
  for (const task of taskLabels) {
    try {
      await command('schtasks.exe', ['/End', '/TN', task]);
      await command('schtasks.exe', ['/Delete', '/TN', task, '/F']);
      const remaining = await command('schtasks.exe', ['/Query', '/TN', task]);
      if (remaining.exit === 0 || remaining.exit === -1) failed('verify-task-absence');
    } catch (error) { failed('remove-task', error); }
    try { remove(path.join(local, task), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { failed('remove-task-directory', error); }
  }
  try { remove(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (error) { failed('remove-runtime-directory', error); result.retainedRuntimeDirectory = root; }
  result.cleanup = errors.length ? 'failed-cleanup' : 'namespaced-tasks-absent';
  if (errors.length) result.cleanupErrors = errors;
  return errors.length === 0;
}

export function writeWindowsAcceptanceReport(report, result) {
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
}
