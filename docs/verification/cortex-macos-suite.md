# macOS suite evidence (work-graph node #2576)

## Hand fix pass, 2026-10-16 — status of this PR

**What this PR delivers.** Linux CI is green. The `$HOME` isolation from
ruling 2 is in place. Watcher and nested-Seatbelt tests skip, gated by a
probe, where the probe measures the capability as missing. On the macOS
host, the full suite is **not** green yet: native `fs.watch` events get lost
inside a full `bun test` run. Following this node's Assumptions, that group
is escalated to
[#2604](https://github.com/the-metafactory/cortex/issues/2604) (a possible
Bun cause), and the other groups are finished here.

**Linux root cause.** Bun's path watcher drops a `change` event for the same
path if it arrives within 1 ms of the previous one
(`ChangeEvent::should_emit`, `src/runtime/node/path_watcher.rs`). The
readiness probe's event fires, and the config write the test makes right
after it reports nothing. At `7b6ddf93`, probe events never triggered a
reload, so nothing reloaded. Evidence comes from a Linux arm64 host with
Bun 1.4.3, the version CI downloads:

- Minimal repro: the probe event arrived at 5 ms, a real write right after
  it got **no event**, and a write 1.5 s later got one. Bun 1.3.9 delivered
  both events.
- `watcher.ts` at `7b6ddf93` failed the same four tests as CI, about 8 s
  each. At `cb4d6877`, `watcher.test.ts` and `watcher-readiness.test.ts`
  gave **5 pass, 0 fail** on three runs in a row.
- On Linux, a `utimes`-only probe (the `a4d27922` design) gets no event at
  all under Bun 1.3.9.

**macOS host runs, with the 8 s watcher bounds widened to 30 s** (`0614b2a0`,
Darwin 25.6.0 arm64, Bun 1.4.2), `bun test && bunx tsc --noEmit`:

| Run | Starting load (1 min) | Tests | Test time | Combined |
| --- | --- | --- | --- | --- |
| 1 | 27.0 | 11,607 pass, 8 skip, 60 todo, 7 fail | 641 s | 676 s |
| 2 | 125.0 | 11,608 pass, 8 skip, 60 todo, 6 fail | 862 s | 881 s |

Typechecking passed in both runs. The watcher failures ran into the 30 s
bound, just as they had run into the 8 s one, so the events were lost, not
late. The widening was reverted. Run 2 also hit Bun's 5 s default timeout in
two unrelated tests at load 125. Run 3 was stopped once the split was clear.

Before that, three runs at `625d20d2` with the 8 s bounds (starting loads
100.7, 25.8 and 59.5; test times 356 s, 499 s and 534 s) failed the same way:
1, 10 and 16 failures. They also failed in two places this PR now fixes:

- `startCortex — federated-peer boot resolution` boots twice and exceeded
  Bun's 5 s default timeout at 5.6 s. The file timeout is now 30 s.
- `MacosSbplSandbox — denial observation` used a fixed 1.5 s grace before
  reading the unified log. It is now a bounded 10 s poll.

`fseventsd` ran at ~180% CPU during these runs. A standalone first-event
probe measured latencies of 0.3–9.4 s. When run on their own, the same
watcher, fragment-watcher, readiness, agents-reload, federated-peer and
Seatbelt suites gave **100 pass, 0 fail** (69 s).

**Sandbox runs pass with skips, not with coverage.** Inside the Codex worker
sandbox, a passing suite means exit 0 with the probe-gated skips from ruling
1 (17 watcher tests and 41 real-Seatbelt tests). Those assertions do not run
there. Their coverage has to come from plain-host runs, and on this host
that coverage is the open item in #2604.

## CI follow-up — ConfigWatcher coalesced notifications

The Linux Test job at `7b6ddf93` still failed all four ConfigWatcher reload
assertions with `Received: null` after approximately eight seconds. Its log
reports Bun 1.4.3. The failing step was `bun test`; the other CI checks passed.
Source: [CI run 38822683317](https://github.com/the-metafactory/cortex/actions/runs/38822683317).

Before this repair, the focused command below also reproduced the repo-removal
failure on plain Darwin 25.6.0, Bun 1.4.2: **7 pass, 1 fail in 17.36 s**.
Readiness resolved, but no reload followed the actual config write.

```sh
bun test src/common/config/__tests__/watcher.test.ts \
  src/common/config/__tests__/watch-handshake.test.ts
```

The readiness callback consumed its change notification without scheduling the
normal debounced reload. When the probe and the subsequent config write share
a notification, no second callback is available to trigger that reload.
ConfigWatcher now resolves readiness **and** retains the normal debounce for
the change event. The deferred reload reads the subsequent write. The probe,
handshake deadlines, skip criteria and existing reload assertions are unchanged;
principal ruling 1 remains in effect.

An isolated child-process regression supplies exactly one notification for the
readiness probe and the following real config write. It fails before the repair
with `coalesced change was lost` (**0 pass, 1 fail, 2.20 s**) and passes after it
(**5 pass, 0 fail, 444 ms**, including the four shared-handshake checks).
The child keeps its mocked backend out of native watcher tests.

The first broader plain-host check passed all four ConfigWatcher cases and
the new regression, but one AgentsDirectoryWatcher readiness handshake timed
out: **51 pass, 1 fail, 42.26 s**. Its unchanged directory-watcher code reported
no event within 8,000 ms. Log: `/tmp/cortex-2576-ci-host-focused.log`.
This failure differs from the Linux ConfigWatcher null assertions: there the
handshake succeeded and the next write was dropped. Here the handshake itself
saw no event. The 2026-10-16 runs above put it in the macOS lost-event group
(#2604); the three green repeats that follow do not show that it is gone.

Three consecutive repeats of the broader focused command then passed, each
with **52 pass, 0 skip, 0 fail**, in **15.28 s, 13.74 s and 13.26 s**. They
cover the config and fragment watchers, boot-level agents reload, the shared
handshake and the new regression. Logs:
`/tmp/cortex-2576-ci-host-repeat-{1,2,3}.log`. Changed-file ESLint,
`bunx tsc --noEmit` and `bun scripts/xdg-audit.ts --repos .` also passed.

The single final worker-sandbox command required by the CI fix-pass SOP,
`bun test && bunx tsc --noEmit`, exited **0**: **11,556 pass, 66 skip, 60 todo,
0 fail** across 666 files, **264.46 s** for tests and **275.09 s** combined wall
time. The new deterministic regression passed. The shared native probe measured
**0 events from 190 writes in 10,003 ms** (10,000 ms deadline), so the existing
17 watcher skips named that measurement; the other 49 skips were unchanged.
Log: `/tmp/cortex-2576-ci-worker-full.log`.

This fix pass adds one full worker execution and the three focused plain-host
repeats above. The three full plain-host timings in the next section remain
evidence for their explicitly named prior revision, not new measurements of
this callback repair.

Native Linux validation came later, on a Linux host and in CI. See the
2026-10-16 section at the top. No VM or container was started.

## Review round 5 acceptance evidence — prior revision

At the revision measured in this section, the suite was green on plain macOS
and inside the actual Codex worker sandbox. The earlier failing executions
retained below are historical, not the
status of the repaired source. The supervisor and principal retain the
`cortex-suite-green-on-host` checkpoint; this record does not close it.

All four measurements tested commit `9d106c635e8001e76d88f9b5992b6f37220419f6`,
which includes fetched main `9d4752402ecfe2465ed9f945dc94962f53d95285` through
merge `60310a0f`. Each command started from the clean assigned worker branch;
no branch switch or other branch update was needed. The final evidence commit
changes only this document. These are fresh measurements of the candidate
containing main, not a claim that the unmodified main branch contains this fix.
The original clean-main baseline remains in the historical reproduction split.

Command in every case: `bun test && bunx tsc --noEmit`. Every combined command
exited **0**, so typechecking actually ran and passed after each test execution.
The three plain-macOS test executions ran consecutively on unchanged source.

Environment: Darwin 25.6.0 arm64, 10 cores, Bun 1.4.2, `/bin/bash` 3.2.57 on
PATH. All starting one-minute loads exceeded the core count.

| Measurement | Starting load (1 minute) | Tests | Test time | Combined wall time |
| --- | --- | --- | --- | --- |
| Plain macOS 1 | 17.25 | 11,613 pass, 8 skip, 60 todo, 0 fail | 353.14 s | 364.91 s |
| Plain macOS 2 | 12.17 | 11,613 pass, 8 skip, 60 todo, 0 fail | 385.84 s | 405.03 s |
| Plain macOS 3 | 31.63 | 11,613 pass, 8 skip, 60 todo, 0 fail | 406.05 s | 440.34 s |
| Actual Codex worker sandbox | not sampled separately | 11,555 pass, 66 skip, 60 todo, 0 fail | 382.75 s | 411.40 s |

Timing caveat: the worker command was launched while the third plain-macOS
**typecheck** was finishing. The host test phases did not overlap. The third
combined timing includes that brief additional load; these are loaded-machine
measurements, not isolated performance benchmarks.

Logs: `/tmp/cortex-2576-r5-host-full-{1,2,3}.log` and
`/tmp/cortex-2576-r5-worker-full.log`. Every command covered 11,681 tests across
665 files. No source or test changed between these measurements.

### Capability split in the fresh measurements

| Environment | Shared native watcher probe | Watcher assertions | Real Seatbelt assertions |
| --- | --- | --- | --- |
| Plain macOS 1 | 1 event, 1 write, 26 ms | enabled | enabled |
| Plain macOS 2 | 8 events, 30 writes, 1,498 ms | enabled | enabled |
| Plain macOS 3 | 8 events, 34 writes, 1,738 ms | enabled | enabled |
| Codex worker sandbox | 0 events, 195 writes, 10,002 ms (10,000 ms deadline) | 17 skipped with the measurement | 41 skipped with the failed profile probe reason |

Each full-suite log has one shared native watcher measurement. The worker's
66 skips comprise the same eight existing skips as plain macOS plus those
17 watcher and 41 real-Seatbelt tests. Skipped assertions are not enforcement
passes. The Bash shell suites passed in both environments without a new skip.

### Repair and focused evidence

- Temporary HOME fixtures: the three affected files reproduced **90 pass,
  1 skip, 9 fail** before the repair and **99 pass, 1 skip, 0 fail** after it
  inside the worker. HOME is fresh per test and restored afterward. The NatsLink
  fixture uses that HOME rather than Bun's cached `os.homedir()`. CLI PID
  fixtures pass an explicit scratch state directory through the existing PID
  derivation seam; tilde derivation also receives the scratch home. Existing
  assertions and production defaults remain unchanged. Logs:
  `/tmp/cortex-2576-r5-before-fixtures.log`, `/tmp/cortex-2576-r5-fixtures.log`.
- Watch readiness: both wrappers now use `watch-handshake.ts`, which owns the
  hook promise and timer cleanup. It removes the hook synchronously on the
  first event, so a later event in the same callback batch is not swallowed.
  The config probe rewrites its first byte unchanged instead of relying on a
  metadata-only touch; it probes the content-write event the tests require.
  Four deterministic handshake checks cover synchronous hook release, probe
  failure, silence and a stopped watcher. The final plain-macOS focused watcher
  check passed **47 tests, 0 skips, 0 failures** in 17.16 s.
- Probe interval errors: a failed interval write resolves an error outcome,
  clears the interval and propagates through cleanup. A child-process fault
  injection proves the second write error rejects, closes the watcher, removes
  the temporary directory and exits promptly. Together with the fixture,
  handshake and purge checks: **105 pass, 1 existing skip, 0 fail** in 3.02 s.
  Logs: `/tmp/cortex-2576-r5-host-watchers-final.log` and
  `/tmp/cortex-2576-r5-focused-final.log`.
- Purge deadline: the historical plain-macOS full-suite failures below exceeded
  the default 5-second test deadline. A fresh isolated plain-macOS baseline
  passed in 1,916.80 ms; the shell command separately passed all 32 assertions
  in 1.67 s. This is intermittent full-suite timing, not a failed shell assertion.
  Its wrapper now has a 20-second deadline, with the same shell assertions.
  It passed all three fresh host checks and the worker check. Baseline logs:
  `/tmp/cortex-2576-r5-before-host.log`, `/tmp/cortex-2576-r5-purge-host.log`.
- Regression checks: **24 PID lifecycle tests passed**; typechecking,
  `bun run lint:errors` and the whole-tree XDG gate passed. The two legacy-state
  references in this document were reworded; no allowlist entry was added.

This revision did not establish a native Linux pass. The earlier
[CI Test failure](https://github.com/the-metafactory/cortex/actions/runs/38802252059/job/116654025945)
showed four reload assertions returning null after readiness had resolved. The
content-write probe and synchronous hook release were insufficient: the next
CI execution at `7b6ddf93` still failed those four tests. The follow-up above
preserves the debounced reload when notifications coalesce.

## Coverage contract

`describeWithSandboxExec` probes `(version 1)(allow default)` with
`/usr/bin/true`. A successful probe enables the real sandbox tests; their
assertions must still pass. An unsuccessful probe skips those tests and prints
the reason. Each diagnostic identifies the platform and Bun version. Bun's
summary counts the skipped tests separately from passes.

The skip is required when an outer Seatbelt sandbox prevents `sandbox_apply`.
It proves neither guarded nor strict enforcement. Enforcement evidence must
come from a macOS execution where the probe succeeds and the tests run. A green
supervisor result does not establish that the full suite is green in a worker.

The principal's 2026-10-15 ruling additionally permits a measured native
`fs.watch` capability gate. `src/common/test-fs-watch.ts` measures once per test
process, shared by all three importing test files. It watches a temporary
directory and writes new files every 50 ms until an event arrives or 10 seconds
expire. The diagnostic reports events, writes, elapsed time and deadline.
Setup and filesystem I/O errors remain failures. The watcher, timers and
temporary files are cleaned up on completion.

Only `AgentsDirectoryWatcher`, both `ConfigWatcher` groups and the boot-level
`startCortex — agents.d/ fs.watch reconcile` group use that gate. When no events
arrive they skip with the measured reason; where an event arrives their
assertions still run. Deterministic `reloadAgents()` coverage remains enabled.

## Recorded executions before review round 3

These are historical results, read from ranger's local worker logs on
2026-10-15. They are not new executions of the current revision.

| Execution | Revision | `bun test` | `bunx tsc --noEmit` |
| --- | --- | --- | --- |
| Ranger build supervisor, plain macOS, 2026-10-15T06:14:43Z | `6a453fff` | 11,558 pass, 8 skip, 60 todo, 0 fail; 321.56 s | exit 0 (combined command) |
| Ranger review-1 supervisor, plain macOS, 2026-10-15T06:28:26Z | `11463642` | 11,559 pass, 8 skip, 60 todo, 0 fail; 283.23 s | exit 0 (combined command) |
| Ranger base-merge supervisor, plain macOS, 2026-10-15T07:20:48Z | `11755413` | 11,573 pass, 8 skip, 60 todo, 0 fail; 339.98 s | exit 0 (combined command) |
| Codex worker sandbox, base-merge pass | `11755413` | 11,507 pass, 49 skip, 60 todo, 25 fail; 414.87 s | separate exit 0 |
| Plain macOS, base-merge worker validation | `11755413` | 11,570 pass, 8 skip, 60 todo, 3 fail; 393.97 s | separate exit 0 |

Sources: `~/.config/ranger/logs/workers/the-metafactory__cortex-2576-g1.log`
and `the-metafactory__cortex-2576-g2.log`; the latter includes the full
supervisor output and worker validation summaries. The sandbox run emitted nine
probe-reason diagnostics. Its 49 skips include 41 more tests than the plain-host
run; those skipped assertions are not counted as enforcement passes.

The plain-macOS worker validation failed on two shell-test 5 s timeouts
(`purge-supervision`, `migrate-config-dir`) and a `HeartbeatTicker.notePhase`
elapsed-time assertion. The later supervisor execution passed; this is evidence
of timing variability, not three consecutive green runs of `11755413`.

The original build worker reported three consecutive plain-host runs of
`6a453fff`: 250 s, 296 s, 245 s for tests, each with 11,558 pass / 8 skip /
0 fail, followed by an 11 s typecheck. Starting one-minute loads were 6.7,
9.4, 11.4. These timings are worker-reported in the g1 log, not three fresh
measurements of the current revision or three ranger supervisor runs.

## Reproduction split from the original build

The original worker recorded a plain-macOS baseline at `16a3a7b0`, plus a
deny-default outer Seatbelt approximation. The approximation was not the actual
Codex worker sandbox.

| Group | Plain macOS finding | Sandbox finding / action |
| --- | --- | --- |
| Strict macos-sbpl acceptance | Claude Code startup denied at shared `/tmp/claude-<uid>` | Keep that shared directory denied; strict spawns use a private `CLAUDE_CODE_TMPDIR`. Real sandbox suites skip only when the capability probe fails. |
| Boot wire-up, capabilities, federated peers | Passed, but discovered installed Arc bundles | Isolate plugin/pack roots, sibling scan and replay fixtures under temporary directories. |
| Last-known-good config | Passed | State-directory seam avoids writes to the real the legacy PID-state directory. |
| Bash shell suites | Passed on Bash 3.2; `mapfile` dependency already removed upstream | No missing-feature skip added. `systemd-render` timeout-absent case failed only in actual Codex; leave it alone under the brief's skip criteria. |
| Watchers | Passed idle, failed under load | Bounded event handshakes replace startup grace sleeps. The later principal ruling adds a measured no-event skip (see coverage contract). |
| Whole-tree carveout scan | Exceeded timeout under load (18 s idle, 47 s loaded) | Give the scan 120 s; assertions unchanged. |
| MC endpoint listeners | Random port collision during full-suite validation | Bind ephemeral port 0. |

The actual base-merge worker's 25 failures were: one boot-level watcher test,
11 `AgentsDirectoryWatcher` tests, four `ConfigWatcher` tests, one NatsLink
tilde-expansion test, one `loadAgentsDirectory` tilde-expansion test, six
`runAgentsReload` tests (tilde expansion and PID/signal handling), and one
`pidFileFor` tilde-expansion test. These results precede the principal's
fs.watch ruling. At that time the non-watcher failures were outside the permitted skip
conditions, so that historical pass left those tests unchanged.
This historical result does **not** establish a green worker-sandbox suite.
The later principal ruling 2 authorizes temporary-home isolation for those
permission failures; its implementation and fresh results appear above.

## Review round 3 validation

Environment probes on 2026-10-15: Darwin 25.6.0 arm64, Bun 1.4.2. Outside the
worker sandbox, `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`
exited 0. Inside the Codex worker sandbox it exited 71 with
`sandbox-exec: sandbox_apply: Operation not permitted`.

The review change affects diagnostics and this evidence record only. It does
not widen a skip condition or change any test assertion.

Focused command (same three files in each environment):

```sh
bun test src/runner/__tests__/session-sandbox-macos.test.ts \
  src/runner/__tests__/session-sandbox-macos-strict.test.ts \
  src/runner/__tests__/cc-session-macos-sandbox-e2e.test.ts
```

| Execution | Result | Meaning |
| --- | --- | --- |
| Actual Codex worker sandbox | 40 pass, 41 skip, 0 fail; 1.032 s | Nine diagnostics report unavailable real sandbox coverage, including the probe's exit 71 reason. |
| Plain macOS, outside the worker sandbox | 81 pass, 0 skip, 0 fail; 41.94 s | Nine diagnostics report the probe succeeded. All 41 tests skipped in the worker ran here, including strict and guarded acceptance. |

Logs: `/tmp/cortex-2576-review3-worker-focused.log` and
`/tmp/cortex-2576-review3-host-focused.log`. These focused runs are not ranger
supervisor runs and do not establish a full worker-sandbox pass.

The single final plain-macOS `bun test && bunx tsc --noEmit` attempt in this
review pass returned exit 1: **11,568 pass, 8 skip, 60 todo, 5 fail in
546.65 s** (546.76 s wall time for the command). The nine real-sandbox groups
were enabled; no Seatbelt-capability skips occurred. The failures were all at
the 5,000 ms test deadline:

| Test file | Failure |
| --- | --- |
| `scripts/__tests__/purge-supervision.test.ts` | Shell suite, 5,290.09 ms |
| `scripts/__tests__/systemd-remove.test.ts` | Shell suite, 5,002.35 ms |
| `src/cli/cortex/commands/__tests__/network-cli.test.ts` | No config/cache status, 5,003.86 ms; JSON status, 5,035.51 ms; default-path monolith status, 5,006.79 ms |

All three files are unchanged from `origin/main`. The purge timeout also
appears in the earlier plain-macOS base-merge validation. The other four failures
have not been rerun at the merge base in this review pass; ranger's supervisor
owns that comparison. They have not been skipped or worked around. This final
attempt is **not** a green full-suite result. Log:
`/tmp/cortex-2576-review3-host-full.log`.

Because the failed tests short-circuited `&&`, typechecking was run separately.
`bunx tsc --noEmit` passed (exit 0, 20.83 s wall time), logged in
`/tmp/cortex-2576-review3-typecheck.log`.

## Principal-ruling fix pass, 2026-10-15

The shared event probe implements the principal's fs.watch ruling without
changing any watcher assertion or selecting by environment name. Sage's
duplicated fragment-file filter suggestion is also applied: the watch callback
and signature calculation now share `isFragmentFile`.

Focused command in each environment:

```sh
bun test src/common/config/__tests__/watcher.test.ts \
  src/common/config/__tests__/fragment-watcher.test.ts \
  src/__tests__/cortex.agents-reload.test.ts
```

| Execution | Probe measurement | Focused result |
| --- | --- | --- |
| Actual Codex worker sandbox | 0 events, 194 writes, 10,004 ms | 30 pass, 17 skip, 0 fail; 10.68 s |
| Plain macOS outside the sandbox | 8 events, 24 writes, 1,214 ms | 47 pass, 0 skip, 0 fail; 8.62 s (8.76 s wall) |

Each log contains exactly one `[fs.watch probe]` measurement, reused across
the four gated groups. The plain-macOS check started at one-minute load 11.34
on 10 cores, so all watcher assertions ran under the requested load condition.
Logs: `/tmp/cortex-2576-ruling-worker-focused.log` and
`/tmp/cortex-2576-ruling-host-focused.log`.

The fix-pass SOP reserves one full-suite command immediately before the final
commit and forbids switching branches. No fresh clean-main baseline or three
new full-suite measurements are claimed by this pass. The original baseline
and three reported timings remain above with their revision and provenance.

Final worker-sandbox command: `bun test && bunx tsc --noEmit`, exit 1.
Tests: **11,505 pass, 66 skip, 60 todo, 10 fail**, 315.77 s (315.90 s wall).
The single shared watcher probe measured 0 events from 191 writes in 10,001 ms.
All 17 watcher tests skipped, alongside 49 existing skips; no watcher failed.

| Unchanged failing file | Tests / cause |
| --- | --- |
| `scripts/__tests__/purge-supervision.test.ts` | Shell suite exceeded its 5,000 ms deadline (5,063.23 ms). The same deadline failure is recorded in earlier plain-macOS validation above. |
| `src/bus/nats/__tests__/connection.test.ts` | NatsLink leading-tilde creds fixture: EPERM writing a file directly under the real home. |
| `src/common/config/__tests__/fragment-loader.test.ts` | Persona tilde-expansion fixture: EPERM creating a directory directly under the real home. |
| `src/cli/cortex/commands/__tests__/agents.test.ts` | Seven failures: tilde-persona fixture, delivered signal, partial-numeric PID, stale PID, JSON failed signal, JSON delivered signal, and pidFileFor tilde spellings. All are EPERM while creating fixtures in the real home or its legacy PID-state directory. |

All four files are byte-identical to merge base
`56794cd1c76a9ac3905d74ac68fdaea2734ec2ed` (`git diff --exit-code` passed).
The nine permission failures match the previously recorded worker failures;
the then-current brief left sandbox-only failures outside the authorized
probe conditions unchanged. Principal ruling 2 subsequently authorized the
temporary-home repairs recorded above. The worker SOP leaves unrelated base
failures to the supervisor's comparison. No current base rerun or plain-macOS full pass is
claimed here. Full log: `/tmp/cortex-2576-ruling-worker-full.log`.

The failed tests short-circuited `&&`; typechecking was also checked separately
and passed (exit 0, 15.06 s wall). Log: `/tmp/cortex-2576-ruling-typecheck.log`.
