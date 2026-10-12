// Pure wire operation schemas shared by classification and typed ingress.
// Classification identifies frames to restrict; it supplies no authority.
const specs = [
  ['owner-decision-prepare', 'principal', 'prepare', ['requestId', 'account', 'soul', 'operation', 'parameters']],
  ['owner-decision', 'principal', 'confirm', ['requestId', 'payloadDigest', 'presence']],
  ['owner-decision-status', 'principal', 'status', ['requestId']],
  ['owner-decision-cancel', 'principal', 'cancel', ['requestId']],
  ...[['owner-decision-prepared', 'prepared', ['nonce', 'preparedAt', 'exp', 'stage']],
    ['owner-decision-check', 'check', ['receiptDigest']],
    ['owner-decision-result', 'result', ['receiptDigest', 'state', 'outcome', 'reconciliation']]]
    .map(([op, method, extra]) => [op, 'daemon', method,
      ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId', ...extra]]),
];
const operations = new Map(specs.map(([op, kind, method, fields]) =>
  [op, Object.freeze([kind, method, Object.freeze(fields)])]));
export const OWNER_DECISION_WIRE_OPERATIONS = Object.freeze([...operations.keys()]);
export const ownerDecisionWireOperation = op => operations.get(op);
export const isOwnerDecisionOperation = op => operations.has(op);
