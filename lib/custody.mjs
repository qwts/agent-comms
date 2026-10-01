// Path custody for the shared rendezvous directory (ADR-0006 decision 1).
// The broker and its clients both refuse a directory that another account
// could have created, replaced, or redirected: the directory itself must be a
// real directory owned by the broker account and writable by nobody else, and
// every ancestor must be owned by root or the broker account and, if others
// can write it, sticky so nobody can rename the path out from under it.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { fail } from './errors.mjs';

const STICKY = 0o1000;

function stat(file, code) {
  try {
    return lstatSync(file);
  } catch {
    return fail(code, `${file} does not exist`);
  }
}

export function assertAncestors(dir, ownerUid, code = 'broker-untrusted') {
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

export function assertOwnedDir(dir, ownerUid, { code = 'broker-untrusted', mode = null } = {}) {
  const info = stat(dir, code);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(code, `${dir} is not a real directory`);
  if (info.uid !== ownerUid) fail(code, `${dir} is owned by uid ${info.uid}, not the broker account ${ownerUid}`);
  if (mode !== null && (info.mode & 0o7777) !== mode) {
    fail(code, `${dir} has mode ${(info.mode & 0o7777).toString(8)}, expected ${mode.toString(8)}`);
  }
  return info;
}

export function assertBrokerSocket(file, ownerUid, code = 'broker-untrusted') {
  const info = stat(file, 'broker-unreachable');
  if (!info.isSocket() || info.uid !== ownerUid) fail(code, `${file} is not the broker account's socket`);
}
