// Task events wake work or review according to the current claim.
const same = (a, b) => a.principal ? a.principal === b.principal
  : !b.principal && a.account === b.account && a.agentId === b.agentId;

export function taskEventPlan(message, task, self) {
  if (!task || message.correlation !== task.id) return { turn: false, linked: false, role: null };
  if (same(self, task.assignee)) {
    const turn = ['offered', 'accepted', 'working', 'input-required'].includes(task.state);
    return { turn, linked: turn, role: 'assignee' };
  }
  if (same(self, task.offerer)) {
    return { turn: ['input-required', 'completed', 'failed', 'rejected'].includes(task.state), linked: false, role: 'offerer' };
  }
  return { turn: false, linked: false, role: null };
}
