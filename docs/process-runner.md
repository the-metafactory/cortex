# Process handler

The reflex bridge's `process` handler runs a deployment-controlled spec from
the processes directory: `$CORTEX_PROCESSES_DIR` when set, otherwise the
`processes/` directory beside the stack's config file. Specs must be trusted:
their commands run with cortex's operating-system permissions.

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

`USER` and `LOGNAME` are set for every spec, with or without an allow-list: from
cortex's environment when present, otherwise from the operating-system account
cortex runs as (when it resolves). launchd starts cortex without them, and keychain-backed CLIs
such as `claude -p` report "Not logged in" without `USER`.

The handler also sets `MF_SERVES_GOAL` and `MF_SERVES_NODE` from the fired
envelope's sibling `payload.serves`, and `MF_CORRELATION_ID` from its
`correlation_id`. Missing fire values remove those keys, including any values
inherited from cortex. Unset parent variables are omitted.

For the generic routine-file process and its configured path boundary, see [Run routine files through Pulse](pulse-flow-process.md).

## Execution input snapshots

A spec can declare `snapshot_inputs: {flow: /absolute/routines/flows}`.
Before publishing `started`, the runner copies each declared input into a
private temporary directory under that root and substitutes its path in argv.
Inputs must be regular files inside the declared root, without symlinks, and
at most 1 MiB each. The process keeps the snapshot until its terminal result.
Cleanup failures retain the path in a structured diagnostic and do not suppress
the process outcome.

For managed routine deletion, `cortex reflex targets --removal-safe --json`
reports configured targets whose process spec snapshots the `flow` parameter.
Reflex requires that capability and the matching owned flow root before
accepting a revision-bound removal. Unknown execution lifetime refuses Delete.
The supported Pulse runner loads installed actions from its absolute inventory;
snapshots preserve nested steps and relative imports within those actions.
They do not add relative file references to Pulse flow YAML.

When upgrading from a runner without snapshots, restart that runner before
enabling deletion. Check for surviving old children and let them finish before
removing any routine they use. Absence of an audit event does not prove that
an old child has released its input.
