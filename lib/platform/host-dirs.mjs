// Per-platform default directories for the host configuration (#293). macOS
// keeps ENG-0339's machine-shared space; Windows keeps its existing installs'
// paths. Linux has no /Users, so its shared space and logs live in the
// account's XDG state, beside, not inside, the client's credential.
import path from 'node:path';

export function hostDirs(platform = process.platform, home, stateHome) {
  if (platform === 'linux') {
    return { logDir: path.join(stateHome, 'agent-comms-logs'), sharedDir: path.join(stateHome, 'agent-comms-shared') };
  }
  return { logDir: path.join(home, 'Library', 'Logs', 'agent-comms'), sharedDir: '/Users/Shared/Public/agent-comms' };
}
