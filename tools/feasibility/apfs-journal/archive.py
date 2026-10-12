#!/usr/bin/env python3
"""Explicit, bounded archive-only operation for reviewed synthetic APFS images."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import stat
import subprocess
import sys
import time
import zlib

MIB = 1024 * 1024
CHUNK = 256 * 1024
ROOTS = [
    Path('/private/tmp/owner-journal-apfs-preflight.3d6crz'),
    Path('/private/var/folders/w9/qmhxw8jx00d7tg6fxlyfbxgr0000gp/T/owner-journal-apfs-f2edefb7-0144-44fa-81b9-c128188a9df8'),
    Path('/private/tmp/owner-journal-apfs-90f39813-6e22-4ed2-abee-90edfbdec6fa'),
    Path('/private/tmp/owner-journal-apfs-e72d2dda-5fea-47bd-ae43-d39951ae36b2'),
    Path('/private/tmp/owner-journal-apfs-d2d00fbf-0fa1-4785-bfbf-668d313cbd36'),
]
IMAGES = [(ROOTS[2], 128 * MIB), (ROOTS[4], 64 * MIB)]
START = time.monotonic()


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def identity(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_blocks,
            info.st_mtime_ns, info.st_ctime_ns]


def regular(file, private=False):
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1, 'owned-regular-file-required')
    if private:
        require(stat.S_IMODE(info.st_mode) == 0o600, 'private-file-required')
    return info


def footprint():
    total = archives = 0
    for root in ROOTS:
        require(root.resolve() == root, 'canonical-root-required')
        info = root.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o700, 'private-root-required')
        names = list(root.iterdir())
        require(len(names) <= 16, 'root-entry-bound')
        for file in names:
            if file.name == 'mnt':
                require(file.is_dir() and not file.is_symlink()
                        and not list(file.iterdir()), 'detached-empty-mount-required')
                continue
            if file.name == 'build':
                require(file.is_dir() and not file.is_symlink(), 'build-directory')
                artifacts = list(file.iterdir())
                require(len(artifacts) <= 16, 'build-entry-bound')
                subtotal = sum(regular(p).st_blocks * 512 for p in artifacts)
                require(subtotal <= 8 * MIB, 'build-byte-bound')
                total += subtotal
                continue
            require(file.name in ['journal.dmg', 'allocator', 'results.jsonl',
                                  'journal.dmg.gz', 'archive-verification.json', 'archive-removal.json'],
                    'unexpected-artifact')
            st = regular(file, file.name in ['journal.dmg.gz', 'archive-verification.json', 'archive-removal.json'])
            total += st.st_blocks * 512
            if file.name == 'journal.dmg.gz':
                require(st.st_size <= 32 * MIB and st.st_blocks * 512 <= 32 * MIB,
                        'single-archive-bound')
                archives += st.st_blocks * 512
            if file.name in ['archive-verification.json', 'archive-removal.json']:
                require(st.st_size <= 16384, 'receipt-byte-bound')
    require(archives <= 40 * MIB, 'aggregate-archive-bound')
    require(total <= 244 * MIB, 'archive-live-guard')
    require(time.monotonic() - START < 300, 'overall-timeout')
    return total


def detached():
    raw = subprocess.run(['/usr/bin/hdiutil', 'info', '-plist'],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         timeout=30, check=True).stdout
    require(len(raw) <= 2 * MIB, 'attachment-inventory-bound')
    info = plistlib.loads(raw)
    paths = {entry.get('image-path') for entry in info.get('images', [])}
    require(all(str(root / 'journal.dmg') not in paths for root, _ in IMAGES),
            'owned-image-attached')
    # Do not print or persist unrelated inventory paths.


def read_hash(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        while data := stream.read(CHUNK):
            digest.update(data)
            footprint()
    return digest.hexdigest()


def archive(root, expected):
    image = root / 'journal.dmg'
    target = root / 'journal.dmg.gz'
    receipt = root / 'archive-verification.json'
    require(not target.exists() and not receipt.exists(), 'no-overwrite-or-retry')
    before = regular(image)
    require(before.st_size == expected, 'exact-image-length')
    result = {'v': 1, 'status': 'failed', 'image': str(image), 'archive': str(target),
              'originalIdentity': identity(before), 'originalRemoved': False,
              'originalBytes': expected, 'physicalCapacitySupported': False}
    try:
        compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
        original_hash = hashlib.sha256()
        total = written = 0
        source_fd = os.open(image, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        require(identity(os.fstat(source_fd)) == identity(before), 'source-identity-race')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                            | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(source_fd, 'rb') as source, os.fdopen(target_fd, 'wb') as output:
            def emit(data):
                nonlocal written
                require(written + len(data) <= 32 * MIB, 'archive-output-bound')
                # Reserve room for this bounded write before it reaches the filesystem.
                require(footprint() + len(data) + MIB <= 244 * MIB, 'next-write-live-guard')
                output.write(data)
                output.flush()
                written += len(data)
                footprint()
            while data := source.read(CHUNK):
                total += len(data)
                require(total <= expected, 'source-grew')
                original_hash.update(data)
                emit(compressor.compress(data))
            emit(compressor.flush())
            os.fsync(output.fileno())
        require(total == expected and identity(regular(image)) == identity(before),
                'source-changed')
        result['originalSha256'] = original_hash.hexdigest()
        result['compressedSha256'] = read_hash(target)
        decoder = zlib.decompressobj(31)
        restored_hash = hashlib.sha256()
        restored = 0
        with open(target, 'rb') as compressed:
            while data := compressed.read(CHUNK):
                require(not decoder.eof, 'gzip-trailing-bytes')
                while data:
                    plain = decoder.decompress(data, CHUNK)
                    restored += len(plain)
                    require(restored <= expected, 'decompression-length-bound')
                    restored_hash.update(plain)
                    require(not decoder.unused_data, 'gzip-trailing-member-or-data')
                    data = decoder.unconsumed_tail
                    footprint()
            require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,
                    'gzip-incomplete-or-trailing')
        require(restored == expected and restored_hash.hexdigest() == result['originalSha256'],
                'decompressed-hash-or-length')
        require(read_hash(image) == result['originalSha256']
                and identity(regular(image)) == identity(before), 'original-final-verification')
        detached()
        result.update(status='verified', decompressedBytes=restored,
                      decompressedSha256=restored_hash.hexdigest(),
                      compressedBytes=regular(target, True).st_size,
                      compressedAllocatedBytes=regular(target, True).st_blocks * 512,
                      attachmentConfirmedAbsent=True, aggregateLiveBytes=footprint())
    except Exception as error:
        result['error'] = str(error)[:256]
        raise
    finally:
        data = (json.dumps(result, sort_keys=True, indent=2) + '\n').encode()
        require(len(data) <= 16384, 'receipt-size')
        try:
            fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
        except Exception as receipt_error:
            result['receiptError'] = str(receipt_error)[:256]
            result['status'] = 'failed'
            print(json.dumps(result, sort_keys=True), flush=True)
            if 'error' not in result:
                raise
        print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == '__main__':
    require(sys.platform == 'darwin' and sys.argv[1:] == ['--archive-reviewed-images'],
            'explicit-darwin-archive-only-invocation')
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError('overall-timeout')))
    signal.alarm(300)
    detached()
    footprint()
    for owned_root, length in IMAGES:
        archive(owned_root, length)
    print(json.dumps({'status': 'verified', 'originalsRetained': True,
                      'aggregateLiveBytes': footprint()}), flush=True)
