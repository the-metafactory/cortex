# Vigil ledger ingest: node #2557 dependency blocker

Implementation stopped on 2026-10-13 at the node's explicit A5b release
precondition. This receipt is not an implementation or a checkpoint pass.

## Evidence

- `git ls-remote --tags https://github.com/the-metafactory/myelin.git` lists
  `v0.8.0` as the latest release tag, pointing to
  `d4262007a3d425132de56842e0b49a10d64b55be`.
- Cortex's `package.json` pins that release. The installed package reports
  version `0.8.0`.
- Importing `@the-metafactory/myelin` with Bun reports `undefined` for both
  `validateExecutionRunFinished` and `executionRunFinishedPattern`.
- The Myelin checkout's main revision
  `277ad3b51ace140b291d749a29edb0a57b5af230` contains both helpers from
  [Myelin node #322](https://github.com/the-metafactory/myelin/issues/322),
  integrated by [PR #328](https://github.com/the-metafactory/myelin/pull/328).
  That revision is newer than the latest release tag.

## Resume condition

Publish a Myelin release containing A5b and both public exports. Then resume
the implementation on this branch, bump the dependency and lockfile to that
release, and exercise the acceptance criteria. Do not substitute an unreleased
main revision or duplicate Myelin's validation contract in Cortex.

Vigil code, deployed stack configs, graph nodes, and the map were not changed.

## Validation of the unchanged implementation

The required full command, `bun test && bunx tsc --noEmit`, was run once.
`bun test` exited 1: 11,416 passed, 51 failed, 8 skipped, 60 todo across
654 files (11,535 tests). Failures include restricted writes to
`~/.config/grove/state`, nested macOS sandbox execution, file-watcher timeouts,
and shell suites (the plist suite uses `mapfile`, absent from macOS Bash).
These failures occurred with no implementation changes.

Because the failed test command skipped the chained typecheck,
`bunx tsc --noEmit` was run separately and passed (exit 0).
This branch does not satisfy the node's passing-tests or implementation gate.
