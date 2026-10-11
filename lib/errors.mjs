// Stable error codes. A workflow branches on `code`, never on the message,
// so codes are append-only: rename one and every agent's recovery breaks.

export class CommsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    const safe = publicDetails(code, details);
    if (safe !== undefined) this.details = safe;
  }
}

export const fail = (code, message, details) => {
  throw new CommsError(code, message, details);
};

const position = (value) => Number.isSafeInteger(value) && value >= 0;

// A code-specific allowlist, not arbitrary Error serialization. Invalid peer
// metadata is discarded, and every accepted payload has constant size.
export function publicDetails(code, details) {
  if (code !== 'cursor-expired' || !details || (details.earliestAvailableSeq !== null
    && (!position(details.earliestAvailableSeq) || details.earliestAvailableSeq === 0)) || !position(details.resumeAfter)) return undefined;
  const result = { earliestAvailableSeq: details.earliestAvailableSeq, resumeAfter: details.resumeAfter };
  if (details.gap !== undefined) {
    const { through, count, firstSeq, lastSeq } = details.gap ?? {};
    if (![through, count, firstSeq, lastSeq].every(position) || !count || count > through || !firstSeq || firstSeq > lastSeq) return undefined;
    result.gap = { through, count, firstSeq, lastSeq };
  }
  return result;
}

export function publicError(error, internalMessage = error.message) {
  const code = error instanceof CommsError ? error.code : 'internal';
  const details = error instanceof CommsError ? publicDetails(code, error.details) : undefined;
  return { code, message: error instanceof CommsError ? error.message : internalMessage,
    ...(details === undefined ? {} : { details }) };
}
