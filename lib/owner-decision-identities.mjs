// Shared owner-decision descriptor grammar. Messaging pairing keeps its own
// existing identity grammar; this module does not change that protocol.
const account = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const soul = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

export const ownerDecisionAccount = value => matches(account, value);
export const ownerDecisionSoul = value => matches(soul, value);
