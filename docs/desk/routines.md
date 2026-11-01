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

The `scripts/desk-compose.ts` wrapper also accepts `--routine-edit` and forwards it to the installed Pulse CLI while preserving its configured model URL, model and credential environment-variable name. Set `--pulse-bin <executable>` when Pulse is outside the daemon's PATH. Routine creation continues to use the wrapper's trusted action catalog.

The initial editable contract covers retry attempts, backoff and delay parameters, derived from the same Pulse schema used to validate retry execution. Other steps remain inspectable and explain why editing is unavailable. Unclassified parameters are hidden rather than guessed safe. No routine execution is used to preview an edit.

Flows with shared YAML references remain inspectable but do not offer parameter editing, because a shared node could otherwise change more than the selected step. Use the routine owner interfaces for concurrent writes; manual filesystem edits do not participate in its locking protocol.

Routines currently have no area classification metadata. AI editing uses the already configured routine composer route and passes only owner-redacted flow metadata. The API refuses a supplied local-area restriction because the composer cannot attest that restriction; it does not silently downgrade it.

## Background routines and Needs attention

A routine that runs many times a day can crowd the Schedule calendar. Open the routine's workspace, choose **Schedule**, and set **Calendar display** to **Background**. The calendar then shows the routine once, in **Background routines** beneath the calendar, with its recurrence, source timezone and planned count for the visible period. Select the count to page through the owner-provided planned starts or open the workspace. Choose **Show individual scheduled starts**, or **Scheduled starts** in the workspace, to restore one slot per start. A dense cell's occurrence details also offer to move a listed routine to Background; the Desk never moves a routine on its own.

The display choice is a Cortex presentation preference for the configured principal, stack and routine. `GET /api/desk/routine-display` lists the Background choices; `POST` with `principal`, `stack`, `routineId` and `mode` (`scheduled` or `background`) changes one after the routine owner confirms the routine is installed. It never changes the routine definition, schedule, timezone, pause state, handling policy, approvals or execution. Read-only definitions accept a display choice. A failed save keeps the previous display and shows the unsaved choice with Retry.

**Needs attention** above the calendar lists, grouped by routine and reason, the pending approvals, the recorded execution failures and stale or conflicting execution evidence in the visible period, and routines whose scheduling state the owner could not confirm. Each group shows its loaded count and latest recorded time; open it to approve or deny, inspect an execution and its log, or open the routine workspace. The section ignores the calendar filters and Background choices. It reads at most 1000 recent decisions and says when this period's history is only partly covered. A dispatched decision without a recorded outcome is not a failure, and an empty section is not a health check.
