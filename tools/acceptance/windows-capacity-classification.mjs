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
      if (!['check','argvCountMatches','argvMatches','executablePathPresent','builtinConsoleHostMatch','rowIsRelay','rowIsDiagnostic','rowIsCompiler','parentIsFixture','parentIsDiagnostic','parentIsRelay','parentIsCompiler','parentIsBuiltinConsoleHost','parentInOwnedRows'].includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      if (!descriptor || !Object.hasOwn(descriptor,'value')) return undefined;
      result[key] = descriptor.value;
    }
    if (!CHECKS.includes(result.check)) return undefined;
    for (const key of ['argvCountMatches','argvMatches']) {
      if (Object.hasOwn(result,key) && typeof result[key] !== 'boolean') return undefined;
    }
    const executableKeys = ['executablePathPresent','builtinConsoleHostMatch','parentIsFixture','parentIsDiagnostic','parentInOwnedRows'];
    if (executableKeys.some(key => Object.hasOwn(result,key))) {
      if (result.check !== 'executable' || executableKeys.some(key => typeof result[key] !== 'boolean')
          || result.argvCountMatches !== undefined || result.argvMatches !== undefined
          || (result.builtinConsoleHostMatch && !result.executablePathPresent)
          || ((result.parentIsFixture || result.parentIsDiagnostic) && !result.parentInOwnedRows)
          || (result.parentIsFixture && result.parentIsDiagnostic)) return undefined;
    }
    const rowParentClassKeys = ['rowIsRelay','rowIsDiagnostic','rowIsCompiler','parentIsRelay','parentIsCompiler','parentIsBuiltinConsoleHost'];
    if (rowParentClassKeys.some(key => Object.hasOwn(result,key))) {
      if (result.check !== 'executable' || rowParentClassKeys.some(key => typeof result[key] !== 'boolean')
          || !executableKeys.every(key => typeof result[key] === 'boolean')
          || ((result.parentIsRelay || result.parentIsCompiler || result.parentIsBuiltinConsoleHost) && !result.parentInOwnedRows)
          || (result.builtinConsoleHostMatch && (result.rowIsRelay || result.rowIsDiagnostic || result.rowIsCompiler))
          || [result.rowIsRelay,result.rowIsDiagnostic,result.rowIsCompiler].filter(Boolean).length > 1
          || [result.parentIsFixture,result.parentIsDiagnostic,result.parentIsRelay,result.parentIsCompiler,result.parentIsBuiltinConsoleHost].filter(Boolean).length > 1) return undefined;
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
