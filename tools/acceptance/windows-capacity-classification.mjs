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
      if (!['check','argvCountMatches','argvMatches','executablePathPresent','builtinConsoleHostMatch','rowIsRelay','rowIsDiagnostic','rowIsCompiler','parentIsFixture','parentIsDiagnostic','parentIsRelay','parentIsCompiler','parentIsBuiltinConsoleHost','parentInOwnedRows',
        'consoleHostCommandLineClass','consoleHostCommandShape','consoleHostArgumentCount','parentCurrentRowFound','parentRelayPathMatch','parentRelayCommandLineClass','parentRelayArgumentCount','parentRelayArgsParsed','parentRelayArgsEqualExpected','parentParentIsFixture','parentCreationDatePresent','parentCreationAtOrAfterFixtureObserved','consoleHostCreationDatePresent','consoleHostCreationAtOrAfterParentObserved'].includes(key)) return undefined;
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
    const conhostDiagnosticKeys = ['consoleHostCommandLineClass','consoleHostCommandShape','consoleHostArgumentCount','parentCurrentRowFound','parentRelayPathMatch','parentRelayCommandLineClass','parentRelayArgumentCount','parentRelayArgsParsed','parentRelayArgsEqualExpected','parentParentIsFixture','parentCreationDatePresent','parentCreationAtOrAfterFixtureObserved','consoleHostCreationDatePresent','consoleHostCreationAtOrAfterParentObserved'];
    if (conhostDiagnosticKeys.some(key => Object.hasOwn(result,key))) {
      const shapeClasses = ['missing','wrong-type','over-bound','parse-refused','no-arguments','one-argument','multiple-arguments'];
      const parsedShape = value => ['no-arguments','one-argument','multiple-arguments'].includes(value);
      const commandShapes = ['legacy-handle-only-candidate','legacy-handle-force-v1-candidate','other','unparsed'];
      const countMatchesShape = (shape,count) => shape === 'no-arguments' ? count === 0
        : shape === 'one-argument' ? count === 1
          : shape === 'multiple-arguments' ? Number.isInteger(count) && count >= 2 && count <= 12
            : count === null;
      const booleans = ['parentCurrentRowFound','parentRelayPathMatch','parentRelayArgsParsed','parentRelayArgsEqualExpected','parentParentIsFixture','parentCreationDatePresent','parentCreationAtOrAfterFixtureObserved','consoleHostCreationDatePresent','consoleHostCreationAtOrAfterParentObserved'];
      const countsValid = count => count === null || Number.isInteger(count) && count >= 0 && count <= 12;
      const parentShapeClasses = [...shapeClasses,'not-checked'];
      if (result.check !== 'executable' || result.builtinConsoleHostMatch !== true
          || conhostDiagnosticKeys.some(key => !Object.hasOwn(result,key))
          || !shapeClasses.includes(result.consoleHostCommandLineClass)
          || !commandShapes.includes(result.consoleHostCommandShape)
          || !parentShapeClasses.includes(result.parentRelayCommandLineClass)
          || !booleans.every(key => typeof result[key] === 'boolean')
          || !countsValid(result.consoleHostArgumentCount) || !countsValid(result.parentRelayArgumentCount)
          || !countMatchesShape(result.consoleHostCommandLineClass,result.consoleHostArgumentCount)
          || !countMatchesShape(result.parentRelayCommandLineClass,result.parentRelayArgumentCount)
          || (parsedShape(result.consoleHostCommandLineClass) === (result.consoleHostCommandShape === 'unparsed'))
          || (result.consoleHostCommandShape === 'legacy-handle-only-candidate' && result.consoleHostArgumentCount !== 1)
          || (result.consoleHostCommandShape === 'legacy-handle-force-v1-candidate' && result.consoleHostArgumentCount !== 2)
          || (result.parentCurrentRowFound && !result.parentInOwnedRows)
          || (result.parentRelayPathMatch && !result.parentCurrentRowFound)
          || (result.parentRelayArgsParsed && (!result.parentRelayPathMatch || !parsedShape(result.parentRelayCommandLineClass)))
          || (parsedShape(result.parentRelayCommandLineClass) && !result.parentRelayArgsParsed)
          || (result.parentRelayArgsEqualExpected && (!result.parentRelayArgsParsed || !result.parentParentIsFixture || !result.parentCreationAtOrAfterFixtureObserved))
          || (result.parentParentIsFixture && !result.parentCurrentRowFound)
          || (result.parentCreationAtOrAfterFixtureObserved && (!result.parentCurrentRowFound || !result.parentCreationDatePresent))
          || (result.consoleHostCreationAtOrAfterParentObserved && (!result.consoleHostCreationDatePresent || !result.parentCreationDatePresent || !result.parentCurrentRowFound))) return undefined;
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
