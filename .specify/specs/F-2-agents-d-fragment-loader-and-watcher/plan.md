---
feature: "agents.d fragment loader and watcher"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: agents.d fragment loader and watcher

## Architecture Overview

```
~/.config/cortex/
├── cortex.yaml                    (primary — inline agents[] + operator + renderers)
├── agents.d/                      (drop-in directory; arc-installable bot fragments)
│   ├── echo.yaml                  (one Agent per file)
│   ├── holly.yaml
│   └── codex-rev.yaml
└── networks/                      (existing — out of scope for F-2)

src/common/config/
├── loader.ts                      ─┬─ extended:
│                                   │   - loadAgentsDirectory(dir) → Agent[]
│                                   │   - merge into existing loadConfig path
│                                   └─ new error: FragmentLoadError
└── watcher.ts                     ─┬─ extended:
                                    │   - watch agents.d/ directory
                                    │   - debounce 200ms
                                    │   - emit ConfigChangeEvent with new diff fields
                                    └─ SIGHUP handler routes here too
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | cortex standard |
| Runtime | Bun | cortex standard |
| YAML parser | `yaml` ^2.8.3 | already in deps; matches existing loader |
| Schema validation | `zod/v4` via `AgentSchema` | already in cortex-config.ts |
| File watching | `fs.watch` (Node API, Bun-compatible) | matches existing watcher.ts |
| Tests | `bun:test` | cortex standard |

## Constitutional Compliance

- [x] **CLI-First:** F-3 ships the `cortex agents reload` CLI surface. This feature exposes the underlying function.
- [x] **Library-First:** `loadAgentsDirectory(dir)` is a pure function — testable without filesystem mocking via tmp-dir fixtures.
- [x] **Test-First:** every new function gets a failing test first. Target coverage: ratio ≥0.8 (test files / source files).
- [x] **Deterministic:** glob is alphabetical; merge order is stable; debounce is fixed window.
- [x] **Code Before Prompts:** no LLM involvement; all parsing/validation is deterministic code.

## Data Model

### Fragment file (on disk)

```yaml
# ~/.config/cortex/agents.d/echo.yaml
id: echo
displayName: Echo
roles: [agent-restricted]
trust: [luna, holly]
persona: ../personas/echo.md          # relative path → resolved against agents.d/
runtime:
  substrate: claude-code
  mode: in-process
  capabilities: [code-review, typescript]
presence:
  discord:
    enabled: true
    token: ${ECHO_DISCORD_TOKEN}
    guildId: "1487..."
```

### Code surface

```typescript
// src/common/config/loader.ts (new exports)

/** Error thrown when a fragment fails to load. */
export class FragmentLoadError extends Error {
  public readonly file: string;
  public readonly reason: string;
  constructor(file: string, reason: string, cause?: Error) {
    super(`fragment ${file}: ${reason}`);
    this.name = "FragmentLoadError";
    this.file = file;
    this.reason = reason;
    if (cause) (this as { cause?: Error }).cause = cause;
  }
}

/** Load all `*.yaml` fragments from a directory in alphabetical order.
 *  Throws FragmentLoadError on any failure. Returns [] if dir missing. */
export function loadAgentsDirectory(dir: string): Agent[]

// Existing loadConfig() extended internally to also call loadAgentsDirectory()
// and merge results with inline agents[] per the precedence rules.
```

```typescript
// src/common/config/watcher.ts (extended)

export interface ConfigChangeEvent {
  // EXISTING:
  applied: string[];
  requiresRestart: string[];
  config: BotConfig | CortexConfig;
  // NEW (additive):
  source: "watcher" | "sighup" | "cli";
  failed?: boolean;
  error?: { file: string; reason: string };
  agentsAdded?: string[];
  agentsRemoved?: string[];
  agentsChanged?: string[];
}
```

## API Contracts

Internal APIs only — no HTTP, no NATS surface in F-2. (F-3's CLI is a separate feature.)

## Implementation Strategy

### Phase 1: Foundation — loadAgentsDirectory function

- New `FragmentLoadError` class
- New `loadAgentsDirectory(dir: string): Agent[]` function
- Tests with tmp-dir fixtures: empty dir → [], single valid → 1 agent, multi valid → N agents in order, invalid YAML → throw, schema fail → throw, duplicate id ACROSS fragments → throw

### Phase 2: Loader integration

- Modify `loadConfig()` to call `loadAgentsDirectory()` against `<configDir>/agents.d/`
- Merge logic: inline agents[] + fragment agents[]; inline wins on id collision; warning log on shadow
- Construct `AgentRegistry` to surface trust errors at load time (existing behavior — registry construction throws on unresolved trust)
- Translate registry errors into `FragmentLoadError` with file context
- Tests: load combinations of inline + fragments; collision tests; trust validation tests

### Phase 3: Watcher extension

- Add `watch()` call against `<configDir>/agents.d/`
- Debounce events (200ms quiet period — reuse existing watcher debounce pattern if present, else add minimal)
- On debounced fire: call full `loadConfig()`; emit `ConfigChangeEvent`
- Diff old vs new `agents[]` to populate `agentsAdded/Removed/Changed`
- Mid-run failure handling: catch, emit failed event, keep prior config
- Tests: fragment add fires event; fragment delete fires event; modify fires event; rapid successive saves debounce to single event; bad fragment doesn't crash watcher; recovers when fixed

### Phase 4: SIGHUP handler

- Register in cortex.ts startup (small modification; outside this PR's scope?  No — keep in scope to ship complete feature)
- Handler invokes the same reload code path
- Tests: synthetic SIGHUP → reload fires; emit event with `source: "sighup"`

## File Structure

```
src/common/config/
├── loader.ts                                # MODIFIED — adds loadAgentsDirectory + merge
├── watcher.ts                               # MODIFIED — adds agents.d watch + event diff
└── __tests__/
    ├── loader.test.ts                       # EXISTING — extended
    ├── watcher.test.ts                      # EXISTING — extended
    ├── fragment-loader.test.ts              # NEW — focused tests for loadAgentsDirectory
    ├── fragment-watcher.test.ts             # NEW — focused tests for the watch behaviour
    └── fixtures/
        ├── agents.d-minimal/
        │   └── echo.yaml
        ├── agents.d-multi/
        │   ├── echo.yaml
        │   ├── holly.yaml
        │   └── luna.yaml
        ├── agents.d-duplicate-id/
        │   ├── echo-1.yaml
        │   └── echo-2.yaml                  # same `id: echo`
        ├── agents.d-bad-yaml/
        │   └── broken.yaml                  # malformed
        ├── agents.d-missing-persona/
        │   └── echo.yaml                    # persona path resolves to nonexistent
        └── agents.d-unresolved-trust/
            └── echo.yaml                    # trust: [missing-agent-id]

src/cortex.ts                                # MODIFIED — register SIGHUP handler
```

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `fs.watch` unreliable on some filesystems | Medium (watcher misses events) | Low on macOS+Linux | SIGHUP + CLI (F-3) as escape hatch; document the failure mode |
| Debounce window too short → repeated reloads | Low (operator-visible noise) | Low | 200ms is well-tested industry standard; configurable via cortex.yaml |
| Schema migration mid-loader-extension | Medium (loader stays bot.yaml-compatible while design assumes cortex.yaml) | Medium | Keep function name `loadConfig` stable; let migration land the bot.yaml→cortex.yaml rename separately |
| Trust validation throws inside watcher | Medium (mid-run crash) | Low | Wrap reload in try/catch; emit failed event; keep prior config |

## Failure Mode Analysis

### How This Code Can Fail

| Failure Mode | Trigger | Detection | Degradation | Recovery |
|-------------|---------|-----------|-------------|----------|
| Watcher loses inotify handle | Filesystem unmount / NFS quirk | Watcher emits error event | Cortex stops auto-reloading | Operator runs `cortex agents reload` |
| Operator drops 100+ fragments at once | Bulk install | All fire within debounce window | Single reload event | None needed — debounce handles |
| Race: fragment dropped DURING a load | Concurrent arc install | Mid-load filesystem read inconsistency | Tracked via mtime check; reload re-fires | Watcher's next event picks it up |
| Persona path points outside `~/.config/cortex/personas/` | Bot ships malformed manifest | `existsSync` succeeds but file is unexpected | Agent loads but persona content is weird | Out of scope for F-2; F-5 install-time check |

### Assumptions That Could Break

| Assumption | What Would Invalidate It | Detection Strategy |
|-----------|-------------------------|-------------------|
| Operator runs cortex on macOS/Linux | Windows host | n/a — cortex MIG-7 plists are macOS-only today |
| Filesystem supports `fs.watch` events | NFS / FUSE mounts | Document; offer SIGHUP fallback |
| Fragment count stays under 50 | Bot ecosystem explosion | Performance regression test at 100 / 500 |

### Blast Radius

- **Files touched:** 2 modified (loader.ts, watcher.ts) + 1 modified (cortex.ts for SIGHUP) + ~6 new test files + fixtures
- **Systems affected:** any caller of `loadConfig()` — verify cortex.ts startup still works
- **Rollback strategy:** revert PR; loader returns to bot.yaml-only behavior; no fragment files exist yet at this point in the migration so rollback is clean

## Dependencies

### External

- `yaml` ^2.8.3 — already pinned
- `zod/v4` ^4.3.6 — already pinned

### Internal

- `src/common/types/cortex-config.ts` — `AgentSchema`, `Agent` type
- `src/common/agents/registry.ts` — `AgentRegistry`, `UnknownAgentReferenceError`, `DuplicateAgentIdError`
- `src/common/types/persona-format.ts` — `PERSONA_FORMAT_VERSION` (imported but not yet used; reserved for future)

## Migration/Deployment

- No DB migrations
- No env vars
- No breaking changes (additive — fragments are optional; existing inline-only configs work unchanged)
- Operator-visible: a new directory `~/.config/cortex/agents.d/` is now read if present. Cortex creates it on first start if missing (chmod 755).

## Estimated Complexity

- **New files:** 2 test files + ~6 fixture dirs
- **Modified files:** 3 (loader.ts, watcher.ts, cortex.ts)
- **Test files:** 2 new + 2 extended
- **Estimated tasks:** ~12 (TDD per function + integration tests)
- **Debt score:** 2 (well-scoped, but touches the watcher which has cross-cutting impact)

## Longevity Assessment

### Maintainability Indicators

| Indicator | Status | Notes |
|-----------|--------|-------|
| Readability: 6 months from now? | Yes | `loadAgentsDirectory` is a single-purpose function; merge logic documented inline |
| Testability: verifiable without manual testing? | Yes | tmp-dir fixtures for everything |
| Documentation: "why" captured? | Yes | spec.md + this plan |

### Evolution Vectors

| What Might Change | Preparation | Impact |
|------------------|-------------|--------|
| Add `personas.d/` watching (live persona reload) | Mirror agents.d/ pattern | Low — same shape |
| Migrate `bot.yaml` → `cortex.yaml` primary | Keep `loadConfig()` function name stable | Low — internal rename |
| Add fragment URL fetch (k/v store agents) | New loader function | Medium — invariants change |

### Deletion Criteria

- [ ] Feature superseded by: a distributed agent registry (NATS KV-driven instead of filesystem)
- [ ] Dependency deprecated: `fs.watch` → chokidar or equivalent migration
- [ ] User need eliminated: no more bot installs → unlikely while ecosystem grows
- [ ] Maintenance cost exceeds value when: fragment count grows past what filesystem watching can handle (~500 files)
