# macOS suite evidence (work-graph node #2576)

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
| Last-known-good config | Passed | State-directory seam avoids writes to the real `~/.config/grove/state`. |
| Bash shell suites | Passed on Bash 3.2; `mapfile` dependency already removed upstream | No missing-feature skip added. `systemd-render` timeout-absent case failed only in actual Codex; leave it alone under the brief's skip criteria. |
| Watchers | Passed idle, failed under load | Bounded event handshakes replace startup grace sleeps. No sandbox-only watcher skip. |
| Whole-tree carveout scan | Exceeded timeout under load (18 s idle, 47 s loaded) | Give the scan 120 s; assertions unchanged. |
| MC endpoint listeners | Random port collision during full-suite validation | Bind ephemeral port 0. |

The actual base-merge worker's 25 failures were: one boot-level watcher test,
11 `AgentsDirectoryWatcher` tests, four `ConfigWatcher` tests, one NatsLink
tilde-expansion test, one `loadAgentsDirectory` tilde-expansion test, six
`runAgentsReload` tests (tilde expansion and PID/signal handling), and one
`pidFileFor` tilde-expansion test. Those are outside the permitted Bash-feature
and nested-Seatbelt skip conditions; they remain visible failures. This record
does **not** claim the full worker-sandbox suite is green.

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
