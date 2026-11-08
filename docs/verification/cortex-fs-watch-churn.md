<!-- glossary-ignore: node, host, run, path, listener, data -->
# Native watcher churn evidence (node #2604)

The suites this gate covers are skipped, not passing, on a macOS host where
the probe measures event loss. On such a host the 17 affected native watcher
tests report as skipped and the full run stays green because of the skip. The
change keeps a full run honest about that; it does not restore the events.

## Review dispositions for node #2683

These dispositions follow the order of the 18 findings in Sage round 1 on
PR #2681, reviewed at `969d58f81cd8f412e0dcd84fc12f725fa8df6663`.
The implementation is on the assigned branch; merge and the
`review-findings-2604-969d58f8` close checkpoint remain supervisor work.

| Finding | Disposition | Evidence or reason |
| --- | --- | --- |
| F1: `src/common` imports the probe from `scripts/` | Fixed | `fs-watch-churn-probe.ts` lives in `src/common`; the gate imports it locally and the script is a CLI wrapper. |
| F2: Probe startup cost | Declined | The probe already stops at the first missing write, including either open or close loss. Keep the measured 1,000-watcher, eight-trial, 1,000 ms settling configuration: no host evidence here supports shorter settling or fewer trials. A runtime-version cache would reuse a capability measurement across changing OS load and sandbox permissions, potentially enabling assertions without a current measurement or retaining stale skips. Passing environments still pay the existing startup cost. |
| F3: Repeated measurement string | Fixed | Both outcomes use `churnSummary()`; only the missing-event outcome adds its suffix. |
| F4: Repeated fixture mode interpolation | Fixed | The generated fixture declares `const mode` once and uses it in each mock branch. |
| F5: Duplicated child-process harness | Fixed | Both suites use `src/common/run-isolated.ts` for execution and decoded output. |
| F6: Headline implies restored delivery | Fixed | The headline describes churn evidence; the opening explicitly states that skipped assertions do not establish restored delivery. The macOS evidence document links using the same wording. |
| F7: `node` in churn evidence | Fixed | The document's glossary directive marks work-graph references and runtime names as intentional technical uses. |
| F8: `host` in churn evidence | Fixed | The directive preserves the distinction between the physical test host and the worker sandbox; neither names a Cortex runtime. |
| F9: `run` in churn evidence | Fixed | The directive preserves test-command execution terminology; these measurements are not Cortex Sessions. |
| F10: `node` in macOS evidence | Fixed | That document's directive marks work-graph references as intentional. |
| F11: `node` in churn tests | Fixed | The suite's directive preserves the `node:` built-in module specifier. |
| F12: `path` in churn tests | Fixed | The directive marks filesystem paths as intentional; these are not bus Subjects. |
| F13: `listener` in churn tests | Fixed | The directive marks filesystem callbacks as intentional; these are not Render targets. |
| F14: `data` in churn tests | Fixed | The directive marks file contents as intentional; these are not envelope Payloads. |
| F15: `node` in the probe script | Fixed | The shared implementation's directive covers its `node:` imports; the CLI wrapper retains the directive too. |
| F16: `path` in the probe script | Fixed | The shared implementation's directive covers its `node:path` import after extraction. |
| F17: `node` in gate tests | Fixed | The suite's directive preserves `node:` built-in module specifiers. |
| F18: `listener` in gate tests | Fixed | The suite's directive marks filesystem callbacks as intentional. |

Focused revalidation on 2026-11-08, Bun 1.4.4, used `bun run test` with
the two probe regression suites, config and fragment watcher suites, and
`cortex.agents-reload.test.ts`: **38 pass, 17 skip, 0 fail**. The shared
first-event probe received zero events during 197 writes within its 10 s
deadline; these skips provide no native watcher coverage. All seven
deterministic probe regressions passed. Log: `/tmp/cortex-2683-focused.log`.

The single final `bun run check` exited 1: **14,556 pass, 71 skip, 201 todo,
1 fail** across 882 test files. Lint, duplication, typecheck, vocabulary,
SDK, shippable hygiene, XDG and branch freshness passed. The failure was
`history preserves recorded authors, subsequent decisions and next steps
without causal claims` at `src/surface/mc/desk/studio/evidence.test.ts:72`:
the fixture expects Git author `Fixture`, but inherited Git author environment
variables override its repository-local fixture identity. The same file
failed identically in focused checks on both this branch and an archived
`origin/main` at `be06d8768345b88e23bf3dcca6241614360dafdf`
(**10 pass, 1 fail** each). The Studio implementation and test files are
unchanged from that base. No workaround was applied. This is not a green
full check; the worker SOP leaves this baseline failure to the supervisor.
Logs: `/tmp/cortex-2683-check.log`, `/tmp/cortex-2683-head-evidence.log`,
`/tmp/cortex-2683-base-evidence.log`.

## Original measurement provenance

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

`src/common/fs-watch-churn-probe.ts` has only Node built-in imports, and
`scripts/probe-fs-watch-churn.ts` is a thin command line wrapper over it. To
run both outside cortex:

```sh
mkdir -p /tmp/cortex-watch-churn/scripts /tmp/cortex-watch-churn/src/common
cp scripts/probe-fs-watch-churn.ts /tmp/cortex-watch-churn/scripts/
cp src/common/fs-watch-churn-probe.ts /tmp/cortex-watch-churn/src/common/
bun /tmp/cortex-watch-churn/scripts/probe-fs-watch-churn.ts
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

## Plain-host revalidation, 2026-10-18

The assigned branch already contained implementation commit `e8916b02`.
Revalidation retained that implementation and merged `origin/main` at
`d907df52` into the assigned branch without rewriting either commit.
The host still reports Darwin 25.6.0 arm64 and Bun 1.4.2. Bun issue #44385
remains open and includes the self-contained control/open/close reproduction.

The standalone copy ran outside the repository with plain-host access:

```text
{"bun":"1.4.2","platform":"darwin","usable":false,"reason":"native fs.watch churn: control 1/1; 1/2 writes delivered during unrelated watcher open/close (0 late); close-1 missing after 1500ms + 2000ms grace; 1000 background watchers, 13659ms elapsed; https://github.com/oven-sh/bun/issues/44385"}
```

A preceding sandboxed run received no control event and explicitly reported
`churn not measured`; it is not evidence of the open/close failure.

The focused command was:

```sh
bun run test scripts/__tests__/fs-watch-churn.test.ts src/common/test-fs-watch.test.ts src/common/config/__tests__/watcher.test.ts src/common/config/__tests__/fragment-watcher.test.ts src/__tests__/cortex.agents-reload.test.ts
```

It finished with **37 pass, 17 skip, 0 fail**, 106 assertions, in **15.42 s**.
The shared probe delivered its control, then missed `open-0` after 1,500 ms
plus 2,000 ms grace, with 12,561 ms total measurement. All four native groups
printed the measurement and upstream issue when skipping. Probe regression
tests passed and the affected suite assertions remain unchanged.
Log: `/tmp/cortex-2604-recheck-focused.log`.

The single final plain-host `bun run check` took **468.48 s** and exited 1.
Lint, duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG and
branch freshness passed. The full test run took **323.75 s** and reported
**12,034 pass, 31 skip, 60 todo, 1 fail**, 91,344 assertions across 700 files.
The watcher gate delivered its control, then missed `open-0` after 3,500 ms
(12,630 ms total measurement); no affected watcher test failed.
Log: `/tmp/cortex-2604-recheck-check.log`.

The sole failure was
`MacosSbplSandbox — denial observation end-to-end (real sandbox-exec + log stream) > a real denied read under audit mode is observed via denials()`
at `src/runner/__tests__/session-sandbox-macos.test.ts:832`: the unified-log
tail observed zero denial records within its existing bound. This test and
its sandbox implementation are unchanged from `origin/main`. It tests log
observation, and this failure alone does not establish failed enforcement.

An archived checkout of `origin/main` (`d907df52`), with the same dependencies,
passed the isolated failing test (1 pass, 2.79 s) and the whole file (48 pass,
3.68 s). The assigned branch then passed the same whole file (48 pass,
3.76 s). Logs: `/tmp/cortex-2604-base-denial.log`,
`/tmp/cortex-2604-base-sandbox.log`, `/tmp/cortex-2604-head-sandbox.log`.
The full-run failure did not reproduce in these focused comparisons, so a
failing base full run has **not** been established. No sandbox-test workaround
or assertion change was made. Supervisor baseline comparison is still needed;
this revalidation is not a green full check or the three-run close checkpoint.
