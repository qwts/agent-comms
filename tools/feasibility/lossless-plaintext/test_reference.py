import json
from pathlib import Path
import unittest
from reference import decode, encode, units, MAX_BYTES

V = json.loads(Path(__file__).with_name('vectors.json').read_text())

class CodecTests(unittest.TestCase):
    def test_golden(self):
        for v in V['golden']:
            with self.subTest(v['name']):
                b = bytes.fromhex(v['hex'])
                self.assertEqual(encode(v['value']), b)
                result = decode(b)
                self.assertEqual(encode(result), b)
                self.assertEqual(list(units(result[1])), list(units(v['value'][1])))

    def test_negative(self):
        for v in V['negative']:
            with self.subTest(v['name']), self.assertRaises(ValueError):
                decode(bytes.fromhex(v['hex']))

    def test_bound(self):
        p = ['a'*32, 'a\ud800'*8192, ['\u0800\ud800'*128]*16,
             '\u0800\ud800'*64, '\u0800\ud800'*64, 8]
        b = encode(p)
        self.assertEqual(len(b), MAX_BYTES)
        self.assertEqual(encode(decode(b)), b)
        with self.assertRaises(ValueError): decode(b+b'\0')
        p[1] += 'x'
        with self.assertRaises(ValueError): encode(p)

    def test_units_pairs_and_limits(self):
        base = ['a', '', [], None, None, 0]
        for s in ['\udc00\ud800', '\ud800\ud800', '\ud800\ud800\udc00', '\U0001f600']:
            p = base.copy(); p[1] = s
            self.assertEqual(list(units(decode(encode(p))[1])), list(units(s)))
        p = base.copy(); p[2] = ['\U0001f600'*128]
        self.assertEqual(encode(decode(encode(p))), encode(p))
        p[2] = ['\U0001f600'*129]
        with self.assertRaises(ValueError): encode(p)

    def test_all_truncations_and_boolean(self):
        b = bytes.fromhex(V['golden'][2]['hex'])
        for i in range(len(b)):
            with self.assertRaises(ValueError): decode(b[:i])
        with self.assertRaises(ValueError): decode(bytes.fromhex('8661616080f6f6f4'))

if __name__ == '__main__': unittest.main()
