# Native watcher churn evidence (node #2604)

Measured on 2026-10-17, Darwin 25.6.0 arm64, Bun 1.4.2
(`744846f84`), base `ef0161b9`. Commands ran on the plain host with
sandbox escalation; no container or VM was used.

## Cause and upstream report

A standalone script outside cortex held a directory watch and 1,000 unrelated
idle directory watches. After a quiet period, each trial wrote a unique file
under the established watch. The control changed no watchers. The other arms
opened or closed one unrelated watcher immediately before the write. Each
trial allowed 1,500 ms for delivery and another 2,000 ms for a late event.

| Runtime | Control | Open during write | Close during write | Late events |
| --- | --- | --- | --- | --- |
| Bun 1.4.2 | 6/6 | 4/6 | 3/6 | 0 |
| Node 24.19.0 | 6/6 | 1/6 | 6/6 | 0 |

The loss occurs without any cortex imports. It is not exclusive to Bun.
The existing [Bun issue #44385](https://github.com/oven-sh/bun/issues/44385)
already reports this exact open/close failure with a self-contained repro on
Bun 1.4.2, so no duplicate issue was filed. Its source analysis attributes the
gap to rebuilding the shared FSEvents stream with `SinceNow`; this is an
upstream source analysis, not an instrumented observation of the stream here.

An initial aggressive continuous-churn script lost events in both runtimes;
that result alone could not distinguish runtime behavior from OS overload.
The table above uses one watcher change per trial instead. Under the worker
sandbox, Bun received zero initial events and Node returned `EMFILE`; those
results are not plain-host evidence.

## Reusable reproduction and suite gate

`scripts/probe-fs-watch-churn.ts` has only Node built-in imports. To run it
outside cortex:

```sh
cp scripts/probe-fs-watch-churn.ts /tmp/cortex-watch-churn.ts
bun /tmp/cortex-watch-churn.ts
```

Exit 0 means all measured writes arrived; exit 1 means the measurement found
missing delivery. Setup or write errors throw instead of becoming skips.
The script creates and removes its own temporary directories and closes every
watcher, including on failure.

The same function extends `src/common/test-fs-watch.ts`. After the existing
first-event probe succeeds, it establishes 1,000 background watchers, verifies
one control write, then alternates unrelated watcher opens and closes for up
to eight trials. It stops at the first event still missing after 1,500 ms plus
2,000 ms grace. Events arriving during grace are counted as late, not lost.
The result depends on delivery, without platform or environment-name checks.
All importing suites share one measurement. The existing four gated groups
and every watcher assertion are unchanged; deterministic reload tests run.

The standalone copy measured:

```text
native fs.watch churn: control 1/1; 0/1 writes delivered during unrelated watcher open/close (0 late); open-0 missing after 1500ms + 2000ms grace; 1000 background watchers, 11916ms elapsed; https://github.com/oven-sh/bun/issues/44385
```

Each skip prints that measurement and upstream link. A skip establishes
unavailable native coverage, never a passing watcher assertion.

## Verification

- Before the gate change: the three affected files passed 47 tests, no skips
  or failures, in 4.45 s on the host. This agrees with the reported isolated
  success and does not establish full-suite reliability.
- With the gate: the affected files and initial probe regression tests gave
  35 pass, 17 skip, 0 fail in 15.76 s on the host. The shared control arrived;
  the first churn write was missing after 3,500 ms, with the issue URL in all
  four skip diagnostics. Log: `/tmp/cortex-2604-focused.log`.
- Seven focused regression tests passed in 1.286 s. They cover preserved
  delivery, loss during open and close, late delivery, I/O error propagation,
  resource cleanup, and selection of the churn failure after initial delivery.
- Typechecking and lint of the modified shared gate passed before final checks.
- Final plain-host `bun run check`: all nine gates passed in 424.87 s.
  Tests: **12,024 pass, 31 skip, 60 todo, 0 fail**, 91,287 assertions across
  698 files, 290.77 s. The shared probe delivered its control, then missed
  `open-0` after 1,500 ms plus 2,000 ms grace (12,061 ms total measurement).
  The 17 affected native watcher tests skipped with that measurement and the
  upstream link. Log: `/tmp/cortex-2604-check.log`.

The ranger worker SOP permits one final `bun run check`; three consecutive
full runs are therefore reserved for supervisor/checkpoint verification.
No claim of three passing full runs or a passing close checkpoint is made here.
