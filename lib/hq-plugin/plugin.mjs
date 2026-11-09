// The agent-comms HQ plugin: exactly one default export (agent-bot-hq SDK,
// plan §4.1). Today it is broker mode (ADR-0306).
import { brokerPlugin } from './broker.mjs';

export default brokerPlugin();
