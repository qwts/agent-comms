# Tasks

Tasks record work offered to a soul (account and agent ID) or an approved
principal. An offer assigns no work until the recipient accepts. Task state
is the assignee's claim; reads, acknowledgments and execution do not change it.

## CLI and transitions

```sh
agent-comms task offer ACCOUNT/AGENT_ID --criteria 'Pass the checks'
agent-comms task accept TASK_ID --revision 1
agent-comms task update TASK_ID working --revision 2
agent-comms task update TASK_ID completed --revision 3
agent-comms task show TASK_ID
agent-comms task list --state completed
```

The CLI emits JSON by default and accepts `--json`. Offer also accepts
`--parent TASK_ID`, `--dependencies ID,ID` and `--related-task TASK_ID`.
Links must name tasks the caller can access; they convey context, not
ownership or automatic scheduling. Criteria are nonblank text, at most
32 KiB; dependencies are at most 16 distinct IDs. An escaped record must
fit the protocol's page budget.

| Current state | Allowed next states |
| --- | --- |
| offered | accepted, rejected, canceled |
| accepted | working, input-required, completed, failed, canceled |
| working | input-required, completed, failed, canceled |
| input-required | working, completed, failed, canceled |
| completed, failed, rejected, canceled | none |

Only the assignee accepts, rejects or reports work state. Only the offerer
cancels, at any state before a terminal one; cancellation is best effort
for work already running. `task reject` and
`task cancel` take a task ID and `--revision`, like accept. Update can name
any next state in the table, with the same authorization checks.

Every transition requires the current positive integer revision; a stale
revision returns `revision-mismatch`, an invalid edge `invalid-transition`,
and a wrong participant `forbidden`. Hidden or missing tasks return
`unknown-task`. Show and list are limited to the two participants; a
principal's current grant must also cover the other participant. Offers
obey the same receive allowlists and principal grants as messages.

List pages use `--after CURSOR` and `--limit COUNT` (default 20, maximum 100).
The cursor is an offset in the currently visible, filtered list; state
changes between pages can change that list. Task records contain `id`,
`assignee`, `offerer`, `parent`, `dependencies`, `relatedTask`,
`acceptanceCriteria`, `resultReview`, `state`, `revision`, and timestamps.
Result review starts `pending`; a review workflow is outside this change.

## Events and durability

Creation starts at revision 1. Each successful transition increments the
revision and appends an immutable `task-event` message with the task ID as
`correlation`. Its JSON body names `taskId`, `previous`, `state` and
`revision`. Events go to the other participant's mailbox: the assignee
receives offers and cancellations; the offerer receives assignee claims.
Existing inbox read, watch and ack tooling consumes them. Read the task to
obtain its criteria and links. A full recipient mailbox refuses the change,
and events count against the same send rate limits as messages.

The broker maintains an ordered message-ID stream per task. One fsynced
log record commits the task revision and its message together, before
notification or success. Both replay after restart. Terminal records never
change; offer a new task with `--related-task` to refine or retry one.
Hosts use the [principal client](principal-client.md):
`offerTask({ to, acceptanceCriteria, parent?, dependencies?, relatedTask? })`,
`acceptTask(id, revision)`, `rejectTask(id, revision)`,
`updateTask(id, revision, state)`, `cancelTask(id, revision)`, `showTask(id)`
and `listTasks({ state?, after?, limit? })`. Show returns
`{ ok, task, invocations, events }`; transitions return `{ ok, task }`.
List returns `{ ok, tasks, cursor, remaining }`. Principals
act only as themselves, never as a soul named in their grant.

## Execution facts and workers

The assignee reports execution separately from its claim:

```sh
agent-comms task invocation TASK_ID --id invocation_UUID --phase started
agent-comms task invocation TASK_ID --id invocation_UUID --phase ended --outcome completed
agent-comms task brief MESSAGE_ID
```

Invocation IDs have 8–64 letters, digits or hyphens after `invocation_`.
Ended requires `completed`, `failed`, `cancelled` or `interrupted`; started
has no outcome and is refused on terminal tasks. Ended remains valid after
termination. Repeating an ID and phase is idempotent; each task holds at
most 256 invocations. Reports change no claim, revision, timestamp or event
stream, and send no messages. Show adds `invocations` and the last five
`events`; list still returns claims only. Principal clients expose
`reportInvocation(taskId, invocationId, phase, outcome?)`.

Brief reads a pending task-event from the caller's inbox by paging the
existing read operation. It returns `{ turn, linked, role, taskId, prompt }`;
acknowledged messages are unavailable, and a skipped turn has a null prompt.
Workers decide from the current task, regardless of an event's older state.
Assignees run on offered, accepted, working or input-required tasks and
report start/end execution facts. Offerers review input-required, completed,
failed or rejected claims without linking an invocation. Other events are
acknowledged without a turn. Task events never receive replies. Finishing a
turn never completes the task; reporting failures are logged and do not
stop work. A stopped turn reports interrupted and leaves its event for replay.

The new `task-invocation` log record makes downgrade unsupported once written;
an older broker refuses to replay it.
