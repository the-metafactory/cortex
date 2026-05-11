---
feature: "Persona format specification"
plan: "./plan.md"
status: "pending"
total_tasks: 4
completed: 0
---

# Tasks: Persona format specification

## Legend

- `[T]` - Test required (TDD: test FIRST)
- `[P]` - Parallel-safe within group
- `depends: T-X.Y` - Sequential dependency

## Task Groups

### Group 1: Version constant (foundation)

- [ ] **T-1.1** Write failing test for `PERSONA_FORMAT_VERSION` constant [T] [P]
  - File: `src/common/types/__tests__/persona-format.test.ts`
  - Test contents: import `PERSONA_FORMAT_VERSION`; assert it matches `/^\d+\.\d+\.\d+$/`; assert value is `"1.0.0"`.
  - RED: test fails because import resolves to nothing.

- [ ] **T-1.2** Create the constant module [T] (depends: T-1.1)
  - File: `src/common/types/persona-format.ts`
  - Contents: JSDoc + `export const PERSONA_FORMAT_VERSION = "1.0.0" as const;`
  - JSDoc points at `docs/persona-format.md` for the schema reference.
  - GREEN: T-1.1 passes.

### Group 2: Documentation (the artifact)

- [ ] **T-2.1** Write failing test for `docs/persona-format.md` existence + structure [T] [P]
  - File: `src/common/types/__tests__/persona-format.test.ts` (extends T-1.1's test file)
  - Test contents:
    - `existsSync` check on `docs/persona-format.md`
    - Read file; assert it contains required section headings: `## Schema`, `## Versioning`, `## Examples`, `## Error handling`, `## Current version`
    - Assert `## Current version` section names the same constant value as `PERSONA_FORMAT_VERSION` (regex match `1\.0\.0`)
  - RED: tests fail because doc doesn't exist.

- [ ] **T-2.2** Write `docs/persona-format.md` [T] (depends: T-2.1)
  - File: `docs/persona-format.md`
  - Sections (per spec.md FR-1..FR-6):
    1. Header (status, version, links to spec / arc-agent-bots design)
    2. `## Schema` — frontmatter required + optional fields with types + descriptions
    3. `## Examples` — minimal (~10 lines) + comprehensive (all optional fields)
    4. `## Versioning` — semver policy table (minor/major triggers) + deprecation pathway
    5. `## Error handling` — what cortex rejects vs warns on
    6. `## Current version` — single line: `PERSONA_FORMAT_VERSION = "1.0.0"` + pointer to `src/common/types/persona-format.ts`
    7. `## Related docs` — links to design-arc-agent-bots.md, design-pi-dev-review-agent.md, architecture.md
  - GREEN: T-2.1 passes.

## Dependency Graph

```
T-1.1 ──> T-1.2
                ╲
                 ╲
T-2.1 ──> T-2.2 ──╲──> all tests green
```

T-1.1 and T-2.1 can run as parallel "RED" phase. T-1.2 and T-2.2 likewise parallel "GREEN" phase.

## Execution Order

1. Parallel: T-1.1 + T-2.1 (both write failing tests)
2. Parallel: T-1.2 + T-2.2 (both implement)
3. Verify: `bun test src/common/types/__tests__/persona-format.test.ts` all green
4. Verify: full `bun test` no regressions (1 pre-existing fail is the mission-control React shell test per RESUME.md — ignore)
5. Commit + open PR

## Progress Tracking

| Task | Status | Started | Completed | Notes |
|------|--------|---------|-----------|-------|
| T-1.1 | pending | - | - | |
| T-1.2 | pending | - | - | |
| T-2.1 | pending | - | - | |
| T-2.2 | pending | - | - | |

## TDD Enforcement

All [T] tasks follow RED → GREEN → BLUE. Coverage ratio target: 1.0 (one test file per source file).

## Post-Implementation Verification

### Functional
- [ ] Unit tests pass for the constant + doc structure
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun test` full suite clean (modulo known mission-control fail)

### Failure (Doctorow Gate — applicable subset)
- [ ] **Edit constant to wrong shape** ("1.0" missing patch) → test catches → revert
- [ ] **Delete a doc section** → test catches → revert
- [ ] **Edit doc's "Current version" to "1.0.1"** → test catches mismatch → revert

### Maintainability
- [ ] Doc reads in under 5 minutes
- [ ] Minimal example is copy-paste-ready
- [ ] No orphan code (constant is intentionally unused at merge; consumers land in F-2/F-5)
