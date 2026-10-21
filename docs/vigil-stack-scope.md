# Vigil source stacks

Vigil runs on the default stack and watches each source stack separately
([soma decision D2](https://github.com/the-metafactory/soma/issues/1033)).
State keys are `state:<vocabulary>:<stack>:<subject>`; run-health keys are
`run:<kind>:<stack>:<ref>`. The stack comes from the second segment of
`envelope.source`, whose shape is `<principal>.<stack>.<instance>`.
An absent or empty segment is invalid and writes no subject.
Vigil's channel checks use its local stack, for example
`state:check:default:vigil:dm-channel`.

Attention IDs include the full key (`att:vigil:state:goal:work:G1`).
New delivery receipts carry that same scoped subject key. Watching displays
the full key and caches goal wording per stack and goal for each request.

Configure wording explicitly in the default stack's `stacks/*.yaml` layer:

```yaml
vigil:
  enabled: true
  soma_homes:
    default: /path/to/personal-soma
    work: /path/to/work-soma
  cadence:
    "state:goal:default:G1": 93600000
    "state:goal:work:G1": 93600000
    "run:job:default:goal-sensor": 3600000
```

Use absolute soma-home paths. Wording is read from
`<configured-home>/profile/goals/<goal-id>.md` at render time; a stack without
a configured home shows the bare ID. There is no implicit home lookup for
subject wording. Result records carry the source stack too; historical
results whose stack is unknown show the bare goal ID. Goal wording is never
stored in subjects, events, receipts, or tracker records.

Before upgrading, rewrite each deployed cadence override by inserting its
source stack: `state:goal:G1` becomes `state:goal:default:G1`, and
`run:job:goal-sensor` becomes `run:job:default:goal-sensor`. If two stacks use
the same reference, configure two entries. The canonical split-layout and
legacy single-file examples use the scoped format.

The inspected default deployment had Vigil enabled with no cadence overrides;
there were no deployed cadence entries to rewrite for node #2713.

Startup detects populated tables containing legacy subject keys and invokes
the existing LEDGER replay path. Replay rebuilds subjects independently for
each source stack, reconnects historical events by their run IDs, and removes
legacy subject rows only when the replay succeeds. Local channel observations
retain their local stack. Result associations are rebuilt with scoped keys.
Existing attention status and confirmed daily text spending are retained.
Historical receipts without a corresponding local event retain their original
key as delivery evidence; they cannot identify a source stack by themselves.

LEDGER must retain the complete observation history. Before this change the
live stream had contiguous sequences starting at 1 and limits retention of
90 days. If replay cannot reconstruct a legacy subject, migration stays pending
for retry and logs the missing-history error. An interrupted replay also stays
pending; restarting resumes by replaying from sequence 1. Do not rename legacy
subject rows to guess the history of a collided reference.
