// Launch is an account daemon command, never a local process start.
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.mjs';
import { writeLine } from '../wire.mjs';
import { covers } from './shared.mjs';

const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shortString = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export const MAX_LAUNCH_DETAIL = 512;

// A failure's detail is daemon-supplied display text. It is normalized, not
// rejected: refusing a report over its wording would leave the launch pending.
function launchDetail(status, detail) {
  if (status !== 'failed' || detail === undefined || detail === null) return null;
  if (typeof detail !== 'string') fail('bad-request', 'launch-result detail must be a string');
  const text = detail.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_LAUNCH_DETAIL).trimEnd();
  return text === '' ? null : text;
}

export function createLaunch(broker, commit, pairing) {
  function caller(request) {
    const identity = pairing.principal(request);
    if (request.sender !== undefined || request.agentId !== undefined) {
      fail('unauthenticated', 'a principal cannot act as a soul or another sender');
    }
    return identity;
  }

  function allowed(grant, target, principal) {
    if (broker.state.pairings.get(target.account)?.state !== 'approved') return false;
    if (target.soul !== undefined) {
      const soul = broker.state.souls.get(target.soul);
      // A departed soul can be launched again; its receive policy still applies.
      return soul?.account === target.account && covers(grant, soul)
        && (soul.allow === null || soul.allow.includes(principal));
    }
    // A package has no soul identity yet. A soul-only grant cannot create one.
    return grant === null || grant.includes(target.account);
  }

  function launch(request) {
    const { principal, pairing: { grant } } = caller(request);
    const { account, soul, package: packagePath, harness, name, comms } = request;
    if (typeof account !== 'string' || !/^[a-z_][a-z0-9_.-]{0,63}$/i.test(account)
      || (soul !== undefined) === (packagePath !== undefined)
      || (soul !== undefined && (typeof soul !== 'string' || !AGENT_ID.test(soul)))
      || (packagePath !== undefined && !shortString(packagePath, 4096))
      || !shortString(harness, 64) || (name !== undefined && !shortString(name, 128))
      || (comms !== undefined && typeof comms !== 'boolean')) {
      fail('bad-request', 'launch requires account, exactly one soul or package path, harness, an optional short name and optional boolean comms');
    }
    const target = { account, ...(soul === undefined ? { package: packagePath } : { soul }), harness,
      ...(name === undefined ? {} : { name }), ...(comms === undefined ? {} : { comms }) };
    if (!allowed(grant, target, principal)) fail('unknown-recipient', 'no launch target is authorized by this principal');
    const socket = [...(broker.accountWatchers.get(account) ?? [])]
      .find((watch) => !watch.destroyed && watch.writable && !watch.writableEnded);
    if (!socket) fail('daemon-unavailable', 'the target account has no open daemon watch');
    const rateKey = `account principal ${principal}`;
    const recent = (broker.sendTimes.get(rateKey) ?? []).filter((at) => broker.now() - at < 60_000);
    if (recent.length >= broker.limits.sendsPerAccountPerMinute) fail('rate-limited', 'too many principal operations in the last minute');
    broker.sendTimes.set(rateKey, [...recent, broker.now()]);
    const requestId = `launch_${randomUUID()}`;
    // Durable authorization evidence precedes delivery. Never replay a process start.
    commit({ t: 'launch-request', requestId, principal, ...target, at: broker.now() });
    writeLine(socket, { event: 'launch', requestId, principal, ...target });
    return { requestId, status: 'pending', agentId: null };
  }

  function status(request) {
    const { principal, pairing: { grant } } = caller(request);
    const launch = broker.state.launches.get(request.requestId);
    if (!launch || launch.principal !== principal || !allowed(grant, launch, principal)) {
      fail('unknown-launch', 'no launch request is available to this principal');
    }
    return { requestId: launch.requestId, status: launch.status, agentId: launch.agentId,
      ...(launch.detail ? { detail: launch.detail } : {}) };
  }

  function result(request, { account }) {
    const launch = broker.state.launches.get(request.requestId);
    if (!launch || launch.account !== account) fail('unknown-launch', 'no launch request belongs to this account');
    const { status, agentId = null } = request;
    if (!['launched', 'failed'].includes(status)
      || (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID.test(agentId)))
      || (status === 'launched' && agentId === null)
      || (agentId !== null && launch.soul !== undefined && agentId !== launch.soul)) {
      fail('bad-request', 'launch-result requires launched or failed and the matching agentId (nullable on failure)');
    }
    const detail = launchDetail(status, request.detail);
    if (launch.status !== 'pending') {
      if (launch.status !== status || launch.agentId !== agentId || (launch.detail ?? null) !== detail) {
        fail('conflict', 'a different result is already recorded');
      }
      return { requestId: launch.requestId, recorded: true, duplicate: true };
    }
    if (agentId !== null) {
      const soul = pairing.soulForAccount(account, agentId);
      if (status === 'launched' && !soul.joined) fail('not-joined', 'the daemon must join the launched soul before reporting success');
    }
    commit({ t: 'launch-result', requestId: launch.requestId, account, agentId, status,
      ...(detail === null ? {} : { detail }), at: broker.now() });
    return { requestId: launch.requestId, recorded: true, duplicate: false };
  }

  return { launch, status, result };
}
