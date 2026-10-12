// Disabled broker-local retention. The public challenge and its digest are
// unchanged; this wrapper retains the authenticated public stage descriptor.
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';
import { bindOwnerDecisionChallenge } from './owner-decision-challenge.mjs';

const invalid = () => { throw new Error('invalid-owner-decision'); };
const exact = (v, names) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== names.length
      || names.some(k => !Object.hasOwn(v, k))) invalid();
};
const integer = n => Number.isSafeInteger(n) && n >= 0;
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);

export function decodeOwnerDecisionPrepared(bytes, saved, nowMilliseconds) {
  try {
    const snapshot = snapshotOwnerDecisionBytes(bytes);
    const wrapper = decodeOwnerDecisionCanonical(snapshot);
    exact(wrapper, ['v', 'challenge', 'stage']);
    if (wrapper.v !== 1) invalid();
    const { action } = decodeOwnerDecisionAction(saved.originalActionBytes);
    const p = action.parameters;
    if (!Object.hasOwn(p, 'stagingId')) {
      if (wrapper.stage !== null) invalid();
    } else {
      exact(wrapper.stage, ['stagingId', 'kind', 'contentDigest', 'expiresAt']);
      const webhook = action.operation === 'cold-wake.set';
      if (wrapper.stage.stagingId !== p.stagingId || wrapper.stage.kind !== (webhook ? 'webhook' : 'package')
          || wrapper.stage.contentDigest !== (webhook ? p.configurationDigest : p.packageDigest)
          || !integer(wrapper.stage.expiresAt)) invalid();
    }
    const challengeBytes = Buffer.from(canonical(wrapper.challenge));
    // Recovery proves a valid bounded instant existed; it never proves fresh
    // preparation. A live writer supplies its trusted current clock instead.
    const seconds = Math.max(0, saved.acceptedAt - 30, wrapper.challenge?.preparedAt - 30);
    const clock = nowMilliseconds === undefined ? seconds * 1000 : nowMilliseconds;
    if (!integer(clock)) invalid();
    const bound = bindOwnerDecisionChallenge(challengeBytes, { ...saved,
      ...(wrapper.stage === null ? {} : { stageExpiresAt: wrapper.stage.expiresAt }), nowMilliseconds: clock });
    return { wrapper, challengeBytes, ...bound };
  } catch { invalid(); }
}
