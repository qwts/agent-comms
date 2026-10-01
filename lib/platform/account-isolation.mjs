import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_CONFIG } from '../host-config.mjs';
import { CommsError, fail } from '../errors.mjs';
const LABEL = HOST_CONFIG.serviceLabel;

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createAccountIsolation(platform = process.platform) {
  if (platform === 'win32') {
    const unavailable = () => fail('platform-not-implemented', 'account-isolation not implemented on win32');
    return Object.freeze(Object.fromEntries(['currentUid', 'assertAncestors', 'assertOwnedDir', 'uidOf', 'systemUidOf', 'assertGroupName', 'systemGroupId', 'groupId', 'assertClientDir', 'loadCredential', 'saveCredential', 'assertBindingFile', 'assertLogFile', 'consumePairingProof'].map((name) => [name, unavailable])));
  }
  const currentUid = () => process.getuid();

  const STICKY = 0o1000;

  function stat(file, code) {
    try {
      return lstatSync(file);
    } catch {
      return fail(code, `${file} does not exist`);
    }
  }

  function assertAncestors(dir, ownerUid, code = 'broker-untrusted') {
    let current = realpathSync(path.dirname(dir));
    for (;;) {
      const info = lstatSync(current);
      if (!info.isDirectory()) fail(code, `${current} is not a directory`);
      if (info.uid !== 0 && info.uid !== ownerUid) {
        fail(code, `${current} is owned by uid ${info.uid}, neither root nor the broker account`);
      }
      if ((info.mode & 0o022) !== 0 && (info.mode & STICKY) === 0) {
        fail(code, `${current} is writable by others and not sticky`);
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  function assertOwnedDir(dir, ownerUid, { code = 'broker-untrusted', mode = null } = {}) {
    const info = stat(dir, code);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(code, `${dir} is not a real directory`);
    if (info.uid !== ownerUid) fail(code, `${dir} is owned by uid ${info.uid}, not the broker account ${ownerUid}`);
    if (mode !== null && (info.mode & 0o7777) !== mode) {
      fail(code, `${dir} has mode ${(info.mode & 0o7777).toString(8)}, expected ${mode.toString(8)}`);
    }
    return info;
  }

  function uidOf(account) {
    try {
      return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
      return fail('usage', `no account named ${account} on this machine`);
    }
  }

  function systemUidOf(account) {
    try {
      return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8' }).trim());
    } catch {
      return null;
    }
  }

  // A label is a single job, so a group sharing one would make launchctl address
  // the wrong job on every later call. The rest of the shape is what dseditgroup
  // accepts, hyphens included: the value lands in one plist string, never in a
  // shell, so the check is about a group, not about escaping.
  const GROUP_NAME = /^[a-z_][a-z0-9_.-]{0,30}$/;

  function assertGroupName(name, label = LABEL) {
    if (!GROUP_NAME.test(String(name)) || name === label) {
      fail('usage', `--group takes a group name like agent-comms, not ${name}`);
    }
    return name;
  }

  // A group is a macOS Directory Service object, so it is looked up there and
  // never created here: the owner makes groups, the broker only names one.
  function systemGroupId(name) {
    assertGroupName(name);
    if (platform !== 'darwin') {
      fail('broker-group-missing', `group ${name} is a macOS construct, and this broker release runs on macOS only`);
    }
    try {
      // macOS keeps groups in Directory Service, not in /etc/group.
      const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const id = out.match(/PrimaryGroupID:\s*(\d+)/)?.[1];
      if (id) return Number(id);
    } catch {
      // no such group
    }
    fail('broker-group-missing', `no group named ${name}; create it and add each agent account, then install again`);
  }

  function groupId(name) {
    if (/^\d+$/.test(name)) return Number(name);
    try {
      // macOS keeps groups in Directory Services, not /etc/group.
      const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], { encoding: 'utf8' });
      const id = out.match(/PrimaryGroupID:\s*(\d+)/)?.[1];
      if (id) return Number(id);
    } catch {
      // not macOS, or no such group
    }
    try {
      const line = readFileSync('/etc/group', 'utf8').split('\n').find((entry) => entry.startsWith(`${name}:`));
      if (line) return Number(line.split(':')[2]);
    } catch {
      // no /etc/group
    }
    return fail('usage', `cannot resolve group ${name}; pass its numeric id`);
  }

  // The credential pins the broker account, so whoever can replace it can
  // point this client at their own socket. Its directory must be ours alone.
  function assertClientDir(dir) {
    const uid = process.getuid();
    assertAncestors(dir, uid, 'client-dir-untrusted');
    const info = assertOwnedDir(dir, uid, { code: 'client-dir-untrusted' });
    if ((info.mode & 0o022) !== 0) fail('client-dir-untrusted', `${dir} is writable by accounts other than this one`);
  }

  function loadCredential(clientPaths) {
    try {
      lstatSync(clientPaths.credential);
    } catch {
      return fail('unpaired', 'this account is not paired; run `agent-comms account pair`');
    }
    assertClientDir(clientPaths.dir);
    const info = lstatSync(clientPaths.credential);
    if (!info.isFile() || info.uid !== process.getuid()) fail('client-dir-untrusted', `${clientPaths.credential} is not this account's file`);
    try {
      return JSON.parse(readFileSync(clientPaths.credential, 'utf8'));
    } catch {
      return fail('unpaired', 'the saved credential is unreadable; pair again');
    }
  }

  function saveCredential(clientPaths, credential) {
    mkdirSync(clientPaths.dir, { recursive: true, mode: 0o700 });
    assertClientDir(clientPaths.dir);
    chmodSync(clientPaths.dir, 0o700);
    const temp = `${clientPaths.credential}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, clientPaths.credential);
  }

  function assertBindingFile(info, file) {
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600) fail('binding-untrusted', `${file} must be a regular file owned by this account with mode 0600`);
  }

  function assertLogFile(file, uid) {
    try {
      const log = lstatSync(file);
      if (!log.isFile() || log.uid !== uid) fail('state-dir-untrusted', `${file} is not the broker's own file`);
    } catch (error) {
      if (error instanceof CommsError) throw error;
    }
  }

  function consumePairingProof(file, account, broker, secretHash) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      fail('pairing-proof-invalid', 'the pairing proof file is missing');
    }
    const uid = broker.uidOf(account);
    const valid = stat.isFile() && uid !== null && stat.uid === uid
      && broker.now() - stat.mtimeMs <= broker.limits.proofMaxAgeMs
      && readFileSync(file, 'utf8').trim() === secretHash;
    rmSync(file, { force: true });
    if (!valid) fail('pairing-proof-invalid', 'the pairing proof does not belong to that account');

    return uid;
  }

  return Object.freeze({ currentUid, assertAncestors, assertOwnedDir, uidOf, systemUidOf, assertGroupName, systemGroupId, groupId, assertClientDir, loadCredential, saveCredential, assertBindingFile, assertLogFile, consumePairingProof });
}

export const { currentUid, assertAncestors, assertOwnedDir, uidOf, systemUidOf, assertGroupName, systemGroupId, groupId, assertClientDir, loadCredential, saveCredential, assertBindingFile, assertLogFile, consumePairingProof } = createAccountIsolation();
