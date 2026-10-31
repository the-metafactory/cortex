# Studio overseer

The overseer scans committed Studio files and enqueues the native Ranger
`ivy-think` job. It never invokes a model or sends an interruption. Ranger owns
the area policy, daily thread limit and model budgets. Automatic enqueues omit
`mode`.

Configure a deployment-owned YAML file:

```yaml
dir: /absolute/path/to/studio
deskUrl: http://127.0.0.1:8767
ranger: [/absolute/path/to/ranger]
staleDays: 6
```

Run `bun /path/to/cortex/src/cli/studio-overseer.ts /path/to/config.yaml` once.
Add `--watch` for committed Material changes. The watcher checks thread-file
changes after a short debounce and rescans every 15 minutes as a fallback.
A dirty tree defers the whole pass. Supervise the watcher with your operating
system. The first pass establishes a Material baseline; subsequent passes detect
added entries in clean, committed files. Notes and stand changes alone do not
count as new Material. Start the watcher before adding new captures.

Install this Reflex blueprint in the stack's `activations_dir`:

```yaml
schema: metafactory/activation/v1
activations:
  - id: studio-overseer
    target: studio-overseer
    when:
      schedule: "*/15 * * * *"
      timezone: UTC
    policy: auto
    guards:
      cooldown: 30s
```

Declare its Cortex target in `reflex_activation.targets`:

```yaml
- target: studio-overseer
  capability: studio-overseer
  assistant: ivy
  handler: process
  process: studio-overseer
```

Install a trusted `studio-overseer.yaml` process spec in the stack config's
`processes/` directory:

```yaml
name: studio-overseer
cwd: /absolute/path/to/cortex
argv:
  - /absolute/path/to/bun
  - /absolute/path/to/cortex/src/cli/studio-overseer.ts
  - /absolute/path/to/overseer.yaml
timeout_ms: 120000
env: [HOME, PATH]
```

Reload Cortex after changing its target config. Reflex watches blueprint files.
`reflex fire studio-overseer --config /path/to/reflex.yaml` runs the guarded
routine by hand. Where Reflex is unavailable, the equivalent system cron is:

```cron
*/15 * * * * /absolute/path/to/bun /absolute/path/to/cortex/src/cli/studio-overseer.ts /absolute/path/to/overseer.yaml
```

Selection uses UTC days, matching Ranger. Active threads qualify after
`staleDays` without a git change, on `thinkTonight`, on new Material, or for a
related calendar meeting starting in the next 24 hours. Decided threads also
qualify on or after `reviewOn`, even after closure. Parked threads and shipped or
dropped outcomes are excluded. A real note today suppresses another automatic
selection. A successful automatic note whose trigger has the component `Asked to think tonight`
consumes `thinkTonight` in the same commit.
Failures retain the request. Ranger enforces started-attempt limits, including
failures.

Recurring themes are conservative word-pair matches across at least three inbox
captures. They create a proposal containing a reason, capture IDs and a suggested
area. A unanimous capture area wins, then a matching area label, then the first
configured area. The person confirms its theme and area. Captures already cited
by a proposal are excluded. A pass that creates proposals does not enqueue
thinking. Captures remain in the inbox. The next pass can select unrelated
threads.

The overseer shares `.git/studio-write.lock` with Cortex and Ranger, verifies a
clean repository and rereads files before writing. It refuses symlinked proposal
directories and never overwrites a proposal. Its checkpoint lives in the git
directory. A failed proposal commit leaves its files for inspection and defers
later scans until the tree is clean; it never resets the person's files. Only
successful native enqueue commands advance the per-day enqueue checkpoint.

The Desk derives one Studio briefing line from today's real notes, naming each
thread once. Queued work and sample notes do not count as completed thinking.
