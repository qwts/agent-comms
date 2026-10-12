"""Black-box Node/Python agreement; neither implementation imports the other."""
import itertools
import json
from pathlib import Path
import subprocess
from reference import encode, decode

ROOT = Path(__file__).parent
ALPHABET = ['a', '\u0800', '\ufeff', '\ud800', '\udbff', '\udc00', '\udfff', '\U0001f600']
corpus = [['a', '', [], None, None, 0]]
for n in range(1, 5):
    for chars in itertools.product(ALPHABET, repeat=n):
        corpus.append(['message', ''.join(chars), [], None, None, n])
for n in [23, 24, 255, 256, 32767, 32768]:
    corpus.append(['a', 'x'*n, [], None, None, 8])
for n in [23, 24, 127, 128, 255, 256]:
    corpus.append(['a', '', ['\u0800'*n], '\ufeff' * min(n,128), None, 0])
corpus.append(['a'*32, 'a\ud800'*8192, ['\u0800\ud800'*128]*16,
               '\u0800\ud800'*64, '\u0800\ud800'*64, 8])
vectors = json.loads((ROOT/'vectors.json').read_text())
corpus.extend(v['value'] for v in vectors['golden'])
invalid_values = [['a\n', '', [], None, None, 0], ['a', 'x'*32769, [], None, None, 0],
                  ['a','', ['x'*257], None, None,0], ['a','',[],None,None,True]]
hexes = [encode(p).hex() for p in corpus]
negative = [v['hex'] for v in vectors['negative']]
negative += [h+'00' for h in hexes[:20]]
script = '''
import {encode,decode} from './node-reference.mjs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {corpus,hexes,negative,invalidValues}=JSON.parse(input);
const enc=corpus.map(p=>encode(p).toString('hex'));
const dec=hexes.map(h=>encode(decode(Buffer.from(h,'hex'))).toString('hex'));
const refuses=(f,x)=>{try{f(x);return false}catch{return true}};
console.log(JSON.stringify({enc,dec,negative:negative.map(h=>refuses(decode,Buffer.from(h,'hex'))),
 invalid:invalidValues.map(p=>refuses(encode,p))}));
'''
payload = json.dumps(dict(corpus=corpus, hexes=hexes, negative=negative,
                          invalidValues=invalid_values), ensure_ascii=True)
result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                        input=payload, capture_output=True, text=True, timeout=30, check=True)
other = json.loads(result.stdout)
for key, expected in [('enc', len(corpus)), ('dec', len(corpus)),
                      ('negative', len(negative)), ('invalid', len(invalid_values))]:
    if not isinstance(other.get(key), list) or len(other[key]) != expected:
        raise AssertionError(f'Node output cardinality: {key}')
mismatches = []
for i, h in enumerate(hexes):
    if other['enc'][i] != h or other['dec'][i] != h:
        mismatches.append(dict(index=i, value=corpus[i], python=h, node=other['enc'][i], nodeDecode=other['dec'][i]))
    # Node encode -> Python decode -> Python encode, independent reverse direction.
    if encode(decode(bytes.fromhex(other['enc'][i]))).hex() != h:
        mismatches.append(dict(index=i, direction='node-python'))
for h, refused in zip(negative, other['negative']):
    try:
        decode(bytes.fromhex(h)); py_refused=False
    except ValueError:
        py_refused=True
    if not (refused and py_refused):
        mismatches.append(dict(negative=h, nodeRefused=refused, pythonRefused=py_refused))
for p, refused in zip(invalid_values, other['invalid']):
    try:
        encode(p); py_refused=False
    except ValueError:
        py_refused=True
    if not (refused and py_refused):
        mismatches.append(dict(invalid=p, nodeRefused=refused, pythonRefused=py_refused))
if mismatches:
    (ROOT/'interop-mismatches.json').write_text(json.dumps(mismatches, ensure_ascii=True, indent=2)+'\n')
    raise AssertionError(f'{len(mismatches)} mismatches; see interop-mismatches.json')
print(json.dumps(dict(pass_=True, corpus=len(corpus), negative=len(negative),
                      invalidValues=len(invalid_values), mismatches=0)))
