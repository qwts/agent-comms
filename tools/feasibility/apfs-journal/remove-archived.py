#!/usr/bin/env python3
"""Separate reviewed removal of only the two losslessly archived synthetic images."""
import json
import os
from pathlib import Path
import signal
import sys
import archive as a


def main():
    a.require(sys.platform == 'darwin' and sys.argv[1:] == ['--remove-reviewed-originals'],
              'explicit-reviewed-removal-only')
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError('overall-timeout')))
    signal.alarm(300)
    a.detached()
    before = a.footprint()
    candidates = []
    for root, length in a.IMAGES:
        receipt_path = root / 'archive-verification.json'
        a.require(a.regular(receipt_path, True).st_size <= 16384, 'verification-receipt-size')
        receipt = json.loads(receipt_path.read_text())
        image, compressed = root / 'journal.dmg', root / 'journal.dmg.gz'
        a.require(receipt['v'] == 1 and receipt['status'] == 'verified'
                  and receipt['originalRemoved'] is False and receipt['image'] == str(image)
                  and receipt['archive'] == str(compressed) and receipt['originalBytes'] == length,
                  'reviewed-receipt-binding')
        a.require(not (root / 'archive-removal.json').exists(), 'no-removal-retry')
        info = a.regular(image)
        a.require(a.identity(info) == receipt['originalIdentity'], 'original-identity-changed')
        a.require(a.read_hash(image) == receipt['originalSha256'], 'original-hash-changed')
        a.regular(compressed, True)
        a.require(a.read_hash(compressed) == receipt['compressedSha256'], 'archive-hash-changed')
        candidates.append((root, receipt, info))
    # Validate both before removing either. Check attachment and exact path identity again.
    a.detached()
    for root, receipt, info in candidates:
        image = root / 'journal.dmg'
        a.require(a.identity(a.regular(image)) == a.identity(info), 'final-original-identity-changed')
        os.unlink(image)
        removed = {'v': 1, 'status': 'removed', 'image': str(image),
                   'archive': receipt['archive'], 'originalSha256': receipt['originalSha256'],
                   'compressedSha256': receipt['compressedSha256'],
                   'originalIdentity': receipt['originalIdentity'],
                   'reportedOriginalAllocatedBytes': info.st_blocks * 512,
                   'priorVerificationReceiptPreserved': True,
                   'attachmentConfirmedAbsent': True, 'physicalCapacitySupported': False}
        fd = os.open(root / 'archive-removal.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(removed, stream, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps(removed, sort_keys=True), flush=True)
    a.detached()
    after = a.footprint()
    print(json.dumps({'status': 'removed', 'aggregateBeforeBytes': before,
                      'aggregateAfterBytes': after, 'reportedNetFreedBytes': before - after,
                      'archivesAndAllLogsRetained': True}), flush=True)


if __name__ == '__main__':
    main()
