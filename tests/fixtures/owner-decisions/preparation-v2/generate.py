"""Generate separate v2 preparation evidence; never rewrite v1 inputs."""
import copy
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = (root / 'effect-evidence-v1.json').read_bytes()
outcome_source = (root / 'effect-outcomes-v1.json').read_bytes()
outcomes = json.loads(outcome_source)
original = json.loads(source)

def canonical(record):
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def vector(identifier, record):
    text = canonical(record)
    return dict(id=identifier, record=record, canonicalJson=text,
                sha256=hashlib.sha256(text.encode()).hexdigest(),
                utf8Bytes=len(text.encode()), cap=2048 if record['kind'] == 'reconciliation' else 4096)

records = copy.deepcopy(original['records'])
records.extend(copy.deepcopy(outcomes['refusalRecords']))
rebounds = {}
for row in records:
    record = row['record']
    if record['kind'] == 'preparation':
        record.update(v=2, trustVersion=1)
        new = vector(row['id'], record)
        rebounds[row['sha256']] = new['sha256']
        row.update(new)
for row in records:
    if row['record']['kind'] == 'effect':
        row['record']['preparationDigest'] = rebounds[row['record']['preparationDigest']]
        new = vector(row['id'], row['record'])
        rebounds[row['sha256']] = new['sha256']
        row.update(new)
for row in records:
    if row['record']['kind'] == 'reconciliation':
        basis = row['record']['basisDigest']
        if basis is not None:
            row['record']['basisDigest'] = rebounds[basis]
        row.update(vector(row['id'], row['record']))
base = records[0]['record']
boundary = copy.deepcopy(base)
boundary['trustVersion'] = 1023
negative = []
for name, value in [('missing', None), ('even', 2), ('zero', 0), ('above-bound', 1024), ('noninteger', 1.5), ('extra-key', 1)]:
    record = copy.deepcopy(base)
    if name == 'missing':
        del record['trustVersion']
    else:
        record['trustVersion'] = value
    if name == 'extra-key':
        record['extra'] = False
    negative.append(dict(**vector(name, record), expected='refused'))
result = dict(version=2, status='disabled-producer-contract',
              sourceSha256=hashlib.sha256(source).hexdigest(),
              outcomeSourceSha256=hashlib.sha256(outcome_source).hexdigest(), records=records,
              boundaryPreparations=[vector('trust-version-1023', boundary)], negatives=negative,
              entryCases=[dict(id='same-trust', preparationId=records[0]['id'], currentTrustVersion=1, expected='accepted'),
                          dict(id='changed-trust', preparationId=records[0]['id'], currentTrustVersion=3, expected='refused')])
(root / 'effect-evidence-v2.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
