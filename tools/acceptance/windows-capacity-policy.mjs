// Dev-only finite admission policy; no production transport substitution.
import { performance } from 'node:perf_hooks';

export const RATES = Object.freeze([1, 10, 100]);
export const MAX_IN_FLIGHT = 32;
export const REQUEST_DEADLINE_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => values.length
  ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;

export async function admissionStage(rate, call, { now = () => performance.now(), wait = sleep } = {}) {
  if (!RATES.includes(rate)) throw new Error('unsupported-offered-rate');
  const seconds = 10, planned = seconds * rate, interval = 1000 / rate;
  const started = now(), pending = new Set(), latency = [], lateness = [];
  const result = { offeredRate: rate, seconds, planned, offered: 0, admitted: 0,
    completed: 0, completedWithinOffers: 0, deadlineFailures: 0, otherFailures: 0,
    capacityRejected: 0, missedOfferIntervals: 0, peakInFlight: 0,
    requestDeadlineMs: REQUEST_DEADLINE_MS, maxInFlight: MAX_IN_FLIGHT };
  let failure;
  for (let index = 0; index < planned; index += 1) {
    const target = started + index * interval;
    await wait(Math.max(0, target - now()));
    if (failure) break;
    result.offered += 1;
    const late = Math.max(0, now() - target);
    lateness.push(late);
    if (late >= interval) {
      result.missedOfferIntervals += 1; failure = 'offer-interval-missed'; break;
    }
    if (pending.size >= MAX_IN_FLIGHT) {
      result.capacityRejected += 1; failure = 'inflight-limit'; break;
    }
    const began = now();
    result.admitted += 1;
    // Invoke the real call immediately: synchronous production custody work is
    // part of admission cost and must not be hidden behind a synthetic callback.
    let actual;
    try { actual = call(REQUEST_DEADLINE_MS); }
    catch (error) { actual = Promise.reject(error); }
    const promise = Promise.resolve(actual).then((response) => {
      if (!response || !Array.isArray(response.messages) || response.messages.length !== 0) {
        result.otherFailures += 1; failure ??= 'unexpected-read-outcome'; return;
      }
      result.completed += 1;
      if (now() <= started + seconds * 1000) result.completedWithinOffers += 1;
      latency.push(now() - began);
    }, (error) => {
      if (error?.code === 'broker-timeout') result.deadlineFailures += 1;
      else result.otherFailures += 1;
      failure ??= error?.code === 'broker-timeout' ? 'request-deadline' : 'request-failed';
    }).finally(() => pending.delete(promise));
    pending.add(promise);
    result.peakInFlight = Math.max(result.peakInFlight, pending.size);
  }
  if (!failure) await wait(Math.max(0, started + seconds * 1000 - now()));
  const offersEnded = now();
  await Promise.all([...pending]);
  const finished = now();
  return { ...result, notOffered: planned - result.offered, offersElapsedMs: offersEnded - started,
    drainMs: finished - offersEnded, elapsedMs: finished - started,
    observedCompletionRate: result.completed * 1000 / Math.max(1, finished - started),
    p95Ms: percentile(latency, 0.95), p99Ms: percentile(latency, 0.99),
    driverLatenessMaxMs: lateness.length ? Math.max(...lateness) : null,
    qualified: !failure && result.admitted === planned && result.completed === planned,
    failure: failure ?? null };
}
