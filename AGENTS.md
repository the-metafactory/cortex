# AGENTS.md

`CLAUDE.md` holds the agent rules for this repo. This file holds one thing: the table of rules that a check enforces. A rule here is not advice; breaking it fails a command, and the third column names a past commit the check fails on.

When the principal corrects an agent for a mistake, fix the mistake, then add or tighten the row. A row whose last column reads "docs only" is unenforced; a second correction for it means moving it up to a check.

| Rule | Enforced by | Proven on |
| --- | --- | --- |
| Tests never read this machine's home (`~/.config`, arc installs, `CORTEX_*`/`GROVE_*` env). | `scripts/test-preload.ts` (bunfig preload) refuses a bare `bun test`; `bun run test` (`scripts/test.ts`) runs the suite under a temp HOME. Tested in `scripts/__tests__/test-home.test.ts`. | `195d7e2d^`: its `cortex.test.ts` fails 2 wire-up tests on a host with arc bundles installed, passes 46/46 under `bun run test`. |
| Code is written once; a copy goes into a shared module. | `scripts/check-duplication.ts` against `scripts/duplication-baseline.json` (CI job: Duplication ratchet). A file may not gain jscpd clones; the baseline may not grow past `origin/main`'s. | The 10 `boundPort` copies removed in this change: restoring them fails 5 files. |
| The MC server's bound port has one owner. | `ServerContext.port` (type). | Same `boundPort` copies. |
| Push only what CI passes. | `bun run check` (`scripts/check.ts`) runs every CI gate; each CI job runs `bun scripts/check.ts <gate>`, and `scripts/__tests__/check.test.ts` fails when `ci.yml` and the gate list differ. | `15ef78be` (#2573): `tsc` passes, `check lint xdg` fails. |
| A branch is not behind `origin/main` when pushed. | The `up-to-date` gate in `bun run check` (local only: CI checks out a merge ref). | Not yet proven on a past commit. |
| A changed surface-SDK contract bumps `SURFACE_SDK_VERSION`. | `scripts/check-release-pins.ts` (CI job: Surface-SDK .d.ts sync). | `66b0e03e` (#2611). |
| Git dependencies pin a release tag, not a commit or branch. | `scripts/check-release-pins.ts`; exceptions carry a reason and an expiry in `PIN_EXCEPTIONS`. | `6270687f` (#2568). |
| No new comments; say it in code. `eslint-disable` does nothing. | `cortex/no-comments` (`eslint/no-comments.ts`) with `noInlineConfig`; `eslint/suppressions-guard.ts` keeps `eslint-suppressions.json` from growing. | No past commit yet: a comment added to `src/common/network-id.ts` fails lint, and re-suppressing it fails the guard. |
| A caught error is logged, or its reason is said in code. | Docs only (`CLAUDE.md`); the comment ban removes the old "explain it in a comment" escape. | — |
