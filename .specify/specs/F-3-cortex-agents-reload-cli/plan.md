---
feature: "cortex agents reload CLI"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: cortex agents reload CLI

## Architecture

```
src/cli/cortex/commands/agents.ts
├── parseArgs(argv) → ParsedAgentsArgs       // hand-rolled, matches migrate-config pattern
├── runAgentsReload(args) → ExitResult       // exported, calls loadAgentsDirectory
├── runAgentsList(args) → ExitResult         // exported, calls loadAgentsDirectory
├── dispatchAgents(argv) → ExitResult        // top-level subcommand router
└── (if main) parses process.argv + exits

src/cli/cortex/commands/__tests__/agents.test.ts
└── exhaustive coverage of both subcommands + arg parsing
```

Both `runAgentsReload` and `runAgentsList` accept an explicit `agentsDir` (resolved from `--config`) so tests can drive against tmp dirs without touching `~/.config`.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Arg parsing | hand-rolled | matches migrate-config.ts convention; no commander dependency for a small CLI |
| Loader | `loadAgentsDirectory` from F-2 | already covers fragment validation |
| Tests | `bun:test` + tmpdir fixtures | mirrors fragment-loader.test.ts |
| Output formatting | plain text default, `--json` flag for structured | aligns with `cloud.ts` precedent |

## API Contracts

```typescript
export interface ParsedAgentsArgs {
  subcommand: "reload" | "list" | "help" | "unknown";
  config: string | undefined;
  fragment: string | undefined;
  json: boolean;
  help: boolean;
}

export interface ExitResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export function parseAgentsArgs(argv: string[]): ParsedAgentsArgs;
export function runAgentsReload(args: ParsedAgentsArgs): ExitResult;
export function runAgentsList(args: ParsedAgentsArgs): ExitResult;
export function dispatchAgents(argv: string[]): ExitResult;
```

## Implementation Strategy

1. parseAgentsArgs — handles `--config`, `--fragment`, `--json`, `--help`, plus positional subcommand
2. runAgentsReload — resolves agents.d/ dir, calls loadAgentsDirectory, formats output
3. runAgentsList — same, different format
4. dispatchAgents — routes to the above; prints help on unknown / no subcommand

## File Structure

```
src/cli/cortex/commands/
├── agents.ts                            # new — entry + parseArgs + handlers + dispatcher
└── __tests__/
    ├── agents.test.ts                   # new — 15+ tests
    └── fixtures/                        # new — reuse F-2 fixture patterns
        ├── agents.d-valid/
        │   ├── echo.yaml
        │   └── echo.md (persona)
        └── agents.d-broken/
            └── broken.yaml
```

## Risks

| Risk | Mitigation |
|------|-----------|
| `--config` defaults to `~/.config/cortex/cortex.yaml` which may not exist on dev box | If config missing AND `--fragment` not specified, exit 2 with friendly error |
| Persona path relative to fragment file but operator runs CLI from different cwd | Loader already handles path resolution against fragment dir |
| Future evolution to talk to running daemon would break stdout contract | Document v1 as "validation only" in CLI help text |

## Estimated Complexity

- **New files:** 1 source + 1 test + 2 fixture dirs (~5 files)
- **Modified files:** 0
- **Estimated tasks:** 6
- **Debt score:** 1 (small, well-scoped, all wraps F-2)
