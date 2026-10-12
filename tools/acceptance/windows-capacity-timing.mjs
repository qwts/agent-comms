// Dev-only relative timing. The reporting cap never changes request deadlines.
import { performance } from 'node:perf_hooks';
export const CAPACITY_TIMING_CAP_MS = 120_000;
export const CAPACITY_PHASE_LIMIT = 64;
const PROFILES = Object.freeze({
  default: Object.freeze({ mode: 'default', requestDeadlineMs: 90_000, timingCapMs: CAPACITY_TIMING_CAP_MS }),
  'candidate-channel': Object.freeze({ mode: 'candidate-channel', requestDeadlineMs: 180_000, timingCapMs: 240_000 }),
});
// Selected by trusted driver/fixture mode, never by a reported IPC duration/cap.
export function capacityTimingProfile(mode = 'default') {
  if (typeof mode !== 'string' || !Object.hasOwn(PROFILES, mode)) throw new Error('control-invalid');
  return PROFILES[mode];
}
export function capacityTimingMode(revision, preflight) {
  return revision === 'candidate' && preflight === 'channel' ? 'candidate-channel' : 'default';
}
export function elapsedCapacityTiming(elapsed, mode = 'default') {
  const { timingCapMs } = capacityTimingProfile(mode);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= timingCapMs
    ? { elapsedMs: Math.floor(elapsed) } : { timingUnavailable: true };
}
export function validCapacityTiming(value, mode = 'default') {
  if (typeof mode !== 'string' || !Object.hasOwn(PROFILES, mode)) return false;
  const { timingCapMs } = PROFILES[mode];
  return value !== null && typeof value === 'object' && Object.keys(value).length === 1
    && (Object.hasOwn(value, 'elapsedMs')
      ? Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= timingCapMs
      : value.timingUnavailable === true);
}
export function createCapacityPhaseTiming(now = () => performance.now(), mode = 'default') {
  capacityTimingProfile(mode);
  const started = now();
  return () => {
    const timing = elapsedCapacityTiming(now() - started, mode);
    return Object.hasOwn(timing, 'elapsedMs') ? { phaseElapsedMs: timing.elapsedMs } : { phaseTimingUnavailable: true };
  };
}
// Always retain timing, including failure, without replacing the original error.
export async function timeCapacityRequest(request, save, now = () => performance.now(), mode = 'default') {
  capacityTimingProfile(mode);
  const started = now();
  try { return await request(); }
  finally { save(elapsedCapacityTiming(now() - started, mode)); }
}
export function validCapacityPhaseTimings(rows, allowedPhases, mode = 'default') {
  if (!Array.isArray(rows) || rows.length > CAPACITY_PHASE_LIMIT) return false;
  let previous = -1;
  return rows.every(row => {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 || !allowedPhases.has(row.phase)) return false;
    const { phase, ...timing } = row;
    if (!validCapacityTiming(timing, mode)) return false;
    if (Object.hasOwn(timing, 'elapsedMs')) {
      if (timing.elapsedMs < previous) return false;
      previous = timing.elapsedMs;
    }
    return true;
  });
}
