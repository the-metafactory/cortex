# Routine schedule editing

Routine workspace opens **Edit schedule** for schedules that advertise the owner capability. Common day and time values use the clock form. Other expressions remain in the custom field exactly as stored.

The timezone field preserves a null stored timezone as **Use owner default timezone**. The effective timezone appears separately in the owner preview. The browser does not expand recurrence rules.

`GET /api/desk/routine-schedule?id=<id>` returns the current revision and read capability. `POST /api/desk/routine-schedule` accepts `id`, `revision`, `schedule` and nullable `timezone`. The response contains the current and proposed values, up to three future instants, the owner reference time and the proposed complete revision. Changing any field invalidates the preview.

**Save schedule** sends a `schedule` action through `/api/desk/routines`, with the target, original revision, proposed revision and request ID. Mission Control's normal identity and rebind checks protect both POST routes. No step-up code is required.

The action uses `desk_routine_operations`, including its existing per-routine resource exclusion. A different pending action produces a definite not-sent refusal and leaves the form editable. A retry of the same stored intent reads the owner's complete revision. Equal schedule values with a different revision do not establish success. Unconfirmed intents keep their request ID and cannot resend an owner update.

A confirmed change refreshes the calendar, library and flow view. Existing parameter drafts and AI proposals keep their original revisions. A schedule change makes those older drafts stale rather than rebasing them silently.

Cancel writes nothing. Closing an uncertain change keeps the durable intent available in the pending-change banner. External ownership, unsafe YAML references, invalid values and owner failures remain explicit refusals.
