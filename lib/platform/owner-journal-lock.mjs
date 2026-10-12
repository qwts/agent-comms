// Disabled journal storage primitive, not an owner-authority gate. Darwin only.
// Apple open(2) O_EXLOCK has flock semantics; libuv passes numeric open flags
// through and adds O_CLOEXEC. Keep this fixed inode: never unlink/recreate it.
import * as fs from 'node:fs';
import path from 'node:path';
import { assertAncestors, assertOwnedDir } from '../custody.mjs';
const O_EXLOCK = 0x20; // Apple xnu-8792.61.2 bsd/sys/fcntl.h (macOS 13 era).
export function acquireOwnerJournalLock(root, { io = fs } = {}) {
  if (process.platform !== 'darwin') throw new Error('owner-journal-platform-unsupported');
  let fd;
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error();
    const uid = process.getuid();
    assertAncestors(root, uid); assertOwnedDir(root, uid, { mode: 0o700 });
    const file = path.join(root, '.journal-lock');
    let creation = 0;
    try { io.lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Create only in a truly empty store. A missing established lock inode
      // must never be silently replaced while another descriptor could hold it.
      const directory = io.opendirSync(root);
      try { if (directory.readSync() !== null) throw new Error(); } finally { directory.closeSync(); }
      creation = fs.constants.O_CREAT | fs.constants.O_EXCL;
    }
    // Existing opens must not recreate a name removed after the lstat above.
    // First creation is exclusive; a racing creator can only make us refuse.
    fd = io.openSync(file, fs.constants.O_RDWR | creation | fs.constants.O_NOFOLLOW
      | fs.constants.O_NONBLOCK | O_EXLOCK, 0o600);
    const info = io.fstatSync(fd); const named = io.lstatSync(file);
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600
        || info.size !== 0 || info.nlink !== 1 || info.dev !== named.dev || info.ino !== named.ino) throw new Error();
    return fd;
  } catch (error) {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* Preserve a sanitized refusal. */ } }
    throw new Error(['EAGAIN', 'EWOULDBLOCK', 'EEXIST'].includes(error?.code) ? 'owner-journal-busy' : 'owner-journal-storage-failed');
  }
}
