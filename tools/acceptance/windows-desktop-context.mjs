// Dev-only desktop attestation. This context never grants production authority.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const owned = new WeakSet();
const refuse = () => { throw new Error('desktop-context-refused'); };
const pins = JSON.parse(readFileSync(new URL('../../tests/fixtures/windows-host-components.json', import.meta.url)));
export function decodeDesktopFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096 || !bytes.length) refuse();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) refuse();
  let value; try { value = JSON.parse(text); } catch { refuse(); }
  if (!value || Object.keys(value).sort().join(',') !== 'nodeArchiveSha256,nodeExecutableSha256,parentPid,root,task,v'
      || value.v !== 1 || !['candidate-compiler','candidate-startup'].includes(value.task)
      || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0
      || typeof value.root !== 'string' || value.root.length > 240 || !path.win32.isAbsolute(value.root)
      || value.nodeArchiveSha256 !== pins.node.sha256['win-x64']
      || typeof value.nodeExecutableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.nodeExecutableSha256)) refuse();
  return value;
}
export async function readOwnedDesktopContext(input) {
  if (process.platform !== 'win32') refuse();
  const chunks = []; let length = 0;
  for await (const chunk of input) { length += chunk.length; if (length > 4096) refuse(); chunks.push(chunk); }
  const frame = decodeDesktopFrame(Buffer.concat(chunks));
  if (frame.parentPid !== process.ppid || process.version !== `v${pins.node.version}`
      || createHash('sha256').update(readFileSync(process.execPath)).digest('hex') !== frame.nodeExecutableSha256) refuse();
  // Re-read the actual token, profile, parent and named root ACL/reparse state.
  // The original wrapper retains no-delete handles on all root ancestors.
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('./windows-desktop-root.ps1', import.meta.url));
  const { stdout, stderr } = await promisify(execFile)(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',helper,
    '-VerifyRoot',frame.root,'-NodePid',String(process.pid),'-WrapperPid',String(process.ppid)],
  { windowsHide: true, timeout: 15000, maxBuffer: 4096, encoding: 'utf8' });
  if (stderr.length) refuse();
  let receipt; try { receipt = JSON.parse(stdout); } catch { refuse(); }
  const expected = ['administrator','defaultOwnerMatches','parentMatches','profileLoaded','profileMatches','rootVerified','v'];
  if (!receipt || Object.keys(receipt).sort().join(',') !== expected.sort().join(',') || receipt.v !== 1
      || receipt.administrator !== false || expected.filter(key => !['administrator','v'].includes(key)).some(key => receipt[key] !== true)) refuse();
  const root = realpathSync(frame.root);
  if (root.toLowerCase() !== path.resolve(frame.root).toLowerCase()) refuse();
  const context = Object.freeze({ root, temp: path.join(root,'temp'), task: frame.task,
    nodeArchiveSha256: frame.nodeArchiveSha256, profile: Object.freeze(receipt) });
  owned.add(context); return context;
}
export const isOwnedDesktopContext = context => owned.has(context);
