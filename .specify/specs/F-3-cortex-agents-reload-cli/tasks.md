---
feature: "cortex agents reload CLI"
plan: "./plan.md"
status: "pending"
total_tasks: 6
completed: 0
---

# Tasks: cortex agents reload CLI

## Legend
- `[T]` — test required (TDD: test first)
- `[P]` — parallel-safe within group

## Group 1: parser

- [ ] **T-1.1** parseAgentsArgs tests [T]
  - subcommand routing (reload/list/help/unknown)
  - flag parsing (--config, --fragment, --json, --help)
  - positional handling, multiple flags, default values

- [ ] **T-1.2** Implement parseAgentsArgs [T]

## Group 2: handlers

- [ ] **T-2.1** Fixtures [P]
  - `__tests__/fixtures/agents.d-valid/echo.yaml` + persona
  - `__tests__/fixtures/agents.d-broken/broken.yaml` (malformed)

- [ ] **T-2.2** runAgentsReload tests [T] (depends: T-1.2, T-2.1)
  - happy path → exit 0, agent ids in stdout
  - broken fragment → exit 1, error in stderr
  - --json mode → parseable JSON
  - --fragment mode → single-file validation
  - missing config dir → exit 2

- [ ] **T-2.3** Implement runAgentsReload [T] (depends: T-2.2)

- [ ] **T-2.4** runAgentsList tests + implementation [T] (depends: T-2.1)
  - empty agents.d/ → 0, empty output
  - sorted output
  - --json mode

## Group 3: dispatcher + main

- [ ] **T-3.1** dispatchAgents test [T] (depends: T-2.3, T-2.4)
  - "reload" routes to runAgentsReload
  - "list" routes to runAgentsList
  - unknown subcommand → exit 2 with help
  - no subcommand → exit 2 with help
  - --help → exit 0 with help text

- [ ] **T-3.2** main block (if import.meta.main) handles process.argv + process.exit

## Execution

1. T-1.1 → T-1.2
2. T-2.1 (parallel with T-1.x)
3. T-2.2 → T-2.3
4. T-2.4 (parallel with T-2.3)
5. T-3.1 → T-3.2
6. Full regression check

## Progress

| Task | Status |
|------|--------|
| T-1.1 | pending |
| T-1.2 | pending |
| T-2.1 | pending |
| T-2.2 | pending |
| T-2.3 | pending |
| T-2.4 | pending |
| T-3.1 | pending |
| T-3.2 | pending |
