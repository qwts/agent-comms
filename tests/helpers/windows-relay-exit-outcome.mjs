// Closed diagnostic projection only. Never expose signal names or child details.
const validCode = value => Number.isInteger(value) && value >= -2147483648 && value <= 4294967295;
export function projectRelayExitOutcome(code, signal) {
  if (typeof signal === 'string' && signal.length > 0) return { exitCode: null, exitOutcome: 'signal' };
  if (signal !== null && signal !== undefined) return { exitCode: null, exitOutcome: 'unknown' };
  if (!validCode(code)) return { exitCode: null, exitOutcome: 'unknown' };
  return { exitCode: code, exitOutcome: code === 0 ? 'zero' : 'nonzero' };
}
export function validRelayExitOutcome(value) {
  if (!value || typeof value !== 'object') return false;
  const { exitCode, exitOutcome } = value;
  if (exitOutcome === 'zero') return exitCode === 0;
  if (exitOutcome === 'nonzero') return validCode(exitCode) && exitCode !== 0;
  return (exitOutcome === 'signal' || exitOutcome === 'unknown') && exitCode === null;
}
