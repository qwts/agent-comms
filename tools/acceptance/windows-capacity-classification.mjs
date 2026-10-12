// Closed dev-only local supervisor metadata. Never serialize exception text,
// command lines, executable paths, process IDs or arbitrary peer fields.
const CHECKS = Object.freeze(['argv-parse','executable','compiler-parent',
  'compiler-arguments','compiler-response','owned-parent','argv-count',
  'argv-equality','pid-reuse','history-bound','kind-bound']);

export function projectSupervisorClassification(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = {};
    for (const key of Object.keys(value)) {
      if (!['check','argvCountMatches','argvMatches'].includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !Object.hasOwn(descriptor,'value')) return undefined;
      result[key] = descriptor.value;
    }
    if (!CHECKS.includes(result.check)) return undefined;
    for (const key of ['argvCountMatches','argvMatches']) {
      if (Object.hasOwn(result,key) && typeof result[key] !== 'boolean') return undefined;
    }
    if (result.argvMatches !== undefined && result.argvCountMatches !== true) return undefined;
    if (result.check === 'argv-count' && (result.argvCountMatches !== false || result.argvMatches !== undefined)) return undefined;
    if (result.check === 'argv-equality' && (result.argvCountMatches !== true || result.argvMatches !== false)) return undefined;
    return result;
  } catch { return undefined; }
}

export function supervisorClassificationFromFailure(record) {
  try {
    const failure = Object.getOwnPropertyDescriptor(record,'failure');
    if (!failure || !Object.hasOwn(failure,'value')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(failure.value,'classification');
    return descriptor && Object.hasOwn(descriptor,'value') ? projectSupervisorClassification(descriptor.value) : undefined;
  } catch { return undefined; }
}

export function supervisorClassificationFromError(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error,'supervisorClassification');
    return descriptor && Object.hasOwn(descriptor,'value') ? projectSupervisorClassification(descriptor.value) : undefined;
  } catch { return undefined; }
}
