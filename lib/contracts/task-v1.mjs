// task/v1 mirror codec (platform PDR-0024, seam task-v1). HQ is the provider
// and owns task state; agent-comms consumes it. These functions validate an
// HQ record against the soul-contracts schema and return it unchanged, as a
// deep-frozen copy. They never translate, fill in or decide anything.
//
// The v0.5.5 peer-offer task workflow in lib/broker/tasks.mjs is a separate,
// local feature and is not task/v1 (docs/tasks.md).

import { admit } from './schemas.mjs';

export const mirrorTaskRecord = (record) => admit('task/v1/task-record.schema.json', record);
export const mirrorTaskCommitment = (request) => admit('task/v1/task-commitment.schema.json', request);
export const mirrorActionRecord = (record) => admit('task/v1/action-record.schema.json', record);
