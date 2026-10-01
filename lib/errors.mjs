// Stable error codes. A workflow branches on `code`, never on the message,
// so codes are append-only: rename one and every agent's recovery breaks.

export class CommsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const fail = (code, message) => {
  throw new CommsError(code, message);
};
