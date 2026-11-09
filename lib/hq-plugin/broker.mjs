// agent-comms broker mode as an HQ plugin (ADR-0306; agent-bot-hq plan §4.9
// and §9 row 13b). HQ core opens broker.sock and hands this plugin every
// frame on it. A member's first frame is `bind` with the runtime ID and
// channel binding from its admission result. hq-admission decides whether
// the binding speaks for that live runtime. From then on the connection
// speaks for that runtime alone, and every later frame is delivered to the
// plugin that registered its kind, with the runtime ID and nothing else.
//
// This plugin authorizes nothing beyond the binding. Liveness, epoch, lease
// generation and "the request names the bound runtime" are checked by the
// consumer on every delivery (hq-tasks, through withBoundRuntime), so a
// superseded or expired runtime is refused there even on a bound connection.

import { readFileSync } from 'node:fs';
import { fail } from '../vendor/agent-bot-sdk/errors.mjs';
import { definePlugin } from '../vendor/agent-bot-sdk/plugin.mjs';

const { name: NAME, version: VERSION } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const BIND = 'bind';

// `beforeBind` is for tests: it holds a bind in flight.
export function brokerPlugin({ beforeBind } = {}) {
  return definePlugin({
    name: NAME,
    version: VERSION,
    hostApi: 1,
    requires: { 'hq-admission': '^0.1.0' },
    async init(ctx) {
      const admission = ctx.deps['hq-admission'];
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
          bound = await admission.verifyBinding(message);
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

      ctx.broker.serve({
        async accept(kind, message, { connection }) {
          if (kind === BIND) return bind(message, connection);
          const state = connections.get(connection);
          if (!state?.runtime_id) fail('caller_mismatch', 'a member binds its connection before anything else');
          return ctx.broker.deliver(kind, message, { runtime_id: state.runtime_id });
        },
        closed(connection) {
          connections.delete(connection);
        },
      });

      return {
        provides: {
          boundConnections: () => [...connections.values()].filter((s) => s.runtime_id).length,
        },
      };
    },
  });
}
