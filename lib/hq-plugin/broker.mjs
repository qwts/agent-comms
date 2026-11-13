// agent-comms broker mode as an HQ plugin (ADR-0306; agent-bot-hq plan §4.9
// and §9 row 13b). HQ core opens broker.sock and hands this plugin every
// frame on it. A member binds its connection first, in one of two ways:
//
// - `bind.challenge { runtime_id }`, then `bind { runtime_id, proof }`: the
//   member answers hq-admission's nonce with a proof keyed by its channel
//   binding, which is never sent (agent-bot-hq plan §9 row 16a). A member
//   that has its own OS account can bind only this way.
// - `bind { runtime_id, channel_binding }`: the binding itself, for a member
//   without an account.
//
// hq-admission decides whether the connection speaks for that live runtime;
// this plugin hands it the connection, and HQ core knows which account that
// connection arrived from. From then on the connection speaks for that
// runtime alone, and every later frame is delivered to the plugin that
// registered its kind, with the runtime ID and nothing else.
//
// This plugin authorizes nothing beyond the binding. Liveness, epoch, lease
// generation and "the request names the bound runtime" are checked by the
// consumer on every delivery (hq-tasks, through withBoundRuntime), so a
// superseded or expired runtime is refused there even on a bound connection.

import { readFileSync } from 'node:fs';
import { fail } from '../vendor/agent-bot-sdk/errors.mjs';
import { definePlugin } from '../vendor/agent-bot-sdk/plugin.mjs';
import { createNoticePump, NOTICE_ROUTES } from './notices.mjs';

const { name: NAME, version: VERSION } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const BIND = 'bind';
export const BIND_CHALLENGE = 'bind.challenge';

// `beforeBind` is for tests: it holds a bind in flight.
export function brokerPlugin({ beforeBind, noticeTimers = {} } = {}) {
  const noticePumps = new WeakMap();
  return definePlugin({
    name: NAME,
    version: VERSION,
    hostApi: 1,
    requires: { 'hq-admission': '^0.1.0' },
    services: ['config', 'store', 'identityService', 'events', 'clock', 'log'],
    identityServiceRoutes: NOTICE_ROUTES,
    async init(ctx) {
      const admission = ctx.deps['hq-admission'];
      const noticePump = createNoticePump({ ...ctx.services, options: ctx.services.config.get('notices'), ...noticeTimers });
      noticePumps.set(ctx, noticePump);
      // connection → { binding: true } while its bind is in flight, then
      // { runtime_id } once bound. A closed connection has no entry.
      const connections = new Map();

      async function bind(message, connection) {
        const prior = connections.get(connection);
        if (prior) fail('host.invalid_request', prior.binding ? 'a bind is already in flight on this connection' : 'this connection is already bound');
        const pending = { binding: true };
        connections.set(connection, pending);
        let bound;
        try {
          if (beforeBind) await beforeBind();
          bound = await admission.verifyBinding(message, { connection });
        } catch (e) {
          if (connections.get(connection) === pending) connections.delete(connection);
          throw e;
        }
        // The connection closed while hq-admission was answering: its
        // binding dies with it.
        if (connections.get(connection) !== pending) fail('host.invalid_request', 'the connection closed during bind');
        connections.set(connection, { runtime_id: bound.runtime_id });
        return { runtime_id: bound.runtime_id, member_id: bound.member_id, role: bound.role };
      }

      // The first half of a keyed bind. hq-admission keeps the challenge
      // against the connection; an HQ that predates row 16a has none to give.
      async function challenge(message, connection) {
        const prior = connections.get(connection);
        if (prior) fail('host.invalid_request', prior.binding ? 'a bind is already in flight on this connection' : 'this connection is already bound');
        if (typeof admission.bindChallenge !== 'function') fail('host.invalid_request', 'this HQ does not offer bind challenges');
        return admission.bindChallenge(message, { connection });
      }

      ctx.broker.serve({
        async accept(kind, message, { connection }) {
          if (kind === BIND_CHALLENGE) return challenge(message, connection);
          if (kind === BIND) return bind(message, connection);
          const state = connections.get(connection);
          if (!state?.runtime_id) fail('caller_mismatch', 'a member binds its connection before anything else');
          return ctx.broker.deliver(kind, message, { runtime_id: state.runtime_id });
        },
        closed(connection) {
          connections.delete(connection);
          admission.forgetConnection?.(connection);
        },
      });

      return {
        provides: {
          boundConnections: () => [...connections.values()].filter((s) => s.runtime_id).length,
          notices: noticePump,
        },
      };
    },
    async start(ctx) { noticePumps.get(ctx).start(); },
    async stop(ctx) { noticePumps.get(ctx).stop(); },
  });
}
