"""Dev-only proposed strict lossless plaintext reference; standard library only."""
import re

MAX_BYTES = 56284
MAX_NODES = 20759


def units(s):
    for c in s:
        n = ord(c)
        if n > 0xffff:
            n -= 0x10000
            yield 0xd800 + (n >> 10)
            yield 0xdc00 + (n & 1023)
        else:
            yield n


def normalize(s, limit, byte_limit=None):
    if not isinstance(s, str) or len(s) > limit:
        raise ValueError('string-unit-limit')
    u = list(units(s))  # len(s) checked before bounded allocation
    if len(u) > limit:
        raise ValueError('string-unit-limit')
    runs, text, native = [], [], 0
    i = 0
    while i < len(u):
        n = u[i]
        if 0xd800 <= n <= 0xdbff and i + 1 < len(u) and 0xdc00 <= u[i+1] <= 0xdfff:
            text.append(chr(0x10000 + ((n-0xd800)<<10) + u[i+1]-0xdc00))
            native += 4
            i += 2
            continue
        if 0xd800 <= n <= 0xdfff:
            if text:
                runs.append(''.join(text)); text = []
            runs.append(n); native += 3
        else:
            text.append(chr(n)); native += len(chr(n).encode('utf8'))
        i += 1
    if byte_limit is not None and native > byte_limit:
        raise ValueError('string-byte-limit')
    if text:
        runs.append(''.join(text))
    return runs if any(isinstance(x, int) for x in runs) else ''.join(runs)


def head(major, n):
    if n < 24:
        return bytes([(major << 5) | n])
    width = 1 if n < 256 else 2 if n < 65536 else 4
    return bytes([(major << 5) | {1:24, 2:25, 4:26}[width]]) + n.to_bytes(width, 'big')


def pack(x):
    if x is None:
        return b'\xf6'
    if isinstance(x, str):
        b = x.encode('utf8'); return head(3, len(b)) + b
    if type(x) is int:
        return head(0, x)
    return head(4, len(x)) + b''.join(pack(y) for y in x)


def encode(p):
    if not isinstance(p, (list, tuple)) or len(p) != 6:
        raise ValueError('plaintext-shape')
    k, body, refs, corr, reply, depth = p
    if not isinstance(k, str) or re.fullmatch(r'[a-z][a-z0-9-]{0,31}', k) is None:
        raise ValueError('kind')
    if not isinstance(refs, (list, tuple)) or len(refs) > 16:
        raise ValueError('refs')
    if type(depth) is not int or not 0 <= depth <= 8:
        raise ValueError('depth')
    p = [k, normalize(body, 32768, 32768), [normalize(s, 256) for s in refs],
         None if corr is None else normalize(corr, 128),
         None if reply is None else normalize(reply, 128), depth]
    b = pack(p)
    if len(b) > MAX_BYTES:
        raise ValueError('plaintext-byte-limit')
    return b


class Reader:
    def __init__(self, b):
        if type(b) is not bytes or len(b) > MAX_BYTES:
            raise ValueError('plaintext-byte-limit-or-type')
        self.b, self.pos, self.nodes = b, 0, 0

    def header(self):
        self.nodes += 1
        if self.nodes > MAX_NODES or self.pos >= len(self.b):
            raise ValueError('node-limit-or-truncated')
        x = self.b[self.pos]; self.pos += 1
        major, n = x >> 5, x & 31
        if x == 0xf6:
            return 7, 22
        if major not in (0, 3, 4) or n > 26:
            raise ValueError('type-or-header')
        if n >= 24:
            w = {24:1, 25:2, 26:4}[n]
            if self.pos + w > len(self.b):
                raise ValueError('truncated-header')
            v = int.from_bytes(self.b[self.pos:self.pos+w], 'big'); self.pos += w
            if v < {1:24, 2:256, 4:65536}[w]:
                raise ValueError('nonminimal-header')
            n = v
        return major, n

    def text(self, n, limit):
        # UTF-8 bytes cannot exceed three times UTF-16 units.
        if n > 3 * limit or self.pos + n > len(self.b):
            raise ValueError('text-length')
        try:
            s = self.b[self.pos:self.pos+n].decode('utf8', errors='strict')
        except UnicodeDecodeError as e:
            raise ValueError('utf8') from e
        self.pos += n
        if sum(1 for _ in units(s)) > limit:
            raise ValueError('text-units')
        return s

    def string(self, limit, byte_limit=None, nullable=False):
        m, n = self.header()
        if nullable and (m, n) == (7, 22):
            return None
        if m == 3:
            s = self.text(n, limit)
        elif m == 4:
            if not 1 <= n <= (16384 if byte_limit == 32768 else limit):
                raise ValueError('run-count')
            parts, prior, count, native, saw_int = [], None, 0, 0, False
            for _ in range(n):
                t, v = self.header()
                if t == 3:
                    if prior == 'text' or v == 0:
                        raise ValueError('nonmaximal-run')
                    part = self.text(v, limit-count)
                    count += sum(1 for _ in units(part)); native += v
                    prior = 'text'
                elif t == 0 and 0xd800 <= v <= 0xdfff:
                    if type(prior) is int and 0xd800 <= prior <= 0xdbff and 0xdc00 <= v <= 0xdfff:
                        raise ValueError('paired-integers')
                    part = chr(v); count += 1; native += 3; prior = v; saw_int = True
                else:
                    raise ValueError('run-type')
                if count > limit or (byte_limit is not None and native > byte_limit):
                    raise ValueError('string-limit')
                parts.append(part)
            if not saw_int:
                raise ValueError('text-only-runs')
            s = ''.join(parts)
        else:
            raise ValueError('string-type')
        normalize(s, limit, byte_limit)
        return s


def decode(b):
    r = Reader(b)
    if r.header() != (4, 6):
        raise ValueError('plaintext-shape')
    k = r.string(32)
    if re.fullmatch(r'[a-z][a-z0-9-]{0,31}', k) is None:
        raise ValueError('kind')
    body = r.string(32768, 32768)
    m, n = r.header()
    if m != 4 or n > 16:
        raise ValueError('refs')
    refs = [r.string(256) for _ in range(n)]
    corr, reply = r.string(128, nullable=True), r.string(128, nullable=True)
    m, depth = r.header()
    if m != 0 or depth > 8 or r.pos != len(b):
        raise ValueError('depth-or-trailing')
    return [k, body, refs, corr, reply, depth]
