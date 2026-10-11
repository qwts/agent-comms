// Membership authorizes channel metadata, never discovery of hidden endpoints.
import { CHANNEL_ADDRESS, sameEndpoint } from '../channel-state.mjs';
import { fail } from '../errors.mjs';
import { serializedBytes } from '../retention.mjs';
import { PAGE_BUDGET } from './message-admission.mjs';
import { covers } from './shared.mjs';

export function createChannelCensus(broker, mailbox, channels) {
  const metadata = (channel) => ({ channel: channel.address, address: channel.address, name: channel.name });
  function visible(channel, caller) {
    const member = channels.memberOf(channel, caller)?.state === 'subscribed';
    const manager = sameEndpoint(channel.manager, caller) && channels.permits(caller, 'manage', channel);
    return (member || manager) && channels.permits(caller, 'census', channel);
  }
  function roster(channel, caller) {
    return channel.members.filter((member) => member.state === 'subscribed').flatMap((member) => {
      const target = member.endpoint;
      if (target.principal) {
        // The ordinary peers API discovers souls, not human principals. Even
        // management cannot expose another principal's identity through a roster.
        if (target.principal !== caller.principal) return [];
        return [{ principal: target.principal, name: broker.state.principals.get(target.principal)?.name ?? null,
          canPost: channel.posters.some((poster) => sameEndpoint(poster, target)), wake: member.wake }];
      }
      const soul = broker.state.souls.get(target.agentId);
      if (!soul || soul.account !== target.account) return [];
      // Principal census uses its grant, regardless of receive allowlists;
      // soul peers use canSend. Self is an explicit channel discovery exception.
      if (caller.principal ? !covers(caller.grant, soul) : !sameEndpoint(caller, soul) && !mailbox.canSend(caller, soul)) return [];
      const joined = soul.joined && broker.state.pairings.get(soul.account)?.state === 'approved';
      return [{ account: soul.account, agentId: soul.agentId, name: soul.name, harness: soul.harness,
        verification: soul.verification ?? 'claimed',
        presence: !joined ? 'left' : broker.watchers.get(soul.agentId)?.size ? 'watching' : 'joined',
        canPost: channel.posters.some((poster) => sameEndpoint(poster, target)), wake: member.wake }];
    }).sort((left, right) => {
      const key = (row) => row.principal ?? `${row.account}/${row.agentId}`;
      return key(left).localeCompare(key(right));
    });
  }
  function page(rows, after, limit, base, field) {
    const result = [];
    let bytes = serializedBytes(base) + 128;
    for (const row of rows.slice(after, after + limit)) {
      bytes += serializedBytes(row) + 1;
      if (bytes > PAGE_BUDGET) break;
      result.push(row);
    }
    const cursor = after + result.length;
    return { ...base, [field]: result, cursor, remaining: Math.max(0, rows.length - cursor) };
  }
  function census(request) {
    const caller = mailbox.caller(request, { joined: true });
    const after = request.after ?? 0, limit = request.limit ?? 20;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > broker.limits.readPage
      || request.channel !== undefined && (typeof request.channel !== 'string' || !CHANNEL_ADDRESS.test(request.channel))) {
      fail('bad-request', 'invalid channel census page');
    }
    let result;
    if (request.channel !== undefined) {
      const channel = broker.state.channels.get(request.channel);
      if (!channel || !visible(channel, caller)) fail('unknown-channel', 'no channel you may inspect has that address');
      result = page(roster(channel, caller), after, limit, metadata(channel), 'members');
    } else {
      const rows = [...broker.state.channels.values()].filter((channel) => visible(channel, caller))
        .sort((left, right) => left.address.localeCompare(right.address)).map(metadata);
      result = page(rows, after, limit, {}, 'channels');
    }
    mailbox.remember(caller);
    return result;
  }
  return { census };
}
