# Run routine files through Pulse

The `pulse-flow` process runs the `name` / `actions` YAML emitted by Pulse's shared composer. It uses the existing Reflex activation bridge and process runner. Reflex owns routine authoring and storage; this command only reads and executes files.

## Register the process

Copy `examples/processes/pulse-flow.yaml` into the configured Cortex processes directory. Replace both `/absolute/routines/flows` values with the absolute directory owned by the routine installer. The process specification is trusted stack configuration: its `--flows-dir` value is the allowed root. Keep that value literal; only `--flow` receives an activation payload parameter.

Register this target in the stack's `reflex_activation.targets` configuration, replacing `example` with the principal:

```yaml
reflex_activation:
  targets:
    - target: "@example/pulse-flow"
      capability: process.run
      assistant: cortex
      handler: process
      process: pulse-flow
```

Each routine targets `@example/pulse-flow` with payload:

```json
{"flow":"/absolute/routines/flows/routine.yaml"}
```

The runner substitutes the path into one argument, without a shell. The command requires an absolute file path whose canonical path is inside the configured directory. It accepts links into that directory and rejects links escaping it, neighboring directories with the same prefix, missing files and directories.

## Validate and execute

`cortex pulse-flow --flows-dir /absolute/routines/flows --flow /absolute/routines/flows/routine.yaml` validates the entire flow before executing an action. Validation uses Pulse's step validator and installed-catalog validator, including nested steps and sovereignty annotations. Optional top-level `input` supplies initial fields; otherwise `scenario` and `text` start empty.

One `arc list --json` snapshot selects only active action packages. The validator reads those exact manifests, and execution resolves actions through a temporary directory containing only those selected installations. It never searches the routine's directory, inactive siblings or unrelated package directories. The temporary directory is removed after execution.

## Configure agent routing

The template explicitly opts into `--agent-provider myelin`. This uses Pulse's existing Myelin agent provider and the process runner's existing `PULSE_PRINCIPAL`, `PULSE_STACK`, `PULSE_NATS_URL` and `PULSE_NATS_CREDS` environment. The bus connection must succeed before any action executes. The provider forwards each agent step's capability and sovereignty to the configured stack and drains its connection when the run ends. It does not select a model or register agents.

For deterministic flows that do not need agent routing, remove the two `--agent-provider` arguments. Without a configured provider, any agent or tribunal step, including a nested step or an action requiring `agent`, fails before the first action. The unattended CLI has no human gate, research-model or direct LLM-model configuration; flows requiring those providers also fail before actions. It never falls back to stdin or an ambient model.

## Outcomes

An invalid path, file or flow exits unsuccessfully with one `pulse-flow:` diagnostic line and executes no action. Execution uses Pulse's public `runPipeline` API, which emits its real run-ledger outcome with the activation correlation. Cortex's process runner also reports its terminal process outcome through the existing ledger funnel. Credentials and correlation metadata follow the existing process environment contract documented in [process-runner.md](process-runner.md).

Installed action code and routine storage remain trusted deployment files. The path check confines the selected routine file; it is not a sandbox for an installed action's filesystem or network capabilities.
