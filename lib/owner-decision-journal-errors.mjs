// Fixed public mapping only. The future route must authenticate and authorize
// before lookup: unknown/unauthorized IDs use owner-decision-unavailable first.
// Mapping a storage error never changes or invents a lifecycle outcome.
const messages = Object.freeze({
  'bad-request': 'The owner-decision storage input is invalid.',
  conflict: 'The owner-decision request conflicts with retained state.',
  'journal-capacity': 'The owner-decision journal cannot admit another request.',
  'owner-decision-unsupported': 'This owner-decision storage operation is unsupported.',
  'storage-failed': 'The owner-decision journal is unavailable.',
});
export function ownerDecisionJournalError(error) {
  const codes = {
    'invalid-owner-journal-record': 'bad-request', 'owner-journal-input-invalid': 'bad-request',
    'owner-journal-conflict': 'conflict', 'owner-journal-id-spent': 'conflict',
    'owner-journal-capacity': 'journal-capacity', 'owner-journal-unsupported-phase': 'owner-decision-unsupported',
  };
  const code = Object.hasOwn(codes, error?.message) ? codes[error.message] : 'storage-failed';
  return { code, message: messages[code] };
}
