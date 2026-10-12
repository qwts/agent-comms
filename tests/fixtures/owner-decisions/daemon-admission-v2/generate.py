"""Synthetic conformance companions, not daemon-v2 writer output.

Independent Python byte encoder. Event insertion order follows the #1053
writer. All effect preparation bindings come from unchanged Comms v2 vectors.
"""
import copy
import datetime
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = (root / 'effect-evidence-v2.json').read_bytes()
actions_source = (root / 'v1.json').read_bytes()
vectors = json.loads(source)
actions = {json.loads(v['actionJson'])['requestId']: json.loads(v['actionJson'])
           for v in json.loads(actions_source)['positive']}
rows = {v['id']: v for v in vectors['records']}

def dump(v, sorted_keys=True):
    return json.dumps(v, sort_keys=sorted_keys, ensure_ascii=False, separators=(',', ':'))

def sha(v):
    return hashlib.sha256(v.encode()).hexdigest()

def frame(record):
    text = dump(record)
    return dict(record=record, canonicalJson=text, sha256=sha(text), utf8Bytes=len(text.encode()))

cases = []
for prep_row in [v for v in vectors['records'] if v['record']['kind'] == 'preparation']:
    p = prep_row['record']
    prefix = prep_row['id'].removesuffix('-preparation')
    entered = rows[prefix + '-entered']
    completed = copy.deepcopy(rows[prefix + '-completed']['record'])
    action = actions[p['requestId']]
    d = completed['detail']
    linked_text = None
    if d['kind'] == 'revision':
        reject = p['operation'] == 'revision.reject'
        if reject:
            event = dict(kind='decision', proposalId=d['proposalId'], author='user', reason=action['parameters']['reason'])
        else:
            event = dict(kind='revision', revision=d['afterRevision'], parentRevision=d['beforeRevision'],
                         author='soul' if p['operation'] == 'revision.approve' else 'user', reason=action['parameters']['reason'])
            if p['operation'] == 'revision.approve':
                event.update(proposalId=d['proposalId'], approval='user', approvedBy='user', approvalReason=action['parameters']['reason'])
        event.update(authorization=dict(method='owner-decision'), ownerDecision={
            k: completed[k] for k in ['requestId', 'payloadDigest', 'receiptDigest', 'effectId', 'preparationDigest']})
        at = datetime.datetime.fromtimestamp(completed['at'], datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        # append() emits schemaVersion first, event insertion order, then at.
        linked_text = dump(dict(schemaVersion=1, **event, at=at), False) + '\n'
        d['journalRecordDigest'] = sha(linked_text)
    complete = frame(completed)
    refusal = dict(v=1, kind='effect', requestId=p['requestId'], payloadDigest=p['payloadDigest'],
                   preparationDigest=prep_row['sha256'], receiptDigest=completed['receiptDigest'], effectId=p['effectId'],
                   phase='refused', at=completed['at'], detail=dict(code='expected-state-changed'))
    refusal = frame(refusal)
    if d['kind'] == 'revision':
        observation = dict(v=1, head=dict(seq=d['journalSeq'], revision=d['afterRevision']),
                           proposal=None, working=d['working'])
    else:
        params = action['parameters']
        desired = {k: params[k] for k in (['mode', 'policy'] if params['mode'] == 'resume' else ['mode'])}
        observation = dict(v=1, setting=desired, webhookDigest=d['webhookDigest'], resume=p['expected']['resume'])
    pairs = []
    for finding, basis in [('applied', complete['sha256']), ('refused', refusal['sha256']), ('indeterminate', None)]:
        record = dict(v=1, kind='reconciliation', requestId=p['requestId'], payloadDigest=p['payloadDigest'], effectId=p['effectId'],
                      auditId='11111111-1111-4111-8111-111111111111', originalDaemonKey=p['daemonKey'], originalDaemonEpoch=p['daemonEpoch'],
                      reportingDaemonKey='d' * 64, reportingDaemonEpoch=2, at=completed['at'] + 10, finding=finding,
                      basisDigest=basis, observedDigest=sha(dump(observation)))
        pairs.append(dict(finding=finding, **frame(dict(v=1, preimage=observation, record=record))))
    no_prep = copy.deepcopy(pairs[-1]['record'])
    no_prep['record']['effectId'] = None
    cases.append(dict(id=prefix, preparationId=prep_row['id'], enteredId=entered['id'], linkedEventJson=linked_text,
                      completed=complete, refused=refusal, pairs=pairs, noPreparation=frame(no_prep)))

result = dict(status='synthetic-conformance-only-not-daemon-v2-output',
              sourceSha256=hashlib.sha256(source).hexdigest(), actionSourceSha256=hashlib.sha256(actions_source).hexdigest(),
              linkedWriterCommit='13ab9a7878d4a0826162400986c21ccb7ca88d0c',
              pairContractCommit='36a6ecde5a8a49d80d32895a120fb272e412ab2f', cases=cases)
(root / 'daemon-admission-v2.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
