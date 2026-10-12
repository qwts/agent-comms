// Private local metadata from the reviewed Windows connector. This is never a
// wire field, authority, exception serializer, or peer-provided diagnostic.
const STAGES = Object.freeze(['host-clixml', 'host-stderr', 'pipe-refused',
  'process-error', 'premature-close', 'startup-timeout']);

export function projectWindowsPipeStage(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'windowsPipeStage');
    // Accessors, inherited values and coercible objects never enter receipts.
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      && STAGES.includes(descriptor.value) ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function preserveWindowsPipeStage(target, source) {
  try {
    const stage = projectWindowsPipeStage(source);
    if (stage !== undefined) Object.defineProperty(target, 'windowsPipeStage', { value: stage, enumerable: false });
  } catch { /* Missing diagnostics cannot change the original transport error. */ }
  return target;
}
