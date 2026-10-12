// Dev-only relative timing. The reporting cap never changes request deadlines.
import { performance } from 'node:perf_hooks';
export const CAPACITY_TIMING_CAP_MS = 120_000;
export const CAPACITY_PHASE_LIMIT = 64;
export function elapsedCapacityTiming(elapsed) {
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CAPACITY_TIMING_CAP_MS
    ? { elapsedMs: Math.floor(elapsed) } : { timingUnavailable: true };
}
export function validCapacityTiming(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 1
    && (Object.hasOwn(value, 'elapsedMs')
      ? Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= CAPACITY_TIMING_CAP_MS
      : value.timingUnavailable === true);
}
export function createCapacityPhaseTiming(now = () => performance.now()) {
  const started = now();
  return () => {
    const timing = elapsedCapacityTiming(now() - started);
    return Object.hasOwn(timing, 'elapsedMs') ? { phaseElapsedMs: timing.elapsedMs } : { phaseTimingUnavailable: true };
  };
}
// Always retain timing, including failure, without replacing the original error.
export async function timeCapacityRequest(request, save, now = () => performance.now()) {
  const started = now();
  try { return await request(); }
  finally { save(elapsedCapacityTiming(now() - started)); }
}
export function validCapacityPhaseTimings(rows, allowedPhases) {
  if (!Array.isArray(rows) || rows.length > CAPACITY_PHASE_LIMIT) return false;
  let previous = -1;
  return rows.every(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 || !allowedPhases.has(row.phase)) return false;
    const { phase, ...timing } = row;
    if (!validCapacityTiming(timing)) return false;
    if (Object.hasOwn(timing, 'elapsedMs')) {
      if (timing.elapsedMs < previous) return false;
      previous = timing.elapsedMs;
    }
    return true;
  });
}
