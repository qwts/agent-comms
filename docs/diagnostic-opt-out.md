# Diagnostic producer opt-out

Set `AGENT_COMMS_DIAGNOSTICS=off` before starting each broker or CLI process to
disable its built-in structured diagnostic producers. The exact lowercase value
`off` is required; unset and all other values preserve enabled behavior. The
policy is sampled once when the diagnostics module loads, so restart an existing
process to change it. Hosts must pass the setting to each process they launch.

Disabled producers return before creating the shared sink, generating diagnostic
IDs or timestamps, serializing records, buffering, scheduling or launching a
diagnostic writer helper. Existing instrumentation calls and duration measurements
remain; this is not a zero-overhead claim. Explicitly injected private diagnostic
callbacks are unchanged. Authentication, canonical errors, security/audit receipts,
message state and message retention are unchanged.

This setting does not erase captures previously saved by an operator. Explicit
offline `diagnostics export` remains available to inspect a selected capture;
it does not enable producers or upload data. There is no automatic diagnostic
disk store or network exporter. Optional OTLP configuration/consent and authorized
live-host consumption remain separate work under #164.
