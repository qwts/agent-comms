// Explicit offline export helpers share this platform spawn seam. They inherit
// only stdout and their owned IPC, never credentials, preloads or stderr text.
import { spawn } from 'node:child_process';
export function spawnDiagnosticExportHelper(writer, { platform = process.platform, env = process.env, run = spawn } = {}) {
  return run(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(writer)}).catch(() => process.exit(1));`], {
    env: platform === 'win32' && env.SystemRoot ? { SystemRoot: env.SystemRoot } : {},
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
  });
}
