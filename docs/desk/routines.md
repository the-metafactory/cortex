# Inspect and edit installed routines

Open **Routines** in the Desk's right-side panel. The page reads the configured routine owner's full scheduled inventory, including routines installed outside the Desk. Each row shows its schedule, timezone when specified, and policy. An owner discovery failure appears as an error.

Select a routine, then select a step to inspect it. Nested bodies and named branches retain their order and connections. Bindings are labelled separately from literal values. Private and unclassified values stay hidden. Routines without an inspectable flow stay listed with an explanation.

Choose **Edit step parameters** where the flow owner declares editable fields. Enter values, then choose **Save parameters**. Invalid values and failed saves retain the draft. If another writer changes the routine, refresh before applying a new edit.

Use **Ask Ivy to change this routine** to prepare parameter changes with the configured `mc.desk.routines.composer` command. Review the before-and-after values, revise or cancel the proposal, then choose **Apply proposed changes**. Preparing a proposal does not write or run a routine. Direct and AI edits preserve schedules, policies and unrelated steps.

## Owner setup

Install a Reflex version with `routine inspect` and `routine update`, and a Pulse version with `routine-contract` and `compose --routine-edit`. Configure the Reflex daemon with:

```yaml
routine_flow_contract_command: [pulse, routine-contract]
```

The executable must be available in the daemon's PATH; an explicit portable deployment path can also be configured. Reflex owns the update and revision check. Cortex does not write owner files. Generated, owner-marked flows support updates; external definitions remain read-only. A missing inspection command fails closed.

The initial editable contract covers retry attempts, backoff and delay parameters, derived from the same Pulse schema used to validate retry execution. Other steps remain inspectable and explain why editing is unavailable. Unclassified parameters are hidden rather than guessed safe. No routine execution is used to preview an edit.

Routines currently have no area classification metadata. AI editing uses the already configured routine composer route and passes only owner-redacted flow metadata. The API refuses a supplied local-area restriction because the composer cannot attest that restriction; it does not silently downgrade it.
