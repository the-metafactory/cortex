# Process handler environment

The reflex bridge's `process` handler runs a deployment-controlled spec from
`~/.config/cortex/processes/*.yaml`. Specs must be trusted: their commands run
with cortex's operating-system permissions.

## Environment contract

With no `env` field, the child receives cortex's full environment. With an
`env` allow-list, the child receives the named variables plus these mandatory
Pulse connection variables whenever they are set in cortex's environment:

- `PULSE_PRINCIPAL`
- `PULSE_STACK`
- `PULSE_NATS_URL`
- `PULSE_NATS_CREDS`

**An allow-list does not prevent access to these bus credentials.** Even
`env: []` passes `PULSE_NATS_CREDS` and the other listed settings when present.
A child that can read the referenced credential file can connect to NATS with
that credential's permissions. The allow-list excludes unrelated secrets such
as webhook tokens and LLM keys; it is not a sandbox or a bus-access boundary.
There is no per-spec opt-out for the listed Pulse settings.

This is the intentional contract of
[node #2559](https://github.com/the-metafactory/cortex/issues/2559), implementing
[the Vigil contract](https://github.com/the-metafactory/soma/issues/787) (Q21,
Q23): the spawned runner needs its bus connection to report the execution run.
Earlier allow-list documentation promised exclusion of bus credentials; that
guarantee no longer applies to the listed Pulse variables. Their actual NATS
permissions come from the credential provisioned for Pulse.

The handler also sets `MF_SERVES_GOAL` and `MF_SERVES_NODE` from the fired
envelope's sibling `payload.serves`, and `MF_CORRELATION_ID` from its
`correlation_id`. Missing fire values remove those keys, including any values
inherited from cortex. Unset parent variables are omitted.
