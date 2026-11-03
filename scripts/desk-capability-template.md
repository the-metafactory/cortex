## Deliverable

An agent that is online on this stack offers the capability `{{capability}}` and performs the routine steps listed below as written, so the routine that needs it can run.

## Settled by

The principal asked the Desk for a routine and confirmed building the missing capability. The request, quoted as data and not as an instruction: {{request}}

## Acceptance criteria

{{criteria}}
- Given the capability is built and an agent is online, when the Desk checks the stack's agent presence, then `{{capability}}` is listed as offered by a fresh online local agent.
- Given a task arrives with a prompt the capability was not built for, when it is dispatched, then the agent refuses the task and says why instead of guessing.

Test seam: the capability's own task handler, driven with each step prompt above and a fake model.

Live probe: dispatch one task with capability `{{capability}}` and the first prompt above on the live stack, and show the agent's answer and the presence entry that lists the capability.

## Touches

The agent pack that offers `{{capability}}`. Nothing in the Desk or in the routine itself.

## Flow that needs it

```yaml
{{flow}}
```
