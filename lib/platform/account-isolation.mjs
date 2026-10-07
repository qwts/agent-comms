import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_CONFIG } from '../host-config.mjs';
import { CommsError, fail } from '../errors.mjs';
const LABEL = HOST_CONFIG.serviceLabel;

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createAccountIsolation(platform = process.platform, { run = spawnSync } = {}) {
  if (platform === 'win32') return createSidIsolation({ run });
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


// Windows (docs/windows.md, the host's ADR-0046 decision 1): one account only.
// The identity is the account's SID in place of a uid, from `whoami /user`;
// custody is ownership, read through `Get-Acl` in PowerShell, because the
// profile directory's own access list is what modes are on macOS. Every
// external call goes through `run` (spawnSync's shape) so a test can stand in
// for whoami.exe and powershell.exe; the script goes on stdin and its output
// is parsed against a fixed grammar, never trusted as it comes.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];
const SID = /^S-1-\d+(?:-\d+)+$/;
const SID_IN = 'S-1-\\d+(?:-\\d+)+';
const ENTRY = new RegExp(`^(${SID_IN})\\|(directory|file)\\|(real|link)$`);
const WHOAMI_CSV = new RegExp(`^"(?:[^"]|"")*","(${SID_IN})"\\s*$`, 'm');

// A PowerShell single-quoted literal: only the quote itself needs doubling,
// and a line break would end the statement, so it is refused.
function quoteForPowershell(value, what, code) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) fail(code, `${what} cannot carry a line break`);
  return `'${text.replace(/'/g, "''")}'`;
}

function createSidIsolation({ run }) {
  const powershell = (script) => run('powershell.exe', POWERSHELL_ARGS, {
    input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutOf = (result) => (result?.status === 0 ? String(result.stdout ?? '') : null);

  // The SID of the account running this process, asked once: whoami's answer
  // cannot change for the life of a process, and it is a subprocess.
  let current = null;
  function currentUid() {
    if (current) return current;
    const result = run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const sid = WHOAMI_CSV.exec(stdoutOf(result) ?? '')?.[1];
    if (!sid) fail('account-unresolved', 'cannot determine this account\'s SID from whoami /user');
    current = sid;
    return sid;
  }

  // One Get-Acl pass over several paths, one answer line per path in order:
  // `<owner SID>|directory or file|real or link`, or `missing` for a path that
  // is absent or cannot be inspected. One statement per line, a blank line at
  // the end: `-Command -` reads stdin as typed input (see secret-store.mjs).
  function inspect(paths, code) {
    const list = paths.map((file) => quoteForPowershell(file, 'a path', code)).join(', ');
    const script = [
      '$ErrorActionPreference = \'Stop\'',
      `foreach ($p in @(${list})) { try { $i = Get-Item -LiteralPath $p -Force; $o = (Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $k = if ($i.PSIsContainer) { 'directory' } else { 'file' }; $r = if ([int]($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { 'link' } else { 'real' }; [Console]::Out.WriteLine(($o, $k, $r) -join '|') } catch { [Console]::Out.WriteLine('missing') } }`,
      '',
      '',
    ].join('\n');
    const out = stdoutOf(powershell(script));
    const lines = (out ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (out === null || lines.length !== paths.length) fail(code, `Get-Acl did not answer for ${paths.join(', ')}`);
    return lines.map((line, index) => {
      if (line === 'missing') return null;
      const match = ENTRY.exec(line);
      if (!match) fail(code, `Get-Acl answered something unexpected for ${paths[index]}`);
      return { owner: match[1], kind: match[2], link: match[3] === 'link' };
    });
  }

  // The profile root is the custody boundary (ADR-0046 decision 1), so there
  // is no ancestor walk: the directory's own owner is the whole check, and
  // this exists so a caller written against the macOS seam needs no change.
  function assertAncestors() {}

  function assertOwnedDir(dir, ownerSid, { code = 'broker-untrusted' } = {}) {
    const [entry] = inspect([dir], code);
    if (!entry) fail(code, `${dir} does not exist or cannot be inspected`);
    if (entry.kind !== 'directory' || entry.link) fail(code, `${dir} is not a real directory`);
    if (entry.owner !== ownerSid) fail(code, `${dir} is owned by ${entry.owner}, not the broker account ${ownerSid}`);
    return entry;
  }

  function assertOwnedFile(entry, file, ownerSid, code, what) {
    if (!entry || entry.kind !== 'file' || entry.link) fail(code, `${file} is not a regular file`);
    if (entry.owner !== ownerSid) fail(code, `${file} is not ${what}`);
  }

  // An account name resolves to its SID through .NET's NTAccount, so a domain
  // form (`DESK\owner`) works too. The name is a quoted literal in the script.
  function sidOf(account) {
    const script = [
      '$ErrorActionPreference = \'Stop\'',
      `[Console]::Out.Write((New-Object System.Security.Principal.NTAccount(${quoteForPowershell(account, 'an account name', 'usage')})).Translate([System.Security.Principal.SecurityIdentifier]).Value)`,
      '',
      '',
    ].join('\n');
    const sid = (stdoutOf(powershell(script)) ?? '').trim();
    return SID.test(sid) ? sid : null;
  }

  const uidOf = (account) => sidOf(account) ?? fail('usage', `no account named ${account} on this machine`);
  const systemUidOf = (account) => sidOf(account);

  // Groups are the persona-accounts add-on, which has no Windows design.
  const noGroups = () => fail('platform-not-implemented', 'persona-accounts groups are not implemented on win32; one-account mode is the only mode on Windows');
  const assertGroupName = noGroups;
  const systemGroupId = noGroups;
  const groupId = noGroups;

  function assertClientDir(dir) {
    assertOwnedDir(dir, currentUid(), { code: 'client-dir-untrusted' });
  }

  function loadCredential(clientPaths) {
    try {
      lstatSync(clientPaths.credential);
    } catch {
      return fail('unpaired', 'this account is not paired; run `agent-comms account pair`');
    }
    const sid = currentUid();
    const [dir, file] = inspect([clientPaths.dir, clientPaths.credential], 'client-dir-untrusted');
    if (!dir || dir.kind !== 'directory' || dir.link) fail('client-dir-untrusted', `${clientPaths.dir} is not a real directory`);
    if (dir.owner !== sid) fail('client-dir-untrusted', `${clientPaths.dir} is owned by ${dir.owner}, not this account`);
    assertOwnedFile(file, clientPaths.credential, sid, 'client-dir-untrusted', 'this account\'s file');
    try {
      return JSON.parse(readFileSync(clientPaths.credential, 'utf8'));
    } catch {
      return fail('unpaired', 'the saved credential is unreadable; pair again');
    }
  }

  // The profile's access list is the custody, so no mode is set; the shape
  // on disk is the macOS one so a credential reads the same on both.
  function saveCredential(clientPaths, credential) {
    mkdirSync(clientPaths.dir, { recursive: true });
    assertClientDir(clientPaths.dir);
    const temp = `${clientPaths.credential}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(credential, null, 2)}\n`);
    renameSync(temp, clientPaths.credential);
  }

  function assertBindingFile(info, file) {
    if (!info.isFile()) fail('binding-untrusted', `${file} must be a regular file owned by this account`);
    const [entry] = inspect([file], 'binding-untrusted');
    assertOwnedFile(entry, file, currentUid(), 'binding-untrusted', 'owned by this account');
  }

  function assertLogFile(file, sid) {
    try {
      lstatSync(file);
    } catch {
      return; // not written yet
    }
    const [entry] = inspect([file], 'state-dir-untrusted');
    assertOwnedFile(entry, file, sid, 'state-dir-untrusted', 'the broker\'s own file');
  }

  // The proof directory is the broker's own on Windows (one account), and the
  // file's owner is still read from the access list rather than assumed, so
  // the check keeps the macOS shape: a file of that account, fresh, holding
  // the hash.
  function consumePairingProof(file, account, broker, secretHash) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      fail('pairing-proof-invalid', 'the pairing proof file is missing');
    }
    const sid = broker.uidOf(account);
    let owner = null;
    try {
      const [entry] = inspect([file], 'pairing-proof-invalid');
      if (entry?.kind === 'file' && !entry.link) owner = entry.owner;
    } catch {
      // an uninspectable proof is an invalid one
    }
    const valid = stat.isFile() && sid !== null && owner === sid
      && broker.now() - stat.mtimeMs <= broker.limits.proofMaxAgeMs
      && readFileSync(file, 'utf8').trim() === secretHash;
    rmSync(file, { force: true });
    if (!valid) fail('pairing-proof-invalid', 'the pairing proof does not belong to that account');
    return sid;
  }

  return Object.freeze({
    currentUid,
    currentSid: currentUid,
    assertAncestors,
    assertOwnedDir,
    uidOf,
    sidOf: uidOf,
    systemUidOf,
    systemSidOf: systemUidOf,
    assertGroupName,
    systemGroupId,
    groupId,
    assertClientDir,
    loadCredential,
    saveCredential,
    assertBindingFile,
    assertLogFile,
    consumePairingProof,
    inspect,
  });
}

export const { currentUid, assertAncestors, assertOwnedDir, uidOf, systemUidOf, assertGroupName, systemGroupId, groupId, assertClientDir, loadCredential, saveCredential, assertBindingFile, assertLogFile, consumePairingProof } = createAccountIsolation();
