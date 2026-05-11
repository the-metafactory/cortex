---
feature: "agents.d fragment loader and watcher"
plan: "./plan.md"
status: "pending"
total_tasks: 12
completed: 0
---

# Tasks: agents.d fragment loader and watcher

## Legend

- `[T]` — Test required (TDD: test FIRST)
- `[P]` — Parallel-safe within group
- `depends: T-X.Y` — Sequential dependency

## Task Groups

### Group 1: FragmentLoadError + loadAgentsDirectory

- [ ] **T-1.1** Test fixtures [P]
  - Create `src/common/config/__tests__/fixtures/agents.d-*/` (6 dirs per plan §File Structure)
  - Each contains the minimal yaml content needed to drive the test scenarios

- [ ] **T-1.2** Failing tests for `loadAgentsDirectory` [T] (depends: T-1.1)
  - File: `src/common/config/__tests__/fragment-loader.test.ts`
  - Tests:
    - empty dir → returns []
    - non-existent dir → returns []
    - single valid fragment → returns 1 Agent matching `AgentSchema`
    - multiple valid fragments → returned in alphabetical order
    - malformed YAML → throws `FragmentLoadError` with file name
    - missing required field → throws `FragmentLoadError`
    - duplicate `id` across fragments → throws `DuplicateAgentIdError`-style error
    - persona path relative → resolved relative to fragment file's dir
    - persona path absolute → used as-is
    - persona path with `~` → expanded to $HOME
    - non-`.yaml` files in dir → skipped silently
    - dotfiles → skipped silently
  - RED: all fail because function doesn't exist

- [ ] **T-1.3** Implement `FragmentLoadError` + `loadAgentsDirectory` [T] (depends: T-1.2)
  - File: `src/common/config/loader.ts`
  - GREEN: T-1.2 passes

### Group 2: Loader integration

- [ ] **T-2.1** Failing tests for merged-load behaviour [T] (depends: T-1.3)
  - File: `src/common/config/__tests__/loader.test.ts` (extends existing)
  - Tests:
    - Load config with only inline `agents[]` → no change from current behavior
    - Load config with only fragments → `agents[]` populated from fragments
    - Inline + fragments different ids → all agents present, alphabetical fragment order
    - Inline + fragments same id → inline wins; warning log captured
    - Frag↔frag same id → throws `FragmentLoadError`
    - Trust references inline agent → resolves
    - Trust references fragment agent → resolves
    - Trust references unknown id → throws (translated from `UnknownAgentReferenceError`)
  - RED: most tests fail

- [ ] **T-2.2** Implement merged-load in `loadConfig` [T] (depends: T-2.1)
  - File: `src/common/config/loader.ts`
  - Adds the merge logic + warning log path
  - GREEN: T-2.1 passes

### Group 3: Watcher extension

- [ ] **T-3.1** Failing tests for `agents.d/` watching [T] (depends: T-2.2)
  - File: `src/common/config/__tests__/fragment-watcher.test.ts`
  - Tests (use tmp-dir + small debounce override to 50ms for test speed):
    - Drop a fragment → `ConfigChangeEvent` fires with `agentsAdded: [id]`
    - Modify a fragment → fires with `agentsChanged: [id]`
    - Delete a fragment → fires with `agentsRemoved: [id]`
    - Rapid-fire 5 file changes within debounce → single event
    - Drop a bad fragment mid-run → `failed: true` event; prior state retained
    - Recover by fixing the bad fragment → next event has `failed: false`
    - `source: "watcher"` set on all watcher-driven events
  - RED: all fail because watcher doesn't know about `agents.d/`

- [ ] **T-3.2** Implement watcher extension [T] (depends: T-3.1)
  - File: `src/common/config/watcher.ts`
  - Adds the `agents.d/` watch + debounce + diff + event payload extension
  - GREEN: T-3.1 passes

### Group 4: SIGHUP handler in cortex.ts

- [ ] **T-4.1** Failing tests for SIGHUP-triggered reload [T] (depends: T-3.2)
  - File: `src/__tests__/cortex-sighup.test.ts` (new)
  - Test: spawn cortex.ts subprocess against fixture config; send SIGHUP; assert reload happens (via stdout structured log line) within 500ms
  - Alternative if subprocess is heavy: unit test the handler-registration function with a synthetic process emitter

- [ ] **T-4.2** Register SIGHUP handler in `cortex.ts` startup [T] (depends: T-4.1)
  - File: `src/cortex.ts`
  - Adds `process.on("SIGHUP", () => triggerReload({ source: "sighup" }))`
  - GREEN: T-4.1 passes

### Group 5: Integration + cleanup

- [ ] **T-5.1** Boot-time strict failure test [T] (depends: T-2.2)
  - Test: spawn cortex.ts subprocess with bad fragment present → assert non-zero exit + stderr contains fragment filename

- [ ] **T-5.2** Full-suite regression check (depends: all)
  - `bun test` — full suite passes (modulo known mission-control React shell test)
  - `bunx tsc --noEmit` — clean

## Dependency Graph

```
T-1.1 ─┬─> T-1.2 ──> T-1.3 ──> T-2.1 ──> T-2.2 ──> T-3.1 ──> T-3.2 ──> T-4.1 ──> T-4.2
       │                                  │                                          │
       │                                  └─> T-5.1 (parallel with 3.x/4.x) ─────────┤
       │                                                                             │
       └─────────────────────────────────────────────────────────────────────> T-5.2
```

## Execution Order

1. T-1.1 fixtures
2. T-1.2 RED → T-1.3 GREEN  (loadAgentsDirectory)
3. T-2.1 RED → T-2.2 GREEN  (merged load)
4. T-3.1 RED → T-3.2 GREEN  (watcher)
5. T-4.1 RED → T-4.2 GREEN  (SIGHUP)
6. T-5.1 (boot strict) — can run any time after T-2.2
7. T-5.2 final regression check

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | pending | |
| T-1.2 | pending | |
| T-1.3 | pending | |
| T-2.1 | pending | |
| T-2.2 | pending | |
| T-3.1 | pending | |
| T-3.2 | pending | |
| T-4.1 | pending | |
| T-4.2 | pending | |
| T-5.1 | pending | |
| T-5.2 | pending | |

## TDD Enforcement

Every [T] task: RED → GREEN → BLUE → VERIFY. Coverage ratio target: 1.0+ (more test files than source given the fixture-heavy approach).

## Post-Implementation Verification

### Functional
- [ ] All new unit tests pass
- [ ] Existing loader.test.ts + watcher.test.ts still pass
- [ ] Full `bun test` regression-clean (modulo mission-control known fail)

### Failure (Doctorow)
- [ ] **Bad fragment at boot** → cortex exits non-zero with named error
- [ ] **Bad fragment mid-run** → prior state retained, error logged
- [ ] **Watcher loses fs.watch handle** → SIGHUP fallback works (manual verify)
- [ ] **Trust cycle across fragments** → caught at boot via AgentRegistry

### Maintainability
- [ ] `loadAgentsDirectory` has JSDoc + 1-line summary
- [ ] Watcher's debounce reuses existing pattern if present (no duplicate)
- [ ] No orphan code — all new functions consumed by loader / watcher path
