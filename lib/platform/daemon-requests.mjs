// A bound daemon call can inspect native ACLs or load its signing key. Keep
// that storage budget separate from quick health probes and broker requests.
export function boundDaemonTimeout(platform = process.platform) {
  return platform === 'win32' ? 60_000 : 3000;
}
